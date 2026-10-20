# Pulse Dialer — Master Engineering Brief & Invariant Guard for Argon AI

> **Target Agent**: Argon AI (Automated Bug Solver & System Reviewer)  
> **Workspace Root**: `/Users/gaganrajput11/Downloads/workspace-01a0f89f-f130-7eed-997f-341234f82d1e/dialer`  
> **System Date**: October 2026  
> **Mandate**: Resolve edge cases, audit defects, and harden without breaking established architectural invariants, telephony bridges, or test suites.

---

## 1. Executive Summary & Architecture Topology

Pulse Dialer is a production-grade, high-velocity B2B cold-calling dialer and mini-CRM tailored for Danish sales outreach.

### System Stack
* **Frontend**: React 19, Vite 8.3, Vanilla CSS (`src/styles.css` — dark glassmorphic `#0f172a` design system, **NO Tailwind CSS**), Framer Motion, `@dnd-kit/core`, `lucide-react`.
* **Backend**: Node.js (v24), Express 5, `better-sqlite3` (12.x) in high-concurrency WAL mode (`synchronous=NORMAL`, `busy_timeout=5000`, Foreign Keys ON).
* **Telephony Gateway**:
  * SIP Client: `sip.js` (0.21.2) WebRTC UserAgent.
  * Carrier: Telnyx RFC 3261 SIP.js proxy at `wss://sip.telnyx.com:7443` (Credential connection: `usertanishkarajput43011498`).
  * Inbound DID: FlyNumber Copenhagen DID (`+45 32 33 16 10`).
* **AI & Phonetics Microservices**:
  * Neural TTS: Kokoro-82M (`scripts/kokoro_server.js`) on `http://localhost:5050` for Danish phonetic name pronunciation.
  * Audio Coach & Script Auditor: Gemini 2.5 Flash / OpenRouter multimodal audio analysis (`server/services/aiRecordingCoach.js`).
  * Lead Sorter: AI extraction of Danish CVR, decision-makers, and Google Maps (`server/services/aiLeadSorter.js`).
* **Local Mail Sink**: Nodemailer sandboxed email ledger for testing follow-up templates (`server/services/emailService.js`).

---

## 2. Telephony Bridge & Inbound Status Truth (READ BEFORE TOUCHING VOIP)

### Inbound Architecture
* **FlyNumber DID**: `+45 32 33 16 10` is active on FlyNumber.
* **Forwarding Path**: FlyNumber forwards calls to Telnyx via SIP URI: `sip:usertanishkarajput43011498@sip.telnyx.com:5060`.
* **Why Recents/Inbound Currently Shows 0 Calls**:
  1. Pulse Dialer was initially running in **Dry Run / Test Mode (`dry_run = 1`)**. In Test Mode, the client intentionally disconnects from `wss://sip.telnyx.com:7443` to protect against accidental carrier charges.
  2. In the Telnyx Mission Control Portal, every credential connection has **"Receive SIP URI calls"** set to **Disabled** by default. When FlyNumber forwarded incoming calls, Telnyx rejected them at the edge before they could reach Pulse Dialer.
  3. Pulse Dialer's database strictly records real signals received by its backend (`SELECT * FROM calls WHERE direction = 'inbound'`). It does not invent mock history for calls dropped at the carrier firewall.
* **Live Mode State**: Database has `dry_run = 0`. The browser softphone connects live to `wss://sip.telnyx.com:7443` and sits in `Standby · Ready for calls`.

---

## 3. Sacred Invariants & Hard Rules (DO NOT BREAK)

1. **NEVER use `wss://rtc.telnyx.com` for SIP.js**:
   `rtc.telnyx.com` speaks Telnyx proprietary JSON-RPC and rejects standard SIP.js INVITEs with `-32000 Authorization required`. The **only** working RFC 3261 WebSocket gateway for `sip.js` is **`wss://sip.telnyx.com:7443`**.
2. **NEVER inject Tailwind CSS**:
   The entire UI is built on a custom design system in `src/styles.css`. Ad-hoc Tailwind utility classes will break layout parity and fail visual QA.
3. **Preserve Local-First Security Guard (`server/middleware/guard.js`)**:
   * All state-changing requests and credential endpoints (`GET /api/telephony/webrtc-session`) mandate the `x-pulse-token` header.
   * DNS rebinding and cross-site origin protection are enforced; do not disable or bypass `requireToken` or `guard`.
4. **Preserve Database Migrations (`server/db/migrations/`)**:
   * Never drop or recreate tables directly in application code. All schema evolution must be versioned migrations executed through `server/db/migrate.js`.
5. **Uphold Concurrency Hardening (G-1 through G-14)**:
   * See `docs/HARDENING-AUDIT-2026-10-19.md` and `test/unit/concurrency-hardening.test.js`.
   * **G-6**: Always detach WebRTC media tracks (`releaseMedia`) *before* stopping peer connections to clear the OS microphone indicator.
   * **G-7**: Standby session must handle WebSocket disconnection and reconnect automatically.
   * **G-10**: `markInboundMissed` is atomic; concurrent CANCEL and decline must be idempotent.
   * **G-11**: Copenhagen timezone math in `telephonyService.js` must remain DST-aware across spring and fall transitions.
6. **Inbound WebRTC Call Handling & Persistent Audio Invariant**:
   * `<audio ref={audioRef}>` must remain persistently mounted at the root of `src/App.jsx`. Placing `<audio>` only inside `Dialer.jsx` leaves the agent deaf on `#recents`, `#dashboard`, and `#settings` views when incoming calls arrive.
   * Inbound `invitation.accept` in `src/webrtcSignalling.js` must inject `sessionDescriptionHandlerFactory` with `localStream` directly so `SessionDescriptionHandler` avoids duplicate `getUserMedia()` prompts and cannot hang on ICE candidate gathering (enforce `iceGatheringTimeout: 1000` and STUN servers `stun:stun.telnyx.com:3478`, `stun:stun.l.google.com:19302`).
   * Remote audio tracks (`sdh.remoteMediaStream` and `pc.addEventListener('track')`) must be attached to `audioRef.current.srcObject` and played immediately upon answering in `useWebRtc.js`.

---

## 4. Key Endpoints & Directory Map

```
dialer/
├── server/
│   ├── config/             # Environment & defaults (DEFAULTS, SECRET_KEYS)
│   ├── db/                 # SQLite connection (WAL), migrations (001-011)
│   ├── repositories/       # prospectRepo, callRepo, recordingRepo, settingsRepo
│   ├── services/           # telephonyService, aiLeadSorter, aiRecordingCoach
│   └── routes/             # prospects, calls, recordings, telephony, settings
├── src/
│   ├── pages/
│   │   ├── Dialer.jsx      # Power dialer cockpit with Queue ↔ Recents toggle
│   │   ├── Recents.jsx     # Dedicated call history, KPI ribbon, audio player
│   │   ├── Prospects.jsx   # CRM lead list & bulk actions
│   │   ├── Recordings.jsx  # Call audio library & AI script auditor
│   │   ├── Import.jsx      # Danish sheet column mapper
│   │   ├── Pipeline.jsx    # Kanban stages
│   │   └── Settings.jsx    # Telephony mode & FlyNumber 4-step bridge
│   ├── useWebRtc.js        # WebRTC state machine (standby, incoming, active)
│   ├── webrtcSignalling.js # sip.js UserAgent & WebSocket transport binding
│   └── styles.css          # Glassmorphic UI design tokens & styling
└── test/
    ├── unit/               # 16 unit test suites (repositories, recordings, etc.)
    └── ui/                 # 230 JSDOM UI race condition tests
```

---

## 5. Verification & Test Gate (MANDATORY CHECKS)

Before declaring any bug fix complete, Argon AI must execute and pass the following three test suites:

1. **Frontend Production Build**:
   ```bash
   npm run build
   ```
   Must compile cleanly via `vite build` with 0 syntax or JSX errors.

2. **Complete Unit Test Suite**:
   ```bash
   npm run test:unit
   ```
   Must pass all 16 test suites 100% green:
   * `repositories.test.js`
   * `inbound.test.js`
   * `hardening.test.js`
   * `email.test.js`
   * `property.test.js` (50,000+ invariant fuzz runs)
   * `import-map.test.js`
   * `recordings.test.js`
   * `ai-lead-sorter.test.js`
   * `ai-recording-coach.test.js`
   * `flynumber.test.js`
   * `chaos-bug-hunter.test.js`
   * `pronunciation.test.js`
   * `direct-dial.test.js`
   * `backend-connectivity.test.js`
   * `concurrency-hardening.test.js`
   * `call-history.test.js`

3. **UI End-to-End Race Tests**:
   ```bash
   npm run test:ui
   ```
   Must pass all 230 UI race checks in JSDOM.
