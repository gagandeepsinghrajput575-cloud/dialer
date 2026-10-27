// One check of the DSP harness. See harness.cpp for what is real and what is stubbed, and
// dsp_support.h for the shared measurement helpers.
#include "dsp_support.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

void testSpeakerPath() {
  std::printf("\n=== VAL-AUDIO-004: renderProc, 8 kHz SIP -> 48 kHz device ===\n");
  const double devRate = 48000.0;
  const double hz = 440.0;
  pulse::g_deviceRate = devRate;

  pulse::Unit u; resetUnit(u);
  // Exactly what Open() computes: one 20 ms frame expands to 160 * deviceRate / 8000 device samples.
  u.expand = static_cast<size_t>(pulse::kFrame * devRate / pulse::kRate);
  std::printf("  expand             : %zu device samples per 20 ms frame\n", u.expand);
  check(u.expand == 960, "expansion factor is 960 at 48 kHz (not kFrame=160)");

  // Eight frames of a known 8 kHz sine: 1280 samples = 160 ms = 7680 device samples of content. The
  // first frames are a warm-up (the band-limited resampler is causal, so its first (taps-1)/2 input
  // samples are silence), and pitch is measured after that — see the delay check below.
  const size_t frames = 8;
  std::vector<int16_t> src;
  for (size_t f = 0; f < frames; f++) {
    int16_t buf[pulse::kFrame];
    for (int i = 0; i < pulse::kFrame; i++) {
      const double t = static_cast<double>(f * pulse::kFrame + i) / pulse::kRate;
      buf[i] = static_cast<int16_t>(16000.0 * std::sin(2.0 * M_PI * hz * t));
    }
    u.outRing.push(buf);
    src.insert(src.end(), buf, buf + pulse::kFrame);
  }

  // Drain with 960-sample callbacks (20 ms at 48 kHz). Correct behaviour: one ring frame per
  // callback, so `frames` callbacks carry all the content and the rest underrun into silence.
  std::vector<float> out;
  size_t nonSilentCallbacks = 0;
  for (size_t c = 0; c < frames + 3; c++) {
    std::vector<float> buf(u.expand, 0.0f);
    callRender(u, static_cast<UInt32>(u.expand), buf.data());
    double peak = 0.0;
    for (float v : buf) peak = std::max(peak, std::fabs(static_cast<double>(v)));
    if (peak > 1e-4) nonSilentCallbacks++;
    out.insert(out.end(), buf.begin(), buf.end());
    std::printf("  callback %zu: peak=%.4f %s\n", c + 1, peak, peak > 1e-4 ? "(audio)" : "(silence)");
  }
  std::printf("  non-silent callbacks: %zu of %zu (%zu frames queued)\n", nonSilentCallbacks,
              frames + 3, frames);
  // The old loop capped each frame's expansion at kFrame, so one 960-sample callback popped SIX
  // frames: the whole queue drained in a single callback and the far end played about six times
  // too fast.
  check(nonSilentCallbacks == frames, "one ring frame is consumed per 20 ms callback");

  // Skip two frames: the first (taps-1)/2 input samples are the filter's warm-up.
  const std::vector<float> content(out.begin() + 2 * u.expand, out.begin() + frames * u.expand);
  const double measured = measureHz(content, devRate);
  std::printf("  measured pitch     : %.2f Hz at %.0f Hz device rate (measured after warm-up)\n",
              measured, devRate);
  check(std::fabs(measured - hz) < 5.0, "speaker pitch preserved within 5 Hz");

  // The band-limited kernel is linear-phase and causal: the output must be delayed by exactly
  // (taps-1)/2 input samples. This asserts the latency is the documented one, not an accident.
  {
    const double expectedDelay = (u.up.taps - 1) / 2.0;   // in 8 kHz samples
    double bestErr = 1e9;
    long bestLag = 0;
    for (long lag = 0; lag <= 240; lag++) {               // device samples
      double err = 0.0;
      for (size_t i = 960; i + 480 < out.size(); i += 7) {
        const double want = 16000.0 / 32768.0 *
            std::sin(2.0 * M_PI * hz * (static_cast<double>(i - lag) / devRate));
        err += std::fabs(out[i] - want);
      }
      if (err < bestErr) { bestErr = err; bestLag = lag; }
    }
    const double wantLag = expectedDelay * devRate / pulse::kRate;
    std::printf("  measured delay     : %ld device samples (want %.1f, taps=%d)\n", bestLag,
                wantLag, u.up.taps);
    check(std::fabs(static_cast<double>(bestLag) - wantLag) <= 2.0,
          "speaker output is delayed by the documented (taps-1)/2 group delay");
  }

  size_t zeros = 0;
  for (float v : content) if (std::fabs(v) < 1e-6) zeros++;
  std::printf("  silent samples in content: %zu of %zu\n", zeros, content.size());
  check(zeros < content.size() / 100, "no silence gaps interleaved into the content");

  // Awkward callback size: 500 device samples against a 960-sample expansion. The surplus must be
  // carried to the next callback, not dropped and not re-expanded from pos 0.
  pulse::Unit u2; resetUnit(u2);
  u2.expand = 960;
  for (size_t f = 0; f < frames; f++) {
    int16_t buf[pulse::kFrame];
    std::memcpy(buf, src.data() + f * pulse::kFrame, sizeof(buf));
    u2.outRing.push(buf);
  }
  std::vector<float> out2;
  for (size_t c = 0; c < 20; c++) {
    std::vector<float> buf(500, 0.0f);
    callRender(u2, 500, buf.data());
    out2.insert(out2.end(), buf.begin(), buf.end());
  }
  size_t nonSilent = 0;
  for (float v : out2) if (std::fabs(v) > 1e-4) nonSilent++;
  std::printf("  awkward 500-sample callbacks: %zu non-silent of %zu (content is %zu)\n",
              nonSilent, out2.size(), frames * u2.expand);
  check(nonSilent >= frames * u2.expand - 960,
        "surplus is carried across awkward callback sizes, not dropped");
  const std::vector<float> steady2(out2.begin() + 1500, out2.begin() + frames * u2.expand);
  const double pitch2 = measureHz(steady2, devRate);
  std::printf("  measured pitch     : %.2f Hz across the carried surplus\n", pitch2);
  check(std::fabs(pitch2 - hz) < 5.0, "pitch survives the carry");
}
