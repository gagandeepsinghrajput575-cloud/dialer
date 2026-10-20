# Root cause: inbound calls logged as missed within 1–3 seconds

**Symptom** (from `data/dialer.db`):

```
id  | direction | status | duration | started_at          | ended_at            | caller_id
160 | inbound   | missed | 0        | 2026-10-20 18:30:37 | 2026-10-20 18:30:38 | 18164653119
161 | inbound   | missed | 0        | 2026-10-20 19:58:01 | 2026-10-20 19:58:04 | 18164653119
162 | inbound   | missed | 0        | 2026-10-20 20:12:29 | 2026-10-20 20:12:31 | 18164653119
163 | inbound   | missed | 0        | 2026-10-20 20:20:59 | 2026-10-20 20:21:01 | 18164653119
```

Two things are established by those rows before any code is read:

1. **The INVITE reached the app.** `/api/calls/inbound` only runs from `onIncoming`, so a ledger
   row exists only after an INVITE arrived and the engine handed it to the cockpit.
2. **The row was closed as `missed`, not `declined`.** `PATCH/·/missed` writes `declined` when the
   agent pressed Decline and `missed` when the ring ended any other way. So this was not a button.

Duration `0` means no answer was ever established.

## Defect 1 — answering threw before any 200 OK (browser engine)

`src/webrtcSignalling.js` assigned the microphone factory onto the invitation:

```js
invitation.sessionDescriptionHandlerFactory = defaultSessionDescriptionHandlerFactory(() => Promise.resolve(localStream));
```

In sip.js 0.21.2 that member is a **getter with no setter** (`lib/api/session.js`):

```js
get sessionDescriptionHandlerFactory() {
  return this.userAgent.configuration.sessionDescriptionHandlerFactory;
}
```

`src/webrtcSignalling.js` is an ES module, so it is strict mode: assigning to a getter-only
property throws

```
TypeError: Cannot set property sessionDescriptionHandlerFactory of #<Invitation> which has only a getter
```

before `invitation.accept()` is ever reached. `answerInbound`'s catch block treats anything that
is not a 487/CANCEL as a failed answer:

```js
releaseMedia();
const reason = `The incoming call could not be answered — ${e?.message || e}`;
setError(reason);
endIncoming('missed');          // ← the ledger row that shows up in SQLite
```

So **every** Answer click closed the row as `missed`, immediately, with no SIP response sent. That
is the 1–3 s window in rows 160–163: ring → Answer → `TypeError` → row closed.

The same accessor mistake meant the cockpit's microphone was never actually used for media;
sip.js opened its own capture, so mute and the level meter could disagree with what the far end
heard.

## Defect 2 — the native engine rang nowhere, then declined (desktop shell)

`desktop/preload.js` exposed `pulseDesktop.onEvent`, but **no renderer code subscribed to it**
(`grep -rn onEvent src/` returned only the preload definition). In `native-sip` mode the shell
answered the INVITE with `180 Ringing` and wrote the ledger row, but the modal never appeared, so
the agent had nothing to click. When the caller gave up the engine wrote `missed` — the same
signature as defect 1.

Worse, if the answer path was reached, `desktop/bridge.js` did this:

```js
answer() {
  if (this.ua && this.media) return { ok: this.ua.answer() };
  if (this.ua) {
    const handoff = this.openSoftphone(phone);
    this.ua.decline();                 // ← rejects the call the agent just answered
    return { ok: false, reason: 'no-native-media', ... };
  }
}
```

A signalling-only engine cannot carry audio, so the old code rejected the call and opened
Linphone — the "mock handoff trap". It is now impossible: `answer()` returns
`{ ok: false, reason: 'no-media-engine' }` and leaves the ring intact, and the shell reports
`canAnswer: false` so the UI offers the handoff instead of a button that cannot work.

## Defect 3 — no engine that can actually carry audio natively

`native-sip` was a real SIP user agent with no media path, so "answer with audio" was never
implemented. The fix is an in-app engine, not another handoff:

- `desktop/telephony/linphoneDaemon.js` supervises a headless `linphone-daemon` / `linphonec`
  child process (no window, stdin/stdout control, restart with a bounded budget).
- Its media path **is** CoreAudio (Opus/G.711, jitter buffer, AEC), so answer carries two-way
  audio inside the app.
- `desktop/telephony/daemonProtocol.js` maps the daemon's dialect to the same
  `incoming/answered/ended` events the browser engine emits, and `desktop/bridge.js` feeds them
  to the renderer through `src/desktop/nativeInbound.mjs`.
- `PULSE_DESKTOP_ENGINE=auto` (default) uses it when present and falls back to the in-window
  WebRTC engine otherwise; the Settings panel reports which is live.

## What changed in the browser engine

`sessionDescriptionHandlerFactory` is now installed where sip.js supports it — on the
**UserAgent configuration** when the standby session is created — and the per-call microphone is
handed over through a module slot (`setActiveLocalStream`) that the factory reads at SDP time.
`acceptInvitation()` (exported, unit-tested against an object with a getter-only factory) never
writes to the accessor. ICE gathering was raised from 1 s to 3 s, because a slow STUN round trip
produced answers without candidates and the carrier hung up a couple of seconds after the 200.

## How to confirm on the next call

```bash
# 1. Which engine is live?
npm run desktop:check

# 2. Ring the DID from a mobile and watch the ledger in real time
sqlite3 data/dialer.db "SELECT id,direction,status,duration_sec,started_at,ended_at,caller_id FROM calls ORDER BY id DESC LIMIT 3;"

# 3. In the app: the banner must appear within a second, Answer must connect audio
#    (not "could not be answered"), and the row must end as completed with duration > 0.
```

A row that stays `ringing` means the INVITE arrived but nobody answered; a row that moves to
`connected` and then `completed` proves the media path. A `missed` row that is *not* preceded by
an agent action now means the caller cancelled — and the reason is in the SIP dialog, not in a
TypeError.

## Regression guards

- `test/unit/linphone-engine.test.js` — getter-only invitation accepted; `answer()` writes
  exactly one command and never terminate/decline; daemon supervision; renderer fan-out.
- `test/unit/desktop-telephony.test.js` — bridge ledger transitions, signalling-only mode
  refuses to fake an answer.
- `test/unit/live-call-hardening.test.js` — challenges 1–8, including the provisional-response
  timing and the 350-line ceiling ratchet.
