// Shared declarations for the DSP harness checks. See harness.cpp for what the harness is, what is
// real and what is stubbed. Build and run: bash test/native/dsp/run.sh
#ifndef PULSE_DSP_SUPPORT_H_
#define PULSE_DSP_SUPPORT_H_

// Host DSP harness: measures the REAL CoreAudio callbacks instead of trusting that they compile.
//
// Every defect this harness targets produces audio that is merely WRONG — never an exception. A test
// that only asserts "did not crash" passes on all of them. So the checks here measure: frequency,
// sample counts, ring frames consumed, and sample-for-sample equality against the input.
//
// What is real: pulse::detail::inputProc, pulse::detail::renderProc, pulse::detail::pickDevice,
// hasStreams, uidOf, nameOf, rateOf, fallbackDevice, devices, pulse::Ring, pulse::Resampler and
// pulse::queueFrames — all compiled from product source, unmodified, against the stubs in ./stubs.
// What is stubbed: device enumeration, property reads, AudioUnitRender, and the N-API boundary.
//
#include "pulse_audio.h"
#include "legacy_impl.h"

#include <cstddef>
#include <string>
#include <vector>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

// The Napi stub intercepts the ThreadSafeFunction, which is the only route microphone frames take to
// JavaScript. Its capture length must be one product frame.
// Defined once, in harness.cpp: the stub in ./stubs/napi.h declares them extern and writes every
// microphone frame the real inputProc hands to JavaScript into g_capturedFrames.
namespace Napi {
extern std::vector<std::vector<int16_t>> g_capturedFrames;
extern size_t g_captureLen;
}  // namespace Napi

static_assert(pulse::kFrame == 160,
              "the Napi stub captures 160 samples per frame; pulse::kFrame must agree");


// The pass/fail counters live in dsp_support.cpp so every check reports into one total.
extern int g_checks;
extern int g_failed;
void ok(const std::string& m);
void bad(const std::string& m);
void check(bool cond, const std::string& m);

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

// Positive-going zero crossings. For a clean sine this is accurate to within one cycle over the
// window and, unlike an FFT, makes no windowing assumption — which matters because the failure mode
// being hunted is a phase discontinuity, and an FFT would smear that into the same peak.
template <typename T>
inline double measureHz(const std::vector<T>& x, double rate) {
  if (x.size() < 8) return 0.0;
  size_t crossings = 0;
  size_t first = 0, last = 0;
  for (size_t i = 1; i < x.size(); i++) {
    const bool prevNeg = static_cast<double>(x[i - 1]) < 0.0;
    const bool nowNonNeg = static_cast<double>(x[i]) >= 0.0;
    if (prevNeg && nowNonNeg) {
      if (!crossings) first = i;
      last = i;
      crossings++;
    }
  }
  if (crossings < 2 || last <= first) return 0.0;
  return static_cast<double>(crossings - 1) * rate / static_cast<double>(last - first);
}

template <typename T>
inline T maxDelta(const std::vector<T>& x) {
  T m = 0;
  for (size_t i = 1; i < x.size(); i++) {
    const double d = std::fabs(static_cast<double>(x[i]) - static_cast<double>(x[i - 1]));
    if (d > static_cast<double>(m)) m = static_cast<T>(d);
  }
  return m;
}

inline size_t longestZeroRun(const std::vector<int16_t>& x) {
  size_t best = 0, run = 0;
  for (auto v : x) { if (v == 0) { run++; if (run > best) best = run; } else run = 0; }
  return best;
}

inline std::vector<float> sineF(size_t n, double hz, double rate, double amp) {
  std::vector<float> v(n);
  for (size_t i = 0; i < n; i++) v[i] = static_cast<float>(amp * std::sin(2.0 * M_PI * hz * i / rate));
  return v;
}

// Single-bin power by Goertzel. Exact for a bin-centred tone (choose a window whose length holds a
// whole number of cycles), which is the point: an FFT would smear an image next to the fundamental,
// and the defect being measured IS a pair of tones that sit far apart (f and fs_in - f).
inline double powerAt(const std::vector<float>& x, double hz, double rate) {
  if (x.size() < 8) return 0.0;
  const double w = 2.0 * M_PI * hz / rate;
  const double c = 2.0 * std::cos(w);
  double s1 = 0.0, s2 = 0.0;
  for (double v : x) { const double s0 = v + c * s1 - s2; s2 = s1; s1 = s0; }
  const double n = static_cast<double>(x.size());
  // A real tone at bin centre has |X_k| = A*N/2, so 2|X|^2/N^2 is its mean square, A^2/2.
  return 2.0 * (s1 * s1 + s2 * s2 - c * s1 * s2) / (n * n);
}

inline double powerAt(const std::vector<int16_t>& x, double hz, double rate) {
  std::vector<float> f(x.size());
  for (size_t i = 0; i < x.size(); i++) f[i] = static_cast<float>(x[i]) / 32768.0f;
  return powerAt(f, hz, rate);
}

// Power ratio in dB. Positive means the numerator is louder.
inline double dbRatio(double num, double den) { return 10.0 * std::log10(num / den + 1e-30); }

inline AudioUnit fakeUnit() { return reinterpret_cast<AudioUnit>(static_cast<uintptr_t>(0x1)); }

inline void resetUnit(pulse::Unit& u) {
  u.allocate();
  u.au = fakeUnit();
  u.tsfnReady = true;   // so inputProc hands assembled frames to the intercepted ThreadSafeFunction
  u.running = true;
  u.have = 0; u.consumed = 0; u.carryLen = 0; u.tailLen = 0;
  u.downPos = 0.0; u.downLast = 0.0f;
  u.outRing.reset();
}

inline OSStatus callInput(pulse::Unit& u, UInt32 frames) {
  AudioUnitRenderActionFlags flags = 0;
  AudioTimeStamp ts{};
  return pulse::detail::inputProc(&u, &flags, &ts, 1, frames, nullptr);
}

inline void callRender(pulse::Unit& u, UInt32 frames, float* dst) {
  AudioUnitRenderActionFlags flags = 0;
  AudioTimeStamp ts{};
  AudioBufferList abl{};
  abl.mNumberBuffers = 1;
  abl.mBuffers[0].mNumberChannels = 1;
  abl.mBuffers[0].mDataByteSize = frames * sizeof(float);
  abl.mBuffers[0].mData = dst;
  pulse::detail::renderProc(&u, &flags, &ts, 0, frames, &abl);
}

// ---------------------------------------------------------------------------
// VAL-AUDIO-003 — the microphone path: device rate -> 8 kHz
// ---------------------------------------------------------------------------

// One translation unit per check, so no file outgrows the 350-line ceiling for new files.
void testMicPath();                 // VAL-AUDIO-003
void testSpeakerPath();             // VAL-AUDIO-004
void testWriteFraming();            // VAL-AUDIO-005
void testDeviceSelection();         // VAL-AUDIO-008
void testResamplerSpectrum();       // VAL-AUDIO-009
void testLegacyNegativeControls();  // proves the measurements above are not vacuous

#endif  // PULSE_DSP_SUPPORT_H_
