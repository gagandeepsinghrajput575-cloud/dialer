# Whole-codebase bug sweep (mission-001, VAL-SWEEP-001 / VAL-SWEEP-002)

Scope: every product file family in the repository, hunted for the defect classes that have already
produced real bugs here. Method is stated per family, because "reviewed, looks fine" is not a finding
and a hunt that does not say what it looked for cannot be checked.

Defect classes hunted, chosen because each one already bit this codebase:

| Class | The bug it came from |
|---|---|
| two layers disagreeing about a field name or value | BUG 9 `audio_level` vs `level`; BUG 18 engine constant |
| a spread/merge letting an absent key erase known-good state | BUG 10 password wipe in `ua.setAccount` |
| errors swallowed by an empty catch | mission 3's silent call; BUG 20 mute |
| optimistic UI state committed before the answer arrives | BUG 20/21/22 |
| guards ordered so a legitimate case is rejected | BUG 8 re-INVITE vs busy |
| a flag set before the action that depends on it being unset | BUG 7 `Dialog.end` |
| timers/listeners never cleared | — |
| values silently defaulted instead of reported missing | `webrtcWsUrl()` defaulting to Telnyx |
| internal linkage / unreachable code | BUG 13, 19, 23, 24 |

## Defects found by this sweep

### BUG 25 — an unsaved note is lost silently (FIXED)
`src/components/Notes.jsx`, the cleanup effect whose own comment says "never lose an unsaved note":

```js
if (t) api.addNote(pid, t).catch(() => {});
```

This cleanup is the last chance the text gets — the component is unmounting and the draft goes with
it — so a rejected save is a note the agent typed and no longer has, and they were never told. Fixed
to surface the failure through the store's `toast`, which is safe from a cleanup because it is not
component state. `toast` is deliberately **not** added to the dependency array: that would re-create
the effect on every render whose toast identity changed, and re-creating runs the cleanup, which would
save the same draft repeatedly while the agent is still typing. Both the fix and that hazard are
commented at the site. 97 → 109 lines.

### BUG 23 — `namespace pulse` opened and never closed (FIXED, w-audio)
`desktop/native/src/coreaudio_impl.mm` opened `namespace pulse {` at line 24 and ended the file at
`#endif // __APPLE__` with no matching brace. Found only when the file was actually compiled:
`203:21: error: expected '}'` with `note: to match this '{'` at `24:17`. The file could not compile on
any platform, not just macOS.

### BUG 24 — all nine JS-surface exports had internal linkage (FIXED, w-audio)
`desktop/native/src/pulse_audio.mm` opened `namespace {` at line 31 and did not close it until line
306, so `Open`, `Start`, `Write`, `Stop`, `Close`, `Devices`, `SampleRate`, `InputDevice`,
`OutputDevice` and `Unsupported` were all defined inside an anonymous namespace. `Init` (line 310,
outside `namespace pulse`) binds the **external** symbols declared in `pulse_audio.h`, so nine
different internal entities were created, nothing called them, `-O2` discarded them, and the addon was
left with all nine undefined at link time.

This is independent of BUG 13 (the same mistake in `coreaudio_impl.mm`) and fixing 13 alone would not
have produced a linkable addon. **Per-translation-unit compilation cannot show either defect** — each
file compiles cleanly on its own. It was found by parsing the Mach-O symbol tables
(`test/native/macho-symbols.py`) after `pulse_audio.o` turned out to reference `pulse::Open` as
undefined while defining only `Init`. Object size went 239,640 → 585,088 bytes once the exports were
actually emitted.

### Recorded, not fixed — with reasons

**`src/pages/Recordings.jsx:247`** swallows a sales-script load failure:
`.then(res => { if (res.script) setScript(res.script) }).catch(() => {})`. Low severity and left as is:
the script drawer simply renders empty, no data is lost, and the component already has a `loading`
state. Turning this into a visible error would need a new error state and a drawer affordance — a UI
change out of proportion to a missing optional document. Noted so it is a decision, not an oversight.

**`server/controllers/emailController.js`** stages attachments in a module-level `Map` shared by every
caller, up to `MAX_ATTACHMENTS = 5` × `MAX_EACH_BYTES = 10 MB` each, with a 15-minute TTL swept by an
`unref`'d 60 s interval. That is bounded and correctly `unref`'d (so it cannot hold the process open),
but many simultaneous half-composed emails could hold hundreds of megabytes. Left as is: it is a
resource-sizing question for a single-user desktop app, not a correctness defect, and changing it
means moving staging to disk.

**`src/webrtcSignalling.js:251-302`** — STUN only, no TURN, and `iceGatheringTimeout: 1000`. These are
the known browser-path limitations already recorded in earlier missions and unchanged here. They are
not new findings and are not silently defaulted: the ICE servers are explicit. Worth restating because
it bounds what the browser engine can do on a restrictive network, and because FlyNumber publishes no
WebSocket gateway at all, so for that carrier the native daemon is the only in-app path.

## Family-by-family coverage

Method key: **compiled** = built against real headers; **symbol** = Mach-O symbol table parsed;
**executed** = real code run under test; **grep+read** = class-targeted grep then the surrounding code
read; **read** = the relevant region read in full.

| Family | Files | Method | Result |
|---|---|---|---|
| `desktop/daemon/lib` | ua, dialog, transport, media, register, rtp, g711, sdp, protocol, audio/ | executed (60-check chaos suite, call-path, end-to-end) + grep+read | Clean this pass. Audited in missions 2-5; BUG 7/8/10 already fixed there. `ua.setMute` re-examined specifically for a second mute bug: it always returns `{ok:true}` and `ua.js:257` applies `this.muted` to a new dialog, so the flag is honoured — no defect. |
| `desktop/native/src` | pulse_audio.h, coreaudio_impl.mm, pulse_audio.mm | compiled + symbol + executed (host DSP harness) | **BUG 11-17 (mission 6) + BUG 23 + BUG 24 found and fixed.** See `.agents/rfcs/coreaudio-never-compiled.md` and the mission attempts record. |
| `desktop/lib`, `main.js`, `preload.js`, `scripts` | serverProcess.js, main.js (350), preload.js (62), run-desktop.js | executed (desktop-supervisor, new supervisor-ipc) + read | **BUG 19 found and fixed.** IPC reply matching verified under 18 concurrent commands, id-less event interleaving, no-daemon, and a real 10 s timeout via SIGSTOP. |
| `server/services` | 15 files, 3481 lines | grep+read, focused on callService/prospectService/telephonyService/carrierAccount/softphoneSession | **BUG 18 found and fixed.** `callService` guard order read (notFound → DNC → no-phone → daily cap → MIN_DIGITS) and is correct. `copilotService.js:157` re-asserts the local fields after spreading `remote`, which is the right way round and the opposite of BUG 10. |
| `server/controllers` | 8 files, 930 lines | grep+read | `recordingController.safeAudioPath` verified: `path.basename()` before `path.join`, so traversal is blocked at the source, with a `startsWith(recordingsDir)` check behind it. `emailController` recorded above. |
| `server/repositories` | 7 files, 829 lines | grep (parameter binding) + executed (repositories suite) | No string-interpolated SQL found; the `${}` hits in this layer are message text, not queries. |
| `server/db`, `config`, `routes` | migrate.js, env.js, routes/* | executed (migration suite, backend-connectivity 24/24) | Clean. `env.js`'s `DATA_DIR`/`PULSE_TEST` handling is what let two new suites isolate their databases. |
| `src` top level | useWebRtc.js (950), nativeSip.js (349), softphone.jsx, store.jsx, api.js, useServerQueue.js, queue.js | executed (new native-controls suite renders the real hook) + grep+read | **BUG 20/21/22 found and fixed.** Timer hygiene audited specifically: `rafRef`/`simRef` cleared in `releaseMedia`, the dial/ring/live one-shots registered into `tonesRef` with a `stop()` that clears all three, and the two bare `setTimeout`s are state-guarded. **No leak found** — the raw 6-timers-vs-2-clears count was misleading. |
| `src/pages` | Dialer.jsx (2040), Recordings.jsx (1087), Settings.jsx | grep+read | 3 `addEventListener` and 3 matching `removeEventListener` — no listener leak. `Settings.jsx:135` tests `sess?.engine === 'native'`, agreeing with the descriptor and with the fixed `engineOf`. **BUG 25 is in `src/components`, fixed.** |
| `src/components` | Notes.jsx and the rest | grep+read | **BUG 25 found and fixed.** |
| `src/utils` | phonetics.js (336), plain.js (205), tones.js (107), ringer.js (89), recorder.js (84) | executed (pronunciation suite, repaired this mission) | Clean. `plain.js` is what makes the renderer's pure logic testable in plain node, and `nativeSip.js` importing only `plain.js`/`ringer.js`/`tones.js` is what let the new hook harness load the real engine. |
| `test/helpers` | daemon-harness, mock-carrier, telephony-mocks, legacy-db | read | Clean. `legacy-db.js` deserves a note: its header records that an earlier version of the fixture marked migrations 1-6 as applied without applying them, so the migration test measured a lie. That is the same failure mode this sweep is guarding against. |

## VAL-SWEEP-002 — the large never-audited files

| File | Lines | Classes hunted | Outcome |
|---|---|---|---|
| `src/pages/Dialer.jsx` | 2040 | listener leaks, optimistic state, stale closures, guard order | No new defect. Listener add/remove balanced 3:3. Its three `toggleMute()` toast sites **were** consuming an optimistic return value and are fixed under BUG 20. It has a tracked-timer helper (`timersRef`, line 549-557) that clears every pending timeout on unmount — the right pattern, and the reason the file has no timer leak despite its size. |
| `src/useWebRtc.js` | 950 | optimistic state, swallowed errors, timer leaks, two-layer disagreement | **BUG 20/21/22 fixed.** Timer hygiene verified clean (above). |
| `src/webrtcSignalling.js` | 497 | silent defaults, uncleared timers, ICE handling | 4 timers vs 9 clears. STUN-only/no-TURN and the 1 s gathering timeout recorded above as known bounded limitations, not new defects. |
| `server/services/callService.js` | 433 | guard order, silent defaults, engine disagreement | Guard order correct. Writes `engine: 'native'` directly, bypassing `engineOf` — which is why `engineOf` returning `'pulse-sip-daemon'` went unnoticed, and why the new engine-descriptor suite asserts all three layers agree. |
| `server/services/prospectService.js` | 417 | SQL interpolation, validation gaps | No interpolated queries. Input validation is explicit and produces field-level errors (e.g. line 46, 247). |
| `server/controllers/recordingController.js` | 289 | path traversal, unsanitised input | `safeAudioPath` verified safe. |
| `server/controllers/emailController.js` | 221 | secret leakage, resource exhaustion, swallowed errors | No secret in any response path found by grep. Memory staging recorded above as a sizing note. |
| `src/utils/phonetics.js` | 336 | silent fallbacks | Exercised by the pronunciation suite, which was broken (`no such table`) until this mission repaired it — so its behaviour had never actually been verified before. It passes now. |
| `desktop/main.js` | 350 | id matching, timeout handling, restart loops | IPC verified under concurrency and a real frozen-daemon timeout. At its line ceiling; untouched. |

## What this sweep does NOT claim

It is a class-targeted hunt, not a line-by-line proof of absence. Every family above was searched for
the nine named classes and the largest files were read in the regions those classes live in; a defect
outside those classes, or one that needs a specific runtime state nobody thought to construct, would
not have been found. The honest statement is that these classes were hunted everywhere and the
findings above are what came out — not that the codebase has no remaining defects.

Two of the four defects found here (BUG 23, BUG 24) were invisible to every existing check and to
reading alone: they only appear when the code is compiled and its symbols inspected. That is the
strongest argument for the two new committed checks (`test/native/cross-compile.sh`,
`test/native/macho-symbols.py`) being part of the suite rather than a one-off investigation.
