// NEGATIVE CONTROL. This is the PRE-FIX arithmetic, reconstructed verbatim from
// `git show HEAD:desktop/native/src/coreaudio_impl.mm` and `git show HEAD:desktop/native/src/pulse_audio.h`,
// renamed with a `legacy` prefix so it can be linked beside the fixed product code.
//
// It is NOT product code and must never be called from it. Its only job is to prove the DSP harness
// actually detects the defects it claims to: a measurement harness that reports the same numbers for
// the broken and the fixed code proves nothing, and VAL-AUDIO-003/004 are only meaningful if these
// legacy paths fail them.
//
// The three defects reproduced here, exactly as HEAD had them:
//   * LegacyResampler::down took a `want` count and wrapped `pos` modulo `have`. Called as
//     down(in, n, pcm, n) — n outputs from n inputs at step 6 — it replayed the same device buffer
//     about six times, and the caller's `downPos = pos - n` went negative and was then cast to
//     size_t on the next callback (undefined behaviour; here it collapses the output to DC).
//   * legacy_inputProc asked for `n` outputs, stored `have = n`, and pushed every frame to an
//     inRing nothing ever popped.
//   * legacy_renderProc capped each ring frame's expansion at kFrame instead of the device-rate
//     expansion, so one callback popped six frames.
#include "pulse_host_coreaudio.h"
#include "pulse_audio.h"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "legacy_impl.h"

namespace legacy {

static void deliverFrame(Napi::Env env, Napi::Function jsCallback, int16_t* data) {
  if (env == nullptr || jsCallback == nullptr || data == nullptr) return;
  Napi::HandleScope scope(env);
  jsCallback.Call({Napi::Buffer<int16_t>::Copy(env, data, pulse::kFrame)});
}

// Verbatim from HEAD's coreaudio_impl.mm inputProc.
OSStatus inputProc(void* userData, AudioUnitRenderActionFlags* flags, const AudioTimeStamp* time,
                   UInt32 bus, UInt32 frames, AudioBufferList* io) {
  (void)flags; (void)time; (void)bus; (void)io;
  auto* unit = static_cast<Unit*>(userData);
  if (!unit || !unit->au || frames == 0 || frames > unit->inScratch.size()) return noErr;

  AudioBufferList abl;
  abl.mNumberBuffers = 1;
  abl.mBuffers[0].mNumberChannels = 1;
  abl.mBuffers[0].mDataByteSize = static_cast<UInt32>(frames * sizeof(Float32));
  abl.mBuffers[0].mData = unit->inScratch.data();
  if (AudioUnitRender(unit->au, flags, time, 1, frames, &abl) != noErr) return noErr;

  const float* in = static_cast<const float*>(abl.mBuffers[0].mData);
  const size_t n = static_cast<size_t>(frames);

  unit->down.step = pulse::g_deviceRate / static_cast<double>(pulse::kRate);
  unit->down.pos = unit->downPos;
  unit->down.last = unit->downLast;
  unit->down.down(in, n, unit->pcm.data(), n);
  unit->downPos = unit->down.pos - static_cast<double>(n);
  unit->downLast = unit->down.last;
  unit->have = n;
  unit->consumed = 0;

  while (unit->have - unit->consumed >= static_cast<size_t>(pulse::kFrame)) {
    std::memcpy(unit->frame.data(), unit->pcm.data() + unit->consumed, sizeof(int16_t) * pulse::kFrame);
    unit->consumed += static_cast<size_t>(pulse::kFrame);
    unit->inRing.push(unit->frame.data());
    if (!unit->tsfnReady || !unit->running) continue;
    int16_t* copy = static_cast<int16_t*>(std::malloc(sizeof(int16_t) * pulse::kFrame));
    if (!copy) continue;
    std::memcpy(copy, unit->frame.data(), sizeof(int16_t) * pulse::kFrame);
    unit->tsfn.NonBlockingCall(copy, [](Napi::Env env, Napi::Function js, int16_t* data) {
      deliverFrame(env, js, data);
      std::free(data);
    });
  }
  return noErr;
}

// Verbatim from HEAD's coreaudio_impl.mm renderProc.
OSStatus renderProc(void* userData, AudioUnitRenderActionFlags* flags, const AudioTimeStamp* time,
                    UInt32 bus, UInt32 frames, AudioBufferList* io) {
  (void)flags; (void)time; (void)bus;
  auto* unit = static_cast<Unit*>(userData);
  if (!unit || !io || io->mNumberBuffers == 0 || frames == 0) return noErr;
  float* out = static_cast<float*>(io->mBuffers[0].mData);
  if (!out) return noErr;

  size_t written = 0;
  while (written < frames) {
    const size_t want = std::min(static_cast<size_t>(pulse::kFrame), static_cast<size_t>(frames) - written);
    if (unit->outRing.pop(unit->outScratch.data())) {
      unit->up.step = static_cast<double>(pulse::kRate) / pulse::g_deviceRate;
      unit->up.pos = 0.0;
      unit->up.up(unit->outScratch.data(), pulse::kFrame, unit->upScratch.data(), want);
      std::memcpy(out + written, unit->upScratch.data(), want * sizeof(float));
    } else {
      std::memset(out + written, 0, want * sizeof(float));
    }
    written += want;
  }
  return noErr;
}

}  // namespace legacy
