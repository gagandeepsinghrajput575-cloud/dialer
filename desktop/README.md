# Pulse Dialer — desktop app and headless native SIP daemon

Dial and receive calls **inside Pulse Dialer**, with the microphone and speaker owned by macOS
itself. No Zoiper window, no Linphone, no second app to switch to, and no WebRTC gateway on the
carrier side — which is the part that makes this necessary:

> FlyNumber publishes a SIP trunk (`sip.flynumber.com:5060`, UDP). It has no public WebSocket
> gateway, so a browser tab cannot register with it at all. The app used to say
> `The browser softphone is not configured yet (missing: wsUrl)` and that was the truth: there is
> no `wsUrl` to configure.

So the phone lives in a **headless child process** that speaks plain SIP over UDP and opens
CoreAudio directly. Electron supervises it; the cockpit you already use drives it.

```
┌────────────────────────────── Electron main process (desktop/main.js) ─────────────────────────┐
│                                                                                               │
│  BrowserWindow ──preload.js──▶ window.pulseNativeSip                                          │
│       │                            │ ipcMain.handle('sip:command')                            │
│       │                            ▼                                                          │
│       │                     stdin  ─────────▶  pulse-sip-daemon  ──UDP SIP/RTP──▶  carrier     │
│       │                     stdout ◀─────────  (desktop/daemon)  ◀──CoreAudio───▶  mic / spk   │
│       │                                                                                       │
│       └── loads http://127.0.0.1:3001/  ◀── heartbeat every 10 s ──▶  server/services/*       │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

While the supervisor beats, the server hands the in-app phone to the daemon
(`server/services/softphoneSession.js`). The moment it stops — quit, crash, window closed — the
app falls back to the browser engine. Nothing is configured by hand to make that switch.

---

## Quick start (macOS, Apple Silicon)

```bash
npm install                 # repository root — better-sqlite3 compiles here
npm i -D electron@^33       # NOT a dependency of the repo, see "Why Electron is not installed"
npm run build               # the renderer into dist/
bash desktop/scripts/build-daemon.sh    # builds the CoreAudio addon + self-tests the daemon
npm run desktop             # the app: window, server (if not already running) and daemon
```

Then, in **Settings → Telephony**:

* *Telephony mode* → **In-browser WebRTC softphone** (this is the "call happens in the app" mode;
  the engine inside it is chosen for you),
* *FlyNumber Inbound SIP Credentials* → server `sip.flynumber.com`, your SIP user and password,
* press **C** in the Dialer.

The card labelled **Native softphone (desktop app)** says which engine is live, what it will
register (`user@sip.flynumber.com:5060`), the caller ID it will present, and the audio backend and
pid of the daemon. If the daemon is not running, it says so and tells you what to run.

### Without Electron (development, CI, a Linux box)

Everything except the window works, and is tested:

```bash
node test/unit/sip-daemon.test.js            # the daemon against a mock carrier on real UDP
node test/unit/native-sip.test.js            # the server's half of the contract
node test/unit/desktop-supervisor.test.js    # the supervisor, with Electron stubbed out
./desktop/bin/pulse-sip-daemon --help
./desktop/bin/pulse-sip-daemon --api-base http://127.0.0.1:3001 --audio coreaudio
```

---

## What is in here

| Path | What it is |
| --- | --- |
| `main.js` | The Electron main process: window, daemon supervision, heartbeat, IPC routing, restart with backoff. |
| `preload.js` | The whole door between the page and the daemon — four functions, two strings. `contextIsolation` on, `nodeIntegration` off. |
| `lib/serverProcess.js` | Adopts a running API server, or starts `server/index.js` as a child. Never a second one on the same SQLite file. |
| `bin/pulse-sip-daemon` | The launcher named in the spec: compiled binary → Electron-as-Node → `node`. POSIX `sh`, executable. |
| `daemon/` | The daemon itself. **Zero dependencies**, Node 18+. |
| `daemon/main.js` | Flags, credential hydration, the action dispatcher, the control socket. |
| `daemon/lib/` | `transport.js` (UDP SIP, RFC 3261 timers), `ua.js`, `dialog.js`, `register.js`, `media.js` (RTP), `sipMessage.js`, `sdp.js`, `digest.js`, `g711.js`, `rtp.js`, `protocol.js`, `credentials.js`. |
| `daemon/lib/audio/` | `coreaudio` (native addon) → `portaudio` (optional) → `null` (no sound card; signalling still runs). |
| `native/` | The CoreAudio addon: `binding.gyp`, `src/pulse_audio.h`, `src/coreaudio_impl.mm` (device + realtime callbacks), `src/pulse_audio.mm` (N-API bindings). |
| `scripts/build-daemon.sh` | One command on a Mac: build the addon, self-test the daemon, print what to run next. |
| `scripts/run-desktop.js` | `npm run desktop`, with an error message that names the fix. |
| `scripts/release-phone.js` | Synchronous "the phone is gone" on quit, because `will-quit` cannot await. |

### Why there is no 40 MB binary

The daemon is JavaScript. SIP, SDP, digest auth, RTP, G.711 and RFC 2833 DTMF are all implemented
under `daemon/lib/` with no dependencies at all, so there is nothing to compile for the signalling
half — and one artefact runs identically on Apple Silicon, Intel and Linux, including in CI, where
`test/unit/sip-daemon.test.js` drives the real daemon over a real UDP socket.

The only platform-specific piece is the audio device, and that is a small N-API addon
(`desktop/native/build/Release/pulse_audio.node`) built by `scripts/build-daemon.sh`. At runtime the
daemon is executed by the Electron binary the app already ships (`ELECTRON_RUN_AS_NODE=1`), so a
packaged `.app` needs no separate Node install either.

If you would rather have a single self-contained executable, `scripts/build-daemon.sh` is the place
to add it: drop the result at `desktop/bin/pulse-sip-daemon.bin` and the launcher will prefer it.

### Why Electron is not installed

`npm i electron` downloads a platform binary from a release host. On a locked-down network, a proxy
or a CI runner that download fails, and a failed postinstall takes the whole repository's
`npm install` with it — Pulse Dialer must still build, serve and pass 38 test groups without it. So
Electron is a documented one-liner (`npm i -D electron@^33`) and `npm run desktop` explains itself
when it is missing.

---

## The IPC protocol

JSON lines. **Commands in on stdin, events out on stdout, logs on stderr only** — that separation is
what lets a controller treat stdout as a protocol instead of guessing which line was a `console.log`.

Every command is answered, always, with `{ "id": <the id you sent, as a string>, "ok": true|false, … }`.
A command that cannot be honoured answers `ok: false` with a reason; it never goes silent.

### Commands

| Action | Payload | Notes |
| --- | --- | --- |
| `hello` | — | version, audio backend, the list of actions |
| `register` | `{ domain, port, user, password, callerId, transport, expires }` | all optional: with `--api-base` the daemon fetches its own account |
| `unregister` | — | sends `REGISTER` with `Expires: 0` |
| `dial` | `{ number, callId }` | `callId` is the CRM call row, echoed back on every event |
| `answer` | `{ callId }` | answers the ringing call; 200 OK carries our SDP |
| `reject` | `{ callId, code }` | default `486`; the UI's decline sends `603` |
| `hangup` | `{ callId }` | BYE for a connected call, CANCEL/603 while ringing |
| `mute` | `{ enabled }` | stops the send path; RTP keeps flowing so the far end hears silence, not a dead line |
| `dtmf` | `{ digit }` | RFC 2833 `telephone-event`, with the end-of-event packet retransmitted |
| `status` | — | registration, audio, transport, current call, dialog count |
| `devices` | — | input/output device list from the audio backend |
| `audio` | — | backend description: name, rate, frame size, opened, frames |
| `log-level` | `{ level }` | `debug` \| `info` \| `warn` \| `error` |
| `shutdown` | — | BYE for a live call, unregister, exit 0 |

### Events

`ready`, `account`, `registered`, `unregistered`, `registering`, `registration_failed`, `incoming`,
`ringing`, `dialing`, `provisional`, `connected`, `ended`, `mute`, `dtmf`, `audio_level`, `state`,
`rejected_incoming`, `log`, `error`, `shutdown`.

The three the UI cannot function without:

```jsonc
{ "event": "incoming",  "callId": 1, "callerPhone": "+4520123456" }
{ "event": "connected", "callId": 1, "codec": "PCMU", "direction": "inbound" }
{ "event": "ended",     "callId": 1, "reason": "normal", "status": 200, "durationSec": 41 }
```

`ended.reason` is one of `normal`, `busy`, `rejected` (plus `canceled`, `no-answer`, `error`), and
carries `rawReason` when the SIP cause was something else — a `486` becomes `busy` with
`status: 486`, a remote BYE becomes `normal`.

### Try it by hand

```bash
./desktop/bin/pulse-sip-daemon --domain sip.flynumber.com --user USER --password PASS \
    --caller-id +4532331610 --audio coreaudio --log-level debug
{"id":1,"action":"status"}
{"id":2,"action":"dial","number":"+4520123456"}
{"id":3,"action":"mute","enabled":true}
{"id":4,"action":"hangup"}
```

Or let it read its own account — the recommended way, and the only way the SIP password stays out
of a process list and a shell history:

```bash
./desktop/bin/pulse-sip-daemon --api-base http://127.0.0.1:3001 --audio coreaudio
```

---

## Credentials, and the rule about the browser

The SIP password is released by exactly one endpoint, `GET /api/telephony/carrier-credentials`,
which demands the session token and is read by **the daemon process**, not the page. The renderer's
descriptor (`GET /api/telephony/webrtc-session`) always says `password: ""`. So the promise the
Settings screen makes — *your credential stays in this computer's local database* — holds in native
mode too, and the `webrtc_credential_handoff` switch is simply not needed: a daemon can register
without handing anything to a browser.

The account the daemon gets is chosen in `server/services/carrierAccount.js`: FlyNumber whenever its
SIP user and password are saved, otherwise the dormant legacy Telnyx SIP settings. Telnyx is never
deleted — an install that only has Telnyx gets a native phone too.

---

## Building on macOS

```bash
xcode-select --install
bash desktop/scripts/build-daemon.sh
```

That builds `desktop/native/build/Release/pulse_audio.node` for `aarch64-apple-darwin`, then
self-tests the daemon (it must print `{"event":"ready", …}` and answer `hello`).

For distribution:

```bash
PULSE_SIGN_IDENTITY="Developer ID Application: You (TEAMID)" bash desktop/scripts/build-daemon.sh
# then notarise the .app that bundles the addon:
xcrun notarytool submit Pulse.app.zip --apple-id … --team-id … --wait
```

Requirements: macOS 12+ (the addon's deployment target), Xcode command line tools, Node 18+.
The addon is arm64; on an Intel Mac pass `npm_config_arch=x64` to the build.

### The honest gap

**No compiled `aarch64-apple-darwin` binary is checked into this repository.** Producing one needs
the macOS SDK, `ld64` and a signing identity, and the environment this was written in is Linux with
no route to Apple's toolchain — so a "binary" produced there would be fabricated, not built. What
ships instead is everything needed to make it in one command on the target machine:

* the complete daemon source (no dependencies, nothing to compile for SIP),
* the complete CoreAudio addon source and its `binding.gyp`,
* `desktop/bin/pulse-sip-daemon` — executable, tested here against a mock carrier,
* `desktop/scripts/build-daemon.sh` — builds, signs if asked, self-tests, prints the next step.

Run it once on the Mac and the artefact exists at
`desktop/native/build/Release/pulse_audio.node` (and `desktop/bin/pulse-sip-daemon.bin` if you add a
packaging step). Nothing else in the app changes when it does.

---

## Failure modes, and what the agent sees

| What happened | What the app does |
| --- | --- |
| Daemon never started | The Settings card says "Not running" with the command; the browser engine keeps the phone. |
| Daemon crashes mid-shift | Restarted with backoff (0.5 s → 30 s), renderer told via `{ event: "supervisor", restarting: true }`. |
| Heartbeat lapses 45 s | The server stops claiming a native phone; the next dial goes through the browser engine. |
| Carrier refuses registration | `registration_failed` → the standby badge shows the reason (e.g. `403 Forbidden`), with backoff at 5 s / 10 s / 20 s / 45 s. |
| No audio device | The daemon still runs on the `null` backend: registration and signalling work, the UI says "no audio device" instead of going quiet. |
| Microphone permission refused | macOS 14 asks once per app; `AudioOutputUnitStart` fails and the error says permission is the likely cause (System Settings → Privacy → Microphone). |
| Second inbound call while one is live | Refused with `486 Busy Here` — one audio device means one call. |
| Two windows / two tabs | One cross-tab lock (`navigator.locks`) decides who rings; the other says "Call in progress on another tab". |
| App quit during a call | BYE is sent, the daemon unregisters, and `scripts/release-phone.js` tells the server synchronously. |

---

## Tests

| Suite | What it proves |
| --- | --- |
| `test/unit/sip-daemon.test.js` | 18 checks. Spawns the **real** daemon against `test/helpers/mock-carrier.js` on a real UDP socket: 401 digest challenge, outbound call with PCMU both ways, mute, RFC 2833 DTMF, local and remote BYE, `486` → busy, inbound INVITE → 180 → 200 → audio, 603 on decline, one-call-at-a-time, malformed input, shutdown mid-call. Plus the pure libraries: G.711 round-trip, SDP negotiation, the RFC 2617 digest reference vector, SIP parsing, RTP arithmetic. |
| `test/unit/native-sip.test.js` | 10 checks. The server's half: inert by default, one heartbeat switches the engine, the secret only leaves behind a token, the dial URI becomes UDP SIP, a stale beat hands the phone back, readiness names exactly what is missing. |
| `test/unit/desktop-supervisor.test.js` | 7 checks. `desktop/main.js` with Electron absent: spawns the daemon, matches answers to command ids, beats the heartbeat, releases the phone on quit, restarts cleanly, and adopts a running API server instead of starting a second one. |
| `test/unit/sip-daemon.test.js` in CI | Runs with `--audio=null`, so no sound card is needed anywhere. |

```bash
npm run test:unit          # every suite, including the three above
node test/all-tests.js     # the 38 integration groups — unchanged by this feature
```

The native engine is **inert by default**: with no daemon beating, every existing assertion about
the browser engine, the Telnyx settings and `test-softphone` passes byte-for-byte as before.
