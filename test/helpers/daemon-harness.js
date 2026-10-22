'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const { MockCarrier } = require('./mock-carrier');

const REPO = path.join(__dirname, '..', '..');
const DAEMON = path.join(REPO, 'desktop', 'daemon', 'main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (v) => JSON.stringify(v);

// Test harness for the headless SIP daemon: spawns the real binary and puts a mock carrier on
// the other end of a UDP socket, so a suite can drive registration, calls and RTP end to end.
//
// `daemonPassword` differs from `password` only in the bad-credential check, where the carrier
// must hold the right secret and the daemon the wrong one.
async function boot({ behaviour = 'answer', codecPt = 0, password = 's3cret', daemonPassword = password, argv = [] } = {}) {
  const carrier = new MockCarrier({ user: 'alice', password, behaviour, codecPt });
  const { sipPort } = await carrier.listen();
  const child = spawn(process.execPath, [
    DAEMON, '--keep-alive', '--audio=null', '--domain=127.0.0.1', `--port=${sipPort}`,
    '--user=alice', `--password=${daemonPassword}`, '--caller-id=+4532331610', ...argv,
  ], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });

  const events = [];
  const logs = [];
  readline.createInterface({ input: child.stdout }).on('line', (l) => { try { events.push(JSON.parse(l)); } catch { logs.push(`unparsable stdout: ${l}`); } });
  readline.createInterface({ input: child.stderr }).on('line', (l) => logs.push(l));
  let seq = 0;
  const api = {
    carrier, child, events, logs, codecPt,
    send(action, payload = {}) {
      const id = `t${++seq}`;
      child.stdin.write(`${j({ id, action, ...payload })}\n`);
      return id;
    },
    /** Resolve with the first event satisfying `pred`, or reject after `ms` with what happened. */
    waitFor(pred, ms = 3000, what = 'event') {
      const started = Date.now();
      return new Promise((resolve, reject) => {
        const tick = () => {
          const found = events.find(pred);
          if (found) return resolve(found);
          if (Date.now() - started > ms) return reject(new Error(`timeout waiting for ${what}; seen: ${events.map((e) => e.event || e.id).join(',')}; logs: ${logs.slice(-3).join(' | ')}`));
          setTimeout(tick, 10);
        };
        tick();
      });
    },
    /** Send a command and wait for its `{id, ok, …}` answer. */
    async command(action, payload = {}, ms = 3000) {
      const id = api.send(action, payload);
      return api.waitFor((e) => e.id === id, ms, `${action} result`);
    },
    countRtp: () => carrier.rtpReceived.length,
    audioPackets: () => carrier.rtpReceived.filter((p) => p.payloadType === codecPt),
    dtmfPackets: () => carrier.rtpReceived.filter((p) => p.payloadType === 101),
  };
  await api.waitFor((e) => e.event === 'ready', 8000, 'daemon ready');
  return api;
}

const bootRegistered = async (opts) => {
  const t = await boot(opts);
  await t.waitFor((e) => e.event === 'registered', 5000, 'registration');
  return t;
};

async function teardown(t) {
  try { t.child.stdin.write(`${j({ action: 'shutdown' })}\n`); } catch { /* gone */ }
  await sleep(80);
  try { t.child.kill('SIGKILL'); } catch { /* gone */ }
  t.carrier.close();
}

// A 440 Hz tone, so "did audio flow" is answered by looking at the bytes, not at a counter.
const toneFrames = (count = 3) => Array.from({ length: count }, (_, f) => {
  const pcm = new Int16Array(160);
  for (let i = 0; i < 160; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * (f * 160 + i)) / 8000) * 12000);
  return pcm;
});

async function dial(t, number = '+4520123456') {
  const res = await t.command('dial', { number });
  assert.strictEqual(res.ok, true, `dial accepted (${j(res)})`);
  const connected = await t.waitFor((e) => e.event === 'connected', 5000, 'connected');
  return { callId: res.callId, connected };
}

module.exports = { boot, bootRegistered, teardown, dial, toneFrames, sleep, DAEMON, REPO };
