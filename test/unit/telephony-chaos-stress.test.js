// TELEPHONY STRESS RUNNER — 60 RFC 3261 chaos invariants, in one verdict.
//
// The two halves live beside this file so each stays readable and inside its own line ceiling:
//
//   telephony-chaos-part1.test.js  checks  1-28  digest, SIP framing, SDP, G.711, RTP, UDP transport
//   telephony-chaos-part2.test.js  checks 29-60  control channel, dialog, native renderer engine
//
// What this file adds is the contract the rest of the repo relies on: exactly 60 checks, numbered
// 1..60 with no gaps and no duplicates, and one line of output a human or a CI log can act on.
// Anything else — a check silently skipped, a number reused, a part that failed to load — is a
// broken suite pretending to be a green one, so it throws instead of reporting a partial pass.
//
// Run it directly:
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON test/unit/telephony-chaos-stress.test.js
//
// The flag is cosmetic: checks 53-60 import src/nativeSip.js, which is ESM inside a package with no
// "type" field, so Node would otherwise print a reparsing notice into the middle of the verdict.
// `node test/unit/telephony-chaos-stress.test.js` works too, notice and all, and with Electron
// installed `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron <same path>` behaves identically —
// nothing here touches a browser API, which is the whole point of checks 53-60.
//
// Exit code is 0 only on 60/60. The `process.exit` is deliberate: an engine that answered a call
// arms a 400 ms "back to standby" timer, and a dialog that never got its ACK arms a 32 s one, so
// waiting for the event loop to drain would leave the verdict printed and the process hanging.
'use strict';

const assert = require('assert');
const { runChecks } = require('../helpers/telephony-mocks');

const EXPECTED = 60;

function load(part, file) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(`./${file}`);
    assert.ok(Array.isArray(mod.checks) && mod.checks.length, `${file} exported no checks`);
    return mod.checks;
  } catch (e) {
    throw new Error(`${part} could not be loaded (${file}): ${e.message}`);
  }
}

const banner = (text) => console.log(`\n${'─'.repeat(78)}\n${text}\n${'─'.repeat(78)}`);

async function main() {
  const part1 = load('part 1 (checks 1-28)', 'telephony-chaos-part1.test.js');
  const part2 = load('part 2 (checks 29-60)', 'telephony-chaos-part2.test.js');
  const checks = part1.concat(part2);

  // Numbering is part of the contract: a suite that quietly drops a check still says "all passed".
  const numbers = checks.map((c) => c[0]);
  const dupes = numbers.filter((n, i) => numbers.indexOf(n) !== i);
  assert.deepStrictEqual(dupes, [], `duplicate check numbers: ${dupes.join(', ')}`);
  assert.deepStrictEqual(numbers.slice().sort((a, b) => a - b),
    Array.from({ length: EXPECTED }, (_, i) => i + 1),
    `checks must be numbered 1..${EXPECTED} with no gaps (found ${numbers.length}: ${numbers.join(',')})`);
  for (const [n, title, run] of checks) {
    assert.ok(typeof title === 'string' && title.length > 8, `check ${n} has no usable title`);
    assert.strictEqual(typeof run, 'function', `check ${n} (${title}) has no test function`);
  }

  banner(`TELEPHONY CHAOS STRESS — ${EXPECTED} invariants across the SIP daemon and the native engine`);
  console.log(`\npart 1: the wire libraries (checks 1-${part1.length})`);
  const first = await runChecks(part1);
  console.log(`\npart 2: control channel, dialog, renderer engine (checks ${part2[0][0]}-${EXPECTED})`);
  const second = await runChecks(part2);

  const passed = first.passed + second.passed;
  const failures = first.failed + second.failed;
  banner(failures
    ? `💥 ${failures} OF ${EXPECTED} TELEPHONY STRESS CHECKS FAILED (${passed} passed)`
    : `🎉 ALL ${passed}/${EXPECTED} TELEPHONY STRESS CHECKS PASSED (0 FAILURES)`);

  // The hard gate: a partial pass is a failure, and so is a suite that stopped being 60 checks.
  if (failures || passed !== EXPECTED) {
    throw new Error(`Telephony stress suite: ${passed}/${EXPECTED} passed, ${failures} failed.`);
  }
  return { passed, failures, total: EXPECTED };
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(`\n${e && e.stack ? e.stack : e}`);
      process.exit(1);
    });
}

module.exports = { main, EXPECTED };
