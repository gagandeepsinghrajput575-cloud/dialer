// VAL-AUDIO-009: spectral integrity of the two resamplers.
//
// The defect this file exists for is inaudible to every other check in the harness: linear
// interpolation is pitch-correct, ratio-correct, continuous, and still sounds metallic, because it
// leaves spectral images at (fs_in - f). A 3 kHz tone produces a 5 kHz image only 6.5 dB down — the
// "scratchy edge" heard live but never in the .wav, which is recorded before the resampler.
// The microphone direction has the mirror defect: no anti-alias filter, so 5 kHz folds to 3 kHz at
// roughly full amplitude.
#include "dsp_support.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace {

constexpr double kDev = 48000.0;

// 8 kHz Int16 tone, whole frames.
std::vector<int16_t> tone8k(double hz, double amp, size_t frames) {
  std::vector<int16_t> v(frames * pulse::kFrame);
  for (size_t i = 0; i < v.size(); i++) {
    const double t = static_cast<double>(i) / pulse::kRate;
    v[i] = static_cast<int16_t>(amp * std::sin(2.0 * M_PI * hz * t));
  }
  return v;
}

// Speaker direction through the REAL renderProc: push whole 20 ms frames, drain device-sized
// callbacks. Returns every device sample the callback wrote.
std::vector<float> renderThroughProduct(const std::vector<int16_t>& src, size_t frames,
                                        size_t expand, size_t callbacks) {
  pulse::Unit u;
  resetUnit(u);
  u.expand = expand;
  for (size_t f = 0; f < frames; f++) u.outRing.push(src.data() + f * pulse::kFrame);
  std::vector<float> out;
  for (size_t c = 0; c < callbacks; c++) {
    std::vector<float> buf(expand, 0.0f);
    callRender(u, static_cast<UInt32>(expand), buf.data());
    out.insert(out.end(), buf.begin(), buf.end());
  }
  return out;
}

// Microphone direction through the REAL inputProc.
std::vector<int16_t> captureThroughProduct(double hz, double amp, size_t cb, size_t callbacks) {
  pulse::Unit u;
  resetUnit(u);
  g_renderSource = sineF(cb * callbacks, hz, kDev, amp);
  g_renderPos = 0;
  g_renderStatus = noErr;
  Napi::g_capturedFrames.clear();
  Napi::g_captureLen = pulse::kFrame;
  for (size_t c = 0; c < callbacks; c++) callInput(u, static_cast<UInt32>(cb));
  std::vector<int16_t> mic;
  for (const auto& f : Napi::g_capturedFrames) mic.insert(mic.end(), f.begin(), f.end());
  return mic;
}

// The pre-fix implementation, copied from `git show HEAD:desktop/native/src/pulse_audio.h`.
// It is NOT product code; it is here so the thresholds below are shown to be non-vacuous.
struct LegacyLinear {
  double step = 1.0;
  double pos = 0.0;
  float last = 0.0f;

  void configure(double from, double to) {
    step = (from > 0 && to > 0) ? from / to : 1.0;
    pos = 0.0;
    last = 0.0f;
  }

  static int16_t clamp16(float v) {
    if (std::isnan(v) || std::isinf(v)) return 0;
    const float scaled = v * 32767.0f;
    if (scaled > 32767.0f) return 32767;
    if (scaled < -32768.0f) return -32768;
    return static_cast<int16_t>(scaled);
  }

  size_t down(const float* in, size_t have, int16_t* out, size_t cap) {
    size_t i = 0;
    const double limit = static_cast<double>(have);
    while (i < cap && pos < limit) {
      const double d = pos;
      const size_t idx = d < 0.0 ? 0 : static_cast<size_t>(d);
      const float a = d < 0.0 ? last : in[idx];
      const float b = (idx + 1) < have ? in[idx + 1] : a;
      const float frac = static_cast<float>(d - std::floor(d));
      out[i++] = clamp16(a + (b - a) * frac);
      pos += step;
    }
    if (have) last = in[have - 1];
    return i;
  }

  void up(const int16_t* in, size_t have, float* out, size_t want) {
    if (!have || !in || !out) return;
    const float lastSlope = have > 1
        ? (static_cast<float>(in[have - 1]) - static_cast<float>(in[have - 2])) / 32768.0f
        : 0.0f;
    for (size_t i = 0; i < want; i++) {
      const double d = pos;
      float a, b;
      if (d < 0.0) {
        a = last;
        b = static_cast<float>(in[0]) / 32768.0f;
      } else {
        const size_t idx = static_cast<size_t>(d);
        a = idx < have ? (static_cast<float>(in[idx]) / 32768.0f) : last;
        if (idx + 1 < have) {
          b = static_cast<float>(in[idx + 1]) / 32768.0f;
        } else if (idx < have) {
          b = a + lastSlope;
        } else {
          b = last;
        }
      }
      const float frac = static_cast<float>(d - std::floor(d));
      out[i] = a + (b - a) * frac;
      pos += step;
    }
    if (have) last = static_cast<float>(in[have - 1]) / 32768.0f;
  }
};

}  // namespace

// Direct-drive helpers for the class-level cases (44.1 kHz and the legacy negative control), so the
// same measurement can be run against either implementation without going through a Unit.
template <typename R>
std::vector<float> runUpDirect(R& r, const std::vector<int16_t>& src, size_t frames, size_t expand,
                               double toRate) {
  r.configure(static_cast<double>(pulse::kRate), toRate);
  std::vector<float> out;
  std::vector<float> buf(expand, 0.0f);
  for (size_t f = 0; f < frames; f++) {
    r.up(src.data() + f * pulse::kFrame, pulse::kFrame, buf.data(), expand);
    r.pos -= static_cast<double>(pulse::kFrame);
    out.insert(out.end(), buf.begin(), buf.end());
  }
  return out;
}

template <typename R>
std::vector<int16_t> runDownDirect(R& r, double hz, double amp, size_t cb, size_t callbacks) {
  r.configure(kDev, static_cast<double>(pulse::kRate));
  std::vector<int16_t> buf(cb);
  std::vector<int16_t> out;
  for (size_t c = 0; c < callbacks; c++) {
    std::vector<float> in(cb);
    for (size_t i = 0; i < cb; i++) {
      const double t = static_cast<double>(c * cb + i) / kDev;
      in[i] = static_cast<float>(amp * std::sin(2.0 * M_PI * hz * t));
    }
    const size_t got = r.down(in.data(), cb, buf.data(), cb);
    out.insert(out.end(), buf.begin(), buf.begin() + static_cast<long>(got));
    r.pos -= static_cast<double>(cb);
  }
  return out;
}

// Steady-state slice: skip the filter warm-up, then measure a whole number of cycles.
std::vector<float> steadyF(const std::vector<float>& v, size_t skip, size_t n) {
  return std::vector<float>(v.begin() + static_cast<long>(skip),
                            v.begin() + static_cast<long>(skip + n));
}
std::vector<int16_t> steadyI(const std::vector<int16_t>& v, size_t skip, size_t n) {
  return std::vector<int16_t>(v.begin() + static_cast<long>(skip),
                              v.begin() + static_cast<long>(skip + n));
}

void report(const char* what, double fundamental, double image, double wantDb) {
  std::printf("  %-18s: fundamental %6.1f dB, image %6.1f dB, rejection %6.1f dB (want <= %.0f)\n",
              what, 10.0 * std::log10(fundamental + 1e-30), 10.0 * std::log10(image + 1e-30),
              dbRatio(image, fundamental), wantDb);
}


void testResamplerSpectrum() {
  std::printf("\n=== VAL-AUDIO-009: resampler spectral integrity (images and aliases) ===\n");

  // (0) Calibrate the measurement itself before it is used to judge the product. A pure 1 kHz tone
  //     of amplitude 0.5 must measure 0.125 (A^2/2); otherwise every number below is meaningless.
  {
    const auto tone = sineF(4800, 1000.0, kDev, 0.5);
    const double p = powerAt(tone, 1000.0, kDev);
    std::printf("  %-18s: %.4f (want 0.1250)\n", "measurement check", p);
    check(std::fabs(dbRatio(p, 0.125)) < 0.1, "Goertzel measurement is calibrated to A^2/2");
  }

  // (a) Speaker 48 kHz: 6 frames of 3 kHz through the real renderProc; measure the last 4.
  {
    const size_t frames = 12, expand = 960, skip = 4 * 960, n = 4 * 960;
    const auto out = renderThroughProduct(tone8k(3000.0, 16000.0, frames), frames, expand, frames + 3);
    const auto content = steadyF(out, skip, n);
    const double pF = powerAt(content, 3000.0, kDev);
    const double pI = powerAt(content, 5000.0, kDev);
    report("3 kHz -> 5 kHz", pF, pI, -55.0);
    check(dbRatio(pI, pF) < -55.0, "speaker: 3 kHz image at 5 kHz is at least 55 dB down");
    const double ideal = std::pow(16000.0 / 32768.0, 2) / 2.0;
    std::printf("  %-18s: %+.2f dB vs ideal amplitude\n", "passband level", dbRatio(pF, ideal));
    check(std::fabs(dbRatio(pF, ideal)) < 1.5, "speaker: 3 kHz passband level within 1.5 dB");
  }

  // (b) The image the ear notices most: 1 kHz -> 7 kHz.
  {
    const size_t frames = 12, expand = 960, skip = 4 * 960, n = 4 * 960;
    const auto out = renderThroughProduct(tone8k(1000.0, 16000.0, frames), frames, expand, frames + 3);
    const auto content = steadyF(out, skip, n);
    const double pF = powerAt(content, 1000.0, kDev);
    const double pI = powerAt(content, 7000.0, kDev);
    report("1 kHz -> 7 kHz", pF, pI, -55.0);
    check(dbRatio(pI, pF) < -55.0, "speaker: 1 kHz image at 7 kHz is at least 55 dB down");
  }

  // (c) Microphone 48 kHz: a 5 kHz component (sibilance, room hiss) must not fold to 3 kHz.
  {
    const auto mic = captureThroughProduct(5000.0, 0.5, 480, 200);
    const auto content = steadyI(mic, 3200, 12800);   // 0.4 s warm-up, then 1.6 s
    const double pAlias = powerAt(content, 3000.0, pulse::kRate);
    const double reference = 0.5 * 0.5 / 2.0;         // power of a 0.5-amplitude tone
    std::printf("  %-18s: alias %6.1f dB, input %6.1f dB, rejection %6.1f dB (want <= -55)\n",
                "5 kHz -> 3 kHz", 10.0 * std::log10(pAlias + 1e-30),
                10.0 * std::log10(reference + 1e-30), dbRatio(pAlias, reference));
    check(dbRatio(pAlias, reference) < -55.0,
          "microphone: 5 kHz alias at 3 kHz is at least 55 dB down");
  }

  // (d) The microphone passband must survive its new anti-alias filter.
  {
    const auto mic = captureThroughProduct(1000.0, 0.5, 480, 200);
    const auto content = steadyI(mic, 3200, 12800);
    const double p = powerAt(content, 1000.0, pulse::kRate);
    const double ideal = 0.5 * 0.5 / 2.0;
    std::printf("  %-18s: %+.2f dB vs ideal amplitude\n", "passband 1 kHz", dbRatio(p, ideal));
    check(std::fabs(dbRatio(p, ideal)) < 1.5, "microphone: 1 kHz passband level within 1.5 dB");
  }

  // (e) 44.1 kHz devices take a different phase walk: 882 device samples per 20 ms frame.
  {
    const size_t frames = 12, expand = 882, skip = 4 * 882, n = 4 * 882;
    pulse::Resampler r;
    const auto out = runUpDirect(r, tone8k(3000.0, 16000.0, frames), frames, expand, 44100.0);
    const auto content = steadyF(out, skip, n);
    const double pF = powerAt(content, 3000.0, 44100.0);
    const double pI = powerAt(content, 5000.0, 44100.0);
    report("44.1k 3k -> 5k", pF, pI, -50.0);
    check(dbRatio(pI, pF) < -50.0, "speaker 44.1 kHz: 3 kHz image at 5 kHz is at least 50 dB down");
  }

  // (f) Negative control: the pre-fix linear resampler must FAIL these gates, proving they bite.
  {
    const size_t frames = 12, expand = 960, skip = 4 * 960, n = 4 * 960;
    LegacyLinear legacyUp;
    const auto out = runUpDirect(legacyUp, tone8k(3000.0, 16000.0, frames), frames, expand, kDev);
    const auto content = steadyF(out, skip, n);
    const double pF = powerAt(content, 3000.0, kDev);
    const double pI = powerAt(content, 5000.0, kDev);
    report("PRE-FIX 3k->5k", pF, pI, -55.0);
    check(dbRatio(pI, pF) > -20.0, "negative control: linear upsample leaves a loud 5 kHz image");

    LegacyLinear legacyDown;
    const auto mic = runDownDirect(legacyDown, 5000.0, 0.5, 480, 200);
    const auto contentI = steadyI(mic, 3200, 12800);
    const double pAlias = powerAt(contentI, 3000.0, pulse::kRate);
    const double reference = 0.5 * 0.5 / 2.0;
    std::printf("  %-18s: alias %6.1f dB, rejection %6.1f dB\n", "PRE-FIX 5k->3k",
                10.0 * std::log10(pAlias + 1e-30), dbRatio(pAlias, reference));
    check(dbRatio(pAlias, reference) > -10.0,
          "negative control: linear decimation folds 5 kHz to 3 kHz");
  }
}

