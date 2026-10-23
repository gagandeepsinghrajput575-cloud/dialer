// One check of the DSP harness. See harness.cpp for what is real and what is stubbed, and
// dsp_support.h for the shared measurement helpers.
#include "dsp_support.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

void testLegacyNegativeControls() {
  std::printf("\n=== NEGATIVE CONTROL: the same measurements against HEAD's arithmetic ===\n");
  const double devRate = 48000.0;
  const double hz = 440.0;
  const UInt32 cbFrames = 480;
  const size_t callbacks = 200;
  pulse::g_deviceRate = devRate;

  // --- microphone path, pre-fix ---
  legacy::Unit lu;
  lu.allocate();
  lu.au = fakeUnit();
  lu.tsfnReady = true;
  lu.running = true;
  g_renderSource = sineF(cbFrames * callbacks, hz, devRate, 0.5);
  g_renderPos = 0;
  g_renderStatus = noErr;
  Napi::g_capturedFrames.clear();
  Napi::g_captureLen = pulse::kFrame;
  for (size_t c = 0; c < callbacks; c++) {
    AudioUnitRenderActionFlags flags = 0;
    AudioTimeStamp ts{};
    legacy::inputProc(&lu, &flags, &ts, 1, cbFrames, nullptr);
  }
  std::vector<int16_t> mic;
  for (const auto& f : Napi::g_capturedFrames) mic.insert(mic.end(), f.begin(), f.end());
  const double deviceSamples = static_cast<double>(cbFrames) * callbacks;
  const double legacyRatio = static_cast<double>(mic.size()) / deviceSamples;
  const double legacyPitch = measureHz(mic, static_cast<double>(pulse::kRate));
  const int16_t legacyStep = maxDelta(mic);
  std::printf("  PRE-FIX mic: %zu samples from %.0f device samples (ratio %.4f; the fixed code\n"
              "               gives %.4f and the correct ratio is %.4f)\n",
              mic.size(), deviceSamples, legacyRatio,
              static_cast<double>(pulse::kRate) / devRate, static_cast<double>(pulse::kRate) / devRate);
  std::printf("  PRE-FIX mic: pitch %.2f Hz, max sample step %d, inRing depth left %zu\n",
              legacyPitch, static_cast<int>(legacyStep), lu.inRing.head.load() - lu.inRing.tail.load());
  // The decisive failure: n outputs were demanded from n inputs, so six times too many samples came
  // out, and the negative `downPos` cast to size_t collapsed every callback after the first to DC.
  check(legacyRatio > 0.5, "pre-fix downsample ratio is grossly wrong (would FAIL the 2% check)");
  check(legacyPitch < hz - 3.0 || legacyPitch > hz + 3.0 || legacyStep >= 12000,
        "pre-fix microphone output is measurably corrupt (would FAIL the pitch/continuity checks)");

  // --- speaker path, pre-fix ---
  legacy::Unit lu2;
  lu2.allocate();
  lu2.au = fakeUnit();
  const size_t frames = 3;
  for (size_t f = 0; f < frames; f++) {
    int16_t buf[pulse::kFrame];
    for (int i = 0; i < pulse::kFrame; i++) {
      const double t = static_cast<double>(f * pulse::kFrame + i) / pulse::kRate;
      buf[i] = static_cast<int16_t>(16000.0 * std::sin(2.0 * M_PI * hz * t));
    }
    lu2.outRing.push(buf);
  }
  size_t legacyNonSilent = 0;
  for (size_t c = 0; c < 5; c++) {
    std::vector<float> buf(960, 0.0f);
    AudioBufferList abl{};
    abl.mNumberBuffers = 1;
    abl.mBuffers[0].mNumberChannels = 1;
    abl.mBuffers[0].mDataByteSize = 960 * sizeof(float);
    abl.mBuffers[0].mData = buf.data();
    AudioUnitRenderActionFlags flags = 0;
    AudioTimeStamp ts{};
    legacy::renderProc(&lu2, &flags, &ts, 0, 960, &abl);
    double peak = 0.0;
    for (float v : buf) peak = std::max(peak, std::fabs(static_cast<double>(v)));
    if (peak > 1e-4) legacyNonSilent++;
  }
  std::printf("  PRE-FIX speaker: %zu non-silent callbacks of 5 for %zu queued frames (the fixed\n"
              "               code gives %zu — one frame per 20 ms callback)\n",
              legacyNonSilent, frames, frames);
  // One 960-sample callback capped each frame at kFrame=160 device samples, so it popped six frames
  // and drained the whole queue in a single callback: the far end played about six times too fast.
  check(legacyNonSilent < frames,
        "pre-fix speaker path drains the queue too fast (would FAIL the one-frame-per-callback check)");
}
