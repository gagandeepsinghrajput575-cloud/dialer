# Post-closure Git audit

**Date:** 2026-10-23
**Baseline:** branch tip `e3cfc9c` (`arena/86f63651-dialer`).
**Scope:** changed call-path, native-engine, supervisor and credential files on the branch; not a claim that every unchanged repository file was re-reviewed. This is a follow-up audit record, not a new architecture proposal.

## Defects confirmed and repaired

| Area | Baseline evidence | Repair |
|---|---|---|
| Native outbound dial | The real hook failed RED with `Cannot access 'session' before initialization`; `start()` read the descriptor before its `let session`. | Fetch the current descriptor before engine selection and browser-media checks; use the native branch when selected, dispose a stale bridge on fallback. |
| Native DTMF | The refusal probe showed `true !== false`, and the keypad log contained the refused digit. | Await the daemon result; only accepted tones appear in the sent-tone log or return success. |
| Native inbound controls | The old implementation cleared the ring after a refused decline (`'idle' !== 'incoming'`). CRM matching also replaced the SIP dialog ID with CRM call ID `99`; answer then targeted the wrong dialog. An event-first answer could dereference a cleared entry. | Preserve `dialogId` separately; keep a refused decline visible; make answer and connected handling idempotent in either event order. |
| Supervisor stop/restart | A deterministic fake child proved a normal stop restarted after the 500 ms crash backoff (`true !== false`); a delayed old-child exit could orphan a replacement. | Track desired lifecycle state, ignore stale exits, settle pending commands, and restart the daemon when macOS re-activates the app. |
| Shutdown | The mock carrier received neither BYE nor `REGISTER Expires: 0` before the daemon closed UDP. | Send call teardown, await the authenticated unregister response with a bound, then close. The test checks both BYE and the carrier's 200 to the authenticated release. |
| Audio badge | The previous source reported `ready` when the renderer missed the daemon's early `ready` event and status said `audio: null`. | Retain audio errors in main-process status, read them when the engine starts, and apply late `ready` events to an already-registered badge. |
| SIP secret boundary | Against the old route/controller, a renderer session token returned HTTP `200` and the SIP secret. | Remove the renderer credential helper. Require the session token, a random in-memory daemon capability, and a no-Origin local-process request; reject browser-origin heartbeat/credential requests. Clear the capability on goodbye. |
| Settings form | The old schema accepted `native_sip_engine` and heartbeat fields. The Settings form sends a full settings object, so it could forge daemon liveness or select native mode. | Strip supervisor-owned fields from `settingsUpdate` and explicitly test the read-only exception to key parity. |

## Executed verification

- `npm run test:unit --silent` → **30/30 suites, 448 ✓ / 0 ✗**.
- `npm test --silent` → **38/38 groups passed**.
- `npm run test:ui --silent` → **230/230 UI race checks passed** on the built bundle.
- `npm run build --silent` → passed (Vite reports the existing large-chunk advisory).
- `bash test/native/dsp/run.sh` → **29/29** host DSP checks, including its HEAD negative control.
- Negative controls used the pushed sources for the native dial, decline/answer, supervisor stop, audio badge and credential-boundary probes; each reproduced its defect before the repair. The settings-schema probe compared `HEAD`'s accepted fields with the repaired schema's stripped fields.

## Still unproven

No Electron binary, real macOS/CoreAudio hardware, or real FlyNumber carrier call was available. The mock UDP carrier and host DSP harness do not prove device permission, real network/NAT behaviour, or audible hardware audio. The Zenith runtime still issued no assertion verdicts.
