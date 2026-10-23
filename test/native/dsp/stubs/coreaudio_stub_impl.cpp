// The two AudioObject property functions, implemented against the harness-seeded device table.
// A separate translation unit so coreaudio_impl.mm keeps compiling from product source with nothing
// added to it.
#include "pulse_host_coreaudio.h"
#include <algorithm>

std::vector<StubDevice> g_stubDevices;
AudioDeviceID g_stubDefaultInput = 0;
AudioDeviceID g_stubDefaultOutput = 0;
std::vector<float> g_renderSource;
size_t g_renderPos = 0;
OSStatus g_renderStatus = noErr;
UInt32 g_renderBus = 0;

static StubDevice* find(AudioDeviceID id) {
  for (auto& d : g_stubDevices) if (d.id == id) return &d;
  return nullptr;
}

// One buffer, its channel count decided by whether the device has a stream in the requested scope.
// A speaker-only device queried on the input scope reports zero channels, which is what makes
// hasStreams() reject it — the case VAL-AUDIO-008 asks about.
static AudioBufferList* configFor(StubDevice* d, AudioObjectPropertyScope scope, UInt32* size) {
  static AudioBufferList abl;
  const bool present = d && (scope == kAudioDevicePropertyScopeInput ? d->hasInput : d->hasOutput);
  abl.mNumberBuffers = 1;
  abl.mBuffers[0].mNumberChannels = present ? 2 : 0;
  abl.mBuffers[0].mDataByteSize = 0;
  abl.mBuffers[0].mData = nullptr;
  *size = static_cast<UInt32>(sizeof(AudioBufferList));
  return &abl;
}

OSStatus AudioObjectGetPropertyDataSize(AudioObjectID id, const AudioObjectPropertyAddress* addr,
                                        UInt32, const void*, UInt32* size) {
  if (!addr || !size) return -1;
  switch (addr->mSelector) {
    case kAudioHardwarePropertyDevices:
      *size = static_cast<UInt32>(g_stubDevices.size() * sizeof(AudioDeviceID));
      return *size ? noErr : -1;
    case kAudioDevicePropertyStreamConfiguration:
      configFor(find(id), addr->mScope, size);
      return noErr;
    case kAudioDevicePropertyNominalSampleRate:
      *size = sizeof(double);
      return noErr;
    case kAudioDevicePropertyDeviceUID:
    case kAudioDevicePropertyDeviceNameCFString:
      *size = sizeof(CFStringRef);
      return noErr;
    default:
      return -1;
  }
}

OSStatus AudioObjectGetPropertyData(AudioObjectID id, const AudioObjectPropertyAddress* addr,
                                    UInt32, const void*, UInt32* size, void* out) {
  if (!addr || !out || !size) return -1;
  switch (addr->mSelector) {
    case kAudioHardwarePropertyDevices: {
      auto* ids = static_cast<AudioDeviceID*>(out);
      const size_t cap = static_cast<size_t>(*size / sizeof(AudioDeviceID));
      const size_t n = std::min(cap, g_stubDevices.size());
      for (size_t i = 0; i < n; i++) ids[i] = g_stubDevices[i].id;
      *size = static_cast<UInt32>(n * sizeof(AudioDeviceID));
      return noErr;
    }
    case kAudioHardwarePropertyDefaultInputDevice:
      *static_cast<AudioDeviceID*>(out) = g_stubDefaultInput;
      return g_stubDefaultInput ? noErr : -1;
    case kAudioHardwarePropertyDefaultOutputDevice:
      *static_cast<AudioDeviceID*>(out) = g_stubDefaultOutput;
      return g_stubDefaultOutput ? noErr : -1;
    case kAudioDevicePropertyStreamConfiguration: {
      UInt32 s = 0;
      const AudioBufferList* src = configFor(find(id), addr->mScope, &s);
      std::memcpy(out, src, std::min(*size, s));
      *size = s;
      return noErr;
    }
    case kAudioDevicePropertyNominalSampleRate: {
      StubDevice* d = find(id);
      if (!d) return -1;
      *static_cast<double*>(out) = d->rate;
      return noErr;
    }
    case kAudioDevicePropertyDeviceUID:
    case kAudioDevicePropertyDeviceNameCFString: {
      StubDevice* d = find(id);
      if (!d) return -1;
      if (d->uidRef.s.empty()) d->uidRef.s = d->uid;
      if (d->nameRef.s.empty()) d->nameRef.s = d->name;
      *static_cast<CFStringRef*>(out) =
          addr->mSelector == kAudioDevicePropertyDeviceUID ? &d->uidRef : &d->nameRef;
      return noErr;
    }
    default:
      return -1;
  }
}
