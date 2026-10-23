#!/usr/bin/env bash
# Build and run the host DSP harness. See harness.cpp for what is real and what is stubbed.
#
# -D__APPLE__ is forced so the product source takes its Apple branch: the code under test lives
# inside `#if defined(__APPLE__)` and would otherwise compile to nothing. The stubs in ./stubs stand
# in for CoreAudio, CoreFoundation, AudioUnit and the N-API boundary.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DSP="$REPO/test/native/dsp"
OUT="${OUT:-/tmp/pulse-dsp-harness}"
CXX="${CXX:-g++}"

echo "compiling the real coreaudio_impl.mm for the host against stubs (9 translation units)…"
"$CXX" -std=c++17 -O2 -D__APPLE__ -Wno-multichar -x c++ \
  -I"$DSP/stubs" -I"$REPO/desktop/native/src" \
  "$REPO/desktop/native/src/coreaudio_impl.mm" \
  "$DSP/stubs/coreaudio_stub_impl.cpp" \
  "$DSP/legacy_impl.cpp" \
  "$DSP/dsp_support.cpp" \
  "$DSP/check_mic.cpp" \
  "$DSP/check_speaker.cpp" \
  "$DSP/check_framing.cpp" \
  "$DSP/check_devices.cpp" \
  "$DSP/check_legacy.cpp" \
  "$DSP/harness.cpp" \
  -o "$OUT" 2>&1 | head -40
rc=${PIPESTATUS[0]}
if [ "$rc" != "0" ]; then echo "BUILD FAILED (exit $rc)"; exit "$rc"; fi
echo "built: $OUT ($(stat -c%s "$OUT" 2>/dev/null || echo ?) bytes)"
echo
"$OUT"
exit $?
