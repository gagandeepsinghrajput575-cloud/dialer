#!/usr/bin/env node
// Run every unit suite and report all of them, instead of stopping at the first failure.
//
// This replaces a 23-command `&&` chain in package.json. That chain had two properties that made
// `npm run test:unit` unusable as a signal:
//
//   1. It short-circuited. When `pronunciation.test.js` (12th in the chain) started failing with
//      `no such table`, the eleven suites after it never ran at all — backend-connectivity,
//      concurrency-hardening, call-history, native-sip, desktop-supervisor, sip-daemon and the four
//      telephony suites. Nothing reported them as skipped; the chain just stopped. A suite can rot
//      completely and the command still looks like "one failure".
//   2. It listed suites by hand, and the list had drifted: 29 suites exist in test/unit and only 23
//      were in the chain, so telephony-chaos-part1 and -part2 were never run by it.
//
// Suites are discovered from the directory, so a new file is picked up with nothing to update.
// Every suite runs regardless of what the previous one did, and the summary is a table with the exit
// status and the suite's own last line, so a crash is distinguishable from a test failure — six suites
// once exited non-zero with zero `✗` lines because a native binding was missing, which reads exactly
// like a pass/fail count of 0 and is neither.
//
// EXCLUDED: backend-connectivity.test.js. It is an integration suite that talks to a live server on
// :3001, so it cannot pass from a cold checkout. It has its own script — `npm run test:backend` —
// which starts nothing and says plainly what to start first. Keeping it in the unit chain is what made
// the documented command a guaranteed failure for anyone who had not already run `npm start`.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const UNIT_DIR = path.join(REPO, 'test', 'unit');

// Integration suites that need a process nobody has started yet. Each has its own npm script.
const EXCLUDED = new Set(['backend-connectivity.test.js']);

// Every suite is run with this: several import ESM renderer modules and node warns loudly about the
// repo having no "type" field. The warning is noise, not a defect, and it can bury a real failure.
const NODE_FLAGS = ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'];

// A suite that ignores SIGTERM and hangs would stall the whole run.
const PER_SUITE_TIMEOUT_MS = Number(process.env.PULSE_SUITE_TIMEOUT_MS || 240000);

function discover() {
  return fs.readdirSync(UNIT_DIR)
    .filter((f) => f.endsWith('.test.js') && !EXCLUDED.has(f))
    .sort();
}

/** The suite's own summary line, so the table says something a human recognises. */
function lastMeaningfulLine(stdout, stderr) {
  const text = `${stdout || ''}\n${stderr || ''}`;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  // Prefer a line that looks like a verdict; otherwise take the last thing printed.
  const verdict = [...lines].reverse().find((l) =>
    /passed|failed|checks|🎉|💥|✗|❌|Error/i.test(l));
  const chosen = verdict || lines[lines.length - 1] || '(no output)';
  return chosen.length > 150 ? `${chosen.slice(0, 147)}…` : chosen;
}

function countMarks(stdout) {
  const text = stdout || '';
  const pass = (text.match(/✓/g) || []).length;
  const fail = (text.match(/[✗❌]/g) || []).length;
  return { pass, fail };
}

function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  let suites = discover();
  if (only.length) {
    suites = suites.filter((f) => only.some((o) => f.includes(o)));
    if (!suites.length) {
      console.error(`no suite matches ${only.join(', ')}`);
      console.error(`available: ${discover().join(' ')}`);
      process.exit(2);
    }
  }

  console.log(`Running ${suites.length} unit suite(s) from test/unit`);
  console.log(`Excluded (integration, see package.json): ${[...EXCLUDED].join(', ') || 'none'}`);
  console.log('');

  const results = [];
  let totalPass = 0;
  let totalFail = 0;
  const startedAll = Date.now();

  for (const file of suites) {
    const label = file.replace(/\.test\.js$/, '');
    const started = Date.now();
    process.stdout.write(`  ▸ ${label} … `);
    let r;
    try {
      r = spawnSync(process.execPath, [...NODE_FLAGS, path.join(UNIT_DIR, file)], {
        cwd: REPO, encoding: 'utf8', timeout: PER_SUITE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
      });
    } catch (e) {
      r = { status: 1, stdout: '', stderr: String(e && e.message ? e.message : e) };
    }
    const ms = Date.now() - started;
    const timedOut = r.error && /ETIMEDOUT|timed? ?out/i.test(String(r.error.code || r.error.message || ''));
    const marks = countMarks(r.stdout);
    totalPass += marks.pass;
    totalFail += marks.fail;
    // exit 0 while printing failures is treated as a failure: a suite that swallows its own result
    // must not be able to green the run.
    const passed = r.status === 0 && marks.fail === 0 && !timedOut;
    results.push({ label, passed, status: r.status, ms, marks, timedOut,
      detail: timedOut ? `TIMED OUT after ${PER_SUITE_TIMEOUT_MS} ms` : lastMeaningfulLine(r.stdout, r.stderr) });
    process.stdout.write(`${passed ? 'PASS' : 'FAIL'} (${ms} ms)\n`);
    if (!passed) {
      // Show enough of a failure to act on without replaying the whole suite.
      const tail = `${r.stdout || ''}${r.stderr || ''}`.split('\n').filter((l) => /[✗❌]|Error|AssertionError|expected|actual/.test(l)).slice(0, 6);
      tail.forEach((l) => process.stdout.write(`      ${l.trim().slice(0, 160)}\n`));
    }
  }

  const elapsed = ((Date.now() - startedAll) / 1000).toFixed(1);
  const failedSuites = results.filter((r) => !r.passed);

  console.log('');
  console.log('─'.repeat(100));
  console.log(`${'SUITE'.padEnd(30)} ${'RESULT'.padEnd(7)} ${'✓'.padEnd(5)} ${'✗'.padEnd(5)} ${'MS'.padEnd(8)} LAST LINE`);
  console.log('─'.repeat(100));
  for (const r of results) {
    console.log(
      `${r.label.padEnd(30)} ${(r.passed ? 'PASS' : 'FAIL').padEnd(7)} `
      + `${String(r.marks.pass).padEnd(5)} ${String(r.marks.fail).padEnd(5)} `
      + `${String(r.ms).padEnd(8)} ${r.detail.slice(0, 60)}`,
    );
  }
  console.log('─'.repeat(100));
  console.log(`suites: ${results.length - failedSuites.length}/${results.length} passed   `
    + `checks seen: ${totalPass} ✓ / ${totalFail} ✗   elapsed: ${elapsed}s`);

  if (failedSuites.length) {
    console.log('');
    console.log('FAILED:');
    for (const r of failedSuites) console.log(`  ${r.label} (exit ${r.status}) — ${r.detail}`);
    console.log('');
    console.log('Every suite ran; nothing was skipped because an earlier one failed.');
    process.exit(1);
  }
  console.log('');
  console.log('All unit suites passed. `npm run test:backend` additionally needs a live server on :3001.');
  process.exit(0);
}

main();
