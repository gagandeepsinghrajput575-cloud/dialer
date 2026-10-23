# RFC — The CoreAudio addon has never compiled: seven defects in the only code that touches a microphone

Status: Phase 0 gate. Findings are proven by compilation against Apple's own macOS 14.5 SDK
headers; fixes follow in §3.

## 0. Why this RFC exists

Every previous sweep stopped at the JavaScript. The daemon's SIP stack, its RTP path, its call
logic and its seam with the renderer are now covered by 20 suites and 60 chaos invariants — and all
of them boot the daemon with `--audio=null`, the one backend that tolerates never being opened.

That means **`desktop/native/` — 743 lines of C++ that is the only thing in this repository that
touches a real microphone — has never been compiled by anything, on any machine, not once.**

This RFC changes that. It compiles the addon for `aarch64-macos` against Apple's real headers and
reports what the compiler says.

## 1. Method: how macOS audio code was verified on Linux

Three independent sources of truth, none of them my memory of the API:

1. **Zig 0.17.0** (`pip install ziglang`) as a cross-compiler. It bundles a Darwin libc and
   `libSystem.tbd`, so `zig c++ -target aarch64-macos` genuinely type-checks and codegens for
   Apple Silicon. Verified: it compiled a probe using `AudioComponentFindNext` and
   `kAudioUnitSubType_HALOutput` and failed only at the framework link step, which `binding.gyp`
   supplies via `-framework AudioToolbox` on a real Mac.
2. **Apple's own SDK headers**, sparse-cloned from `alexey-lysiuk/macos-sdk` at
   `MacOSX14.5.sdk` — the user's OS generation. AudioToolbox, CoreAudio, CoreAudioTypes,
   CoreFoundation, AudioUnit. Every disputed symbol was grepped in these files, not recalled.
3. **miniaudio** (`mackron/miniaudio`) as an independent implementation cross-check for the
   AudioUnit call sequence.

An earlier pass used the macOS 11.3 SDK from `phracker/MacOSX-SDKs` and reported
`kAudioObjectPropertyElementMain` as undeclared. That was **an artifact of the old SDK, not a bug**:
the symbol is the macOS 12 rename of `kAudioObjectPropertyElementMaster` (both `= 0`) and is present
in 14.5. Re-running against 14.5 is what separates real defects from toolchain noise, and the
distinction is the reason this RFC quotes the 14.5 output.

## 2. Defects, in the order the compiler finds them

### BUG 11 — `AudioDevicePropertyAddress` is not a type (4 sites, compile error)

```
desktop/native/src/coreaudio_impl.mm:45:9: error: unknown type name 'AudioDevicePropertyAddress'
desktop/native/src/coreaudio_impl.mm:57:9: error: unknown type name 'AudioDevicePropertyAddress'
desktop/native/src/coreaudio_impl.mm:67:9: error: unknown type name 'AudioDevicePropertyAddress'
desktop/native/src/coreaudio_impl.mm:114:9: error: unknown type name 'AudioDevicePropertyAddress'
```

`grep -rn AudioDevicePropertyAddress` over the entire 14.5 SDK returns **zero** hits. The real type
is `AudioObjectPropertyAddress`, declared at `CoreAudio.framework/Headers/AudioHardwareBase.h:108`.
The two are the same three-field struct; only the name in the source is wrong.

Affects `uidOf`, `nameOf`, `hasStreams` and `devices()` — i.e. all device discovery.

### BUG 12 — `kAudioInputUnitProperty_CurrentDevice` does not exist (compile error)

```
desktop/native/src/pulse_audio.mm:96:58: error: use of undeclared identifier
    'kAudioInputUnitProperty_CurrentDevice'
```

Zero occurrences in the 14.5 SDK and zero in miniaudio. The only such property is
`kAudioOutputUnitProperty_CurrentDevice = 2000` (`AudioUnitProperties.h:2340`), which selects the
output device on element 0 and the **input device on element 1**. The source already passes element
1, so the constant name is the only thing wrong.

This is the line that points the microphone at the device the operator picked in Settings. With it
uncompilable, the addon cannot be built at all; with it silently wrong, the mic would follow the
system default instead of the chosen headset.

### BUG 13 — every `detail::` definition has internal linkage (link error)

`pulse_audio.mm` calls `detail::pickDevice`, `detail::fallbackDevice`, `detail::rateOf`,
`detail::nameOf`, `detail::devices`, `detail::uidOf`, `detail::hasStreams` and takes the addresses
of `detail::inputProc` / `detail::renderProc` to install them on the unit.

`pulse_audio.h` declares all of them at `pulse::detail::`, with a comment explaining why:

> Declared here (not in an anonymous namespace) so the binding file can call them: an anonymous
> namespace would give them internal linkage and they would be invisible across the two files.

`coreaudio_impl.mm` then defines all of them inside `namespace detail { namespace { ... } }` —
doing precisely what its own header warns against. The definitions get internal linkage and the
declarations in the other translation unit are never satisfied: **undefined symbols at link time.**

This is the defect that makes the whole feature dead on arrival, and it is invisible to every test
in the repository because every test boots `--audio=null`.

### BUG 14 — the speaker plays audio about six times too fast, and drops most of it

```cpp
const size_t want = std::min(static_cast<size_t>(kFrame), frames - written);
unit->up.pos = 0.0;
unit->up.up(unit->outScratch.data(), kFrame, unit->upScratch.data(), want);
```

`kFrame` is 160 samples of **8 kHz** audio. At a 48 kHz device those 160 samples must expand to
960 device samples. Capping `want` at `kFrame` produces only 160, so the loop pops **six** ring
frames to fill one 20 ms callback — draining the queue 6× too fast and playing the far end's voice
at roughly six times speed.

Worse, `up.pos` is reset to `0.0` each iteration, so each frame contributes only its first
160 × (8000/48000) ≈ 27 samples and the remaining 133 are thrown away. The output is not merely
fast, it is unintelligible.

There is also no carry: when `frames` is not a multiple of the expansion ratio, the tail of the last
expanded frame is discarded instead of being held for the next callback.

### BUG 15 — the microphone produces six times too many samples, then invokes UB

```cpp
unit->down.down(in, n, unit->pcm.data(), n);          // want = n INPUT samples
unit->downPos = unit->down.pos - static_cast<double>(n);
```

Downsampling 48 kHz → 8 kHz must *reduce* the count by 6. Asking for `n` outputs from `n` inputs
makes `down()` walk `pos` to `6n` over a buffer of `n`, replaying it six times through the
`while (pos >= have) pos -= have` wrap — the mic is stretched to roughly one-sixth speed.

Then `down.pos` has been wrapped into `[0, n)`, so `downPos = pos - n` is **negative**, and the next
callback does `static_cast<size_t>(negative double)` — undefined behaviour, in practice a huge or
zero index, which sends every subsequent sample down the `idx < have ? … : last` fallback.

### BUG 16 — every partial frame injects up to 20 ms of silence

```cpp
static std::vector<int16_t> tail;
static size_t tailLen = 0;
tail.assign(kFrame, 0);            // wipes the samples saved by the PREVIOUS write
if (tailLen) { memcpy(tail.data() + tailLen, data, take); ... }
```

`assign` zeroes all 160 slots before the new data is copied in at offset `tailLen`, so the partial
frame accumulated by the previous `write()` is destroyed and replaced with zeros. Any write whose
length is not a multiple of 160 emits a frame that begins with silence and loses real audio.

The `static` also shares one tail across every open unit, so two handles would interleave frames.

### BUG 17 — `inRing` is written on the realtime thread and never read

`inputProc` pushes every microphone frame into `unit->inRing`; nothing in the addon or the daemon
ever pops it (the exports are `open/start/write/stop/close/devices/sampleRate/inputDevice/
outputDevice` — there is no `read`). Mic frames reach JavaScript through the `ThreadSafeFunction`.
So the ring is a 320-byte `memcpy` per frame on the realtime audio thread, purely to be dropped once
it fills. It is dead weight in the one place where wasted cycles are audible.

### BUG 18 — the server's native-engine detector compares against the wrong constant

`server/services/softphoneSession.js`:

```js
const { NATIVE_ENGINE } = require('./carrierAccount');   // 'pulse-sip-daemon'
const isNative = (session) => !!session
  && (session.engine === NATIVE_ENGINE || session.transport === 'udp' || ...);
```

but `carrierAccount.webrtcSession()` emits `engine: 'native'`. The primary witness is therefore
always false and only the `transport === 'udp'` fallback keeps the phone working. The renderer's own
`isNativeSession()` in `src/nativeSip.js` correctly tests `engine === 'native'`, so the two halves of
the app disagree about the value of the same field.

### BUG 19 — `findElectron()` can never report that Electron is missing

`desktop/scripts/run-desktop.js` exists to print a precise "Electron is not installed, run
`npm i -D electron@^33`" message rather than `spawn electron ENOENT`. Its candidate list ends with
the bare string `'electron'`, and the loop returns that string unconditionally:

```js
for (const candidate of CANDIDATES) {
  if (candidate === 'electron') return candidate;   // always taken on the last pass
  if (fs.existsSync(candidate)) return candidate;
}
return null;                                        // unreachable
```

`return null` is dead code, so the detailed guidance never prints. The fallback should only be used
when the binary is actually resolvable on `PATH`.

## 3. Planned fixes

| # | Fix | File |
| --- | --- | --- |
| 11 | `AudioDevicePropertyAddress` → `AudioObjectPropertyAddress` (4 sites) | `coreaudio_impl.mm` |
| 12 | `kAudioInputUnitProperty_CurrentDevice` → `kAudioOutputUnitProperty_CurrentDevice`, element 1 unchanged | `pulse_audio.mm` |
| 13 | Move the nine declared functions out of the anonymous namespace; keep only `cfToString` and `deliverFrame` inside it | `coreaudio_impl.mm` |
| 14 | Expand each 8 kHz frame to `kFrame * deviceRate / 8000` device samples, computed once at `open()`; carry the surplus into the next callback from a pre-sized buffer (no allocation on the realtime thread) | `coreaudio_impl.mm`, `pulse_audio.h` |
| 15 | Rewrite `Resampler::down` as a streaming resampler that returns the number of samples produced and carries a fractional position that may legitimately be negative, bracketed by `last`; assemble 20 ms frames from a persistent fill count instead of assuming one callback yields whole frames | `pulse_audio.h`, `coreaudio_impl.mm` |
| 16 | Move the tail buffer into `Unit` (per-handle) and stop zeroing it on every write | `pulse_audio.h`, `pulse_audio.mm` |
| 17 | Delete `inRing` | `pulse_audio.h`, `coreaudio_impl.mm` |
| 18 | Compare against the descriptor's actual value; keep `NATIVE_ENGINE` for the settings key it is really for | `softphoneSession.js` |
| 19 | Resolve the bare `electron` through `PATH` before returning it, so the real message can print | `run-desktop.js` |

## 4. How the fixes will be verified

Compilation alone proves 11–13 and nothing about 14–17, which are arithmetic. So:

1. **Cross-compile both translation units for `aarch64-macos` against the real 14.5 SDK headers.**
   Must produce two object files with zero errors, and `nm` must show `pulse_audio.o`'s references
   to `pulse::detail::*` satisfied by `coreaudio_impl.o` — the direct disproof of BUG 13.
2. **A runnable DSP harness on Linux.** `Ring` and `Resampler` already live outside the `__APPLE__`
   guard in `pulse_audio.h`, and the callbacks touch no Apple symbol except `AudioUnitRender`. With
   test-only stub headers on the include path, the *real* `coreaudio_impl.mm` compiles for the host
   and its real `inputProc` / `renderProc` can be driven with synthetic audio:
   - feed a known 440 Hz tone at 48 kHz into `inputProc` and assert the output is 440 Hz at 8 kHz,
     with the right sample count and no drift across many callbacks (disproves BUG 15);
   - push 8 kHz frames through `outRing` and run `renderProc`, asserting the device-rate output
     contains the same tone at the same pitch and that no input sample is skipped (disproves 14);
   - call `write()` with lengths that are not multiples of 160 and assert the reconstructed stream
     equals the original with no zero-run inserted (disproves 16).
   A test that measures pitch rather than asserting "no exception" is the only kind that can catch
   these, because every one of them produces audio that is merely *wrong*.
3. **Full regression**: all 20 suites, `all-tests.js`, `vite build`.

## 5. What this still does not prove

Stated up front so the result is not over-read:

* **Cross-compilation is not execution.** A clean `aarch64-macos` build proves the source is valid
  C++ against Apple's real headers and that its internal symbols resolve. It does not prove the
  AudioUnit graph behaves as expected on the user's hardware — only running it on a Mac can.
* The 14.5 headers are used with `-Wno-elaborated-enum-base`, needed because CoreFoundation's
  `CF_ENUM` macro trips a diagnostic that is an error by default in clang 19 but not in Apple's
  clang. This is a toolchain-age artifact and does not weaken the type checking of the audio APIs.
* No real audio device exists in this sandbox, so `AudioUnitRender`, `AudioOutputUnitStart` and the
  device-discovery calls are stubbed in the harness. The harness verifies the DSP arithmetic and the
  frame plumbing around them, not CoreAudio itself.
