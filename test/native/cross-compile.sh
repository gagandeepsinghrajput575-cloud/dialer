#!/usr/bin/env bash
# Cross-compile the CoreAudio addon for aarch64-macos and report every compiler diagnostic.
#
# Why this exists. `desktop/native/src/` is the only code in the repo that touches a real microphone,
# and `desktop/scripts/build-daemon.sh` is `set -euo pipefail`, so a compile error there aborts the
# whole Mac build and the app silently falls back to `--audio=null`. Until this script existed the
# addon had NEVER been compiled against Apple's real headers, so three build defects and four DSP
# defects shipped unnoticed. This makes "does it compile" a repeatable check instead of a claim.
#
# It is a check, not the product build. The real Mac build stays `desktop/scripts/build-daemon.sh`.
# Cross-compiling proves the source is valid against Apple's real headers and that every internal
# symbol resolves; it does NOT prove AudioUnit behaviour on real hardware (mission risk R1).
#
# Toolchain, all overridable by environment:
#   ZIG          python module entry point for Zig (default: `python3 -m ziglang`)
#   SDK_FW       .../MacOSX<ver>.sdk/System/Library/Frameworks   (must be >= the target OS)
#   NODE_INC     node-gyp include dir containing node.h AND v8.h directly
#   NAPI_INC     dir containing napi.h (node-addon-api)
#
# NEVER point SDK_FW at an SDK older than the target OS. The 11.3 SDK reports
# `kAudioObjectPropertyElementMain` as undeclared; it exists in 14.5 as the macOS 12 rename of
# `ElementMaster` (both = 0). That produced a false positive, not a bug.
#
# Zig bundles macOS system headers but no framework headers, so frameworks must come from a real SDK.
# `-Wno-elaborated-enum-base` is required because CoreFoundation's CF_ENUM trips it under clang 19
# (Apple clang does not error on it); `-Wno-deprecated-declarations` silences ElementMaster. Both are
# disclosed here rather than hidden, since they change what the compiler reports.
#
# Exit status: 0 only if BOTH translation units compiled with zero `error:` lines.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO/desktop/native/src"
OUT="${OUT:-/tmp/pulse-native-cross}"

ZIG="${ZIG:-python3 -m ziglang}"
SDK_FW="${SDK_FW:-/tmp/sdk14/MacOSX14.5.sdk/System/Library/Frameworks}"
NODE_INC="${NODE_INC:-$HOME/.dev/node-gyp/22.22.3/include/node}"
NAPI_INC="${NAPI_INC:-/tmp/napi/node_modules/node-addon-api}"

for d in "$SDK_FW" "$NODE_INC" "$NAPI_INC" "$SRC"; do
  if [ ! -d "$d" ]; then echo "MISSING DIR: $d" >&2; exit 2; fi
done
for f in "$NODE_INC/node.h" "$NODE_INC/v8.h" "$NAPI_INC/napi.h"; do
  # v8.h must sit DIRECTLY in the node include dir. Copying `deps/v8/include` as a subdirectory
  # nests it at include/node/include/ and node.h then fails with `fatal error: v8.h: No such file`.
  if [ ! -f "$f" ]; then echo "MISSING HEADER: $f" >&2; exit 2; fi
done
if [ -d "$NODE_INC/include" ]; then
  echo "WARNING: nested $NODE_INC/include exists — v8.h is probably in the wrong place" >&2
fi

mkdir -p "$OUT"
echo "repo      : $REPO"
echo "sdk fw    : $SDK_FW"
echo "node inc  : $NODE_INC"
echo "napi inc  : $NAPI_INC"
echo "objects   : $OUT"
echo

status=0
for unit in coreaudio_impl pulse_audio; do
  echo "=== compiling $unit.mm for aarch64-macos ==="
  # shellcheck disable=SC2086
  $ZIG c++ -x c++ -std=c++17 -c -target aarch64-macos -O2 \
    -DNAPI_DISABLE_CPP_EXCEPTIONS \
    -F"$SDK_FW" \
    -I"$NODE_INC" -I"$NAPI_INC" -I"$SRC" \
    -Wno-elaborated-enum-base -Wno-deprecated-declarations \
    "$SRC/$unit.mm" -o "$OUT/$unit.o" 2>"$OUT/$unit.log"
  rc=$?
  errors=$(grep -c "error:" "$OUT/$unit.log" 2>/dev/null || true)
  warnings=$(grep -c "warning:" "$OUT/$unit.log" 2>/dev/null || true)
  echo "  exit=$rc  errors=$errors  warnings=$warnings"
  if [ "$errors" != "0" ]; then
    echo "  --- diagnostics ---"
    grep -E "error:|note:" "$OUT/$unit.log" | head -20 | sed 's/^/  /'
    status=1
  elif [ "$rc" != "0" ]; then
    tail -20 "$OUT/$unit.log" | sed 's/^/  /'
    status=1
  else
    echo "  compiled clean; object: $(ls -l "$OUT/$unit.o" | awk '{print $5}') bytes"
  fi
  echo
done

# Symbol resolution. GNU nm cannot read Mach-O ("file format not recognized"), `python3 -m ziglang nm`
# is not a subcommand, and zig's `c++ -shared` driver segfaults (rc=139) before it can link one, so
# the usual "did it link" proof is unavailable. test/native/macho-symbols.py parses LC_SYMTAB instead.
#
# This catches what compilation cannot: a definition wrapped in an anonymous namespace has a
# DIFFERENT mangled name, so each translation unit compiles cleanly and the addon then fails to link.
if [ -f "$OUT/pulse_audio.o" ] && [ -f "$OUT/coreaudio_impl.o" ]; then
  echo "=== symbol resolution (Mach-O LC_SYMTAB) ==="
  if python3 "$REPO/test/native/macho-symbols.py" "$OUT/pulse_audio.o" "$OUT/coreaudio_impl.o" \
      | sed -n '/resolution verdict/,$p' | sed 's/^/  /'; then :; fi
  python3 "$REPO/test/native/macho-symbols.py" "$OUT/pulse_audio.o" "$OUT/coreaudio_impl.o" >/dev/null 2>&1
  rc=$?
  [ "$rc" != "0" ] && status=1
  # The nine JS-surface exports must be DEFINED EXTERNAL, not swallowed by an anonymous namespace.
  python3 - "$OUT/pulse_audio.o" <<'PYEOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location('m', 'test/native/macho-symbols.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
de, _, un = m.read_symbols(sys.argv[1])
want = ['Open','Start','Write','Stop','Close','Devices','SampleRate','InputDevice','OutputDevice']
bad = []
for w in want:
    sym = '__ZN5pulse' + str(len(w)) + w + 'ERKN4Napi12CallbackInfoE'
    state = 'DEFINED EXTERNAL' if sym in de else 'MISSING'
    print(f'  pulse::{w:<13} {state}')
    if sym not in de:
        bad.append(w)
leftover = [x for x in un if x.startswith('__ZN5pulse') and 'detail' not in x and 'g_' not in x]
print(f'  undefined pulse:: exports left: {len(leftover)}')
sys.exit(1 if (bad or leftover) else 0)
PYEOF
  rc=$?
  [ "$rc" != "0" ] && status=1
  echo
fi

if [ "$status" = "0" ]; then
  echo "CROSS-COMPILE OK: both translation units compiled for aarch64-macos with zero errors"
else
  echo "CROSS-COMPILE FAILED: see diagnostics above"
fi
exit $status
