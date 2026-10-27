# Project Overview: Pulse Dialer

> **High-Velocity B2B Outbound Cold-Calling Dialer & Mini-CRM tailored for the Danish market (+45).**  
> Combines a React frontend, an Express.js backend with SQLite (WAL mode), and a headless native SIP daemon (`desktop/daemon`) running with CoreAudio / UDP SIP via FlyNumber wholesale telephony.

---

## 1. Executive Summary

Pulse Dialer is built for solo sales development reps (SDRs) and cold callers dialing Danish business decision-makers. It optimizes for:
1. **Zero-Latency Dialing:** Instant outbound calls via FlyNumber SIP (`sip.flynumber.com`) using a local native daemon (`pulse-sip-daemon`) over UDP or direct softphone registration (Zoiper/Linphone), avoiding high-latency PSTN bridges.
2. **Keyboard-Driven Workflow:** Power-dialing interface driven completely via keyboard shortcuts (`C` to call/hangup, `1–8` to classify outcomes, `N` for live notes, arrow keys to navigate).
3. **Danish Business Intelligence:** E.164 phone normalization for 8-digit Danish numbers, Copenhagen business hours checking (`08:30–16:30 Europe/Copenhagen`), CVR company number detection, and Danish phonetic pronunciation guides.
4. **Natural Neural Voice & Speech:** Integrated Azure Neural Speech (`da-DK-ChristelNeural`) with SSML prosody optimization (`-4%` speed, `-2%` pitch, 180ms breath breaks, sentence buffering, and thinking tag suppression) for generating voicemail greetings and speech.
5. **AI Multimodal Call Coach & Copilot:** Automated post-call summarization, transcript evaluation, objection analysis, and follow-up email drafts powered by Gemini 2.5 Flash / OpenRouter with deterministic local fallback.

---

## 2. How Calls Actually Get Placed (Call Flow Architecture)

Pulse Dialer does **not** use slow two-legged PSTN callback bridges. When you press **`C`** on your keyboard:

```
[Agent presses C]
       │
       ▼
  1. Frontend (src/pages/Dialer.jsx)
       │ HTTP POST /api/prospects/:id/call
       ▼
  2. Express Backend (server/controllers/prospectController.js -> callService.js)
       │ • Normalizes target number to Danish E.164 (+45XXXXXXXX)
       │ • Verifies business hours (08:30–16:30 Copenhagen)
       │ • Creates pending call row in SQLite (dialer.db)
       │ • Resolves active engine ('native') & carrier ('flynumber')
       │ • Returns dial payload { dialUri: "sip:+45XXXXXXXX@sip.flynumber.com" }
       ▼
  3. Electron Supervisor (desktop/main.js)
       │ Sends JSON-RPC command over stdin:
       │ {"id": "1", "action": "dial", "number": "+45XXXXXXXX", "callerId": "+4532331610"}
       ▼
  4. Native SIP Daemon (desktop/daemon/main.js -> ua.js & dialog.js)
       │
       ├─► A. macOS CoreAudio I/O Unit:
       │      • Hooks directly into default input (Microphone) & output (Speaker/Headset)
       │      • Captures 48 kHz float audio -> resamples to 8 kHz 16-bit PCM mono
       │      • Encodes with G.711 PCMA/PCMU
       │
       ├─► B. SIP Signalling Engine (desktop/daemon/lib/transport.js):
       │      • Builds SIP INVITE with SDP offer (audio RTP port e.g. 10000–20000)
       │      • Sends UDP datagram to sip.flynumber.com:5060
       │      • Handles 401 Unauthorized with MD5 Digest Auth challenge
       │      • Resends authenticated INVITE with credentials
       │
       └─► C. Media Engine (desktop/daemon/lib/media.js & rtp.js):
              • Receives 200 OK with FlyNumber SDP answer
              • Sends ACK and starts two-way RTP stream (8 kHz G.711)
              • Splits audio stream into background call recorder (WAV/MP3)
```

---

## 3. What You Have Inside Your Mac (Components & Local State)

Everything runs **100% locally on your machine**. No cloud server is hosting your database, credentials, or audio.

### A. Processes Running on Your Mac
1. **Node.js Express Server (`server/index.js` on port `3001`):**
   - Serves the compiled React app and API endpoints.
   - Manages SQLite database and local disk file operations.
2. **Electron App & Supervisor (`desktop/main.js`):**
   - The desktop wrapper window running Electron 33.4.
   - Supervises and health-checks the child daemon every 10s.
3. **Headless Native SIP Daemon (`desktop/daemon/main.js` via `desktop/bin/pulse-sip-daemon`):**
   - Runs in Node mode with direct UDP sockets on port `5060`.
   - Binds to macOS CoreAudio framework (`/System/Library/Frameworks/CoreAudio.framework`).
   - Maintains continuous digest registration with FlyNumber.

### B. Files & Storage on Your Mac
- **SQLite Database (`dialer/data/dialer.db`):**
  - Stores all prospects, calls, notes, follow-ups, and app settings.
  - Runs in `WAL` (Write-Ahead Logging) mode with `synchronous=NORMAL` and 5000ms busy timeout.
- **Audio Greetings & Voicemails (`dialer/data/audio/`):**
  - Contains `vm_danish.mp3` (the natural Danish voicemail greeting dropped on unanswered calls).
- **Call Recordings (`dialer/data/recordings/`):**
  - Stores two-way recorded calls (`.wav`/`.mp3`) saved locally after each conversation.
- **Database Snapshots (`dialer/data/backups/`):**
  - Automated SQLite online backups created on boot and before bulk CSV imports.
- **Environment & Secrets (`dialer/.env`):**
  - Local credentials for FlyNumber wholesale SIP, Gemini API, and Azure Speech.

---

## 4. Everything We Use (Complete Technology Inventory)

### 1. Telephony & Audio Transport
- **FlyNumber Wholesale SIP Trunk (`sip.flynumber.com:5060`):**
  - Primary carrier for outbound dials stamped with your verified Copenhagen landline DID (`+45 32 33 16 10`).
  - Free unlimited inbound SIP routing.
- **macOS CoreAudio (`desktop/daemon/lib/audio/coreaudio.js`):**
  - Low-level Apple Silicon / Intel audio I/O units for microphone input and speaker playback.
- **G.711 A-law / µ-law Codec (`desktop/daemon/lib/g711.js`):**
  - Telephony-standard ITU-T G.711 audio companding (8 kHz sample rate, 20ms frame size = 160 samples/packet).
- **RTP Packet Engine (`desktop/daemon/lib/rtp.js`):**
  - Custom UDP RTP/RTCP packetizer with jitter buffer and sequence validation.
- **Optional External Softphones:**
  - Registered via `sip:` or `tel:` OS protocol handlers (Zoiper, Linphone, Telephone).

### 2. Speech Synthesis & AI Engines
- **Microsoft Azure Cognitive Speech Services (`server/services/azureSpeechService.js`):**
  - Voice: `da-DK-ChristelNeural` (Danish conversational neural model).
  - SSML Prosody Optimization: `-4%` speed, `-2%` pitch, 180ms breath breaks, 120ms clause breaks.
  - Sentence-Level Streaming Buffer: Groups token fragments into full grammatical clauses before synthesis.
  - Thinking Tag Filter: Blocks `<think>...</think>` internal reasoning from being spoken aloud.
  - Channel Formats: `riff-8khz-16bit-mono-pcm` (telephony SIP), `audio-24khz-160kbitrate-mono-mp3` (web).
- **Google Gemini 2.5 Flash (`PULSE_AI_PROVIDER=gemini`):**
  - Ingests audio recordings directly for multimodal call coaching, objection handling, and scorecards.
- **OpenRouter (`OPENROUTER_API_KEY`):**
  - Fallback provider for LLM summarization and script analysis.
- **Local Deterministic Summarizer (`server/services/copilotService.js`):**
  - Zero-dependency regex and keyword-based sales signal extractor (`budget`, `pris`, `møde`, `kontrakt`) if offline.
- **Kokoro Local TTS (Optional on port `5050`):**
  - Local neural pronunciation speaker with automatic fallback to Azure Speech / Web Speech API.

### 3. Backend Technologies
- **Express 5.2:** HTTP REST routing and middleware.
- **better-sqlite3 12.1:** High-performance synchronous SQLite driver.
- **Zod 4.6:** Schema validation for all write payloads.
- **Nodemailer 10.0:** SMTP follow-up email dispatch with local outbox capture sink.
- **PapaParse & XLSX:** High-speed CSV/Excel parsing with formula injection (`= + - @`) sanitization.
- **Multer:** Audio file upload streaming.

### 4. Frontend Technologies
- **React 19 & React-DOM 19:** Modern component tree and hooks.
- **Vite 8.3:** Ultra-fast ES-module bundling and HMR.
- **Framer Motion 13.5:** Smooth micro-animations, slide-overs, and cockpit transitions.
- **Lucide React:** Streamlined icon system.
- **@dnd-kit/core:** Drag-and-drop pipeline Kanban board.
- **Vanilla CSS:** Curated custom design tokens (`styles.css`) featuring sleek dark glassmorphism.

---

## 5. Development & Verification Commands

All commands run from the `dialer/` directory:

| Command | Purpose |
|---|---|
| `npm run app` | Builds frontend (`dist/`) and starts Express server on `http://localhost:3001` |
| `npm run dev` | Runs Vite dev server (`:5173`) and API (`:3001`) concurrently |
| `npm run desktop` | Launches the Electron desktop app with native SIP supervisor |
| `node test/all-tests.js` | Runs full regression test suite (38 groups, security, concurrency, UI races) |
| `node test/run-unit.js` | Runs isolated unit test suite across `test/unit/*.test.js` |
| `node test/unit/azure-speech.test.js` | Tests Azure SSML generation, prosody, and sentence buffering |

---

## 6. Directory Layout Reference

```
dialer/
├── desktop/                # Electron supervisor, native daemon, and CoreAudio bindings
│   ├── bin/                # pulse-sip-daemon launcher script
│   ├── daemon/             # Headless SIP client (UDP, RTP, digest auth, audio I/O)
│   └── main.js             # Electron main process & IPC coordinator
├── server/                 # Express backend
│   ├── config/             # Environment, paths, defaults
│   ├── controllers/        # Route controllers
│   ├── db/                 # SQLite database & migrations
│   ├── repositories/       # SQL queries (prospects, calls, settings, notes)
│   ├── routes/             # API routes (/api/*)
│   └── services/           # Telephony, Azure speech, AI copilot, carrier logic
├── src/                    # React frontend (Vite)
│   ├── components/         # ProspectCard, CallTimer, PipelineBoard, etc.
│   ├── pages/              # Dialer, Prospects, Pipeline, Recordings, Settings
│   └── utils/              # Phonetics, Danish number formatters, WebRTC
├── test/                   # Regression & unit test suites
│   ├── all-tests.js        # Main 38-suite integration test runner
│   ├── run-unit.js         # Multi-file unit test runner
│   └── unit/               # Individual unit test files
└── data/                   # SQLite database (dialer.db), audio greetings, backups
```

---

## 7. Production Troubleshooting, Operational Lessons & Brute-Force Runbook

During initial setup and live testing, several real-world telecommunication, network, and audio bottlenecks were identified and resolved. Below is the operational ledger and recovery runbook:

### A. Key Problems Diagnosed & Solved

1. **Dual SIP Client Port Collision (Linphone vs Pulse Dialer):**
   - *Symptom:* Pulse Dialer failed to register or outbound calls never received SIP 401 challenges or ACKs.
   - *Cause:* Linphone was running in the background on macOS, bound to UDP port `5060` with the same FlyNumber credentials.
   - *Fix:* Terminated Linphone (`pkill -9 -i linphone`). Only one SIP client may bind to port 5060 and hold the FlyNumber digest nonce.

2. **FlyNumber TLS vs UDP Protocol Mismatch:**
   - *Symptom:* FlyNumber rejected outbound INVITEs or dropped calls silently.
   - *Cause:* "TLS Encryption" was enabled in the FlyNumber portal, requiring SIPS (port 5061) and SRTP, whereas the native daemon communicates over standard UDP SIP (`sip.flynumber.com:5060`).
   - *Fix:* Toggled **TLS Encryption: OFF** in FlyNumber account settings.

3. **ISP IP Blacklisting & Throttle (Fail2ban Bypass):**
   - *Symptom:* Zero response from `sip.flynumber.com:5060` on home Wi-Fi; speed tests showed severe jitter (`1,377 ms`) and low upload (`0.39 Mbps`).
   - *Cause:* Repeated failed authentication during early debugging triggered carrier-level IP rate limiting / firewall rules.
   - *Fix:* Switched the Mac to a **Mobile Hotspot**, obtaining a fresh, unthrottled IP address that immediately bypassed the block.

4. **Anxiety-Free Audio Cues:**
   - *Symptom:* Harsh, continuous telephone ringtones caused high caller anxiety during outbound sessions.
   - *Cause:* Default UI softphone was looping telephone bell frequencies.
   - *Fix:* Implemented soothing Web Audio API harmonic chimes in `src/utils/tones.js` (a single gentle Major 9th chime on dial, ascending chime on pickup, descending chime on hangup).
   - *Note on In-Band Ringing:* When dialing real numbers in Denmark, the Danish telecom provider (TDC/Telia) sends SIP 183 Early Media, playing the European ringback tone (*tuuut... tuuut...*) directly over the RTP audio pipe until the prospect answers.

5. **Daemon Cold-Start Supervision & Database Lock Prevention:**
   - *Symptom:* "SIP Disconnected" or database lock contention during concurrent call writes.
   - *Fix:* Configured SQLite in `WAL` mode with 5000ms busy timeout, and added robust child-process lifecycle tracking in `desktop/main.js`.

6. **Microphone 0 dBFS Full-Scale Clipping Bug:**
   - *Symptom:* Prospects heard an unbearable screeching static / square-wave buzz (`call-346.wav` showed 574,683 clipped samples at `±32,767`).
   - *Cause:* In `desktop/daemon/lib/media.js`, the code checked `frame instanceof Int16Array`. In Node.js, `Buffer` inherits from `Uint8Array`, not `Int16Array`, so raw byte integers (0–255) fell through to `g711.toInt16(float)`, clamping all non-zero bytes to maximum rail `32,767`.
   - *Fix:* Explicitly unpacked Node `Buffer` to genuine `Int16Array` in both `coreaudio.js` and `media.js`.

7. **In-Call DTMF Touch-Tone Keypad & IVR Routing:**
   - *Symptom:* Keypresses `1–8` were intercepted by call-classification outcome hotkeys in `Dialer.jsx` instead of sending DTMF to Danish phone menus.
   - *Fix:* Bound in-call number keys strictly to DTMF keypad, added on-screen interactive dialpad, supported dual RFC 2833 + in-band G.711 tones in `ua.js`/`rtp.js`, and enabled DTMF during early media (`dialog.state === 'early'`).

8. **CoreAudio Multi-Channel Buffer Mirroring:**
   - *Symptom:* Right channel of stereo headphones (EarPods) received uninitialized buzzing noise.
   - *Fix:* Mirrored `ioData->mBuffers[0]` across all `ioData->mBuffers[b]` in `coreaudio_impl.mm`.

9. **The 50 Hz Starvation Gap Jitter Bug:**
   - *Symptom:* Robotic, stuttering voice received from the other side.
   - *Cause:* CoreAudio's callback runs every 10.66 ms (512 samples at 48 kHz), while UDP network RTP packets arrive every 20.00 ms. The buffer starved every other callback, zeroing out 64 samples 50 times per second (a 50 Hz impulse buzz).
   - *Fix:* Implemented a 40 ms (2-frame) jitter buffer pre-roll in `desktop/daemon/lib/audio/coreaudio.js` and tuned `ReorderBuffer` in `media.js`.

10. **Persistent In-DOM Dialer Across Navigation:**
    - *Symptom:* Navigating away to Recordings or Recents caused the dialer UI to completely unmount and forget active calls.
    - *Fix:* In `App.jsx`, kept `<Dialer />` mounted in DOM (`display: none` when unselected), synchronized active call state to root store (`src/store.jsx`), and added floating global active-call pill bar.

11. **Temporal Dead Zone (TDZ) Blank Screen Fix:**
    - *Symptom:* Black screen on launch with `Uncaught ReferenceError: Cannot access 'U' before initialization`.
    - *Cause:* `useEffect` referenced `active` before `const active = useMemo(...)` declaration in `src/pages/Dialer.jsx`.
    - *Fix:* Reordered the effect hook below declaration and rebuilt `dist/`.

12. **Tenda 11N Router Kernel SIP ALG Lockup:**
    - *Symptom:* Outbound dials and registrations timed out after 32s (`Timer B`) on home Wi-Fi; 100% packet loss to `sip.flynumber.com:5060`.
    - *Cause:* Tenda 11N router has hardcoded `nf_nat_sip` netfilter module in Linux kernel with no GUI toggle. Corrupts port 5060 connection tracking tables.
    - *Resolution:* Reverted all experimental DMZ changes on router back to defaults (`def_dmzen = 0`), performed clean router reboot, and standardized on **Jio Personal Hotspot** for calling (cellular network has no router SIP ALG, confirmed instant SIP 200 OK registration).

13. **RESOLVED (2026-10-28): Live Resampling Aliasing / Metallic Edge:**
    - *Symptom:* Live voice played through earphones/speakers had a scratchy, metallic, robotic edge or high-frequency hiss, while the recorded `.wav` file (`data/recordings/call-XXX.wav`) was cleaner.
    - *Root Cause (measured, not guessed):* `desktop/native/src/pulse_audio.h` resampled with **linear interpolation and no filter in either direction**. `Resampler::up` left spectral images at `fs_in − f` — a 3 kHz tone reappeared at 5 kHz only 9.1 dB down, 1 kHz at 7 kHz 33.6 dB down, passband 4.0 dB low. `Resampler::down` decimated with no anti-alias filter, so 5 kHz folded to 3 kHz at full level. The `.wav` was clean because `media.js` records the 8 kHz RTP frames *before* the resampler.
    - *Fix:* `Resampler` is now a Kaiser-windowed sinc interpolator (cutoff 3.6 kHz, 70 dB stopband, 128 phase banks, causal with cross-callback history, tables built in `Open()`). Images/aliases are now ≤ −91 dB, the passband is flat, and the added group delay is 2.7 ms per direction — inside the existing 40 ms jitter pre-roll.
    - *Guard:* `VAL-AUDIO-009` in `test/native/dsp/check_resampler.cpp` asserts the −55 dB gates and includes a negative control that runs the old linear kernel and must fail them. Full detail: `dialer/current.md` §13.


14. **CORRECTED (2026-10-28): "The Tenda blackholes port 5060" — measured, it does not:**
    - *What the earlier entry (item 12) claimed:* the Tenda's SIP ALG drops all inbound 5060 traffic, 100% loss, so calls cannot connect. **That is not what the packets show.**
    - *Measured on the Tenda LAN (`192.168.0.100`, gw `192.168.0.1`, public `103.192.64.176`):* three UDP `REGISTER`s → **3/3 answered `401 Unauthorized` in 226–350 ms**; an unauthenticated `INVITE` → **`407` in 261 ms**; TCP 5060 `REGISTER` → **`401` in 440 ms**; TLS 5061 → **valid cert for `sip.flynumber.com`, `401` in 823 ms**. The daemon was registered through the same network at the time.
    - *What is actually wrong:* the ALG **rewrites the SIP text**. The `Via` we send (`192.168.0.100:<port>`) comes back as `10.180.131.111:26407` — a CGNAT address — while the real mapping is `rport=48209`. Stateless responses still arrive because `rport` sends them to the source, which is why registration and OPTIONS work. Dialog routing uses the rewritten Via/Contact, whose port never matches, so retransmissions run to **Timer B = 64 × T1 = 32 s** and the UI reports `timeout`. `traceroute` confirms CGNAT at hop 2 (`10.153.110.1`), so DMZ/port-forwarding can never fix this.
    - *Fix 1 (shipped):* a **carrier preflight** — `desktop/daemon/lib/reachability.js` sends one `OPTIONS` before the first INVITE and refuses to dial if nothing answers, so the operator gets an actionable message in **~1.5 s** instead of staring at "Calling…" for 32 s. Skipped entirely while `registered` (a live registration is better evidence, and the normal dial path pays 0 ms). New daemon action `reachability`, and `status.carrier` exposes the last result. Guarded by `VAL-NET-010` in `test/unit/reachability.test.js`.
    - *Fix 2 (attempted, reverted):* **SIP over TLS on 5061**. The ALG cannot parse TLS, so the TLS 401 came back with the Via untouched and `received=103.192.64.176` — the approach was sound. It was reverted anyway because TLS turned out to require SRTP, SRTP required per-socket STUN for CGNAT media, and the third defect in that chain reached a live call as a loud buzz. See item 15.


15. **ATTEMPTED, THEN REVERTED (2026-10-28): SIP over TLS + SRTP + STUN:**
    - *Why it was attempted:* the ALG rewrites plaintext Via/Contact to a CGNAT address whose port does not match the real mapping (item 14), so dialog routing timed out.
    - *What was built:* a TLS 5061 transport in `transport.js` (stream framing by `Content-Length`, CRLF keep-alives, reconnect, certificate validation); `srtp.js` (AES_CM_128_HMAC_SHA1_80 per RFC 3711); `stun.js` (the socket's real mapped address for the SDP line). Measured along the way: TLS registration succeeded, plain `RTP/AVP` was rejected `488` / `Q.850 cause=88`, and the CGNAT mapping differs from the local port (local 52466 mapped to 48154).
    - *Why it was reverted:* it became a chain of four linked requirements — TLS, then mandatory SRTP, then NAT-traversed media, then per-socket STUN — so every new requirement was another chance to fail on a live call. The failure that reached one was deafening square-wave buzz: the SRTP context was never built (the SDP crypto attribute kept its `crypto:` prefix and did not parse), so the 10-byte authentication tag was decoded as audio. The operator chose the working UDP trunk over a fourth round of crypto debugging.
    - *What was removed:* `desktop/daemon/lib/{srtp,stun}.js`, the TLS mode and Via/Contact helpers in `transport.js`, the `RTP/SAVP` + crypto SDP offer, `PULSE_SIP_TRANSPORT`, `PULSE_PUBLIC_IP`, and four test suites (`VAL-NET-011`..`014`).
    - *What was kept:* the 1.5 s UDP carrier preflight (item 14) — media-independent, and still the difference between an actionable error in 1.5 s and a 32 s hang.
    - *Rollback point:* `12ea6bf`. The FlyNumber portal must have TLS Encryption **OFF** for the UDP trunk to register.
    - *If ever revisited:* behind a flag, against a mock carrier that enforces SRTP, and never on the live trunk until a recorded call round-trips audio in both directions.

### B. Brute-Force Restart Runbook

If launching Pulse Dialer on a new machine or recovering after a system restart:

1. **Kill Conflicting Telephony Apps:**
   ```bash
   pkill -9 -i linphone; pkill -9 -i zoiper; pkill -9 -i telephone
   ```
2. **Verify Network Health:**
   - Home Wi-Fi or Mobile Hotspot.
3. **Verify FlyNumber Account Settings:**
   - Server: `sip.flynumber.com`, Port: `5060`, TLS Encryption: **OFF**
   - Username and Password must match `dialer/.env`.
   - `PULSE_SIP_TRANSPORT=udp` in `dialer/.env`.
4. **Start Pulse Dialer:**
   ```bash
   cd dialer
   npm run dev       # Starts backend API (port 3001) & Vite dev server
   npm run desktop   # Launches Electron wrapper & native SIP daemon
   ```
5. **Verify Status:**
   - Title bar / status: `SIP: Registered (sip.flynumber.com)`
   - Call log will output to `dialer/data/recordings/call-<id>.wav`.





