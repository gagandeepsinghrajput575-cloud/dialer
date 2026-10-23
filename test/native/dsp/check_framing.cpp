// One check of the DSP harness. See harness.cpp for what is real and what is stubbed, and
// dsp_support.h for the shared measurement helpers.
#include "dsp_support.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

// The pre-fix algorithm, copied verbatim from `git show HEAD:desktop/native/src/pulse_audio.mm`
// (Write()), as a negative control. It is NOT product code and is only here to be shown wrong.
// Two defects: `static` state shared by every open handle, and `assign(kFrame, 0)` zeroing the
// partial frame it was holding while tailLen persisted.
void oldQueueFrames(pulse::Unit* unit, const int16_t* data, size_t samples) {
  static std::vector<int16_t> tail(pulse::kFrame, 0);
  static size_t tailLen = 0;
  tail.assign(pulse::kFrame, 0);
  size_t offset = 0;
  if (tailLen) {
    const size_t take = std::min(static_cast<size_t>(pulse::kFrame) - tailLen, samples);
    std::memcpy(tail.data() + tailLen, data, take * sizeof(int16_t));
    tailLen += take;
    offset += take;
    if (tailLen == static_cast<size_t>(pulse::kFrame)) { unit->outRing.push(tail.data()); tailLen = 0; }
  }
  while (samples - offset >= static_cast<size_t>(pulse::kFrame)) {
    unit->outRing.push(data + offset);
    offset += static_cast<size_t>(pulse::kFrame);
  }
  if (offset < samples) {
    tailLen = samples - offset;
    std::memcpy(tail.data(), data + offset, tailLen * sizeof(int16_t));
  }
}

template <typename Fn>
std::vector<int16_t> framingRun(Fn queue, const size_t* chunks, size_t nChunks,
                                       const std::vector<int16_t>& input, size_t* tailLeft) {
  pulse::Unit u; resetUnit(u);
  size_t off = 0;
  for (size_t c = 0; c < nChunks; c++) {
    const size_t n = std::min(chunks[c], input.size() - off);
    queue(&u, input.data() + off, n);
    off += n;
  }
  std::vector<int16_t> out;
  int16_t buf[pulse::kFrame];
  while (u.outRing.pop(buf)) out.insert(out.end(), buf, buf + pulse::kFrame);
  *tailLeft = u.tailLen;
  return out;
}

void testWriteFraming() {
  std::printf("\n=== VAL-AUDIO-005: queueFrames, writes that are not multiples of 160 ===\n");
  // Deterministic non-zero signal: a ramp, so an injected zero is unmistakable and its position
  // identifies which write produced it.
  std::vector<int16_t> input(1040);
  for (size_t i = 0; i < input.size(); i++) input[i] = static_cast<int16_t>(1000 + (i % 900));

  const size_t chunks[] = {200, 40, 161, 319, 1, 160, 159};
  const size_t nChunks = sizeof(chunks) / sizeof(chunks[0]);
  std::printf("  chunk lengths      :");
  for (size_t c = 0; c < nChunks; c++) std::printf(" %zu", chunks[c]);
  std::printf("  (total %zu)\n", input.size());

  size_t tailLeft = 0;
  const std::vector<int16_t> out = framingRun(pulse::queueFrames, chunks, nChunks, input, &tailLeft);
  std::printf("  frames queued      : %zu (%zu samples), tail still held: %zu\n",
              out.size() / pulse::kFrame, out.size(), tailLeft);

  check(out.size() == 960, "1040 samples queue exactly 6 whole frames (960)");
  check(tailLeft == 80, "the 80-sample remainder is held, not dropped or padded");

  bool identical = out.size() == 960 && std::memcmp(out.data(), input.data(), 960 * sizeof(int16_t)) == 0;
  size_t firstDiff = 0;
  if (!identical) for (size_t i = 0; i < std::min(out.size(), static_cast<size_t>(960)); i++)
    if (out[i] != input[i]) { firstDiff = i; break; }
  std::printf("  sample-for-sample  : %s%s\n", identical ? "IDENTICAL to the input" : "DIFFERS",
              identical ? "" : (" at index " + std::to_string(firstDiff)).c_str());
  check(identical, "queued frames equal the input sample for sample");

  const size_t zr = longestZeroRun(out);
  std::printf("  longest zero run   : %zu\n", zr);
  check(zr == 0, "no silence injected at a chunk boundary");

  // Negative control: the pre-fix algorithm on the same input.
  size_t oldTail = 0;
  const std::vector<int16_t> oldOut = framingRun(oldQueueFrames, chunks, nChunks, input, &oldTail);
  size_t oldDiff = 0, oldZeros = 0;
  for (size_t i = 0; i < std::min(oldOut.size(), static_cast<size_t>(960)); i++) {
    if (oldOut[i] != input[i] && !oldDiff) oldDiff = i;
    if (oldOut[i] == 0) oldZeros++;
  }
  std::printf("  PRE-FIX algorithm  : first mismatch at index %zu, %zu zero samples, "
              "longest zero run %zu\n", oldDiff, oldZeros, longestZeroRun(oldOut));
  check(oldDiff != 0 || oldZeros != 0,
        "the pre-fix algorithm really does corrupt the stream (negative control is not vacuous)");

  // Two handles must not share assembly state.
  pulse::Unit a; resetUnit(a);
  pulse::Unit b; resetUnit(b);
  const int16_t ones[200] = {0};
  std::vector<int16_t> fill(200, 1111);
  pulse::queueFrames(&a, fill.data(), 200);
  std::vector<int16_t> fill2(200, 2222);
  pulse::queueFrames(&b, fill2.data(), 200);
  int16_t fa[pulse::kFrame], fb[pulse::kFrame];
  const bool gotA = a.outRing.pop(fa), gotB = b.outRing.pop(fb);
  (void)ones;
  std::printf("  two handles        : A first sample=%d, B first sample=%d\n",
              gotA ? fa[0] : -1, gotB ? fb[0] : -1);
  check(gotA && gotB && fa[0] == 1111 && fb[0] == 2222,
        "per-unit tails: two open handles do not interleave each other's frames");
}
