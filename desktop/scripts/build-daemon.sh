#!/usr/bin/env bash
# Build the native half of the headless SIP daemon on macOS (Apple Silicon).
#
# What is actually compiled here is *only* the audio device: desktop/native/pulse_audio, a
# CoreAudio AudioUnit addon that opens the microphone and speaker and hands the daemon 8 kHz mono
# Int16 frames. Everything else — SIP, SDP, digest auth, RTP, RFC 2833 DTMF, the state machine —
# is JavaScript under desktop/daemon and needs no compiler at all.
#
# That split is the reason this feature can ship without a 40 MB signed binary per platform:
# `desktop/bin/pulse-sip-daemon` is a launcher, the daemon runs on the Electron binary the app
# already ships (ELECTRON_RUN_AS_NODE=1), and the only platform-specific artefact is the addon.
#
#   bash desktop/scripts/build-daemon.sh              # build + self-test
#   bash desktop/scripts/build-daemon.sh --skip-addon # self-test only (no Xcode needed)
#
# Requires: macOS, Xcode command line tools (`xcode-select --install`), Node 18+.
# Optional: PULSE_SIGN_IDENTITY="Developer ID Application: …" to codesign the addon.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESKTOP="$REPO/desktop"
NATIVE="$DESKTOP/native"
DAEMON="$DESKTOP/daemon/main.js"
SKIP_ADDON=0
for arg in "$@"; do
  case "$arg" in
    --skip-addon) SKIP_ADDON=1 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- 1. runtime
say "Runtime"
NODE_BIN=""
if [ -x "$REPO/node_modules/.bin/electron" ]; then NODE_BIN="$REPO/node_modules/.bin/electron"; fi
if command -v node >/dev/null 2>&1; then NODE_BIN="$(command -v node)"; fi
[ -n "$NODE_BIN" ] || die "No Node.js found. Install Node 18+ from https://nodejs.org and re-run."
printf 'node/electron : %s\n' "$NODE_BIN"
printf 'repo          : %s\n' "$REPO"
printf 'platform      : %s %s\n' "$(uname -s)" "$(uname -m)"
[ -f "$DAEMON" ] || die "desktop/daemon/main.js is missing — is this the Pulse Dialer repository?"

if [ "$(uname -s)" != "Darwin" ]; then
  printf '\nThis is not macOS: the CoreAudio addon cannot be built here.\n'
  printf 'The daemon still runs (audio backend "null"), which is how the SIP suite is tested in CI.\n'
  SKIP_ADDON=1
fi

# ---------------------------------------------------------------- 2. CoreAudio addon
if [ "$SKIP_ADDON" -eq 0 ]; then
  say "CoreAudio addon (desktop/native)"
  [ -f "$NATIVE/binding.gyp" ] || die "$NATIVE/binding.gyp is missing."
  xcode-select -p >/dev/null 2>&1 || die "Xcode command line tools are not installed. Run: xcode-select --install"
  ( cd "$NATIVE" && npm install --no-audit --no-fund --loglevel=error )
  ( cd "$NATIVE" && npm run build )
  ADDON="$NATIVE/build/Release/pulse_audio.node"
  [ -f "$ADDON" ] || die "the addon did not appear at $ADDON"
  printf 'built         : %s (%s KB)\n' "$ADDON" "$(( $(wc -c < "$ADDON") / 1024 ))"
  file "$ADDON" || true

  if [ -n "${PULSE_SIGN_IDENTITY:-}" ] && command -v codesign >/dev/null 2>&1; then
    say "Codesigning"
    codesign --force --sign "$PULSE_SIGN_IDENTITY" --timestamp "$ADDON"
    codesign --verify --verbose=2 "$ADDON" || true
  else
    printf '\nNot signed. For distribution outside the Mac App Store:\n'
    printf '  PULSE_SIGN_IDENTITY="Developer ID Application: You (TEAMID)" bash desktop/scripts/build-daemon.sh\n'
    printf 'then notarise the .app that bundles it (xcrun notarytool submit …).\n'
  fi
fi

# ---------------------------------------------------------------- 3. self-test
say "Self-test: does the daemon speak its own protocol?"
# `--audio=null` because the build machine may have no audio device, and `--keep-alive` because no
# supervisor is holding stdin open. Two lines out (ready + the hello reply) is the whole assertion;
# the daemon is then killed, since --keep-alive means it would otherwise sit there forever.
SELFTEST_LOG="$(mktemp)"
( printf '{"id":1,"action":"hello"}\n'; sleep 5 ) | "$NODE_BIN" "$DAEMON" --audio=null --keep-alive \
  --log-level=warn >"$SELFTEST_LOG" 2>/dev/null &
SELFTEST_PID=$!
sleep 2
kill "$SELFTEST_PID" >/dev/null 2>&1 || true
wait "$SELFTEST_PID" >/dev/null 2>&1 || true
OUT="$(head -2 "$SELFTEST_LOG" || true)"
rm -f "$SELFTEST_LOG"
printf '%s\n' "$OUT"
printf '%s' "$OUT" | grep -q '"event":"ready"' || die "the daemon did not report ready — see the output above."
printf '%s' "$OUT" | grep -q '"version"' || die "the ready event carries no version."
printf '\n✓ the daemon starts, emits `ready` and answers `hello`.\n'

# ---------------------------------------------------------------- 4. what next
say "Done"
cat <<EOF
Run the app:
  (cd "$REPO" && npm run build)     # build the renderer into dist/
  (cd "$REPO" && npm start)         # the local API server on port ${PORT:-3001}
  (cd "$REPO" && npm run desktop)   # this supervisor + the daemon

Talk to the daemon by hand:
  "$DESKTOP/bin/pulse-sip-daemon" --api-base http://127.0.0.1:${PORT:-3001}
  echo '{"id":1,"action":"status"}' | "$DESKTOP/bin/pulse-sip-daemon" --domain sip.flynumber.com \\
      --user USER --password PASS --caller-id +4532331610 --audio coreaudio

Run the SIP test suite (a mock carrier on a real UDP socket):
  (cd "$REPO" && node test/unit/sip-daemon.test.js)
EOF
