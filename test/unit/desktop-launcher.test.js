// `npm run desktop` must say exactly what is missing when Electron is not installed.
//
// desktop/scripts/run-desktop.js exists for one reason, stated in its own header: starting the app is
// a two-step because Electron is deliberately not a dependency, and "a two-step needs a good error
// message rather than `spawn electron ENOENT`". Its findElectron() returned the bare string
// 'electron' unconditionally, so `return null` was unreachable and the guidance block could never
// print — the operator got ENOENT, the exact failure the file was written to prevent.
//
// Electron cannot be installed here (its release host is unreachable), which is precisely why both
// halves of this contract are testable: absent, and present-but-fake.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const LAUNCHER = path.join(REPO, 'desktop', 'scripts', 'run-desktop.js');

let checks = 0;
const ok = (m) => { checks += 1; console.log('  ✓', m); };

// A PATH with no electron in it. /usr/bin and friends are kept so `node` itself still resolves when
// the launcher is run through a shell, but the two node_modules candidates are checked first by the
// launcher and must genuinely not exist for this test to mean anything.
function runWith(env, args = []) {
  return spawnSync(process.execPath, [LAUNCHER, ...args], {
    cwd: REPO, encoding: 'utf8', env, timeout: 30000,
  });
}

console.log('--- Unit: Desktop Launcher Dependency Guidance ---');

// The launcher's own candidates must be absent, or it would find a real Electron and neither branch
// below would be the one under test.
{
  const cands = [
    path.join(REPO, 'node_modules', '.bin', 'electron'),
    path.join(REPO, 'desktop', 'node_modules', '.bin', 'electron'),
  ];
  const present = cands.filter((c) => fs.existsSync(c));
  assert.deepStrictEqual(present, [], `a real Electron is installed at ${present}, this test cannot run`);
  ok('neither node_modules Electron candidate exists, so PATH resolution is what decides');
}

// 1. Electron absent from PATH: the detailed guidance must print and the exit code must be 1.
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-nopath-'));
  const r = runWith({ PATH: empty, PULSE_TEST: '1' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  console.log(`  exit=${r.status}`);
  assert.strictEqual(r.status, 1, `must exit 1 when Electron is missing, got ${r.status}`);
  ok('exits 1 when Electron is not installed');

  assert.ok(out.includes('needs Electron, and it is not installed'),
    'must print the detailed guidance, not ENOENT');
  assert.ok(out.includes('npm i -D electron@^33'), 'must give the exact install command');
  assert.ok(out.includes('npm run desktop'), 'must give the command to run afterwards');
  assert.ok(out.includes('not a dependency of this repository on purpose'),
    'must explain WHY Electron is not a dependency');
  assert.ok(!out.includes('ENOENT'), `must not fall through to spawn ENOENT, got: ${out.slice(0, 160)}`);
  ok('prints the full guidance block (install command, next step, and the reason) with no ENOENT');
  fs.rmSync(empty, { recursive: true, force: true });
}

// 2. A runnable `electron` on PATH: the launcher must take the launch path instead. A shell script
//    standing in for the binary proves resolution works without needing the 100 MB download.
{
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-fakebin-'));
  const marker = path.join(bin, 'launched.txt');
  const fake = path.join(bin, 'electron');
  fs.writeFileSync(fake, `#!/bin/sh\necho "FAKE-ELECTRON args=$*" > "${marker}"\nexit 0\n`, { mode: 0o755 });

  const r = runWith({ PATH: bin, PULSE_TEST: '1' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.strictEqual(r.status, 0, `must launch and exit 0, got ${r.status}: ${out.slice(0, 300)}`);
  assert.ok(!out.includes('needs Electron, and it is not installed'),
    'must NOT print the missing-Electron guidance when one is runnable');
  assert.ok(fs.existsSync(marker), 'the fake Electron must actually have been spawned');
  const spawned = fs.readFileSync(marker, 'utf8');
  assert.ok(spawned.includes(path.join(REPO, 'desktop')),
    `must pass the desktop directory as the app path, got: ${spawned.trim()}`);
  ok(`resolves a runnable electron through PATH and spawns it on the desktop dir (${spawned.trim().slice(0, 60)}…)`);
  fs.rmSync(bin, { recursive: true, force: true });
}

console.log(`--- Desktop launcher guidance: ${checks} checks passed ---`);
