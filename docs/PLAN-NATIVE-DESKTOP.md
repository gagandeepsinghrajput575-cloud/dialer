# Native macOS dialer — engineering plan (Option B, with E/A fallback)

**Baseline:** `edfa937` (the brief's `0f4a919` does not exist upstream; `origin/main` is `edfa937`).
**Branch:** `arena/0da1c1ab-dialer`.

## 1. Post-mortem: why the browser leg failed

| Failure | Root cause | Fix location |
| --- | --- | --- |
| Answer takes seconds, Telnyx cancels at 10 s | `getUserMedia` → `RTCPeerConnection` → ICE → SDP answer, all on one JS event loop | Desktop shell grants mic at process start; no per-answer permission prompt |
| Remote audio never plays | Chromium autoplay policy suspends the output `AudioContext` until a gesture; RTP arrives before unlock | `autoplay-policy=no-user-gesture-required` + `autoplayPolicy` webPreference in the desktop shell |
| `sessionDescriptionHandlerFactory` throws | Getter-only in strict ESM under `sip.js` 0.21 | Desktop path never rewrites the factory; native SIP uses our own transport |
| Tab lifecycle owns the call | Closing/backgrounding the tab kills the call | Call lives in the Electron main process / a persistent window |

## 2. Decisions

1. **Two engines, one contract.**
   - `webrtc` (default, Option B2): Electron renderer runs the existing `useWebRtc` engine with
     autoplay unlocked. Chromium's macOS audio backend *is* CoreAudio, so mic/speaker bind to the
     hardware with no browser policy in the way. This is the path that gives two-way audio today.
   - `native-sip` (Option B1-lite): a plain-Node SIP user agent that registers over **UDP/TCP
     5060** to `sip.telnyx.com`, answers every INVITE with `180 Ringing` inside the SBC window,
     and hands media to the OS softphone (Option E/A) because a native RTP/CoreAudio media
     pipeline cannot be compiled for macOS inside this Linux sandbox. Signalling is real and
     tested; media is explicitly delegated rather than faked.
2. **No duplicated business logic.** Phone normalisation stays in
   `server/services/telephonyService.js`; Danish phonetics stay in `server/services/danishPhonetics.js`
   and `src/utils/phonetics.js`. The brief's `shared/phone.mjs` / `shared/phonetics.mjs` do not exist
   in this repository, and creating them would fork the source of truth.
3. **The renderer stays web-first.** `src/desktop/bridge.js` is inert when `window.pulseDesktop` is
   absent, so the existing browser app, its tests and the live preview are untouched.
4. **Option E/A is a first-class fallback, not an error path.** When native media is unavailable the
   desktop shell opens `sip:<number>@sip.telnyx.com` (or `tel:`) in Linphone; Pulse keeps the queue,
   phonetics, notes, dispositions and the SQLite ledger.
5. **Security is unchanged.** The new `GET /api/telephony/desktop` descriptor contains no password and
   is guarded by `x-pulse-token`, exactly like `webrtc-session`. The desktop process fetches the
   session token over loopback before writing to the ledger.

## 3. File map (all new files ≤ 350 lines)

```
desktop/
  main.js               Electron lifecycle, window, mic permission, dock/menu wiring
  window.js             BrowserWindow factory (#0f172a frame, preload, autoplay preferences)
  menu.js               macOS menu bar + dock badge + native notifications
  preload.js            contextBridge -> window.pulseDesktop (frozen, no node in renderer)
  config.js             carrier constants, build metadata re-export, pulse:// parser
  bridge.js             main-process call state machine + IPC fan-out
  ledger.js             token-aware loopback client for the CRM ledger
  sip/message.js        SIP parse/serialise/framing (RFC 3261 subset)
  sip/digest.js         RFC 2617 MD5 digest
  sip/transport.js      UDP/TCP transport, retransmission, stream framing
  sip/ua.js             REGISTER/OPTIONS/INVITE routing, auth retry, refresh
  sip/call.js           dialog: 180/200/486/487, ACK, BYE, DTMF, SDP
  sip/sdp.js            minimal audio SDP offer/answer
server/
  config/buildInfo.js           BUILD_METADATA watermark
  services/desktopBridgeService.js  descriptor served to the shell
src/desktop/bridge.js    renderer-safe IPC facade (inert in a browser)
src/components/DesktopBridgeCard.jsx  Settings panel: native status + copyable fallback config
test/unit/desktop-telephony.test.js   SIP, digest, framing, UA, call and bridge coverage
test/unit/live-call-hardening.test.js Challenges 1–8 (incl. the ≤350-line ceiling)
```

## 4. Call lifecycle contract

```
INVITE ──► 100 Trying ──► 180 Ringing  (immediately; SBC timer satisfied)
                              ├── answer()  ──► 200 OK + SDP ──► ACK ──► connected ──► BYE ──► ended{duration}
                              ├── decline() ──► 486 Busy Here ──► ended{reason:'declined'}
                              └── CANCEL    ──► 200 (CANCEL) + 487 (INVITE) ──► ended{reason:'canceled'}
```

Ledger: `ringing → connected → completed`, written through the existing
`POST /api/calls/inbound` / `PATCH /api/calls/:id` endpoints. No new tables, no schema change.

## 5. Verification gates

1. `npm test` → 38/38 groups.
2. `npm run test:unit` → every suite green, including the two new ones.
3. `node test/ui/dialer-race.test.js` → all checks green against a fresh `dist/`.
4. Line ceiling challenge → every file under `desktop/`, `server/`, `src/` at ≤350 lines, or a
   documented, non-growing grandfather entry for pre-existing debt.
5. `npm run build` → clean, < 1 s.

## 6. Risks and mitigations

- **Electron cannot be installed or run in this Linux sandbox.** The shell is built and linted by
  tests against pure modules; `main.js`/`window.js` are exercised through injected fakes. Packaging
  instructions and entitlements are checked in so `npm run desktop:dist` works on macOS.
- **better-sqlite3 is a native module.** Electron requires its own ABI rebuild; `electron-rebuild`
  is wired into the desktop scripts and documented.
- **Native media.** Explicitly out of scope for this environment; the E/A handoff covers it and the
  UI states which engine is live instead of pretending.
