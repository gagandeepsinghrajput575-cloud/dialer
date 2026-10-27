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
#include <cmath>
#include <cstdint>
#include <algorithm>
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

// ---- band-limited resampler --------------------------------------------------------------------
// 8 kHz telephony <-> the device rate, both directions, with the filter neither direction had.
//
// Linear interpolation is pitch-correct and phase-continuous, and it still sounds metallic: it
// leaves spectral IMAGES at (fs_in - f). Measured through this class, a 3 kHz tone reappears at
// 5 kHz only 9.1 dB down, a 1 kHz tone at 7 kHz 33.6 dB down, and the 3 kHz passband sits 4 dB below
// where it should be. That is the "scratchy edge" heard live but never in the .wav, because the
// recorder taps the 8 kHz RTP stream before this stage. The microphone direction had the mirror
// defect — decimation with no anti-alias filter — so 5 kHz room noise folded to 3 kHz at full level.
//
// So: a Kaiser-windowed sinc interpolator, 128 phase banks with linear interpolation between banks,
// cutoff 0.45 * min(from, to) and ~70 dB stopband. It is CAUSAL (taps read backwards from the read
// position), which is what lets it run inside a render callback without lookahead: every call needs
// only the samples it already has plus the history carried from previous calls. The price is a
// fixed group delay of (taps-1)/2 input samples — 2.9 ms up, 2.7 ms down — well inside the 40 ms
// jitter pre-roll the daemon already keeps.
//
// The table is built in configure() (from Open(), never from a callback); the callbacks only read
// it. `ensure()` rebuilds if a caller changes `step` without calling configure first, which is how
// the host harness drives the class directly.
struct Resampler {
  static constexpr int kPhases = 128;    // fractional-phase resolution, interpolated between banks
  static constexpr int kMaxTaps = 320;   // 48 kHz -> 8 kHz needs ~260 for 70 dB

  double step = 1.0;
  double pos = 0.0;
  float last = 0.0f;   // retained for the caller's contract; the FIR keeps its own history

  int taps = 0;
  double configuredStep = 0.0;
  std::vector<float> table;   // kPhases banks of `taps` coefficients
  std::vector<float> hist;    // the taps-1 input samples immediately before the current block
  std::vector<float> fin;     // int16 -> float scratch for up()

  void configure(double from, double to) {
    step = (from > 0 && to > 0) ? from / to : 1.0;
    build(from, to);
  }

  void reset() {
    pos = 0.0;
    last = 0.0f;
    std::fill(hist.begin(), hist.end(), 0.0f);
  }

  // Zeroth-order modified Bessel, series form: converges for the beta used here and needs no
  // C++17 special-math support, which libc++ does not reliably provide.
  static double besselI0(double x) {
    double sum = 1.0, term = 1.0;
    const double y = x * x / 4.0;
    for (int k = 1; k < 64; k++) {
      term *= y / (static_cast<double>(k) * static_cast<double>(k));
      sum += term;
      if (term < 1e-16 * sum) break;
    }
    return sum;
  }

  static double kaiser(int k, int n, double beta) {
    if (n <= 1) return 1.0;
    const double t = (2.0 * static_cast<double>(k)) / static_cast<double>(n - 1) - 1.0;
    const double r = std::sqrt(std::max(0.0, 1.0 - t * t));
    return besselI0(beta * r) / besselI0(beta);
  }

  void build(double from, double to) {
    const double minRate = std::min(from, to);
    const double fc = 0.45 * minRate / from;   // cutoff, cycles per input sample
    const double df = 0.10 * minRate / from;   // transition width, same units
    int n = static_cast<int>(std::ceil((70.0 - 8.0) / (2.285 * 2.0 * M_PI * df)));
    n = std::max(16, std::min(n, kMaxTaps));
    taps = n;
    const double beta = 8.6;
    table.assign(static_cast<size_t>(kPhases) * static_cast<size_t>(taps), 0.0f);
    for (int p = 0; p < kPhases; p++) {
      const double c = static_cast<double>(p) / kPhases;
      float* bank = table.data() + static_cast<size_t>(p) * static_cast<size_t>(taps);
      double sum = 0.0;
      for (int k = 0; k < taps; k++) {
        const double d = (static_cast<double>(k) - (taps - 1) / 2.0) - c;
        const double x = 2.0 * fc * d;
        const double s = (std::fabs(x) < 1e-9) ? 1.0 : std::sin(M_PI * x) / (M_PI * x);
        const double v = 2.0 * fc * s * kaiser(k, taps, beta);
        bank[k] = static_cast<float>(v);
        sum += v;
      }
      if (sum != 0.0) {
        const double scale = 1.0 / sum;
        for (int k = 0; k < taps; k++) bank[k] = static_cast<float>(bank[k] * scale);
      }
    }
    hist.assign(taps > 1 ? static_cast<size_t>(taps - 1) : 1u, 0.0f);
    fin.assign(8192, 0.0f);
    pos = 0.0;
    last = 0.0f;
    configuredStep = step;
  }

  void ensure(double from, double to) {
    if (taps == 0 || step != configuredStep) build(from, to);
  }


  // float32 -> int16, device rate -> 8 kHz, STREAMING across device buffers.
  //
  // `pos` is the read offset into `in` and may be carried in negative from the previous buffer; the
  // taps below read backwards through `hist` for those samples, so the phase stays continuous across
  // callbacks instead of snapping back to zero.
  //
  // Returns the number of outputs actually written, capped by `cap` and by the input available, so
  // the caller can carry `pos - have` as a double and never cast a negative one to size_t.
  size_t down(const float* in, size_t have, int16_t* out, size_t cap) {
    if (step <= 0.0) step = 1.0;
    ensure(kRate * step, static_cast<double>(kRate));
    if (!in || !out || !have || !taps) return 0;
    if (pos < 0.0 && pos > -1e-6) pos = 0.0;   // float residue from the caller's `pos -= have`
    size_t i = 0;
    const double limit = static_cast<double>(have);
    while (i < cap && pos < limit) {
      const double d = std::floor(pos);
      const long base = static_cast<long>(d);
      const float frac = static_cast<float>(pos - d);
      out[i++] = clamp16(filter(in, have, base, frac));
      pos += step;
    }
    pushHistory(in, have);
    return i;
  }

  // int16 -> float32, 8 kHz -> device rate. Produces exactly `want` device samples so the caller's
  // one-frame-per-20 ms cadence never drifts.
  size_t up(const int16_t* in, size_t have, float* out, size_t want) {
    if (step <= 0.0) step = 1.0;
    ensure(static_cast<double>(kRate), kRate / step);
    if (!in || !out || !have || !taps) return 0;
    if (pos < 0.0 && pos > -1e-6) pos = 0.0;   // float residue from the caller's `pos -= have`
    const size_t n = std::min(have, fin.size());
    for (size_t i = 0; i < n; i++) fin[i] = static_cast<float>(in[i]) / 32768.0f;
    for (size_t i = 0; i < want; i++) {
      const double d = std::floor(pos);
      long base = static_cast<long>(d);
      if (base > static_cast<long>(n) - 1) base = static_cast<long>(n) - 1;
      const float frac = static_cast<float>(pos - d);
      out[i] = filter(fin.data(), n, base, frac);
      pos += step;
    }
    pushHistory(fin.data(), n);
    return want;
  }

  // One output: the taps are read backwards from `base`, so nothing later than `base` is touched.
  float filter(const float* in, size_t have, long base, float frac) const {
    const double pf = static_cast<double>(frac) * kPhases;
    int p0 = static_cast<int>(pf);
    if (p0 >= kPhases) p0 = kPhases - 1;
    if (p0 < 0) p0 = 0;
    const float w = static_cast<float>(pf - p0);
    const float* h0 = table.data() + static_cast<size_t>(p0) * static_cast<size_t>(taps);
    // Past the last bank there is no "next" phase to interpolate towards: bank 0 is a whole sample
    // earlier, and blending into it adds a full input sample of delay (measured: every sixth output
    // sample arrived one input sample late, a 50 Hz-rate click train). Extrapolate forwards from the
    // last two banks instead; the residual error is O(w^2 / kPhases^2), around -80 dB.
    const bool at_end = (p0 + 1) >= kPhases;
    const float* h1 = table.data() +
        static_cast<size_t>(at_end ? p0 - 1 : p0 + 1) * static_cast<size_t>(taps);
    float acc = 0.0f;
    long j = base - static_cast<long>(taps) + 1;
    for (int k = 0; k < taps; k++, j++) {
      float x;
      if (j >= 0) {
        x = static_cast<size_t>(j) < have ? in[j] : 0.0f;
      } else {
        const long idx = static_cast<long>(hist.size()) + j;
        x = (idx >= 0 && idx < static_cast<long>(hist.size()))
            ? hist[static_cast<size_t>(idx)] : 0.0f;
      }
      const float c = at_end ? (h0[k] + (h0[k] - h1[k]) * w)
                             : (h0[k] + (h1[k] - h0[k]) * w);
      acc += c * x;
    }
    return acc;
  }

  void pushHistory(const float* in, size_t have) {
    if (hist.empty() || !have) return;
    if (have >= hist.size()) {
      std::memcpy(hist.data(), in + have - hist.size(), hist.size() * sizeof(float));
      return;
    }
    const size_t keep = hist.size() - have;
    if (keep) std::memmove(hist.data(), hist.data() + have, keep * sizeof(float));
    std::memcpy(hist.data() + keep, in, have * sizeof(float));
  }


  static int16_t clamp16(float v) {
    if (std::isnan(v) || std::isinf(v)) return 0;
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
  AudioUnit inAU = nullptr;
  AudioUnit outAU = nullptr;
#endif
  double inRate = 48000.0;
  double outRate = 48000.0;
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
  std::vector<float> carry;        // the surplus of the last expanded frame, for the next callback
  std::vector<int16_t> tail;       // the partial 20 ms frame Write() is still assembling
  double downPos = 0.0;            // resampler state carried across callbacks
  float downLast = 0.0f;
  size_t have = 0;                 // 8 kHz samples held in pcm, carried across callbacks
  size_t consumed = 0;             // of those, how many were already assembled into frames
  size_t carryLen = 0;             // valid floats at the front of carry
  size_t tailLen = 0;              // valid samples at the front of tail
  // Device samples one 20 ms frame expands to: kFrame * deviceRate / kRate — 960 at 48 kHz, 882 at
  // 44.1 kHz. Computed once in Open() because the render callback must not derive or allocate it.
  size_t expand = kFrame;

  void allocate() {
    inScratch.assign(4096, 0.0f);
    pcm.assign(4096, 0);
    upScratch.assign(4096, 0.0f);
    carry.assign(4096, 0.0f);
    frame.assign(kFrame, 0);
    outScratch.assign(kFrame, 0);
    tail.assign(kFrame, 0);
  }
};

// ---- speaker frame assembly ---------------------------------------------------------------------
// Split out of Write() so the framing can be exercised on a host build (test/native/dsp) instead of
// only on a Mac with a real audio device. Write() calls this; nothing else does.
//
// Accepts any number of samples and queues whole 20 ms frames, holding a partial tail until the next
// call completes it — so the ring only ever contains exactly one frame per slot, which is what lets
// the render callback treat "a frame" and "20 ms" as the same thing.
//
// The tail is per-unit. It used to be a function-level `static`, which was shared by every open
// handle, and it was `assign(kFrame, 0)`-zeroed on every call while `tailLen` persisted: that
// destroyed the samples it was holding and then wrote new ones at offset tailLen, pushing a frame
// whose first tailLen samples were silence. Any write whose length was not a multiple of 160
// therefore injected up to 159 zeros into the far-end audio — a click on every write.
inline size_t queueFrames(Unit* unit, const int16_t* data, size_t samples) {
  if (!unit || !data || samples == 0) return 0;
  int16_t* tail = unit->tail.data();
  size_t offset = 0;
  size_t queued = 0;
  if (unit->tailLen) {
    const size_t take = std::min(static_cast<size_t>(kFrame) - unit->tailLen, samples);
    std::memcpy(tail + unit->tailLen, data, take * sizeof(int16_t));
    unit->tailLen += take;
    offset += take;
    if (unit->tailLen == static_cast<size_t>(kFrame)) { unit->outRing.push(tail); unit->tailLen = 0; queued++; }
  }
  while (samples - offset >= static_cast<size_t>(kFrame)) {
    unit->outRing.push(data + offset);
    offset += static_cast<size_t>(kFrame);
    queued++;
  }
  if (offset < samples) {
    unit->tailLen = samples - offset;
    std::memcpy(tail, data + offset, unit->tailLen * sizeof(int16_t));
  }
  return queued;
}

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
