// pulse_audio internals shared by the CoreAudio implementation and the N-API bindings.
//
// The addon is two files on purpose:
//   coreaudio_impl.mm — CoreAudio device discovery, the AudioUnit and its realtime callbacks;
//   pulse_audio.mm    — the JavaScript surface (open/start/write/stop/close/devices).
// Keeping the realtime code away from the binding code is what makes the rule "the audio thread
// never touches V8" checkable by reading one file.
//
// The exchange rate with JavaScript is fixed: 8 kHz mono signed 16-bit, 160 samples (20 ms) per
// frame, because that is exactly what the SIP media path in desktop/daemon/lib/media.js pumps.
#ifndef PULSE_AUDIO_H_
#define PULSE_AUDIO_H_

#include <napi.h>

#if defined(__APPLE__)
// Outside the namespace: a system header inside `namespace pulse` is asking for a subtle
// linkage bug, and AudioUnitRenderActionFlags below needs these types.
#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>
#endif

#include <atomic>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace pulse {

constexpr int kRate = 8000;          // the SIP/RTP clock, fixed by the codec negotiation
constexpr int kFrame = 160;          // 20 ms of 8 kHz — every buffer exchanged with JS is this
constexpr size_t kRingFrames = 64;   // 1.28 s of slack; more than enough for a scheduler hiccup

// ---- a lock-free ring of fixed frames ----------------------------------------------------------
// One producer, one consumer, atomic head/tail. The audio thread produces (mic) or consumes
// (speaker); the JS thread does the other. Dropping on overflow is correct for a phone: late
// audio is worse than no audio.
struct Ring {
  int16_t slot[kRingFrames][kFrame];
  std::atomic<size_t> head{0};
  std::atomic<size_t> tail{0};

  bool push(const int16_t* data) {
    const size_t h = head.load(std::memory_order_relaxed);
    const size_t next = (h + 1) % kRingFrames;
    if (next == tail.load(std::memory_order_acquire)) return false;   // full: drop this frame
    std::memcpy(slot[h], data, sizeof(int16_t) * kFrame);
    head.store(next, std::memory_order_release);
    return true;
  }

  bool pop(int16_t* out) {
    const size_t t = tail.load(std::memory_order_relaxed);
    if (t == head.load(std::memory_order_acquire)) return false;      // empty: caller writes zeros
    std::memcpy(out, slot[t], sizeof(int16_t) * kFrame);
    tail.store((t + 1) % kRingFrames, std::memory_order_release);
    return true;
  }

  void reset() { head.store(0); tail.store(0); }
};

// ---- linear resampler --------------------------------------------------------------------------
// Good enough for voice at 8 kHz and cheap enough to run inside a render callback. Keeping the
// fractional position between calls means no drift and no click at frame boundaries.
struct Resampler {
  double step = 1.0;
  double pos = 0.0;
  float last = 0.0f;

  void configure(double from, double to) {
    step = (from > 0 && to > 0) ? from / to : 1.0;
    pos = 0.0;
    last = 0.0f;
  }

  // float32 -> int16, device rate -> 8 kHz
  void down(const float* in, size_t have, int16_t* out, size_t want) {
    for (size_t i = 0; i < want; i++) {
      const size_t idx = static_cast<size_t>(pos);
      const float frac = static_cast<float>(pos - static_cast<double>(idx));
      const float a = idx < have ? in[idx] : last;
      const float b = (idx + 1) < have ? in[idx + 1] : a;
      out[i] = clamp16(a + (b - a) * frac);
      pos += step;
      while (pos >= static_cast<double>(have) && have) pos -= static_cast<double>(have);
    }
    if (have) last = in[have - 1];
  }

  // int16 -> float32, 8 kHz -> device rate
  void up(const int16_t* in, size_t have, float* out, size_t want) {
    for (size_t i = 0; i < want; i++) {
      const size_t idx = static_cast<size_t>(pos);
      const float frac = static_cast<float>(pos - static_cast<double>(idx));
      const float a = idx < have ? in[idx] / 32768.0f : last;
      const float b = (idx + 1) < have ? in[idx + 1] / 32768.0f : a;
      out[i] = a + (b - a) * frac;
      pos += step;
      while (pos >= static_cast<double>(have) && have) pos -= static_cast<double>(have);
    }
    if (have) last = in[have - 1] / 32768.0f;
  }

  static int16_t clamp16(float v) {
    const float scaled = v * 32767.0f;
    if (scaled > 32767.0f) return 32767;
    if (scaled < -32768.0f) return -32768;
    return static_cast<int16_t>(scaled);
  }
};

struct Unit;

// One process, one phone: the last opened unit's clock and device names, for `describe()`.
extern double g_deviceRate;
extern std::string g_inputName;
extern std::string g_outputName;
extern std::vector<Unit*> g_units;

struct Unit {
#if defined(__APPLE__)
  AudioUnit au = nullptr;
#endif
  Ring inRing;                 // produced by the audio thread, consumed by JS
  Ring outRing;                // produced by JS, consumed by the audio thread
  Resampler down;              // device rate -> 8 kHz (microphone)
  Resampler up;                // 8 kHz -> device rate (speaker)
  Napi::ThreadSafeFunction tsfn;
  bool tsfnReady = false;
  bool running = false;
  // Scratch space for the audio thread: sized once at open(), never inside a callback.
  std::vector<float> inScratch;    // float32 straight from AudioUnitRender
  std::vector<int16_t> pcm;        // the same samples, downsampled to 8 kHz
  std::vector<int16_t> frame;      // the 160-sample frame being assembled
  std::vector<int16_t> outScratch; // a frame pulled from the ring for the speaker
  std::vector<float> upScratch;    // that frame, upsampled to the device rate
  double downPos = 0.0;            // resampler state carried across callbacks
  float downLast = 0.0f;
  size_t have = 0;                 // samples in inScratch/pcm this callback
  size_t consumed = 0;             // samples already handed to JS

  void allocate() {
    inScratch.assign(4096, 0.0f);
    pcm.assign(4096, 0);
    upScratch.assign(4096, 0.0f);
    frame.assign(kFrame, 0);
    outScratch.assign(kFrame, 0);
  }
};

// ---- the device layer, implemented in coreaudio_impl.mm ----------------------------------------
// Declared here (not in an anonymous namespace) so the binding file can call them: an anonymous
// namespace would give them internal linkage and they would be invisible across the two files.
namespace detail {
#if defined(__APPLE__)
std::string uidOf(AudioDeviceID id);
std::string nameOf(AudioDeviceID id);
bool hasStreams(AudioDeviceID id, AudioObjectPropertyScope scope);
std::vector<AudioDeviceID> devices();
AudioDeviceID pickDevice(const std::string& want, bool input);
AudioDeviceID fallbackDevice(AudioObjectPropertySelector which);
double rateOf(AudioDeviceID id);
// The two realtime callbacks, installed on the unit by open().
OSStatus inputProc(void* userData, AudioUnitRenderActionFlags* flags, const AudioTimeStamp* time,
                   UInt32 bus, UInt32 frames, AudioBufferList* io);
OSStatus renderProc(void* userData, AudioUnitRenderActionFlags* flags, const AudioTimeStamp* time,
                    UInt32 bus, UInt32 frames, AudioBufferList* io);
#endif
}  // namespace detail

// ---- the JavaScript surface, implemented in pulse_audio.mm -------------------------------------
// On a non-Apple build every one of these throws the same honest error, so the daemon can be
// built and tested anywhere and simply reports "coreaudio: not available" through its fallback.
Napi::Value Open(const Napi::CallbackInfo& info);
Napi::Value Start(const Napi::CallbackInfo& info);
Napi::Value Write(const Napi::CallbackInfo& info);
Napi::Value Stop(const Napi::CallbackInfo& info);
Napi::Value Close(const Napi::CallbackInfo& info);
Napi::Value Devices(const Napi::CallbackInfo& info);
Napi::Value SampleRate(const Napi::CallbackInfo& info);
Napi::Value InputDevice(const Napi::CallbackInfo& info);
Napi::Value OutputDevice(const Napi::CallbackInfo& info);
Napi::Value Unsupported(const Napi::CallbackInfo& info);

}  // namespace pulse

#endif  // PULSE_AUDIO_H_
