// One check of the DSP harness. See harness.cpp for what is real and what is stubbed, and
// dsp_support.h for the shared measurement helpers.
#include "dsp_support.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

void testDeviceSelection() {
  std::printf("\n=== VAL-AUDIO-008: pickDevice / fallbackDevice against a seeded device table ===\n");
  g_stubDevices.clear();
  StubDevice mic;   mic.id = 10;   mic.uid = "uid-mic";   mic.name = "Studio Microphone";
  mic.hasInput = true;  mic.hasOutput = false; mic.rate = 48000.0;
  StubDevice spk;   spk.id = 11;   spk.uid = "uid-spk";   spk.name = "External Speakers";
  spk.hasInput = false; spk.hasOutput = true;  spk.rate = 48000.0;
  StubDevice head;  head.id = 12;  head.uid = "uid-head";  head.name = "USB Headset";
  head.hasInput = true;  head.hasOutput = true;  head.rate = 44100.0;
  g_stubDevices = {mic, spk, head};
  g_stubDefaultInput = 10;
  g_stubDefaultOutput = 11;

  const auto ids = pulse::detail::devices();
  std::printf("  enumerated devices : %zu\n", ids.size());
  check(ids.size() == 3, "all three seeded devices are enumerated");

  const AudioDeviceID byUid = pulse::detail::pickDevice("uid-head", true);
  std::printf("  pickDevice(uid)    : %u (want 12)\n", byUid);
  check(byUid == 12, "an exact UID resolves to that device");

  const AudioDeviceID byName = pulse::detail::pickDevice("Studio", true);
  std::printf("  pickDevice(name)   : %u (want 10)\n", byName);
  check(byName == 10, "a name substring resolves to that device");

  const AudioDeviceID empty = pulse::detail::pickDevice("", true);
  std::printf("  pickDevice(empty)  : %u (want 0 = unknown)\n", empty);
  check(empty == kAudioObjectUnknown, "an empty preference resolves to unknown, not to a guess");

  // A speaker-only device offered as the input must be rejected, or the mic opens on hardware that
  // has no microphone and every call is silent in one direction.
  const AudioDeviceID wrongScope = pulse::detail::pickDevice("External", true);
  std::printf("  speaker-only as in : %u (want 0 = unknown)\n", wrongScope);
  check(wrongScope == kAudioObjectUnknown, "a speaker-only device is rejected for the input scope");

  const AudioDeviceID asOutput = pulse::detail::pickDevice("External", false);
  std::printf("  same device as out : %u (want 11)\n", asOutput);
  check(asOutput == 11, "and accepted for the output scope");

  const AudioDeviceID fbIn = pulse::detail::fallbackDevice(kAudioHardwarePropertyDefaultInputDevice);
  const AudioDeviceID fbOut = pulse::detail::fallbackDevice(kAudioHardwarePropertyDefaultOutputDevice);
  std::printf("  system defaults    : input=%u output=%u (want 10, 11)\n", fbIn, fbOut);
  check(fbIn == 10 && fbOut == 11, "the system default devices are read for each role separately");

  std::printf("  uidOf/nameOf/rateOf: \"%s\" / \"%s\" / %.1f\n",
              pulse::detail::uidOf(10).c_str(), pulse::detail::nameOf(10).c_str(),
              pulse::detail::rateOf(12));
  check(pulse::detail::uidOf(10) == "uid-mic" && pulse::detail::nameOf(10) == "Studio Microphone",
        "UID and name are read back correctly through CFString");
  check(std::fabs(pulse::detail::rateOf(12) - 44100.0) < 0.5,
        "the nominal sample rate is read per device (44100 for the headset)");

  const bool inOk = pulse::detail::hasStreams(10, kAudioDevicePropertyScopeInput);
  const bool outOk = pulse::detail::hasStreams(11, kAudioDevicePropertyScopeOutput);
  const bool badOk = pulse::detail::hasStreams(11, kAudioDevicePropertyScopeInput);
  std::printf("  hasStreams         : mic/in=%d spk/out=%d spk/in=%d\n", inOk, outOk, badOk);
  check(inOk && outOk && !badOk, "hasStreams honours the scope it is given");
}
