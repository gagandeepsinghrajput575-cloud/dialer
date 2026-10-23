// One check of the DSP harness. See harness.cpp for what is real and what is stubbed, and
// dsp_support.h for the shared measurement helpers.
#include "dsp_support.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

void testMicPath() {
  std::printf("\n=== VAL-AUDIO-003: inputProc, 48 kHz device -> 8 kHz SIP ===\n");
  const double devRate = 48000.0;
  const double hz = 440.0;
  const UInt32 cbFrames = 480;        // 10 ms at 48 kHz, a realistic callback size
  const size_t callbacks = 200;       // 2 s of audio
  pulse::g_deviceRate = devRate;

  pulse::Unit u; resetUnit(u);
  g_renderSource = sineF(cbFrames * callbacks, hz, devRate, 0.5);
  g_renderPos = 0;
  g_renderStatus = noErr;
  Napi::g_capturedFrames.clear();
  Napi::g_captureLen = pulse::kFrame;

  for (size_t c = 0; c < callbacks; c++) callInput(u, cbFrames);

  std::vector<int16_t> mic;
  for (const auto& f : Napi::g_capturedFrames) mic.insert(mic.end(), f.begin(), f.end());

  const double deviceSamples = static_cast<double>(cbFrames) * callbacks;   // 96000
  const double expected8k = deviceSamples * static_cast<double>(pulse::kRate) / devRate;  // 16000
  std::printf("  device samples fed : %.0f (%.0f callbacks x %u)\n", deviceSamples,
              static_cast<double>(callbacks), cbFrames);
  std::printf("  8 kHz samples out  : %zu in %zu frames\n", mic.size(), Napi::g_capturedFrames.size());
  std::printf("  expected 8 kHz out : %.0f (ratio 1:%.1f)\n", expected8k, devRate / pulse::kRate);

  // (a) The ratio is the decisive measurement. Asking the resampler for n outputs from n inputs at
  //     step 6 produced SIX times too many samples, which stretches the microphone about sixfold.
  const double ratio = static_cast<double>(mic.size()) / deviceSamples;
  const double wantRatio = static_cast<double>(pulse::kRate) / devRate;
  std::printf("  measured ratio     : %.5f  (want %.5f)\n", ratio, wantRatio);
  check(std::fabs(ratio - wantRatio) < wantRatio * 0.02,
        "downsample ratio is 8k/48k within 2% (not 1:1)");

  // (b) Pitch must survive the resample.
  const double measured = measureHz(mic, static_cast<double>(pulse::kRate));
  std::printf("  measured pitch     : %.2f Hz at 8 kHz (fed %.1f Hz)\n", measured, hz);
  check(std::fabs(measured - hz) < 3.0, "microphone pitch preserved within 3 Hz");

  // (c) Phase continuity. A 440 Hz sine at 8 kHz with this amplitude cannot step more than about
  //     5700 counts between adjacent samples; the old wrap-around replay jumped back to the start of
  //     the device buffer and broke that bound.
  const int16_t d = maxDelta(mic);
  std::printf("  max sample step    : %d (bound 12000)\n", static_cast<int>(d));
  check(d < 12000, "no phase discontinuity between callbacks");

  // (d) AudioUnitRender must be asked for bus 1 (the mic), not bus 0 (the speaker).
  std::printf("  AudioUnitRender bus: %u\n", g_renderBus);
  check(g_renderBus == 1, "microphone is pulled from bus 1");
}
