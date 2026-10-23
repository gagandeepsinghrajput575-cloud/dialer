// Host stubs for the CoreAudio / CoreFoundation / AudioUnit surface that
// desktop/native/src/coreaudio_impl.mm compiles against.
//
// WHY THIS EXISTS. The addon's two realtime callbacks contain the DSP arithmetic, and four of the
// defects found in it (the render callback's expansion factor, the input callback's resampler call,
// the write path's partial-frame tail, and device selection) produce audio that is merely WRONG —
// never an exception. Cross-compiling for aarch64-macos proves the source is valid against Apple's
// real headers and that every symbol resolves; it cannot prove the arithmetic. There is no audio
// device here and AudioUnit cannot run off macOS, so the only way to MEASURE the real callbacks is to
// compile the real coreaudio_impl.mm for the host against stubs it cannot tell the difference from.
//
// What is stubbed: device enumeration, property reads, AudioUnitRender. What is NOT stubbed: every
// line of pulse::detail — pickDevice, hasStreams, uidOf, nameOf, rateOf, fallbackDevice, inputProc,
// renderProc — and all of pulse::Ring, pulse::Resampler and pulse::queueFrames. Those are the code
// under test, compiled from the product source, unmodified.
//
// The stubs are deliberately faithful to Apple's declarations (same names, same types, same struct
// layout for AudioObjectPropertyAddress and AudioBufferList) so the product source compiles unchanged
// and the constant values are the real four-char codes.
#ifndef PULSE_HOST_COREAUDIO_H_
#define PULSE_HOST_COREAUDIO_H_

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

typedef uint32_t UInt32;
typedef uint64_t UInt64;
typedef int32_t SInt32;
typedef float Float32;
typedef SInt32 OSStatus;
static const OSStatus noErr = 0;

typedef UInt32 AudioDeviceID;
typedef AudioDeviceID AudioObjectID;
typedef UInt32 AudioObjectPropertySelector;
typedef UInt32 AudioObjectPropertyScope;
typedef UInt32 AudioObjectPropertyElement;

struct AudioObjectPropertyAddress {
  AudioObjectPropertySelector mSelector;
  AudioObjectPropertyScope mScope;
  AudioObjectPropertyElement mElement;
};

struct AudioBuffer {
  UInt32 mNumberChannels;
  UInt32 mDataByteSize;
  void* mData;
};
struct AudioBufferList {
  UInt32 mNumberBuffers;
  AudioBuffer mBuffers[1];
};

// The real four-char codes, so a scope/selector mix-up shows up as a miss rather than a coincidence.
// Apple's own headers use the same multi-character constants; run.sh passes -Wno-multichar so the
// host build is as quiet as the cross-compile is.
static const AudioObjectPropertySelector kAudioDevicePropertyDeviceUID = 'luid';
static const AudioObjectPropertySelector kAudioDevicePropertyDeviceNameCFString = 'lchn';
static const AudioObjectPropertySelector kAudioDevicePropertyStreamConfiguration = 'srcc';
static const AudioObjectPropertySelector kAudioDevicePropertyNominalSampleRate = 'nsrt';
static const AudioObjectPropertySelector kAudioHardwarePropertyDevices = 'dev#';
static const AudioObjectPropertySelector kAudioHardwarePropertyDefaultInputDevice = 'dIn ';
static const AudioObjectPropertySelector kAudioHardwarePropertyDefaultOutputDevice = 'dOut';
static const AudioObjectPropertyScope kAudioObjectPropertyScopeGlobal = 'glob';
static const AudioObjectPropertyScope kAudioDevicePropertyScopeInput = 'in  ';
static const AudioObjectPropertyScope kAudioDevicePropertyScopeOutput = 'out ';
// macOS 12 renamed ElementMaster to ElementMain; both are 0. The product uses ElementMain.
static const AudioObjectPropertyElement kAudioObjectPropertyElementMain = 0;
static const AudioObjectID kAudioObjectSystemObject = 0;
static const AudioDeviceID kAudioObjectUnknown = 0;

// ---- CoreFoundation ----------------------------------------------------------------------------
struct __CFString { std::string s; };
typedef const __CFString* CFStringRef;
typedef UInt32 CFStringEncoding;
static const CFStringEncoding kCFStringEncodingUTF8 = 0x08000100;

inline bool CFStringGetCString(CFStringRef ref, char* buf, long size, CFStringEncoding) {
  if (!ref || !buf || size <= 0) return false;
  const size_t n = std::min(ref->s.size(), static_cast<size_t>(size - 1));
  std::memcpy(buf, ref->s.data(), n);
  buf[n] = '\0';
  return true;
}
// The real API releases a retained reference. These strings are owned by the device table below, so
// releasing one would be a use-after-free in the harness.
inline void CFRelease(CFStringRef) {}

// ---- the controllable device table the harness seeds -------------------------------------------
struct StubDevice {
  AudioDeviceID id = 0;
  std::string uid;
  std::string name;
  bool hasInput = false;
  bool hasOutput = false;
  double rate = 48000.0;
  __CFString uidRef;      // stable addresses for CFStringRef returns
  __CFString nameRef;
};
extern std::vector<StubDevice> g_stubDevices;
extern AudioDeviceID g_stubDefaultInput;
extern AudioDeviceID g_stubDefaultOutput;

// ---- AudioUnit / AudioToolbox ------------------------------------------------------------------
struct PulseStubAudioUnit;
typedef PulseStubAudioUnit* AudioUnit;
typedef UInt32 AudioUnitRenderActionFlags;
struct AudioTimeStamp { double mSampleTime = 0.0; UInt64 mHostTime = 0; UInt32 mFlags = 0; };

// What AudioUnitRender hands the input callback. The harness fills this with a known signal and reads
// g_renderPos back to learn exactly how many device samples were consumed.
extern std::vector<float> g_renderSource;
extern size_t g_renderPos;
extern OSStatus g_renderStatus;
extern UInt32 g_renderBus;

inline OSStatus AudioUnitRender(AudioUnit, AudioUnitRenderActionFlags*, const AudioTimeStamp*,
                                UInt32 bus, UInt32 frames, AudioBufferList* io) {
  g_renderBus = bus;
  if (g_renderStatus != noErr) return g_renderStatus;
  if (!io || io->mNumberBuffers == 0 || !io->mBuffers[0].mData) return noErr;
  float* dst = static_cast<float*>(io->mBuffers[0].mData);
  for (UInt32 i = 0; i < frames; i++) {
    dst[i] = g_renderPos < g_renderSource.size() ? g_renderSource[g_renderPos] : 0.0f;
    if (g_renderPos < g_renderSource.size()) g_renderPos++;
  }
  return noErr;
}

OSStatus AudioObjectGetPropertyDataSize(AudioObjectID id, const AudioObjectPropertyAddress* addr,
                                        UInt32, const void*, UInt32* size);
OSStatus AudioObjectGetPropertyData(AudioObjectID id, const AudioObjectPropertyAddress* addr,
                                    UInt32, const void*, UInt32* size, void* out);

#endif  // PULSE_HOST_COREAUDIO_H_
