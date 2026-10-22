# RFC — Call-path bug sweep: six defects that break a real call

Status: implemented and verified in this branch (see §7).

Scope: everything a call touches, end to end — registration, the inbound and outbound INVITE
paths, hang-up, re-INVITE, media, credentials and the renderer. Each defect below was **confirmed
by an executable probe against the real modules**, not inferred from reading. The probe output is
quoted so the claim can be re-checked.

This follows the previous RFC (`native-audio-no-sound.md`), which fixed the silent-call bug. These
six are what is left.

---

## 1. `unregister` reports success as a registration, then re-registers

`register.js`, `onRegisterResponse`:

```js
const granted = parseInt(res.first('expires') || '', 10) || expires || REGISTER_EXPIRES;
ua.registration.state = 'registered';
ua.emit('registered', { … });
ua.scheduleRefresh(granted);
```

A de-registration is `REGISTER` with `Expires: 0`, and the carrier answers `200 OK` with
`Expires: 0`. `parseInt('0')` is `0`, which is falsy, so the `||` chain discards it, falls through
the requested `expires` (also `0`, also falsy) and lands on `REGISTER_EXPIRES = 300`. The daemon
then marks itself **registered**, emits `registered`, and arms a refresh timer for 240 s.

Probe (real `register.js`, fake transport):

```
H1 unregister ->
   events: ["registering","unregistered","registered"]
   state : registered (expected "unregistered")
   granted expires: 300 (expected 0)
   refresh timer armed: true (expected false)
```

Consequence: the engine switch the whole design rests on — the server stops claiming a native phone
when the daemon's heartbeats stop — is contradicted by a daemon that silently re-registers. Inbound
calls keep being routed to a phone the app believes is released.

**Fix.** Treat `expires === 0` as its own outcome: `state = 'unregistered'`, emit `unregistered`,
arm nothing. And stop using `||` for a number where `0` is meaningful — `Number.isFinite(parsed)`
decides, so a granted `0` is honoured rather than replaced by a default.

## 2. The registration backoff never escalates

`register.js`:

```js
ua.failRegistration = function (reason) {
  const delay = RETRY_MS[Math.min(ua.registration.attempt, RETRY_MS.length - 1)];
  ua.registration.attempt += 1;
  …
  ua.registration.timer = setTimeout(() => { … ua.register({ expires: … }); }, delay);
};

ua.register = function ({ expires = … } = {}) {
  …
  ua.registration.attempt = 0;     // ← undoes the increment above
  ua.sendRegister(expires, null);
};
```

The retry timer calls `register()`, which resets `attempt` to `0`, so `RETRY_MS[min(0, 3)]` is
always `5000`. `RETRY_MS = [5000, 10000, 20000, 45000]` is dead code, and the README's claim of
"backoff at 5 s / 10 s / 20 s / 45 s" is false.

Probe:

```
H2 backoff delays observed: [5000,5000,5000,5000]
   attempt counter now: 0
```

Consequence: with bad credentials or an unreachable carrier the daemon re-REGISTERs every five
seconds forever. Carriers rate-limit and temporarily block accounts that hammer them, which turns a
configuration mistake into an outage that outlives the mistake.

**Fix.** `register()` takes `resetBackoff` (default `true`, so a human pressing "register" in
Settings still starts fresh) and the automatic retry passes `false`. `attempt` is already zeroed on
success in `onRegisterResponse`, which is the only place it should be.

## 3. Hang-up while the customer is ringing sends no CANCEL

`ua.js`:

```js
async hangup(callId) {
  const wasLive = dialog.state === 'confirmed';
  if (wasLive) await dialog.bye();
  dialog.end(wasLive ? 'normal' : 'canceled');   // no { sendCancel: true }
}
```

`Dialog.end()` only cancels when told to — `if (sendCancel) this.cancel()` — and `hangup()` never
tells it. The dialog tears down locally and emits `ended{canceled}`, and nothing goes on the wire.

Probe (real `UserAgent` + real `Dialog`, recording transport):

```
H5 outbound, ringing:
   dialog state   : calling
   after hangup() : []          ← nothing sent
   ended event    : ["canceled"]
   VERDICT: BUG - no CANCEL
```

Consequence: the agent hangs up, the UI shows the call ended, and the customer's phone keeps
ringing until the carrier's own timer fires — typically 30–60 s. This is the single most visible
defect in the sweep, and it is the kind of thing that ends with a stranger answering a dead call.

**Fix.** `hangup()` branches on direction and state: confirmed → `bye()` then `end('normal')`;
outbound and unconfirmed → `end('canceled', { sendCancel: true })`.

## 4. Hang-up on a ringing inbound call sends no 486/603

Same call, other direction. `end('canceled')` is passed no `sendReject`, so no refusal is sent.

```
H6 inbound, ringing:
   dialog state : proceeding
   after hangup(): []           ← no 486, no 603
```

`Dialog.ring()` does arm a missed-call timer that sends `486` — but it is guarded by
`if (!this.ended && …)`, and `hangup()` has already set `ended`, so it never fires. The caller rings
into a vacuum.

**Fix.** Inbound and unconfirmed → `end('rejected', { sendReject: 603 })`. `603 Decline` is correct
for "a human said no", where `486 Busy Here` means "cannot take it"; the missed-call timer keeps
`486`, which is right for a ring nobody answered.

## 5. Two calls ring at once on one audio device

`ua.js` refuses a second INVITE with `486 Busy Here` only when `this.active` is set, and
`this.active` is assigned in exactly one place — `onCallConfirmed`. A leg that is ringing is not
`active`.

```
H7 second INVITE while first is ringing:
   dialogs held : 2
   incoming evts: 2
   VERDICT: BUG - two legs ring on one audio device, neither refused
```

Probe confirms `this.active = …` appears only in the constructor, `onCallConfirmed` and
`onDialogEnded`. The daemon's own invariant — one sound card, one call, which is why `486` exists —
does not hold for the window between `180 Ringing` and `200 OK`, which is precisely when a second
caller arrives in practice (call waiting, a redial, a carrier retry after a lost UDP packet).

Consequence: two `incoming` events reach the renderer, which has one ring, one modal and one
`navigator.locks` claim. Whichever the agent answers, the other leg is never refused and never
times out locally.

**Fix.** The busy test becomes "is any dialog still standing": `this.active` **or** any dialog with
`state !== 'terminated' && !ended`. `dial()` gets the same guard, so an outbound dial cannot start
on top of a ringing inbound either.

## 6. A re-INVITE is answered 200 OK with no SDP

```js
const existing = this.dialogByCallId(msg.first('call-id'));
if (existing) {
  ctx.reply(serialize({ startLine: 'SIP/2.0 200 OK', headers: existing.responseHeaders() }));
  return;
}
```

RFC 3261 §14 requires a 200 OK to a re-INVITE to carry an answer. This one carries no body and no
`Content-Type`, and `applyRemoteSdp` is never called, so a codec or port change in the offer is
ignored while we keep sending to the old address.

Consequence: carriers that send a re-INVITE for hold, resume, codec renegotiation or a media relay
move get a malformed answer. Most respond by tearing the call down — a call that dies when the
customer is put on hold.

**Fix.** Answer with our current media (`sdp.build` over the live `dialog.media.port`, or a
media-less `m=audio 0` answer when there is none), set `Content-Type: application/sdp`, and run
`applyRemoteSdp` so the receive path follows the new offer.

---

## 6b. Two more, found while implementing

**7. `end()` could never send a CANCEL or a refusal — the root cause behind §3 and §4.**

```js
end(reason, { sendCancel = false, sendReject = 0, … } = {}) {
  if (this.ended) return;
  this.ended = true;                       // ← set first
  …
  if (sendCancel) this.cancel().catch(() => {});          // cancel(): if (this.ended …) return
  if (sendReject && this.request) this.reject(sendReject); // reject(): if (this.ended) return false
}
```

Both wire methods guard on `this.ended`, and `end()` sets it before calling them, so the two
options were dead parameters. This is not only about hang-up: `ring()`'s missed-call timer is
`end('missed', { sendReject: 486 })`, so **an unanswered inbound call was never refused either** —
it was quietly dropped locally and the caller rang until the carrier gave up. Fixing §3 and §4 in
`hangup()` alone changed nothing; the probe proved it (CANCEL still absent after that fix landed).

Fix: `cancel({ fromEnd })` and `reject(code, { fromEnd })` bypass their own guard when `end()` is
the caller. Idempotence is untouched — `ended` is still set first, so `reject()` re-entering `end()`
returns at the top and exactly one `ended` event is emitted, with the reason `end()` was given
winning over `reject()`'s own. Check 13 pins all three properties.

**8. The busy guard ran before the re-INVITE check, so an answered call rejected its own re-INVITE.**

```js
if (this.active) { …486 Busy Here…; return; }              // guard first
const existing = this.dialogByCallId(msg.first('call-id')); // never reached for a live call
if (existing) { …200 OK… }
```

`this.active` is set by the 200 OK, so for any answered call the guard fired and the re-INVITE
branch was unreachable — the caller got `486 Busy Here` for its own media renegotiation. This made
§6 worse than described: the malformed empty answer was not even what shipped for a live call; a
live call got a refusal. Fixing §5 (widening the guard to ringing legs) would have extended that to
ringing calls too, so the reorder is part of the fix, not a refinement.

Fix: match the existing dialog first, then apply the busy guard. Check 12 asserts both the SDP
answer and that no `486` is produced.

---

## 7. Verification

`test/unit/call-path.test.js` (312 lines, 13 checks) drives the **real** `UserAgent`, `Dialog`,
`register.js` and `transport.js` through `test/helpers/telephony-mocks.js`, asserting on bytes
actually handed to the transport. Negative controls included:

* a hang-up on a **confirmed** call still sends BYE and not CANCEL (the fix must not over-correct);
* a **decline** still sends `486`, distinct from a hang-up's `603`;
* a second INVITE **after** the first terminates is accepted, not refused forever;
* a granted `Expires: 300` still registers normally (fix 1 must not break the happy path);
* a manual `register()` after failures resets the backoff to 5 s (fix 2 must not strand a user).

Negative control, run against the unfixed modules at `HEAD~0` before the fixes were restored:

```
✗ 1  ✗ 3  ✗ 5  ✗ 7  ✗ 9  ✗ 10  ✗ 11  ✗ 12  ✗ 13      → 4/13 passed
✓ 2  ✓ 4  ✓ 6  ✓ 8                                   → exactly the four negative controls
```

Nine of thirteen fail without the fix, and the four that pass are the four that are supposed to
pass either way. That is the standard the previous RFC's suite set, and the only reason the audio
bug is now caught rather than merely described.

Existing suites that must stay green: `all-tests.js` 38/51/0, `sip-daemon` 18, `native-sip` 10,
`desktop-supervisor` 7, `native-audio` 13, `telephony-chaos` 60, `concurrency-hardening` 13,
`hardening` 12, and `vite build`.

Ceilings: `ua.js` 270 → ≤350, `register.js` 132 → ≤350, `dialog.js` **350/350 — must not grow**,
`media.js` 196, `main.js` 217, `nativeSip.js` **350/350 — must not grow**, new test file ≤350.
No new dependencies.

## 8. Not claimed

This sweep covers the call path in this repository. It cannot prove a live call works: that needs
the CoreAudio addon built on a Mac and a carrier that answers. What it does guarantee is that the
daemon stops doing six things that break calls on its own — re-registering after unregistering,
hammering a carrier every 5 s, leaving a customer's phone ringing after hang-up, leaving a caller
ringing after decline, ringing twice on one sound card, and answering a re-INVITE with a malformed
response.
