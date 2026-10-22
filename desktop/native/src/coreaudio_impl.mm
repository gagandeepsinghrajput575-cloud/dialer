// CoreAudio device layer: discovery, the AudioUnit, and the two realtime callbacks.
//
// Nothing in this file calls into V8 except through the Napi::ThreadSafeFunction that `Start`
// installed. That is deliberate — the callbacks run on CoreAudio's realtime thread, where a lock,
// an allocation or a GC pause is an audible dropout.
//
// Shape of the pipeline, microphone to JavaScript:
//   device (48 kHz float32) -> AudioUnitRender -> linear downsample -> 8 kHz Int16
//     -> 160-sample frames -> lock-free ring + ThreadSafeFunction -> daemon's media pump
// and back out again:
//   daemon write(Int16) -> ring -> render callback -> linear upsample -> device float32
#include "pulse_audio.h"

#if defined(__APPLE__)
#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#endif

#include <algorithm>
#include <cstdlib>
#include <cstring>

namespace pulse {

double g_deviceRate = 48000.0;
std::string g_inputName;
std::string g_outputName;
std::vector<Unit*> g_units;

#if defined(__APPLE__)
namespace detail {
namespace {

std::string cfToString(CFStringRef ref) {
  if (!ref) return "";
  char buf[256] = {0};
  if (CFStringGetCString(ref, buf, sizeof(buf), kCFStringEncodingUTF8)) return std::string(buf);
  return "";
}

std::string uidOf(AudioDeviceID id) {
  CFStringRef uid = nullptr;
  UInt32 size = sizeof(uid);
  const AudioDevicePropertyAddress addr = {
    kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
  };
  if (AudioObjectGetPropertyData(id, &addr, 0, nullptr, &size, &uid) != noErr) return "";
  const std::string out = cfToString(uid);
  if (uid) CFRelease(uid);
  return out;
}

std::string nameOf(AudioDeviceID id) {
  CFStringRef name = nullptr;
  UInt32 size = sizeof(name);
  const AudioDevicePropertyAddress addr = {
    kAudioDevicePropertyDeviceNameCFString, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
  };
  if (AudioObjectGetPropertyData(id, &addr, 0, nullptr, &size, &name) != noErr) return "";
  const std::string out = cfToString(name);
  if (name) CFRelease(name);
  return out;
}

bool hasStreams(AudioDeviceID id, AudioObjectPropertyScope scope) {
  const AudioDevicePropertyAddress addr = {
    kAudioDevicePropertyStreamConfiguration, scope, kAudioObjectPropertyElementMain
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(id, &addr, 0, nullptr, &size) != noErr || size == 0) return false;
  std::vector<char> raw(size);
  if (AudioObjectGetPropertyData(id, &addr, 0, nullptr, &size, raw.data()) != noErr) return false;
  auto* list = reinterpret_cast<AudioBufferList*>(raw.data());
  UInt32 channels = 0;
  for (UInt32 i = 0; i < list->mNumberBuffers; i++) channels += list->mBuffers[i].mNumberChannels;
  return channels > 0;
}

std::vector<AudioDeviceID> devices() {
  const AudioObjectPropertyAddress addr = {
    kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, nullptr, &size) != noErr) return {};
  std::vector<AudioDeviceID> ids(size / sizeof(AudioDeviceID));
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, nullptr, &size, ids.data()) != noErr) return {};
  return ids;
}

AudioDeviceID fallbackDevice(AudioObjectPropertySelector which) {
  const AudioObjectPropertyAddress addr = { which, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
  AudioDeviceID id = kAudioObjectUnknown;
  UInt32 size = sizeof(id);
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, nullptr, &size, &id) != noErr) return kAudioObjectUnknown;
  return id;
}

// Find a device by its UID, or by a substring of its name — the UI shows names, the daemon gets
// whatever the operator picked, and both must resolve to the same hardware.
AudioDeviceID pickDevice(const std::string& want, bool input) {
  if (want.empty()) return kAudioObjectUnknown;
  for (AudioDeviceID id : devices()) {
    const AudioObjectPropertyScope scope =
        input ? kAudioDevicePropertyScopeInput : kAudioDevicePropertyScopeOutput;
    if (!hasStreams(id, scope)) continue;
    if (uidOf(id) == want) return id;
    if (nameOf(id).find(want) != std::string::npos) return id;
  }
  return kAudioObjectUnknown;
}

double rateOf(AudioDeviceID id) {
  const AudioDevicePropertyAddress addr = {
    kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
  };
  double rate = 0.0;
  UInt32 size = sizeof(rate);
  if (AudioObjectGetPropertyData(id, &addr, 0, nullptr, &size, &rate) != noErr || rate <= 0) return 48000.0;
  return rate;
}

// Hand one microphone frame to JavaScript. Runs on the JS thread, so Buffer::Copy is safe here.
void deliverFrame(Napi::Env env, Napi::Function jsCallback, int16_t* data) {
  if (env == nullptr || jsCallback == nullptr || data == nullptr) return;
  Napi::HandleScope scope(env);
  jsCallback.Call({Napi::Buffer<int16_t>::Copy(env, data, kFrame)});
}

OSStatus inputProc(void* userData, AudioUnitRenderActionFlags* flags, const AudioTimeStamp* time,
                   UInt32 bus, UInt32 frames, AudioBufferList* io) {
  (void)flags; (void)time; (void)bus; (void)io;
  auto* unit = static_cast<Unit*>(userData);
  if (!unit || !unit->au || frames == 0 || frames > unit->inScratch.size()) return noErr;

  AudioBufferList abl;
  abl.mNumberBuffers = 1;
  abl.mBuffers[0].mNumberChannels = 1;
  abl.mBuffers[0].mDataByteSize = static_cast<UInt32>(frames * sizeof(Float32));
  abl.mBuffers[0].mData = unit->inScratch.data();
  if (AudioUnitRender(unit->au, flags, time, 1, frames, &abl) != noErr) return noErr;

  const float* in = static_cast<const float*>(abl.mBuffers[0].mData);
  const size_t n = static_cast<size_t>(frames);

  // 1. Downsample to 8 kHz mono Int16, continuing the fractional position from the last callback
  //    so there is no seam (and no drift) between device buffers.
  unit->down.step = g_deviceRate / static_cast<double>(kRate);
  unit->down.pos = unit->downPos;
  unit->down.last = unit->downLast;
  unit->down.down(in, n, unit->pcm.data(), n);
  unit->downPos = unit->down.pos - static_cast<double>(n);
  unit->downLast = unit->down.last;
  unit->have = n;
  unit->consumed = 0;

  // 2. Assemble whole 20 ms frames. The copy is malloc'd here and freed on the JS thread — the
  //    one allocation the realtime thread makes, and the deal ThreadSafeFunction offers.
  while (unit->have - unit->consumed >= static_cast<size_t>(kFrame)) {
    std::memcpy(unit->frame.data(), unit->pcm.data() + unit->consumed, sizeof(int16_t) * kFrame);
    unit->consumed += static_cast<size_t>(kFrame);
    unit->inRing.push(unit->frame.data());
    if (!unit->tsfnReady || !unit->running) continue;
    int16_t* copy = static_cast<int16_t*>(std::malloc(sizeof(int16_t) * kFrame));
    if (!copy) continue;
    std::memcpy(copy, unit->frame.data(), sizeof(int16_t) * kFrame);
    unit->tsfn.NonBlockingCall(copy, [](Napi::Env env, Napi::Function js, int16_t* data) {
      deliverFrame(env, js, data);
      std::free(data);
    });
  }
  return noErr;
}

OSStatus renderProc(void* userData, AudioUnitRenderActionFlags* flags, const AudioTimeStamp* time,
                    UInt32 bus, UInt32 frames, AudioBufferList* io) {
  (void)flags; (void)time; (void)bus;
  auto* unit = static_cast<Unit*>(userData);
  if (!unit || !io || io->mNumberBuffers == 0 || frames == 0) return noErr;
  float* out = static_cast<float*>(io->mBuffers[0].mData);
  if (!out) return noErr;

  // Pull as many 20 ms frames as this callback needs, upsample each, concatenate. Silence fills
  // any gap: an underrun must never replay the previous frame.
  size_t written = 0;
  while (written < frames) {
    const size_t want = std::min(static_cast<size_t>(kFrame), static_cast<size_t>(frames) - written);
    if (unit->outRing.pop(unit->outScratch.data())) {
      unit->up.step = static_cast<double>(kRate) / g_deviceRate;
      unit->up.pos = 0.0;
      unit->up.up(unit->outScratch.data(), kFrame, unit->upScratch.data(), want);
      std::memcpy(out + written, unit->upScratch.data(), want * sizeof(float));
    } else {
      std::memset(out + written, 0, want * sizeof(float));
    }
    written += want;
  }
  return noErr;
}

}  // namespace
}  // namespace detail
#endif  // __APPLE__
