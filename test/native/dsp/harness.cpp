// Host DSP harness entry point: measures the REAL CoreAudio callbacks instead of trusting that they
// compile.
//
// Every defect this harness targets produces audio that is merely WRONG — never an exception. A test
// that only asserts "did not crash" passes on all of them. So the checks measure: frequency, sample
// counts, ring frames consumed, and sample-for-sample equality against the input.
//
// What is real: pulse::detail::inputProc, pulse::detail::renderProc, pulse::detail::pickDevice,
// hasStreams, uidOf, nameOf, rateOf, fallbackDevice, devices, pulse::Ring, pulse::Resampler and
// pulse::queueFrames — all compiled from product source, unmodified, against the stubs in ./stubs.
// What is stubbed: device enumeration, property reads, AudioUnitRender, and the N-API boundary.
//
// The checks are one translation unit each (check_mic / check_speaker / check_framing / check_devices
// / check_legacy) so no file outgrows the 350-line ceiling for new files; dsp_support.h holds the
// shared measurement helpers and dsp_support.cpp the counters they all report into.
//
// Build and run: bash test/native/dsp/run.sh
#include "dsp_support.h"

#include <cstddef>
#include <cstdio>
#include <vector>

// The Napi stub intercepts the ThreadSafeFunction, which is the only route microphone frames take to
// JavaScript. Its capture length must be one product frame.
namespace Napi {
std::vector<std::vector<int16_t>> g_capturedFrames;
size_t g_captureLen = 160;
}  // namespace Napi

static_assert(pulse::kFrame == 160,
              "the Napi stub captures 160 samples per frame; pulse::kFrame must agree");

int main() {
  std::printf("--- Pulse CoreAudio DSP harness (real callbacks, stubbed device layer) ---\n");
  std::printf("product code under test: detail::inputProc, detail::renderProc, detail::pickDevice,\n"
              "  hasStreams, uidOf, nameOf, rateOf, fallbackDevice, devices, Ring, Resampler,\n"
              "  queueFrames\n");
  testMicPath();
  testSpeakerPath();
  testWriteFraming();
  testDeviceSelection();
  testLegacyNegativeControls();
  std::printf("\n%s %d/%d checks passed%s\n", g_failed ? "💥" : "🎉",
              g_checks - g_failed, g_checks, g_failed ? "" : " (all)");
  return g_failed ? 1 : 0;
}
