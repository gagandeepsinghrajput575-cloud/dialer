# Pulse Dialer — Telnyx + softphone power dialer & mini CRM

Keyboard-driven cold calling for the Danish market (+45). Press **C** and your desktop softphone
(**Zoiper**, Linphone, Telephone) dials the prospect **directly** over [Telnyx](https://telnyx.com) — no
callback bridge, no second leg to wait for. The prospect card, live notes, running timer and the
`1–8` outcome shortcuts stay on screen the whole time.

## Run it
```bash
npm install
npm run app        # builds the UI and starts everything on http://localhost:3001
```
For UI development use `npm run dev` (Vite on :5173 + API on :3001).

## Native macOS app (Option B) — with the Linphone fallback (Option E/A)
The desktop build runs the same Express + SQLite backend and the same React CRM inside an
Electron shell, with the microphone and speakers bound to CoreAudio and **no browser autoplay
policy in the way**. It also answers Telnyx INVITEs over native SIP/UDP 5060 when you ask it to.

```bash
npm install                 # Electron is a dev dependency
npm run build
npm run desktop             # native window on http://127.0.0.1:3001
npm run desktop:dist        # release/Pulse Dialer-<version>.dmg  (x64 + arm64)
```

Requirements on the Mac: macOS 11+, Node 20+, and the Xcode command-line tools
(`xcode-select --install`) so `better-sqlite3` can be rebuilt for Electron
(`npm run desktop:rebuild`).

**Two engines, one contract.** Choose with `PULSE_DESKTOP_ENGINE`:

| Engine | Command | Audio path | Best for |
| --- | --- | --- | --- |
| `webrtc` (default) | `npm run desktop` | In-app, Chromium → CoreAudio, autoplay unlocked | everyday calling, recording, inbound ringing in the app |
| `native-sip` | `PULSE_DESKTOP_ENGINE=native-sip npm run desktop` | Signalling in the shell, voice in Linphone | inspecting SIP reachability, or when the WSS gateway is blocked |

`native-sip` is a real SIP user agent: it REGISTERs with digest auth over UDP/TCP 5060, answers
every INVITE with `100` + `180 Ringing` immediately (inside Telnyx's 10-second SBC window),
handles CANCEL/BYE/DTMF, and writes the same `ringing → connected → completed` ledger rows. It
does **not** carry RTP audio itself in this build, and it will never answer into a silent call:
the Answer action opens Linphone and releases Pulse's fork. That is the deliberate Option E/A boundary:
the shell hands the number to Linphone (`sip:<number>@sip.telnyx.com`) while Pulse keeps the
queue, Danish phonetics, notes, dispositions and the SQLite ledger.

The Settings page has a **Native macOS app** panel with the copyable Linphone parameters
(username, `sip.telnyx.com:5060`, transport, `+45 32 33 16 10` caller ID) and the live engine /
registration status. Everything it shows comes from `GET /api/telephony/desktop`, which is
guarded by `x-pulse-token` and never contains a SIP secret.

If in-app audio cannot start (engine disabled, gateway blocked, no microphone), the menu dial,
dock action or `pulse://` link hands the number to Linphone automatically — the call still goes
out, and Pulse still owns the queue and the ledger.

**Why this fixes the browser failure:** the answer no longer races `getUserMedia`, ICE and SDP
generation inside a tab; the window never suspends its audio context; mic permission is granted
once at process start; and the call survives the window being hidden or closed to the dock.

## First-time setup
1. **Telnyx** — in [Mission Control](https://portal.telnyx.com), create a **SIP Connection** with
   **Credential Auth**, buy Danish **+45** numbers (two or more if you want DID rotation), assign
   them to that connection and copy the SIP **username** and **secret**. The domain is
   `sip.telnyx.com`.
2. **Zoiper** — register a SIP account with those credentials, wait for the green *Registered*
   badge and set your outbound caller ID to your +45 number.
3. **Pulse Dialer → Settings** — *Telephony & Telnyx (Denmark +45)*: calling mode, `sip:`/`tel:`
   scheme, outbound caller ID, Telnyx SIP domain/username/password, then press
   **Test softphone launch** to confirm Zoiper answers a sample `sip:+4520123456`.
4. Turn **Test mode OFF** when you're ready for real calls. Test mode simulates everything in the
   browser and never dials.

Credentials can also live in `.env` (see `.env.example`); they seed the local database on first boot.

## Backend architecture (2.0)
`server/` is layered — routes only wire, controllers only translate HTTP, services hold the rules,
repositories hold the SQL:

```
server/
├── config/          env + filesystem layout, setting defaults, domain constants
├── db/              connection (WAL, synchronous=NORMAL, foreign_keys, busy_timeout=5000),
│                    schema, versioned migrations, snapshot backups
├── repositories/    settingsRepo · prospectRepo · callRepo · noteRepo   (pure SQL)
├── services/        telephony · prospect · call · stats · csv · copilot · followUp
├── controllers/     request/response handlers
├── validation/      Zod schemas for every write endpoint
├── middleware/      error handler · validation · rate limit · request log
└── routes/          /api/prospects · /calls · /notes · /settings · /telephony · /import
```

**Migrations** run from a `_migrations` ledger, so upgrading an existing database never loses data
(`npm start` prints what it applied). **Snapshots** are written to `data/backups/` with the online
backup API — one per day on boot, plus one before every bulk import, and `POST /api/settings/backups`
any time. `GET /api/health` reports journal mode, busy timeout and migration count.

**Validation** — every write endpoint is Zod-validated; bad payloads return
`400 { error, details: [{ field, message }] }` instead of crashing. Uploads, JSON parse errors and
oversized bodies are mapped to 4xx by the same handler, so a client never receives an HTML stack.

**Hardened against abuse and mistakes**

- Repository `UPDATE`s check every column name against the schema before it reaches the SQL string;
  `LIKE` searches escape `%` and `_`.
- Snapshot file names are slugified, so a crafted `reason` cannot write outside `data/backups`.
- CSV exports are BOM-prefixed (Excel reads Danish characters) and neutralize `= + - @` formula
  injection.
- The rate limiter reclaims expired buckets instead of keeping one per client forever.
- Dials and outcome logging are guarded by synchronous locks in the UI: mashing `C` places one
  call, mashing an outcome key logs one call and saves one note, and a held key does not repeat.
- Test mode never hands a `sip:`/`tel:` URI to the operating system — including on re-launch.

## Cold-calling superpowers
- **Direct dialing** — `POST /api/prospects/:id/call` returns `{ callId, dryRun, dialUri, dialUriFull, callerId, … }`;
  the browser dispatches `sip:+4520123456` through a hidden iframe so the app never navigates away.
- **Multi-DID rotation** — set a caller ID pool in Settings; each dial takes the next number
  round-robin (cursor persisted), so no single number gets spam-flagged. `GET /api/telephony/caller-ids`.
- **Voicemail drop** — `POST /api/calls/:id/voicemail-drop` logs `voicemail`, flags `vm_dropped`,
  schedules the callback (+3 days) and moves the prospect to *Follow-up*. Keep your Danish greeting
  at `data/audio/vm_danish.mp3` (or upload it in Settings); `GET /api/telephony/voicemail-greeting`
  reports whether it exists. The UI key `V` lands in Phase B.
- **Danish calling window** — `GET /api/telephony/business-hours` reports whether 08:30–16:30
  Europe/Copenhagen is open right now (all times computed in Copenhagen, not the server's zone).
- **Smart queue** — `GET /api/queue` ranks prospects: follow-ups due › never called › no answer ›
  aged voicemail › gatekeeper › routine, each with a `reason` and `score`.
- **Follow-up scheduler + email** — `POST /api/telephony/prospects/:id/follow-up` sets the date,
  `GET /api/prospects/follow-ups` lists what is due, and `POST …/follow-up-email` renders the Danish
  template with `{{name}} {{company}} {{notes}} {{follow_up}} {{agent}}` filled in.
- **Post-call copilot** — `POST /api/calls/:id/summary` returns a summary, extracted next steps,
  key signals and a suggested callback, and stores them on the call row. Default provider is `local`
  (zero-dependency, deterministic). Set `ai_provider` to `openai`/`gemini` plus an API key in
  Settings (or `PULSE_AI_*` in `.env`) to delegate to a hosted model; if that call fails it degrades
  to the local summarizer and says so.
- **Exports** — `GET /api/prospects/export` (CSV, adds talk time, VM drops and last dial URI) and
  `GET /api/prospects/export?format=json` (prospects with notes, full call history and talk totals).

## Keyboard shortcuts (Dialer)
`C` call / hang up · `1–8` classify the outcome · `H` hang up & classify · `R` re-launch the softphone ·
`←`/`→` previous/next prospect · `N` focus live notes

Misdial? **Discard without logging** (`POST /api/calls/:id/discard`) removes the call so analytics stay clean.

## Danish phone normalization
Numbers are stored in E.164. Danish numbers are 8 digits with no trunk prefix, so `20123456`,
`20 12 34 56`, `4520123456` and `004520123456` all normalize to `+4520123456`.

## Metrics
Pickup = a live person answered (gatekeeper, hung up, conversation, meeting). Voicemail / no answer /
wrong number don't count.

## Tests
```bash
npm test           # 36 groups: boots the API on a free port against a throwaway SQLite DB,
                   # then runs the unit, hardening and UI race suites
npm run test:unit  # repositories/migrations/backups + hardening + email verification
npm run test:ui    # builds the bundle, then drives it in jsdom (23 checks)
```
`API_BASE=http://localhost:3001 npm test` runs the same suite against an already-running instance.

What is covered:

| Suite | What it proves |
| --- | --- |
| `test/all-tests.js` | every endpoint the UI uses: settings, validation, Danish normalization, dial URIs, DID rotation, voicemail drops, follow-ups, queue ranking, copilot, snapshots, exports, hostile input, 50k-row imports, timezone maths — plus a repo-wide check that no retired telephony provider is referenced anywhere |
| `test/unit/repositories.test.js` | migrations, pragmas, repositories, normalization table, DID rotation, business hours, copilot, snapshots |
| `test/unit/hardening.test.js` | 36 adversarial phone inputs, DST/midnight business hours, wall-clock↔UTC conversion, SQL/ISO timestamp parsing, CSV formula-injection defence, backup path traversal, SQL column allowlists, LIKE escaping, copilot fault tolerance, rate-limiter bounds |
| `test/unit/email.test.js` | 25 checks: malformed/over-long addresses, throwaway inboxes, role mailboxes, typo suggestions, known-good domains never second-guessed, live MX lookups, batch verification, SMTP config and password masking, `send()` input guards |
| `test/ui/dialer-race.test.js` | the real bundle in jsdom (23 checks): mashing `C`, holding a key, mashing an outcome key, `H` + arrows in one tick, `R` in test mode, typing in fields, toast bursts, hostile URL fragments (`#constructor`, `#__proto__`), a rejected save showing an error toast, a cross-tab-blocked dial placing no call, and zero React console warnings |

Groups 32–36 cover the cross-site attack surface, email, un-diallable leads, Danish cost ranges
and duplicate detection.

### Known third-party caveat
`xlsx` is pinned at **0.18.5** because that is the last version published to npmjs.org; the fixed
releases (0.19.3+ for prototype pollution, 0.20.2+ for ReDoS) are only distributed from
`https://cdn.sheetjs.com`. Imports are therefore fenced off with an extension allowlist
(`.csv/.tsv/.txt/.xlsx/.xls/.xlsm`), a 30 MB size limit and a structured JSON error. To take the
upstream fix, install from the vendor registry:
`npm i https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`.

## Dialling guards
- **Premium Danish ranges are flagged before you dial.** `70` is shared-cost, `90` is
  premium-rate and `80` is a freephone service line. The range shows as a badge on the dial
  card and an expensive range asks for confirmation first — one bad row in a purchased list
  is otherwise an expensive afternoon. Ordinary Danish mobiles and all foreign numbers are
  left alone, so the warning never becomes noise you click through.
- **Un-diallable numbers are refused, not stored.** A phone that looks like a number but
  will not parse (`+45 123`, `abcde`) is a 400 with a clear message. A blank phone is still
  allowed — plenty of real leads have no number yet. Placeholders (`N/A`, `null`, `-`) count
  as blank rather than broken. Imports never drop a row for a bad number; they keep it and
  report a `badPhones` count.
- **Two tabs cannot double-dial.** The dial takes a `navigator.locks` mutex, so a second open
  tab is told *"Another tab is already dialing this prospect"* instead of logging a second call.
- **Duplicates are caught by email as well as phone.** The same person on a mobile and a
  landline is one contact; matching is case- and whitespace-insensitive, and works within a
  single file too.

## Email — send, verify, attach, meet
Every prospect row has an **Email** button. The composer pre-fills the follow-up template
(`{{name}}`, `{{company}}`, `{{notes}}`, `{{meet_link}}` and friends already substituted),
lets you attach up to 5 files of 10 MB, and logs the send as a note on the prospect.

**Verification is built in and needs no third-party service.** As you type an address it is
checked in layers, cheapest first:

| Layer | Catches |
|---|---|
| syntax | `not-an-email`, 300-character local parts |
| throwaway domains | `mailinator.com`, `10minutemail.com` — mail expires unread |
| role mailboxes | `info@`, `salg@` — real, but a department, not your contact |
| typo suggestion | `gmial.com` → *did you mean gmail.com?* (one click to apply) |
| live MX lookup | domains with no mail server, where nothing can ever arrive |
| SMTP RCPT probe *(off)* | asks the mail server directly — see the caveat below |

A verdict is a **confidence level, not a yes/no**. Nothing can prove a human owns an inbox:
providers accept almost everything at the handshake and bounce later, which is why the deep
RCPT probe is off by default (`email_verify_deep`). Sending to an address that failed
verification asks for an explicit confirmation first — that is how a domain ends up flagging
your sending reputation.

**Sending** needs any SMTP account (Settings → Email). Gmail requires an *App password*, not
your normal one. The password is stored server-side and masked in the API exactly like the SIP
password. **Google Meet**: *New Google Meet room* opens `meet.google.com/new`, which mints a
fresh room in your own logged-in browser — a link cannot be generated server-side without
Google OAuth, so you paste it back. Or store one standing link in Settings and it is appended
to every draft.

## Security model
Pulse Dialer holds your whole lead list, so it does not trust the network it sits on:

- **Origin allowlist.** Requests carrying an `Origin` header from anywhere other than
  `localhost` / `127.0.0.1` / `::1` (or your `PULSE_ALLOWED_HOSTS`) are refused with 403.
  Before this existed, `cors()` answered `Access-Control-Allow-Origin: *`, so **any website
  you visited could delete your database** by firing a request at `http://localhost:3001`.
- **Host validation.** The `Host` header must also be an allowed name, which defeats DNS
  rebinding (an attacker resolving `evil.com` to `127.0.0.1`, where Origin and Host would
  otherwise agree).
- **Session token.** The app reads a random 24-byte token from `GET /api/session` and echoes
  it as `x-pulse-token` on every write. A page on another origin cannot read the token,
  because reading it is itself a refused cross-origin request. Set `PULSE_REQUIRE_TOKEN=1`
  to demand it from curl and scripts too.
- The Telnyx SIP password and API key are never returned to the browser in plaintext (masked, with
  `has_password` instead).

Group 32 of the test suite replays all four attacks and asserts they fail.

## Data
Everything is stored locally in `data/dialer.db` (SQLite), with snapshots in `data/backups/`.
`data/` is **gitignored on purpose** — that database also holds your SIP password and AI key,
so it must never be committed. Keep a copy off this machine: **Settings → Take a snapshot now
→ Download**, or *Export JSON* for a human-readable dump. To restore, stop the server, copy
the snapshot over `data/dialer.db` and start it again.
