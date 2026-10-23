// Explicitly stopping the daemon must not be mistaken for a crash and auto-restarted.
//
// The child is a deterministic fake process: this exercises the real supervisor lifecycle and
// its exit listener without Electron, a carrier, or a native addon.
'use strict';

const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const Module = require('module');
const childProcess = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const MAIN = path.join(REPO, 'desktop', 'main.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let spawns = 0;

function stream() {
  const s = new EventEmitter();
  s.setEncoding = () => s;
  return s;
}

function fakeSpawn() {
  spawns += 1;
  const child = new EventEmitter();
  child.pid = 9000 + spawns;
  child.stdout = stream();
  child.stderr = stream();
  child.stdin = {
    writable: true,
    write(line) {
      let action = '';
      try { action = JSON.parse(line).action; } catch { /* not a command */ }
      if (action === 'shutdown') setImmediate(() => child.emit('exit', 0, null));
      return true;
    },
  };
  child.kill = (signal) => { setImmediate(() => child.emit('exit', null, signal)); return true; };
  return child;
}

async function main() {
  const oldSpawn = childProcess.spawn;
  const oldFetch = globalThis.fetch;
  const oldLoad = Module._load;
  childProcess.spawn = fakeSpawn;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => String(url).endsWith('/api/session') ? { token: 'test-token' } : { ok: true },
  });
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === MAIN && request === '../server/services/carrierAccount') {
      return { NATIVE_ENGINE: 'pulse-sip-daemon' };
    }
    return oldLoad.call(this, request, parent, isMain);
  };

  let supervisor;
  try {
    supervisor = require('../../desktop/main');
  } finally {
    Module._load = oldLoad;
    childProcess.spawn = oldSpawn;
  }

  try {
    const child = supervisor.startDaemon();
    assert.ok(child?.pid, 'the fake daemon starts');
    supervisor.stopDaemon();
    await sleep(850); // stop is immediate; a crash retry would already have fired after 500 ms
    assert.strictEqual(supervisor.isRunning(), false, 'an intentional stop must remain stopped');
    assert.strictEqual(spawns, 1, 'the supervisor must not spawn a replacement after stop');
    console.log('  ✓ an intentional stop remains stopped past the crash-backoff deadline');

    const old = supervisor.startDaemon();
    supervisor.stopDaemon();
    const replacement = supervisor.startDaemon();
    assert.ok(replacement && replacement !== old, 'a manual restart creates a replacement child');
    await sleep(30); // the old child's exit callback must not clear the replacement handle
    assert.strictEqual(supervisor.isRunning(), true, 'the old exit event must not orphan the new daemon');
    assert.strictEqual(spawns, 3, 'one restart must not spawn a third child');
    console.log('  ✓ a delayed exit from the old child cannot clear its replacement');
    supervisor.stopDaemon();
  } finally {
    await supervisor.releasePhone();
    childProcess.spawn = oldSpawn;
    globalThis.fetch = oldFetch;
  }
}

main().catch((e) => {
  console.error(`  ✗ ${e.message}`);
  process.exit(1);
});
