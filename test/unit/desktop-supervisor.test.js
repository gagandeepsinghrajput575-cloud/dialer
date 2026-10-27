// The desktop supervisor, tested without Electron.
//
// test/unit/sip-daemon.test.js drives the daemon itself; test/unit/native-sip.test.js drives the
// server's half of the contract. This one covers the piece that joins them — `desktop/main.js` —
// which is the part that fails silently in the field: a daemon nobody spawned, a heartbeat nobody
// sends, a command whose answer is never matched to its caller, a phone the server keeps believing
// in after the app has quit.
//
// Electron is not installed here (and cannot be: its binary lives on a release host a locked-down
// network cannot reach), so the module is loaded with `require('electron')` failing — which is
// exactly what desktop/main.js is written to tolerate, because the supervisor's plumbing is
// ordinary Node and only `boot()` needs the real thing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3911;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-supervisor-'));
process.env.DATA_DIR = tmp;
process.env.PORT = String(PORT);
process.env.PULSE_API_BASE = `http://127.0.0.1:${PORT}`;

const REPO = path.join(__dirname, '..', '..');
const migrate = require(path.join(REPO, 'server', 'db', 'migrate'));
migrate.run();

const settings = require(path.join(REPO, 'server', 'repositories', 'settingsRepo'));
const { createApp } = require(path.join(REPO, 'server', 'app'));
const supervisor = require(path.join(REPO, 'desktop', 'main.js'));
const { ensureServer, stopServer, probe } = require(path.join(REPO, 'desktop', 'lib', 'serverProcess'));

let passed = 0;
const ok = (msg) => { passed++; console.log(`  \u2713 ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API = `http://127.0.0.1:${PORT}`;

async function main() {
  console.log('[unit:desktop-supervisor] the Electron main process, without Electron');

  // The supervisor's own API origin must match the server this suite starts, or the heartbeat
  // would go somewhere else and every assertion below would be about a different process.
  assert.strictEqual(supervisor.API_BASE, API, 'the supervisor read PULSE_API_BASE');

  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    // ---------------------------------------------------------------- 1. no server, no lies
    assert.strictEqual(await probe('http://127.0.0.1:3999'), false, 'a dead port probes false');
    assert.strictEqual(await probe(API), true, 'and a live one probes true');
    ok('the server probe tells "already running" from "nobody home"');

    // ---------------------------------------------------------------- 2. spawn the daemon
    settings.set('flynumber_sip_user', 'flynumber-4532');
    settings.set('flynumber_sip_password', 'copenhagen-sip-secret');
    settings.set('flynumber_sip_server', '127.0.0.1:59999');
    settings.set('telephony_mode', 'webrtc');

    assert.strictEqual(supervisor.isRunning(), false, 'nothing is running before startDaemon()');
    // No PULSE_API_BASE for the child: a daemon that can read credentials would immediately try
    // to REGISTER with sip.flynumber.com, and a test suite has no business talking to a real
    // carrier. The supervisor's own heartbeat uses its module-level API_BASE and is unaffected.
    const savedApiBase = process.env.PULSE_API_BASE;
    process.env.PULSE_API_BASE = '';
    const child = supervisor.startDaemon();
    process.env.PULSE_API_BASE = savedApiBase;
    assert.ok(child && child.pid, 'the daemon was spawned as a child process');
    assert.strictEqual(supervisor.isRunning(), true);

    // The launcher the mission spec asks for must exist, be executable, and reach the same daemon.
    const launcher = path.join(REPO, 'desktop', 'bin', 'pulse-sip-daemon');
    assert.ok(fs.existsSync(launcher), 'desktop/bin/pulse-sip-daemon exists');
    const mode = fs.statSync(launcher).mode & 0o111;
    assert.ok(mode !== 0, '…and it is executable (chmod +x)');
    ok(`the daemon is spawned (pid ${child.pid}) and desktop/bin/pulse-sip-daemon is executable`);

    // ---------------------------------------------------------------- 3. one command, one answer
    // The daemon echoes `id` as a string; if the supervisor keyed its pending map on a number,
    // this would hang until the timeout instead of answering.
    const hello = await supervisor.command('hello', {});
    assert.strictEqual(hello.ok, true, `hello answered (got ${JSON.stringify(hello)})`);
    assert.strictEqual(hello.version, supervisor.DAEMON_VERSION, 'and reported its version');

    const status = await supervisor.command('status', {});
    assert.strictEqual(status.ok, true, 'status answered');
    assert.ok(['null', 'coreaudio'].includes(status.audio?.name), 'audio backend is valid (coreaudio on macOS, null elsewhere)');
    assert.ok(status.transport?.port > 0, 'and it opened a SIP socket');

    const bogus = await supervisor.command('not-an-action', {});
    assert.strictEqual(bogus.ok, false, 'an unknown action is refused…');
    assert.match(bogus.error || '', /Unknown action/, '…with a reason');

    // A second command after the first proves the line reader is still in sync (a half-read JSON
    // line would desynchronise every answer after it).
    const devices = await supervisor.command('devices', {});
    assert.strictEqual(devices.ok, true, 'a second command still matches its answer');
    ok('stdin/stdout JSON lines: commands are answered, matched by id, and errors are errors');

    // ---------------------------------------------------------------- 4. the heartbeat
    // Give the beat time to land: startDaemon beats immediately, but the write is async.
    let beat = null;
    for (let i = 0; i < 20; i++) {
      beat = settings.get('native_daemon_last_seen');
      if (beat && beat !== '0') break;
      await sleep(150);
    }
    assert.notStrictEqual(beat, '0', 'the server was told a native phone exists');
    assert.strictEqual(settings.get('native_sip_engine'), supervisor.NATIVE_ENGINE_NAME,
      'and the beat is the opt-in that switches the in-app engine to native');
    assert.strictEqual(settings.get('native_daemon_pid'), String(child.pid), 'with the pid that holds it');

    const session = await fetch(`${API}/api/telephony/webrtc-session`, {
      headers: { 'x-pulse-token': (await fetch(`${API}/api/session`).then((r) => r.json())).token },
    }).then((r) => r.json());
    assert.strictEqual(session.engine, 'native', 'so the session endpoint now describes the daemon');
    assert.strictEqual(session.provider, 'flynumber');
    assert.strictEqual(session.canRegister, true);
    ok('one heartbeat hands the in-app phone to the daemon');

    // ---------------------------------------------------------------- 5. stopping
    supervisor.stopDaemon();
    await sleep(400);
    assert.strictEqual(supervisor.isRunning(), false, 'the child is gone');
    const afterStop = await supervisor.command('status', {});
    assert.strictEqual(afterStop.ok, false, 'and a command with no daemon says so instead of hanging');
    assert.match(afterStop.error || '', /not running/i);

    await supervisor.releasePhone();
    assert.strictEqual(settings.get('native_daemon_last_seen'), '0', 'the server was told the phone is gone');
    assert.strictEqual(settings.get('native_sip_engine'), supervisor.NATIVE_ENGINE_NAME,
      'but the agent’s opt-in survives a quit — reopening the app is enough');
    const back = await fetch(`${API}/api/telephony/webrtc-session`, {
      headers: { 'x-pulse-token': (await fetch(`${API}/api/session`).then((r) => r.json())).token },
    }).then((r) => r.json());
    assert.strictEqual(back.provider, 'flynumber', 'so the browser engine has the phone again');
    ok('quitting releases the phone immediately, and gives it back on the next launch');

    // ---------------------------------------------------------------- 6. crash restart
    const restarted = supervisor.startDaemon();
    assert.ok(restarted?.pid, 'the daemon can be started again after a stop');
    const ready = await supervisor.command('status', {});
    assert.strictEqual(ready.ok, true, 'and answers again');
    supervisor.stopDaemon();
    await sleep(200);
    ok('a restart after a crash or a quit produces a working daemon, not a stale handle');

    // ---------------------------------------------------------------- 7. server bootstrap
    // `ensureServer` must not start a second server when one already answers — two processes on
    // one SQLite file is how a database gets corrupted.
    const found = await ensureServer(API, REPO);
    assert.strictEqual(found.external, true, 'an already-running server is adopted, not replaced');
    assert.strictEqual(found.child, null);
    stopServer(found.child);
    ok('the supervisor adopts a running API server instead of starting a second one');

    console.log(`\n🎉 [unit:desktop-supervisor] all ${passed} checks passed`);
  } finally {
    supervisor.stopDaemon();
    await supervisor.releasePhone();
    await new Promise((r) => server.close(r));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    // The heartbeat interval would otherwise hold the process open forever.
    setTimeout(() => process.exit(0), 50).unref();
  }
}

main().catch((e) => {
  console.error(`\n❌ [unit:desktop-supervisor] ${e && e.message}`);
  if (process.env.SIP_TEST_DEBUG) console.error(e);
  try { supervisor.stopDaemon(); } catch { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
