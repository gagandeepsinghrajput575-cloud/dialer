// CoreAudio device layer: discovery, the AudioUnit, and the two realtime callbacks.
//
// Nothing in this file calls into V8 except through the Napi::ThreadSafeFunction that `Start`
// installed. That is deliberate — the callbacks run on CoreAudio's realtime thread, where a lock,
// an allocation or a GC pause is an audible dropout.
//
// Shape of the pipeline, microphone to JavaScript:
//   device (48 kHz float32) -> AudioUnitRender -> band-limited decimation -> 8 kHz Int16
//     -> 160-sample frames -> lock-free ring + ThreadSafeFunction -> daemon's media pump
// and back out again:
//   daemon write(Int16) -> ring -> render callback -> band-limited interpolation -> device float32
//
// Both directions are windowed-sinc (see pulse::Resampler): linear interpolation is pitch-correct
// and still sounds metallic, because it leaves images at fs_in - f on the way out and folds
// everything above 4 kHz back into the passband on the way in.
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

// Hand one microphone frame to JavaScript. Runs on the JS thread, so Buffer::Copy is safe here.
void deliverFrame(Napi::Env env, Napi::Function jsCallback, int16_t* data) {
  if (env == nullptr || jsCallback == nullptr || data == nullptr) return;
  Napi::HandleScope scope(env);
  jsCallback.Call({Napi::Buffer<int16_t>::Copy(env, data, kFrame)});
}

}  // namespace
// Everything below is DECLARED in pulse_audio.h, so it must have external linkage: pulse_audio.mm
// calls detail::pickDevice, detail::fallbackDevice, detail::rateOf, detail::nameOf and installs
// detail::inputProc / detail::renderProc as callbacks. Wrapping them in an anonymous namespace gave
// them internal linkage — each translation unit compiled happily on its own and the addon then failed
// to link with nine undefined symbols. The header says so in as many words.

std::string uidOf(AudioDeviceID id) {
  CFStringRef uid = nullptr;
  UInt32 size = sizeof(uid);
  const AudioObjectPropertyAddress addr = {
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
  const AudioObjectPropertyAddress addr = {
    kAudioDevicePropertyDeviceNameCFString, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
  };
  if (AudioObjectGetPropertyData(id, &addr, 0, nullptr, &size, &name) != noErr) return "";
  const std::string out = cfToString(name);
  if (name) CFRelease(name);
  return out;
}

bool hasStreams(AudioDeviceID id, AudioObjectPropertyScope scope) {
  const AudioObjectPropertyAddress addr = {
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
  const AudioObjectPropertyAddress addr = {
    kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
  };
  double rate = 0.0;
  UInt32 size = sizeof(rate);
  if (AudioObjectGetPropertyData(id, &addr, 0, nullptr, &size, &rate) != noErr || rate <= 0) return 48000.0;
  return rate;
}

OSStatus inputProc(void* userData, AudioUnitRenderActionFlags* flags, const AudioTimeStamp* time,
                   UInt32 bus, UInt32 frames, AudioBufferList* io) {
  (void)flags; (void)time; (void)bus; (void)io;
  auto* unit = static_cast<Unit*>(userData);
  AudioUnit au = (unit && unit->inAU) ? unit->inAU : (unit ? unit->au : nullptr);
  if (!unit || !au || frames == 0 || frames > unit->inScratch.size()) return noErr;

  AudioBufferList abl;
  abl.mNumberBuffers = 1;
  abl.mBuffers[0].mNumberChannels = 1;
  abl.mBuffers[0].mDataByteSize = static_cast<UInt32>(frames * sizeof(Float32));
  abl.mBuffers[0].mData = unit->inScratch.data();
  if (AudioUnitRender(au, flags, time, 1, frames, &abl) != noErr) return noErr;

  const float* in = static_cast<const float*>(abl.mBuffers[0].mData);
  const size_t n = static_cast<size_t>(frames);

  // 1. Downsample to 8 kHz mono Int16, continuing the fractional position from the last callback
  //    so there is no seam (and no drift) between device buffers. `down` returns how many 8 kHz
  //    samples it actually produced from these `n` device samples — about n/6 at 48 kHz — and
  //    appends them after whatever the previous callback left unfinished.
  //
  //    This used to ask for `n` OUTPUTS from `n` inputs. With step 6 that ran the read position six
  //    times past the end of the buffer, where the old resampler wrapped it modulo `have` and
  //    replayed the same audio, so the microphone ran about six times too slow. The caller then
  //    stored `pos - n`, which was negative, and the next callback cast that negative double to
  //    size_t — undefined behaviour. `downPos` stays a double now and may legitimately be <= 0.
  const double inRate = unit->inRate > 0 ? unit->inRate : g_deviceRate;
  unit->down.step = inRate / static_cast<double>(kRate);
  unit->down.pos = unit->downPos;
  unit->down.last = unit->downLast;
  const size_t room = unit->pcm.size() - unit->have;
  if (room) unit->have += unit->down.down(in, n, unit->pcm.data() + unit->have, room);
  unit->downPos = unit->down.pos - static_cast<double>(n);
  unit->downLast = unit->down.last;

  // 2. Assemble whole 20 ms frames. The copy is malloc'd here and freed on the JS thread — the
  //    one allocation the realtime thread makes, and the deal ThreadSafeFunction offers.
  //
  //    Nothing is pushed to a mic ring any more: there was no `read` export and no other consumer,
  //    so inRing was write-only state that cost a 320-byte memcpy per frame on the realtime thread
  //    and 20 KB per unit for nothing. Microphone frames reach JavaScript through the
  //    ThreadSafeFunction below and by no other route.
  while (unit->have - unit->consumed >= static_cast<size_t>(kFrame)) {
    std::memcpy(unit->frame.data(), unit->pcm.data() + unit->consumed, sizeof(int16_t) * kFrame);
    unit->consumed += static_cast<size_t>(kFrame);
    if (!unit->tsfnReady || !unit->running) continue;
    int16_t* copy = static_cast<int16_t*>(std::malloc(sizeof(int16_t) * kFrame));
    if (!copy) continue;
    std::memcpy(copy, unit->frame.data(), sizeof(int16_t) * kFrame);
    unit->tsfn.NonBlockingCall(copy, [](Napi::Env env, Napi::Function js, int16_t* data) {
      deliverFrame(env, js, data);
      std::free(data);
    });
  }

  // 3. Keep the unfinished remainder at the front of pcm so the next callback appends after it.
  //    Both buffers were sized once by allocate(); nothing is resized on this thread.
  if (unit->consumed) {
    const size_t left = unit->have - unit->consumed;
    if (left) std::memmove(unit->pcm.data(), unit->pcm.data() + unit->consumed, left * sizeof(int16_t));
    unit->have = left;
    unit->consumed = 0;
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
  //
  // One ring frame expands to `unit->expand` DEVICE samples (960 at 48 kHz), not to kFrame. The old
  // loop capped each frame's expansion at kFrame = 160 device samples, so a 960-sample callback
  // popped SIX frames and played the far end about six times too fast; resetting `up.pos = 0.0` per
  // iteration on top of that kept only about 27 of every 160 samples. `expand` is computed once in
  // Open() and the surplus that does not fit in this callback is carried in a buffer allocate()
  // pre-sized, so the realtime thread neither derives nor allocates anything.
  size_t written = 0;

  // Finish the frame the previous callback could not fit. Already expanded: this is a plain copy.
  if (unit->carryLen) {
    const size_t take = std::min(unit->carryLen, static_cast<size_t>(frames));
    std::memcpy(out, unit->carry.data(), take * sizeof(float));
    if (take < unit->carryLen) {
      std::memmove(unit->carry.data(), unit->carry.data() + take,
                   (unit->carryLen - take) * sizeof(float));
    }
    unit->carryLen -= take;
    written += take;
  }

  const size_t expand = unit->expand ? unit->expand : static_cast<size_t>(kFrame);
  while (written < frames) {
    if (!unit->outRing.pop(unit->outScratch.data())) {
      std::memset(out + written, 0, (static_cast<size_t>(frames) - written) * sizeof(float));
      break;                                       // underrun: silence, never a replayed frame
    }
    const double outRate = unit->outRate > 0 ? unit->outRate : g_deviceRate;
    unit->up.step = static_cast<double>(kRate) / outRate;
    const size_t produced =
        unit->up.up(unit->outScratch.data(), kFrame, unit->upScratch.data(), expand);
    unit->up.pos -= static_cast<double>(kFrame);
    // A negative pos legitimately means "read back into history" now that the kernel is causal, so
    // it is carried rather than clamped to zero (the old clamp is what lost the fractional phase at
    // every frame boundary). Re-anchor only if a rounded `expand` ever pushes it outside one frame.
    if (unit->up.pos < -static_cast<double>(kFrame) ||
        unit->up.pos > static_cast<double>(kFrame)) {
      unit->up.pos = 0.0;
    }
    if (produced < expand) {
      std::memset(unit->upScratch.data() + produced, 0,
                  (expand - produced) * sizeof(float));
    }
    const size_t take = std::min(expand, static_cast<size_t>(frames) - written);
    std::memcpy(out + written, unit->upScratch.data(), take * sizeof(float));
    written += take;
    if (take < expand) {                           // the rest belongs to the next callback
      unit->carryLen = expand - take;
      std::memcpy(unit->carry.data(), unit->upScratch.data() + take, unit->carryLen * sizeof(float));
      break;
    }
  }

  // Mirror buffer 0 to all other buffers (e.g. Right channel in non-interleaved stereo)
  // so all output channels receive clean, uncorrupted audio.
  for (UInt32 b = 1; b < io->mNumberBuffers; b++) {
    if (io->mBuffers[b].mData && io->mBuffers[0].mData) {
      std::memcpy(io->mBuffers[b].mData, io->mBuffers[0].mData, io->mBuffers[0].mDataByteSize);
    }
  }

  return noErr;
}

}  // namespace detail
}  // namespace pulse
#endif  // __APPLE__
