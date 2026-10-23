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

  // Three frames of a known 8 kHz sine: 480 samples = 60 ms = 2880 device samples of content.
  const size_t frames = 3;
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
  // callback, so three callbacks carry all the content and the fourth underruns into silence.
  std::vector<float> out;
  size_t nonSilentCallbacks = 0;
  for (size_t c = 0; c < 5; c++) {
    std::vector<float> buf(u.expand, 0.0f);
    callRender(u, static_cast<UInt32>(u.expand), buf.data());
    double peak = 0.0;
    for (float v : buf) peak = std::max(peak, std::fabs(static_cast<double>(v)));
    if (peak > 1e-4) nonSilentCallbacks++;
    out.insert(out.end(), buf.begin(), buf.end());
    std::printf("  callback %zu: peak=%.4f %s\n", c + 1, peak, peak > 1e-4 ? "(audio)" : "(silence)");
  }
  std::printf("  non-silent callbacks: %zu of 5 (3 frames queued)\n", nonSilentCallbacks);
  // The old loop capped each frame's expansion at kFrame, so one 960-sample callback popped SIX
  // frames: the whole queue drained in a single callback and the far end played about six times
  // too fast.
  check(nonSilentCallbacks == frames, "one ring frame is consumed per 20 ms callback");

  const std::vector<float> content(out.begin(), out.begin() + frames * u.expand);
  const double measured = measureHz(content, devRate);
  std::printf("  measured pitch     : %.2f Hz at %.0f Hz device rate\n", measured, devRate);
  check(std::fabs(measured - hz) < 5.0, "speaker pitch preserved within 5 Hz");

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
  for (size_t c = 0; c < 8; c++) {
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
  const double pitch2 = measureHz(out2, devRate);
  std::printf("  measured pitch     : %.2f Hz across the carried surplus\n", pitch2);
  check(std::fabs(pitch2 - hz) < 5.0, "pitch survives the carry");
}
