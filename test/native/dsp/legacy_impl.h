// NEGATIVE CONTROL — the PRE-FIX types. See legacy_impl.cpp for why this file exists and why it must
// never be included by product code.
#ifndef PULSE_DSP_LEGACY_IMPL_H_
#define PULSE_DSP_LEGACY_IMPL_H_

#include "pulse_host_coreaudio.h"
#include "pulse_audio.h"

#include <cstddef>
#include <vector>

namespace legacy {

// Verbatim from HEAD's pulse_audio.h.
struct Resampler {
  double step = 1.0;
  double pos = 0.0;
  float last = 0.0f;

  void down(const float* in, size_t have, int16_t* out, size_t want) {
    for (size_t i = 0; i < want; i++) {
      const size_t idx = static_cast<size_t>(pos);
      const float frac = static_cast<float>(pos - static_cast<double>(idx));
      const float a = idx < have ? in[idx] : last;
      const float b = (idx + 1) < have ? in[idx + 1] : a;
      out[i] = pulse::Resampler::clamp16(a + (b - a) * frac);
      pos += step;
      while (pos >= static_cast<double>(have) && have) pos -= static_cast<double>(have);
    }
    if (have) last = in[have - 1];
  }

  void configure(double from, double to) {
    step = (from > 0 && to > 0) ? from / to : 1.0;
    pos = 0.0;
    last = 0.0f;
  }
};

// HEAD's Unit, minus the fields the fix added and plus the inRing it deleted. `up` is unchanged by
// the fix, so the product's own Resampler is reused for it.
struct Unit {
  AudioUnit au = nullptr;
  pulse::Ring inRing;
  pulse::Ring outRing;
  Resampler down;
  pulse::Resampler up;
  Napi::ThreadSafeFunction tsfn;
  bool tsfnReady = false;
  bool running = false;
  std::vector<float> inScratch;
  std::vector<int16_t> pcm;
  std::vector<int16_t> frame;
  std::vector<int16_t> outScratch;
  std::vector<float> upScratch;
  double downPos = 0.0;
  float downLast = 0.0f;
  size_t have = 0;
  size_t consumed = 0;

  void allocate() {
    inScratch.assign(4096, 0.0f);
    pcm.assign(4096, 0);
    upScratch.assign(4096, 0.0f);
    frame.assign(pulse::kFrame, 0);
    outScratch.assign(pulse::kFrame, 0);
  }
};


OSStatus inputProc(void* userData, AudioUnitRenderActionFlags* flags, const AudioTimeStamp* time,
                   UInt32 bus, UInt32 frames, AudioBufferList* io);
OSStatus renderProc(void* userData, AudioUnitRenderActionFlags* flags, const AudioTimeStamp* time,
                    UInt32 bus, UInt32 frames, AudioBufferList* io);

}  // namespace legacy

#endif  // PULSE_DSP_LEGACY_IMPL_H_
