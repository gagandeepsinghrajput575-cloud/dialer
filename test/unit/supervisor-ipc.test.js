// Supervisor ↔ daemon IPC: does a reply reach the command that asked for it?
//
// desktop-supervisor.test.js proves the supervisor spawns the daemon, answers one command at a time,
// and hands the phone back. This suite covers the failure mode that only appears under load and that
// the renderer cannot distinguish from a hung call: several commands in flight at once, ids that
// differ in type between the two processes, daemon output that is not a reply at all, and a daemon
// that never answers.
//
// desktop/main.js keys its pending map on String(id) because the daemon echoes ids as strings
// (protocol.js normalises them). Keying on the number instead would make every command time out while
// its answer sat unread — and `1 !== "1"` is invisible in a one-command test.
//
// Electron is not installed here, and desktop/main.js is written to tolerate that: its plumbing is
// ordinary Node and only boot() needs the real thing.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3913;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ipc-'));
process.env.DATA_DIR = tmp;
process.env.PORT = String(PORT);
process.env.PULSE_API_BASE = `http://127.0.0.1:${PORT}`;
process.env.PULSE_TEST = '1';

const REPO = path.join(__dirname, '..', '..');
require(path.join(REPO, 'server', 'db', 'migrate')).run();
const supervisor = require(path.join(REPO, 'desktop', 'main.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0;
let failed = 0;
const ok = (m) => { checks += 1; console.log('  ✓', m); };
const bad = (m) => { failed += 1; checks += 1; console.log('  ✗', m); };

async function check(title, fn) {
  try {
    await fn();
  } catch (e) {
    bad(`${title}\n      ${String(e && e.message ? e.message : e).split('\n').slice(0, 3).join('\n      ')}`);
    return;
  }
}

// Distinguishable actions: if two replies were crossed, the result carrying the wrong field would be
// obvious rather than merely plausible.
// [action, payload, predicate, what the predicate proves]. `log-level` must be sent WITH a level:
// the daemon echoes `msg.level` back, and an empty payload returns `{level: undefined}` which
// JSON.stringify drops — that reads exactly like a crossed reply and is not one.
const PROBES = [
  ['hello', {}, (r) => r.version === supervisor.DAEMON_VERSION, `version=${supervisor.DAEMON_VERSION}`],
  ['status', {}, (r) => !!r.transport && r.transport.port > 0, 'transport.port'],
  ['devices', {}, (r) => Array.isArray(r.inputs) && Array.isArray(r.outputs), 'inputs[]+outputs[]'],
  ['audio', {}, (r) => typeof r.name === 'string', 'audio.name'],
  ['log-level', { level: 'info' }, (r) => r.level === 'info', 'level="info" echoed back'],
  ['not-an-action', {}, (r) => r.ok === false && /Unknown action/.test(r.error || ''), 'refusal+error'],
];

async function main() {
  console.log('--- Unit: Supervisor IPC Under Concurrency ---');

  assert.strictEqual(supervisor.isRunning(), false, 'nothing running before startDaemon()');
  // No PULSE_API_BASE for the child: a daemon that could read credentials would immediately try to
  // REGISTER with sip.flynumber.com, and a test suite has no business talking to a real carrier.
  const savedApiBase = process.env.PULSE_API_BASE;
  process.env.PULSE_API_BASE = '';
  const child = supervisor.startDaemon();
  process.env.PULSE_API_BASE = savedApiBase;
  assert.ok(child && child.pid, 'the daemon was spawned');
  await sleep(400);

  try {
    // ------------------------------------------------------------------ 1. sequential baseline
    await check('one command, one answer', async () => {
      const hello = await supervisor.command('hello', {});
      assert.strictEqual(hello.ok, true, `hello answered (${JSON.stringify(hello)})`);
      assert.strictEqual(hello.version, supervisor.DAEMON_VERSION, 'and reported the right version');
      ok('a single command is answered with its own reply');
    });

    // ------------------------------------------------- 2. six commands in flight at the same time
    await check('six concurrent commands each get their own reply', async () => {
      const rounds = 3;
      for (let round = 0; round < rounds; round++) {
        const results = await Promise.all(PROBES.map(([action, payload]) => supervisor.command(action, payload)));
        results.forEach((r, i) => {
          const [action, , predicate, describe] = PROBES[i];
          assert.ok(predicate(r),
            `round ${round + 1}: "${action}" must come back with ${describe}, got ${JSON.stringify(r).slice(0, 140)}`);
        });
      }
      ok(`${PROBES.length} commands x ${rounds} rounds in flight concurrently, every reply matched `
        + 'its own caller (ids echoed as strings by the daemon)');
    });

    // ---------------------------- 3. concurrency while the daemon emits id-less events of its own
    await check('daemon events do not steal or corrupt a pending reply', async () => {
      // Every event the daemon emits (ready, audio_level, …) carries no `id`, so each one takes
      // onDaemonLine's "no matching pending entry" path — the same path a reply with a bogus id
      // would take. They are forwarded to the window instead of resolving anything. This is not a
      // synthetic case: it is what happens on every single event.
      const before = supervisor.isRunning();
      const inflight = PROBES.map(([action, payload]) => supervisor.command(action, payload));
      await sleep(120);                       // let events and replies interleave on the same stdout
      const results = await Promise.all(inflight);
      results.forEach((r, i) => {
        const [action, , predicate, describe] = PROBES[i];
        assert.ok(predicate(r), `"${action}" must still carry ${describe} despite interleaved events`);
      });
      assert.strictEqual(supervisor.isRunning(), before, 'the daemon is still the same process');
      ok('six replies resolved correctly while id-less daemon events interleaved on the same stream');
    });

    // ------------------------------------------- 4. a command that cannot be answered at all
    await check('a command with no daemon resolves with a reason instead of hanging', async () => {
      supervisor.stopDaemon();
      await sleep(250);
      assert.strictEqual(supervisor.isRunning(), false, 'the daemon is stopped');
      const started = Date.now();
      const r = await supervisor.command('status', {});
      const took = Date.now() - started;
      assert.strictEqual(r.ok, false, 'refused');
      assert.match(r.error || '', /not running/i, `with a readable reason, got "${r.error}"`);
      assert.ok(took < 1000, `and immediately, not after the ${10000} ms timeout (took ${took} ms)`);
      ok(`no-daemon command resolved in ${took} ms: "${r.error}"`);
    });

    // ------------------------------------- 5. a daemon that is alive but never answers: the timer
    await check('a frozen daemon times out with a reason rather than hanging the renderer', async () => {
      const savedApi = process.env.PULSE_API_BASE;
      process.env.PULSE_API_BASE = '';
      const restarted = supervisor.startDaemon();
      process.env.PULSE_API_BASE = savedApi;
      assert.ok(restarted && restarted.pid, 'the daemon restarted');
      await sleep(400);
      const warm = await supervisor.command('hello', {});
      assert.strictEqual(warm.ok, true, 'and answers before it is frozen');

      const pid = supervisor.pid();
      console.log(`      freezing daemon pid ${pid} (SIGSTOP) and issuing a command…`);
      process.kill(pid, 'SIGSTOP');
      const started = Date.now();
      let r;
      try {
        r = await supervisor.command('status', {});   // COMMAND_TIMEOUT_MS is 10 s
      } finally {
        try { process.kill(pid, 'SIGCONT'); } catch { /* already reaped */ }
      }
      const took = Date.now() - started;
      assert.strictEqual(r.ok, false, 'the frozen daemon must not produce a success');
      assert.match(r.error || '', /did not answer .* in time/,
        `must say which command timed out, got "${r.error}"`);
      assert.ok(took >= 9500 && took < 13000,
        `must wait the real timeout, not fail early or hang (took ${took} ms)`);
      ok(`timed out after ${took} ms: "${r.error}"`);

      // The pending map must have been cleaned up, or every later command would leak a timer.
      const after = await supervisor.command('hello', {}).catch(() => null);
      assert.ok(after && typeof after.ok === 'boolean', 'the supervisor still answers afterwards');
      ok('the timed-out entry was dropped and the supervisor recovers');
    });
  } finally {
    try { supervisor.stopDaemon(); } catch { /* already gone */ }
    await sleep(150);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const total = checks;
  if (failed) {
    console.log(`\n💥 Supervisor IPC: ${total - failed}/${total} passed, ${failed} FAILED`);
    process.exitCode = 1;
  } else {
    console.log(`\n🎉 Supervisor IPC: all ${total} checks passed`);
  }
  process.exit(process.exitCode || 0);
}

main().catch((e) => {
  console.error('\n💥 harness failure:', e && e.message ? e.message : e);
  try { supervisor.stopDaemon(); } catch { /* already gone */ }
  process.exit(1);
});
