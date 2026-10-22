# RFC — End-to-end verification sweep: the seam between the daemon and the UI

Status: implemented and verified in this branch (see §5).

The two previous sweeps (`native-audio-no-sound.md`, `call-path-bug-sweep.md`) each audited one
layer: the daemon's media path, then the daemon's call logic. Both were thorough and both missed
the same category of defect, because **neither crossed a boundary**. This sweep exists to cross
them, and it found two more bugs — one of which takes the phone deaf minutes into a shift.

The premise: a field the daemon calls `output` and the renderer calls `level` does not throw. A
password the renderer is not allowed to know, spread over one it loaded from the API, does not
throw either. Both just make calls quietly stop working.

---

## 1. `setAccount` let the renderer erase the SIP password — the phone goes deaf after ~4 minutes

Two registration paths exist, and they disagree about who knows the secret:

* `desktop/daemon/main.js` → `hydrate()` loads credentials from
  `GET /api/telephony/carrier-credentials` and calls `ua.register()`. This is the path that works,
  and it keeps the password inside the daemon, which is the whole security design.
* `src/nativeSip.js` → `start()` sends `register` whenever the tab becomes the phone:

```js
const res = await send('register', {
  domain: session.domain, port: session.port, user: session.username,
  callerId: session.callerId, transport: session.transport || 'udp',
});
```

No `password` — correctly, because the browser is never given it. But `main.js` forwards that
payload straight into `setAccount`, which did:

```js
const next = { ...this.account, ...account };
```

`{...{password:'s3cret'}, ...{password:undefined}}` is `{password: undefined}`. Spreading an
absent key does not skip it; it overwrites with `undefined`. So **the renderer's first register
command deleted the daemon's password.**

Probe against the real daemon process (booted with credentials, then sent exactly the renderer's
payload):

```
1. daemon registered on its own credentials: OK
2. renderer-style register reply: {"id":"t1","ok":false,"reason":"missing password"}
3. registration state now: registered
6. registration_failed events: ["missing password"]
```

Why this is worse than it looks, and why it presents as "random":

* The **live registration survives**, because wiping a stored field does not cancel a timer that is
  already armed. So calls keep working — nothing looks broken.
* The UI, meanwhile, gets `{ok:false}` and a `registration_failed` event, so the badge flips to
  *unavailable / missing password* while calls still work. A misleading error on a working phone.
* At 80% of the granted expiry (240 s for the default 300 s), `scheduleRefresh` calls
  `register()`, which runs `validateAccount()`, finds no password, emits `registration_failed` and
  **never re-registers**. The carrier's binding expires. Outbound may limp on; **inbound calls stop
  arriving entirely** — the daemon is no longer contactable.

That is a phone that works for four minutes and then goes deaf, with no error at the moment it
breaks. It is the best candidate in this whole sweep for the operator's "this happens too often".

**Fix.** `setAccount` now treats an absent or `undefined` key as "not supplied" rather than
"erase it", filtering the patch before the spread. Explicit `''` still clears a field, so nothing
loses the ability to unset. `ua.js` 306 → 314 lines.

Probe after the fix:

```
2. renderer-style register reply: {"id":"t1","ok":true,"account":"alice@127.0.0.1"}
6. registration_failed events: []
```

## 2. The level meter never moved, because the two halves named the field differently

The daemon emits:

```js
ua.emit('audio_level', { input: ua.levels.input, output: ua.levels.output });
```

The renderer read:

```js
case 'audio_level':
  if (typeof msg.level === 'number') setLevel(Math.max(0, Math.min(1, msg.level)));
```

There is no `level` field. The guard is never true, `setLevel` is never called, and the meter —
the operator's only visual evidence that audio is moving — sits at zero for the whole call on the
native engine. Confirmed end to end with a real daemon and real RTP: `the meter never moved: level
is undefined`.

This is the same class as the silent-call bug: not a crash, an absent signal. During the previous
sweep it mattered doubly, because with no meter and no watchdog there was no way to tell a working
call from a dead one.

**Fix.** Prefer `msg.level` (the browser engine's shape, which the existing chaos-suite checks pin)
and fall back to `Math.max(input, output)` — the max, because either direction moving proves the
media path is alive. Still clamped to 0..1. `nativeSip.js` stays at exactly 350/350 lines.

## 3. What this sweep checked and found correct

Recording these matters as much as the bugs, because they are the things most likely to be
"simplified" later and break:

* **`defaultLocalAddress()`** already filters link-local (`169.254/16`) and CGNAT (`100.64/10`)
  before advertising an address in SDP and Contact. In this sandbox every interface is link-local,
  so it correctly falls through to the only address there is; on a Mac with a LAN it picks the LAN
  address. Not a bug.
* **NAT traversal by latching.** SDP advertises a private address, which no carrier can route to.
  That is normal and handled: the daemon sends RTP first, the carrier latches onto the source
  address it arrived from, and `media.js` re-latches `media.target` onto whatever address the
  inbound RTP actually came from. Both directions therefore survive NAT without a TURN server.
  `PULSE_PUBLIC_IP` remains the escape hatch when a carrier refuses to latch.
* **Command/reply matching.** `main.js` keys `pending` on `String(id)` and `protocol.js` stringifies
  ids, so `1 !== "1"` cannot strand a reply. Verified by the real daemon answering `status` and
  `dial` under load.
* **`beginRing`** reads `payload.callerPhone || payload.caller`, and the daemon emits
  `callerPhone`. Inbound calls ring with the real number, verified end to end — not "Unknown".
* **Auto-registration.** `hydrate()` registers on startup without waiting for the renderer, so a
  daemon spawned before the UI loads still receives inbound calls.

## 4. Method: replay the daemon's real output into the real renderer

`test/unit/end-to-end.test.js` (319 lines, 12 checks) boots the **real daemon process** against
`test/helpers/mock-carrier.js` on a **real UDP socket**, then captures the events the daemon
actually emitted and replays them into the **real** `createNativeEngine`, asserting on what the
operator would have seen.

Two of the twelve are structural rather than behavioural, and they are the reason this sweep found
what reading could not:

* **Check 9** collects every event name the daemon produced during a full call lifecycle and
  compares it against every `case` in the renderer's switch — *and* against the event names the
  renderer's own `default:` comment says it ignores on purpose. That ignore list is parsed out of
  the source, not hardcoded, so an event added to one side and not the other fails here instead of
  in front of a customer.
* **Check 4** was initially vacuous and is worth recording as a trap: `carrier.sendRtp()` returns
  `false` when the carrier has not yet learned our RTP address, and it learns that only from our
  first packet. Sending before then delivers nothing while the check still passed, because the
  daemon's own pump emits `audio_level` events regardless. It now waits for the path, asserts every
  `sendRtp` returned true, and asserts the decoded peak is above zero.

One test-timing detail worth keeping: `toneFrames()` are `Int16Array`, and RTP payloads must be
G.711 bytes — `carrier.sendRtp(g711.encode(frame, 0))`, matching `sip-daemon.test.js`.

## 5. Verification

| Suite | Result |
| --- | --- |
| `test/unit/end-to-end.test.js` | **12/12** (new) |
| `test/unit/call-path.test.js` | 13/13 |
| `test/unit/native-audio.test.js` | 13/13 |
| `test/unit/telephony-chaos-stress.test.js` | 60/60 |
| `sip-daemon` / `native-sip` / `desktop-supervisor` | 18 / 10 / 7 |
| `concurrency-hardening` / `hardening` / `direct-dial` / `flynumber` / `chaos-bug-hunter` | 13 / 12 / 4 / 7 / 4 |
| `import-map`, `property`, `inbound`, `email`, `repositories`, `recordings`, `ai-lead-sorter`, `ai-recording-coach` | pass |
| `test/all-tests.js` | 38 groups, 51 checks, 0 failures |
| `vite build` | clean |

Negative controls — each new check was run against the unfixed module to prove it is not vacuous:

* revert the `audio_level` fix → check 10 fails with `the meter never moved: level is undefined`;
* revert the `setAccount` fix → check 12 fails with `register without a password was refused:
  {"ok":false,"reason":"missing password"}`.

Ceilings: `nativeSip.js` **350/350** (unchanged), `ua.js` 314, `end-to-end.test.js` 319,
`dialog.js` 350, `transport.js` 276 (untouched), `media.js` 196, `main.js` 217. No new
dependencies; the suite uses `dgram`, `assert`, `fs` and the repo's own modules.

## 6. What no test in this repository can prove

Stated plainly, because the difference matters more than the count:

1. **Real audio hardware.** Every suite runs `--audio=null`. The CoreAudio addon cannot be compiled
   here (Linux, no macOS SDK). §1 of `native-audio-no-sound.md` — opening the device — is proven by
   a backend that reproduces the addon's exact `start()`-before-`open()` contract, not by the addon.
   Only `bash desktop/scripts/build-daemon.sh` on the Mac closes that gap.
2. **The real carrier.** `sip.flynumber.com` is not reachable from this sandbox and no call was
   placed to the PSTN. Everything proven here is against a mock carrier that implements RFC 3261
   digest, INVITE/200/ACK/BYE and RTP — faithful, but it is not FlyNumber, and it will never
   reproduce their media relay, their codec preferences or their fraud rules.
3. **Electron.** Not installed and not downloadable here, so `desktop/main.js`'s IPC relay is
   covered by `desktop-supervisor.test.js` with Electron stubbed, not by a real window.

What *is* proven end to end, with real processes and real sockets: registration through a 401
digest challenge, an outbound INVITE reaching a carrier and being answered, an ACK going back,
RTP flowing in both directions with valid sequence numbers, an inbound INVITE ringing the UI with
the caller's real number, answering it, hanging up with a BYE the carrier receives, and the
renderer consuming every event the daemon emits without a single one falling through.
