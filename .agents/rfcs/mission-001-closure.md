# Mission-001 closure: eight bugs fixed, and why no runtime ever said "passed"

Closes the A-to-Z bug sweep of the Pulse Dialer codebase. Everything below is a verdict backed by a
command whose output is quoted, either here or in the mission's lane records. Nothing is asserted from
reading alone.

**Commit: `637406d` on `arena/86f63651-dialer`.** Working tree clean.

This document exists because the Zenith runtime could not issue a verdict, so the closure record has to
live somewhere a human will actually find it: in the repository, next to the code it describes.

---

## 1. What was fixed

| Bug | Where | Was |
|---|---|---|
| **18** | `server/services/carrierAccount.js`, `softphoneSession.js` | Two engine identities shared one name. `NATIVE_ENGINE='pulse-sip-daemon'` is the settings value and the daemon-facing `credentials()` value; the renderer-facing descriptor field is `'native'`. `isNative()` compared the descriptor against the settings value, so its primary witness was **always false** and the decision rode on the `transport === 'udp'` fallback. `engineOf()` returned `'pulse-sip-daemon'`, contradicting the descriptor, `callService.js:104` and `src/nativeSip.js:34/129` — and had zero consumers. |
| **19** | `desktop/scripts/run-desktop.js` | `findElectron()` returned the bare string `'electron'` unconditionally, making `return null` unreachable. The guidance block the file exists to print could never print, so the operator got `spawn electron ENOENT` — the exact failure named in its own header comment. |
| **20** | `src/nativeSip.js`, `src/useWebRtc.js`, `src/pages/Dialer.jsx` | `toggleMute()` returned the state *asked for*, not the state applied, even when the daemon refused. `useWebRtc` flipped its own ref and dropped the result with `.catch(() => {})`. The return value feeds the operator toast, so a refused mute announced **"Microphone muted" while the customer still heard everything**. |
| **21** | `src/useWebRtc.js` | The native `sendDtmf()` branch returned an unconditional `true`, discarding the engine's truthful answer. A refused digit was logged as sent. |
| **22** | `src/useWebRtc.js` | `hangUp()` fired `nativeRef.current.hangUp().catch(() => {})`. On failure no `ended` event arrives, so the call stayed up on the daemon while the UI believed it had ended. |
| **23** | `desktop/native/src/coreaudio_impl.mm` | `namespace pulse {` opened at line 24 and the file ended at `#endif` with no closing brace. The addon could not compile **on any platform**. |
| **24** | `desktop/native/src/pulse_audio.mm` | `namespace {` opened at line 31 and did not close until line 306, swallowing all nine JS-surface exports. `Init` bound the *external* symbols; nothing called the internal ones; `-O2` discarded them; the addon could not link. |
| **25** | `src/components/Notes.jsx` | The cleanup effect whose own comment reads "never lose an unsaved note" ended in `api.addNote(pid, t).catch(() => {})`. That cleanup is the last chance the text gets, so a rejected save silently lost the agent's typing. |

Plus BUG 11–17, located in mission 6 and fixed here: four wrong CoreAudio property types, a
`kAudioInputUnitProperty_CurrentDevice` that is not a symbol in any SDK, nine `detail::` definitions with
internal linkage, a render callback that expanded a 20 ms frame to 160 device samples instead of 960
(~6× too fast far end), an input callback that asked for n outputs from n inputs at step 6 (~6× too slow
microphone, then cast a negative double to `size_t`), a `static` tail that zeroed the partial frame it
was holding, and an `inRing` pushed on the realtime thread that nothing ever popped.

### Why 23 and 24 matter disproportionately

Both are invisible to reading and to per-file compilation: each translation unit compiled cleanly on its
own. They surface only when the code is compiled **and its symbols inspected**. `pulse_audio.o` grew
239,640 → 585,088 bytes once its exports were actually emitted. Two new committed checks exist because of
them — `test/native/cross-compile.sh` and `test/native/macho-symbols.py` — and the second one caught a
defect the first one could not.

---

## 2. Verification

All 22 `VAL-*` assertions passed. Full lane records: mission `attempts/` directory
(`v-audio-scrutiny`, `v-audio-dsp`, `v-app-surface`, `v-sweep`, `v-regress`).

### Commands in this repo

```
npm run test:unit     → suites: 28/28 passed   checks seen: 436 ✓ / 0 ✗   EXIT=0
npm run test:backend  → ALL 24 BACKEND CONNECTIVITY CHECKS PASSED         EXIT=0   (needs :3001)
npm run test:native   → CROSS-COMPILE OK; SYMBOL RESOLUTION OK; 29/29     EXIT=0
npm run build         → ✓ built in 969ms                                  EXIT=0
npm run test:ui       → [ui] 230 UI race checks passed, 0 failed          EXIT=0
```

`test:ui` matters here specifically: it loads the **real production bundle** in jsdom and mashes the
keyboard shortcuts, which is the path through the `Dialer.jsx` mute handler this mission changed.

### The checks that carry the weight

**Cross-compile against Apple's real macOS 14.5 SDK** — zero errors *and* zero warnings in both
translation units. Before the fix, the same command failed:

```
coreaudio_impl.mm:45,57,67,114:9: error: unknown type name 'AudioDevicePropertyAddress'
coreaudio_impl.mm:203:21: error: expected '}'   (note: to match this '{' at 24:17)
pulse_audio.mm:96:58: error: use of undeclared identifier 'kAudioInputUnitProperty_CurrentDevice'
```

**Symbol resolution** — `nm` cannot read a Mach-O aarch64 object here (GNU nm: `file format not
recognized`; `python3 -m ziglang nm` is not a subcommand; zig's `c++ -shared` **segfaults** and writes a
0-byte file first, so `ls -l` looks like success). `test/native/macho-symbols.py` parses LC_SYMTAB:

```
SYMBOL RESOLUTION OK: all 9 pulse::detail symbol(s) the consumer needs are defined external
pulse::Open/Start/Write/Stop/Close/Devices/SampleRate/InputDevice/OutputDevice  DEFINED EXTERNAL
undefined pulse:: exports left: 0
```

**The DSP harness measures instead of trusting** — the real `coreaudio_impl.mm` compiled for the host
against stubs, so `inputProc`, `renderProc`, `pickDevice`, `Ring`, `Resampler` and `queueFrames` are
product code executed:

```
measured ratio     : 0.16667  (want 0.16667)      measured pitch : 440.04 Hz at 8 kHz
expand             : 960 device samples per 20 ms frame
non-silent callbacks: 3 of 5 (3 frames queued)     silent samples in content: 5 of 2880
sample-for-sample  : IDENTICAL to the input        longest zero run   : 0
🎉 29/29 checks passed
```

**Negative control over the DSP measurements** — HEAD's arithmetic, reconstructed verbatim, fails the
same thresholds by wide margins:

```
PRE-FIX mic: 96000 samples from 96000 device samples (ratio 1.0000; correct is 0.1667)
PRE-FIX mic: pitch 380.31 Hz, max sample step 28526, inRing depth left 63
PRE-FIX speaker: 1 non-silent callbacks of 5 for 3 queued frames (fixed code gives 3)
```

That is what makes the 440.04 Hz above evidence rather than a coincidence, and it confirms BUG 17
directly: `inRing` was 63 frames deep because nothing ever popped it.

**The renderer hook, for real** — `test/unit/native-controls.test.js` renders the real `useWebRtc` in
jsdom with the real `nativeSip` engine behind it, wired to the production React setters, driving a
connected call through the real event path. Only the daemon is simulated.

```
🎉 Native call controls: all 20 checks passed
✓ reported=undefined muted=false error="The daemon refused the mute."
✓ accepted mute: muted=true payload={enabled:true}; unmute: muted=false payload={enabled:false}
✗ before the fix: 1, 3, 5, 7.mute, 7.dtmf, 7.hangup → 💥 8/14 passed, 6 FAILED
```

The four success-path guards passed pre-fix, so the probe fails only where the bugs are and cannot be
satisfied by making every control report failure.

**Live HTTP surface** — the browser descriptor was byte-identical before and after, and a genuine
native opt-in produced `engine='native' transport='udp' password='' hasPassword=false`. With both
fallback witnesses deleted so only `engine` could carry the decision: `isNative = true`,
`engineOf = "native"`. Settings were recorded before and after and restored to defaults.

---

## 3. The scripted-signal trap this repo already fell into

Worth recording, because it is the cheapest way to fake an entire test harness.

`test/helpers/legacy-db.js` carries a header explaining that an earlier version of the fixture marked
migrations 1–6 as applied **without applying them**. The migration test then measured a lie: it passed,
and proved nothing. That is the same failure mode as a probe that passes with and without the fix.

Both are why this mission's discipline was: run the probe **RED first against unfixed code**, delete the
fallback witnesses so only the primary one can carry the decision, and quote the pre-fix failure. A
check that passes before and after is not evidence — it is decoration.

---

## 4. Why no runtime verdict exists

The Zenith runtime accepted the plan (14 tasks, 22 assertions, `mission_running`) and then could not
dispatch a single worker. Eight attempts across two rounds, four frontier tasks at once, every failure
identical:

```
{'code': -32000, 'message': 'Authentication required'}   exit -15
```

`retry` was used as the negative control and reproduced the identical failure, so it is not a
cold-start artefact. The consequences were mapped before deciding: dependents unblock only on `cleared`
or `superseded`, a `failed` task unblocks nothing, and `end_node` needs `ZENITH_HANDOFF_PATH` /
`ZENITH_NODE_ID` which only the dispatcher sets. No inline execution mode exists anywhere in the
`ZENITH_*` surface.

```
end_mission → {"error": "wrong_state",
               "message": "end_mission requires MissionRunning; got attention_needed"}
decide_attention (abort ×4) → {"state": {"state": "aborted", …}, "dag": null}
```

**Rejected:** pointing `ZENITH_WORKER_ACP_COMMAND` at a local shim. A shim has no judgement of its own
and could only report success, manufacturing `cleared` records and false `passed` verdicts — the precise
failure this mission exists to prevent. Not attempted.

So: **no assertion carries a runtime-issued `passed`, no gate was sealed by the runtime, and no task was
ever `cleared`.** The abort records the *runtime's* inability to execute, not a failure of the
engineering. If a future session has working provider credentials, the plan is already runtime-accepted
and the contracts are written; re-submitting unchanged would produce real `cleared` records.

---

## 5. What is **not** proven

- **AudioUnit behaviour on real hardware.** There is no audio device in this sandbox:
  `AudioUnitRender`, `AudioOutputUnitStart` and device discovery are stubbed. The harness proves the DSP
  arithmetic, framing, ring discipline and resampler phase bookkeeping. It does not prove CoreAudio
  calls these callbacks with the sizes assumed, that the device opens, or that audio is audible.
  **This needs the user's Mac.**
- **Electron's real process model.** Its binary lives on a release host that is unreachable here. The
  launcher is proven with a stand-in executable on PATH; the supervisor is proven with
  `require('electron')` failing, which `desktop/main.js` is written to tolerate.
- **A real carrier call.** `sip.flynumber.com` is unreachable from this sandbox. The call path is proven
  against a mock carrier over real UDP.
- **The mute refusal path specifically.** The shipped daemon's `ua.setMute()` always returns `{ok:true}`
  (checked, not assumed), so no real refusal can be produced for mute — only a transport failure. The
  hang-up and DTMF refusal strings asserted are the real daemon's (`ua.js:104`, `:142`).
- **The sweep is not a proof of absence.** Nine defect classes were hunted across twelve file families
  and the nine largest never-audited files were read where those classes live. A defect outside those
  classes, or one needing a runtime state nobody constructed, would not have been found.

Also disclosed: `toggleMute()` can no longer return a synchronous prediction on the native path — it
returns `undefined`, meaning "the daemon decides". `Dialer.jsx`'s three toast sites announce only a
definite boolean. The mute badge and Mute/Unmute button were already bound to the confirmed state, so
confirmation is still immediate, and a refusal now raises a visible error instead of a false
"Microphone muted".

---

## 6. Reproducing all of it

```bash
npm run test:unit      # 28 suites, no short-circuit, fails on exit-0-with-failures
npm run build && npm run test:ui
npm start & npm run test:backend
npm run test:native    # needs the macOS 14.5 SDK, a node include dir and node-addon-api
```

The native check's toolchain is passed by environment variable and documented in
`test/native/cross-compile.sh`; it defaults to the paths used here. On the user's Mac the real build
remains `desktop/scripts/build-daemon.sh` — these are checks, not the product build.
