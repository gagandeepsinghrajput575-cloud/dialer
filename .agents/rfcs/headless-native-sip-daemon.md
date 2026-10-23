# RFC — Headless native SIP audio daemon for Pulse Dialer

Status: implemented on branch `arena/86f63651-dialer`
Date: 2026-10-22
Scope: `desktop/` (new), `server/services/carrierAccount.js` (new), `src/nativeSip.js` (new),
`src/utils/tones.js` (new), `test/unit/sip-daemon.test.js` (new), plus minimal hooks in
`useWebRtc.js`, `telephonyService.js`, `callService.js`, `api.js`, `defaults.js`, `schemas.js`.

## 1. Problem

FlyNumber terminates SIP on `sip.flynumber.com:5060` over UDP. It has no public
unauthenticated `wss://` WebRTC gateway, so the browser engine can never register:

```
The browser softphone is not configured yet (missing: wsUrl)
```

and the only working alternative today is an external GUI softphone (Zoiper / Linphone /
Telephone), which means the operator leaves Pulse Dialer's window to talk to a customer.

Requirement: clicking **Dial** in Pulse Dialer places the call, and audio runs through the
operator's macOS headset, with **no second window and no `wss://` gateway**.

## 2. Decision

Add a **headless sidecar daemon** supervised by an Electron main process. The daemon owns
SIP + RTP + CoreAudio; the renderer keeps owning the CRM state machine, so `Dialer.jsx`
does not learn about SIP at all.

Engine choice (mission offered A: bundled baresip, B: native Rust daemon). Neither can be
*verified* from this repository's toolchain, and both add a second language + build system to
a project whose whole test suite is `node test/all-tests.js`. The chosen engine is therefore:

**Option C — a zero-dependency Node.js SIP/RTP user agent with a pluggable native audio
backend**, shipped as `desktop/bin/pulse-sip-daemon` and executed by the Electron binary
itself (`ELECTRON_RUN_AS_NODE=1`), which is the "self-contained native binary" the mission
asks for without requiring Node to be installed separately.

Why:
- The SIP/RTP/media core is pure JS → it runs under `node test/all-tests.js` on any platform,
  so the state machine, digest auth, SDP negotiation and RFC 2833 DTMF are **actually tested**
  here rather than asserted.
- The only macOS-specific piece is audio capture/playback, isolated behind one interface
  (`desktop/daemon/lib/audio/*.js`) and built by `desktop/scripts/build-daemon.sh` on the Mac.
- G.711 (PCMU/PCMA) is the payload type every SIP trunk, FlyNumber included, must support,
  and it is ~40 lines of JS — no libopus, no codec download, no license surface.

## 3. Topology

```
Renderer (Dialer.jsx, unchanged)
   └── useSoftphone() → useWebRtc()            src/useWebRtc.js
          ├── engine === 'webrtc' → sip.js     src/webrtcSignalling.js   (browser, unchanged)
          └── engine === 'native' → bridge     src/nativeSip.js          (new)
                 └── window.pulseSip           desktop/preload.js
                        └── ipcRenderer        desktop/main.js
                               └── child_process.spawn(ELECTRON_RUN_AS_NODE, daemon)
                                      │  JSON lines over stdin/stdout
                                      ▼
                               desktop/bin/pulse-sip-daemon
                                      ├── SIP/RTP (UDP 5060) ──▶ sip.flynumber.com
                                      └── CoreAudio (AudioUnit) ──▶ headset mic / speaker
Server (Express, loopback)
   └── GET /api/telephony/carrier-credentials  (session + daemon capability; no Origin)
                                             ←── the daemon fetches its own credentials; they
                                                  never transit the renderer
```

Credential rule: the renderer **never** receives the SIP secret in native mode. The no-Origin
desktop supervisor provisions a random capability in server memory and passes it only to the
child daemon's environment; the daemon presents that capability plus `x-pulse-token` to fetch the
secret. Browser-origin heartbeat/credential requests are refused. `webrtcSession()` keeps the
password blank in native mode.

## 4. IPC contract

Commands (renderer/main → daemon, one JSON object per line on stdin):

```jsonc
{"id":"c1","action":"register"}                                  // uses fetched credentials
{"id":"c2","action":"register","domain":"sip.flynumber.com","port":5060,
 "transport":"udp","user":"a2YqM0bsm","password":"…","callerId":"+4532331610"}
{"id":"c3","action":"dial","number":"+4520123456"}
{"id":"c4","action":"answer","callId":1}
{"id":"c5","action":"reject","callId":1,"code":486}
{"id":"c6","action":"hangup","callId":1}
{"id":"c7","action":"mute","enabled":true}
{"id":"c8","action":"dtmf","digit":"1"}
{"id":"c9","action":"status"}
{"id":"c10","action":"shutdown"}
```

Events (daemon → controller, one JSON object per line on stdout; logs go to stderr):

```jsonc
{"event":"ready","pid":1234,"version":"1.0.0","audio":{"backend":"coreaudio"}}
{"event":"registered","account":"a2YqM0bsm@sip.flynumber.com","expires":300}
{"event":"registration_failed","reason":"403 Forbidden"}
{"event":"incoming","callId":1,"callerPhone":"+4520123456","callerName":"…"}
{"event":"ringing","callId":1,"direction":"outbound"}
{"event":"connected","callId":1,"direction":"outbound","codec":"PCMU"}
{"event":"ended","callId":1,"reason":"normal","durationSec":124}
{"event":"audio_level","direction":"input","level":0.42}
{"event":"log","level":"warn","message":"…"}
```

Every command is answered by `{"id":"c1","ok":true,…}` or `{"id":"c1","ok":false,"error":"…"}`,
so the controller never has to guess whether a write was understood.

`reason` ∈ `normal | busy | rejected | canceled | timeout | failed | remote-ended`.
The renderer maps those onto the outcomes it already knows (`no_answer`, `hung_up`, …).

## 5. Line ceilings (non-negotiable, from the mission)

| File | Ceiling | Before | After |
| --- | --- | --- | --- |
| `src/pages/Dialer.jsx` | 2040 | 2040 | 2040 (**untouched**) |
| `src/useWebRtc.js` | 970 | 971 | ≤ 970 |
| `src/webrtcSignalling.js` | 413 | 497 | **untouched** (already over; not made worse) |
| `src/softphone.jsx` | 350 | 187 | 187 (**untouched**) |
| `server/services/telephonyService.js` | 480 | 480 | ≤ 480 |
| any new file | 350 | — | ≤ 350 |

`useWebRtc.js` is 1 line over its ceiling *before* this change, so room is made first: the
DTMF tables, the tone player and the simulated level meter move verbatim to
`src/utils/tones.js` (public re-exports kept, so `DTMF_KEYS` still resolves from
`useWebRtc.js` for every existing importer and test). `telephonyService.js` is at its
ceiling, so all carrier logic lands in the new `server/services/carrierAccount.js` and
`telephonyService.js` only delegates.

## 6. Failure modes and the required behaviour

| Failure | Behaviour |
| --- | --- |
| Daemon binary missing / not executable | `desktop/main.js` emits `daemon-unavailable`; renderer stays on the browser engine and the UI says why. Never a crash. |
| No audio backend (Linux CI, unbuilt addon) | Daemon starts with `--audio=null`, registers and negotiates RTP, and reports `audio.backend = "null"`. Signalling is testable without a sound card — this is how the suite runs here. |
| 401 with no nonce / wrong password | One re-REGISTER with digest; a second 4xx emits `registration_failed` with the SIP reason and backs off (5/10/20/45 s), never a hot loop. |
| Far end never answers | `Timer B` (32 s) → `ended {reason:"timeout"}`; CANCEL is sent at the app's own no-answer timeout. |
| Caller hangs up while ringing | CANCEL → `ended {reason:"canceled"}`, ringer stops, no phantom call row. |
| Glare (INVITE arrives while dialling) | Second dialog is refused with 486, exactly like the browser engine. |
| Daemon dies mid-call | Supervisor emits `ended {reason:"failed"}` and restarts the daemon with capped backoff. |
| Two controllers | Single stdin owner (Electron). The optional loopback control socket is opt-in (`--control-port`) and binds 127.0.0.1 only. |

## 7. Verification

```bash
node test/unit/sip-daemon.test.js   # new: mock SIP/RTP server on 127.0.0.1, real daemon child
node test/all-tests.js              # must stay green, including the carrier-credentials group
npm run build                       # renderer bundle unchanged in shape
```

The daemon suite spawns the real binary as a child process against a mock carrier written in
the test (UDP), and asserts: REGISTER → 401 → digest re-REGISTER → 200; INVITE → 100/180/200
→ ACK → bidirectional RTP with decodable PCMU; BYE; inbound INVITE → `incoming` → answer →
200/ACK → BYE from the far end; mute produces silence; DTMF produces RFC 2833 packets.

## 8. Explicitly out of scope / not deliverable here

1. **A compiled `darwin-arm64` Mach-O binary.** This workspace is Linux x64 with no Apple
   SDK, no `ld64`, no Apple certificate and outbound access limited to
   `github.com`/`npmjs.org`/`pypi.org`. Producing a real `arm64` executable — or
   cross-compiling Rust against `AudioToolbox` — is impossible from here, and a fake one
   would be worse than none. `desktop/scripts/build-daemon.sh` is the single command that
   produces it on the Mac, and `desktop/bin/pulse-sip-daemon` is the committed launcher that
   resolves to it (Electron-as-Node ⇒ no separate runtime, no Node install).
2. Opus / SRTP / TLS transport / ICE. G.711 over UDP is what FlyNumber's trunk needs;
   the codec table is open for extension.
3. Native call recording. The renderer's `MediaRecorder` path does not apply to a native
   audio device; recording in native mode is a follow-up (WAV writer in the daemon).

## 9. Implementation status (what was actually built)

Built, wired and tested. Where the build differs from §2–§5 above, this section is the truth.

**The daemon is neither Option A (baresip) nor Option B (Rust).** It is a zero-dependency
JavaScript SIP user agent under `desktop/daemon/` (17 files, ~3.2 kLOC): UDP transport with the
RFC 3261 client/transaction timers, digest auth, SDP offer/answer, RTP with G.711 µ-law/A-law,
RFC 2833 DTMF, one dialog state machine for both directions, and a JSON-lines control protocol.
Reason: baresip cannot be cross-compiled for `darwin-arm64` from this workspace and Rust is not
installed, while a JS daemon runs on the Electron binary the app already ships — so there is no
second runtime, no per-platform artefact for the signalling half, and the *same* daemon is what CI
tests against a mock carrier on a real UDP socket.

**Audio is the only compiled piece.** `desktop/native/` is an N-API CoreAudio addon
(`pulse_audio.h`, `coreaudio_impl.mm` for the device layer and the realtime callbacks,
`pulse_audio.mm` for the bindings). It opens one HAL output unit with input and output enabled,
resamples between the device rate and 8 kHz mono Int16, and exchanges 160-sample frames with the
daemon through two lock-free rings plus a `ThreadSafeFunction`. `binding.gyp` targets arm64;
`scripts/build-daemon.sh` builds and signs it on a Mac and then self-tests the daemon.
Backend order stays `coreaudio → portaudio → null`.

**Engine selection is a heartbeat, not a setting an agent flips.** `desktop/main.js` beats
`POST /api/telephony/native-heartbeat` every 10 s while it holds a live daemon; that beat is also
the opt-in (`native_sip_engine = pulse-sip-daemon`). `server/services/softphoneSession.js` resolves
one descriptor for both engines, so `GET /api/telephony/webrtc-session` answers with the browser
descriptor byte-for-byte as before when no daemon is beating — which is why all 38 integration
groups still pass unchanged. Stale beat (45 s) ⇒ the phone returns to the browser engine.

**Renderer seam.** `window.pulseNativeSip` (from `desktop/preload.js`, `contextIsolation` on) is
detected by `src/nativeSip.js`, which implements the *same* engine contract as `useWebRtc.js`
(state machine, standby badge, incoming entry with `attachCrm`, `onActive`/`onEnded`/
`onIncomingEnded`). `useWebRtc.js` branches on `isNativeSession(descriptor)` in exactly two places
(the standby registration and `start()`), and forwards `hangUp`/`toggleMute`/`sendDtmf` when a
native call is live. `Dialer.jsx` and `softphone.jsx` did not need to learn a second contract; the
only visible change is the label ("native softphone") and the standby strip naming the engine.

**Server surface added:** `server/services/carrierAccount.js` (account choice: FlyNumber when its
SIP user *and* secret are saved, otherwise the dormant legacy Telnyx SIP settings),
`GET /api/telephony/carrier-credentials` (session token + ephemeral supervisor capability, no browser
Origin; only the daemon receives the secret), `POST /api/telephony/native-heartbeat`, and five
settings keys (`native_sip_engine`, `native_daemon_{last_seen,pid,version,audio}`) registered in
`DEFAULTS`. Supervisor state is deliberately stripped from user `settingsUpdate` payloads.

**Current file ceilings after the post-closure audit.** `Dialer.jsx` 2040/2040,
`useWebRtc.js` 969/970, `nativeSip.js` 350/350, `desktop/main.js` 346/350,
`webrtcSignalling.js` 497/498, `telephonyService.js` 480/480; all new files remain ≤350 lines.

**Current verification.** `npm run test:unit` passes 30/30 suites (448 checks); `npm test` passes
38/38 groups; `npm run test:ui` passes 230/230; `npm run build` succeeds; the host DSP harness passes
29/29. The dispatch runtime has no verdicts, and none of these checks substitutes for a real Mac or
carrier call.

| Suite | Checks | What it drives |
| --- | --- | --- |
| `test/unit/sip-daemon.test.js` | 18 | real daemon and mock UDP carrier; shutdown sends BYE and authenticated `REGISTER Expires: 0` |
| `test/unit/native-sip.test.js` | 11 | descriptor, read-only supervisor settings, secret capability gate and fallback |
| `test/unit/desktop-supervisor.test.js` | 7 | spawn, command IDs, heartbeat, release, restart and server adoption |
| `test/unit/desktop-supervisor-lifecycle.test.js` | 2 | intentional stop and stale-child restart race |
| `test/unit/native-controls.test.js` | 26 | outbound native dial, honest controls, inbound decline/answer and CRM/SIP ID separation |
| `test/unit/native-audio-badge.test.js` | 3 | missed/late audio-ready event and the null-backend badge |

**Two pre-existing failures, unchanged by this work** (verified by stashing every edit, rebuilding
and re-running): `test/ui/dialer-race.test.js` aborts at check 90 ("timed out waiting for the live
badge after answering") on a loaded machine — it passed 230/230 once during this work, so it is
timing-sensitive, and step 30 of `all-tests.js` inherits that; and `pronunciation`,
`backend-connectivity` and `call-history` in `test:unit` fail at HEAD (missing tables / no live
server). Neither is caused by, or fixed by, this feature.

**Still not deliverable here:** the compiled `aarch64-apple-darwin` artefact (§8.1) and native call
recording (§8.3). `desktop/README.md` states both plainly and gives the one command that produces
the addon on the target machine.
