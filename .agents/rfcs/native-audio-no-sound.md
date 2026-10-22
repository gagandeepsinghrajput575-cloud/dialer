# RFC — "Connected, total silence both ways, then the call drops"

Status: implemented and verified in this branch (see §4).
Symptom reported by the operator: native SIP daemon engine, app opened at `http://localhost:3001`,
every call shows `connected` with a running timer, **no audio in either direction**, and the far
end releases the call after a few seconds.

---

## 1. What was actually traced

Four independent defects, in the order they bite. None of them are guesses: each is a line in this
repository that does not do what the code around it assumes.

### 1.1 The audio device is never opened (fatal, and it is the reported symptom)

`desktop/daemon/lib/audio/coreaudio.js`:

```js
start(onInput) {
  if (!unit) throw new Error('coreaudio: open() first');
  ...
}
```

`unit` is only ever assigned inside `open()`. A repository-wide search for a caller finds none:

```
grep -rn "\.open(" desktop/daemon/lib/*.js desktop/daemon/main.js | grep -i audio
(no matches)
```

`main.js` loads the backend (`audio.load(opts.audio)`), reports `backend.describe()`, and then hands
it to the UserAgent — but nobody calls `open()`. So on macOS, even with the addon correctly
compiled, the first call does this:

```
onCallConfirmed(dialog)                     // ua.js:209
  → applyRemoteSdp(dialog)                  // ok
  → startPump(dialog)                       // media.js
      → ua.audio.start(cb)                  // THROWS 'coreaudio: open() first'
  → this.emit('connected', …)               // NEVER REACHED
```

`startPump` has no try/catch, so the throw escapes `onCallConfirmed` and is swallowed by the
transaction layer's `.catch(() => {})` on the way back through the 200 OK handler. The SIP dialog is
`confirmed` — the call *is* up — but no audio unit exists, no RTP is ever sent, no RTP is ever
played, and the `connected` event that would have started the UI timer is never emitted. The carrier
hears nothing and releases the leg.

The `null` and `portaudio` backends tolerate a missing `open()` (their `start()` creates what they
need), which is exactly why the test suite — which runs `--audio=null` — has always been green while
the product was silent. **A green suite that cannot reach the defect is the reason this shipped.**

### 1.2 The CoreAudio addon cannot be built at all

`desktop/scripts/build-daemon.sh` step 2:

```bash
( cd "$NATIVE" && npm install --no-audit --no-fund --loglevel=error )
( cd "$NATIVE" && npm run build )
```

`desktop/native/` contains `binding.gyp` and `src/` and **no `package.json`**. `npm install` errors
out (`ENOENT … package.json`), `npm run build` has no script to run, and `build-daemon.sh` is
`set -euo pipefail`, so it dies there. Even after fixing 1.1 there would be no addon to open.

`binding.gyp` also resolves its include directory with
`<!(node -p "require('node-addon-api').include_dir")`, so `node-addon-api` has to be a real
devDependency of that directory — another reason the missing manifest is fatal rather than cosmetic.

### 1.3 The renderer throws away the daemon's own diagnosis

`desktop/daemon/main.js` emits, at startup:

```js
protocol.emit('ready', {
  pid, version,
  audio: chosen.backend.describe?.() || { name: chosen.name },
  audioErrors: chosen.errors,          // e.g. ['coreaudio: addon not built — Run: bash …']
  transport: { … },
});
```

`desktop/main.js` forwards every daemon line to the renderer untouched, so this arrives — and
`src/nativeSip.js` explicitly discards it:

```js
default:
  break; // 'ready', 'log', 'state', 'dtmf': useful in the log, nothing to render
```

The daemon says "I have no sound card" and the dialer shows a green **ready** badge and lets the
agent dial. That is the difference between "the app is broken" and "the app told me what to run".

### 1.4 Nothing distinguishes a live call from a silent one

`media.js` counts `stats.received`, and nothing ever reads it. A call with zero RTP arriving and a
call with perfect audio render identically: `connected`, timer running, level 0. There is no
watchdog, so the operator's only evidence is their own ears and a call that dies at four seconds.

---

## 2. The fix

Ordered so that each step is independently verifiable.

**A. Open the device, and survive it failing.** `media.js` gains `ensureAudioOpen()` (idempotent —
`open()` is a no-op once the unit exists) and `startPump` becomes an async sequence that opens the
device *before* starting it, catches, logs through the existing `[media]` scope and emits an `error`
event instead of throwing into the dialog layer. `onCallConfirmed` therefore always reaches
`emit('connected')`: a call with a dead sound card is now a call the agent can see and hang up, not
a call that silently never started its timer.

**B. Make the documented build work.** Add `desktop/native/package.json` with `node-addon-api` and
`node-gyp` as devDependencies and `build`/`rebuild` scripts, so `build-daemon.sh` step 2 runs. The
addon still cannot be compiled in this sandbox (Linux, no macOS SDK) — that is stated, not hidden.

**C. Render the diagnosis.** `src/nativeSip.js` handles `ready`: if the backend is not `coreaudio`
(or the platform is not macOS), or `audioErrors` is non-empty, the standby badge becomes
`unavailable` with the daemon's own reason and the exact command that fixes it. Registration still
succeeds and inbound calls still ring — the badge is a warning, not a lockout, because a silent
inbound call is still worth seeing.

**D. A media watchdog.** `media.js` starts a 12 s timer on confirm; if `stats.received` is still 0
it emits `media_timeout` once, forwarded through `desktop/main.js`'s existing untouched relay and
rendered as a badge reason in `nativeSip.js`. This turns "silence" into "no RTP arrived from the
carrier in 12 s", which is a NAT/routing statement rather than a mystery.

**E. Tests that can actually fail.** The suite runs `--audio=null`, which is why 1.1 was invisible.
Two additions:
  - a unit check on `media.js` with a backend whose `start()` throws unless `open()` ran first —
    the exact CoreAudio contract — asserting the pump still reports `connected` and that `open()`
    was called;
  - an assertion in `sip-daemon.test.js` that the `ready` event carries `audio.name` and
    `audioErrors`, so 1.3 cannot regress quietly.

---

## 3. Ceilings and compatibility

| File | Now | After | Limit |
| --- | --- | --- | --- |
| `desktop/daemon/lib/media.js` | 136 | ~185 | ≤350 |
| `desktop/daemon/lib/ua.js` | 270 | ~278 | ≤350 |
| `desktop/daemon/main.js` | 214 | ~216 | ≤350 |
| `src/nativeSip.js` | 348 | ≤350 | ≤350 (2 lines of headroom — the `ready` case must be terse) |
| `desktop/main.js` | 350 | 350 | ≤350 — **not touched**; its relay already forwards `ready` |
| `desktop/native/package.json` | absent | new | new files ≤350 |

No new runtime dependencies. `node-addon-api` and `node-gyp` are devDependencies of the
`desktop/native` build directory only, which is not installed by `npm install` at the repo root and
is never loaded at runtime — the addon is `require`d by absolute path if and only if it was built.

The 60-check telephony suite, `sip-daemon`, `native-sip`, `desktop-supervisor` and
`test/all-tests.js` must all stay green; `nativeSip.js`'s event contract changes only by adding a
case, so checks 53–60 keep their assertions.

## 4. Verification

`test/unit/native-audio.test.js` (301 lines, 13 checks) drives the **real** `UserAgent` and the
**real** `media.js` against a backend with the CoreAudio addon's exact contract — `start()` throws
`'coreaudio: open() first'` unless `open()` already ran — plus the renderer's badge path and the
real spawned daemon.

The negative control is the point of the file. Run against the committed, unfixed `media.js`:

```
✗ 1. the pump opens the sound card before starting it…      coreaudio: open() first
✗ 2. a device that will not start still reports connected…  the media fault must not escape…
✗ 3. a device that will not open is reported…               coreaudio: open() first
✗ 4. a failed device is retried on the next call…           coreaudio: open() first
✗ 5–7. the media watchdog…                                  coreaudio: open() first
✓ 8. the silent backend the CI suite runs on still pumps RTP unchanged
```

Check 8 passing while 1–7 fail is the whole diagnosis in one line: `--audio=null` is the one
backend that tolerates never being opened, so the existing suite was structurally incapable of
seeing this bug. The watchdog interval is injectable (`ua.mediaWatchdogMs`) so checks 5–7 prove it
in milliseconds rather than sleeping 12 s.

Everything else stayed green:

| Suite | Result |
| --- | --- |
| `test/all-tests.js` | 38 groups, 51 checks, 0 failures |
| `test/unit/native-audio.test.js` | 13/13 (new) |
| `test/unit/telephony-chaos-stress.test.js` | 60/60 |
| `sip-daemon` / `native-sip` / `desktop-supervisor` | 18 / 10 / 7 |
| `concurrency-hardening` / `hardening` / `direct-dial` / `flynumber` / `chaos-bug-hunter` | 13 / 12 / 4 / 7 / 4 |
| `import-map`, `property`, `inbound`, `email`, `repositories`, `recordings`, `ai-lead-sorter`, `ai-recording-coach` | pass |
| `vite build` | clean |

Ceilings: `media.js` 196, `main.js` 217, `ua.js` 270, `nativeSip.js` **350/350**,
`plain.js` 205, `native-audio.test.js` 301 — all ≤350. `dialog.js` still 350, `Dialer.jsx` still
2040, `useWebRtc.js` still 923: untouched.

## 5. What this RFC does not claim

It does not claim the operator's calls will work after this. It claims the app will stop lying: the
audio device gets opened, a missing device is reported on screen before the first dial instead of
after, and a call with no media says so within 12 seconds. If silence persists with `coreaudio`
reported as the live backend, the remaining suspects are RTP reachability (NAT, `PULSE_PUBLIC_IP`)
and the carrier's media relay, and the watchdog message is what tells them apart.
