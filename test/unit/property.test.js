// Pulse Dialer — Generative Property-Based Fuzz Testing Suite
// Verifies safety properties (idempotency, invertibility, boundaries, prototype pollution invariance)
// across 10,000+ seeded pseudo-random iterations.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The telephony service resolves its defaults (default_country_code, caller_id_pool, …) from
// the settings table, so this suite needs a migrated throwaway database exactly like the unit
// and hardening layers do. Without this bootstrap the suite silently depends on an ambient
// data/dialer.db and crashes with "no such table: settings" on a fresh checkout.
const tmp = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-prop-'));
process.env.DATA_DIR = tmp;
require('../../server/db/migrate').run();

const telephony = require('../../server/services/telephonyService');
const { encodeCursor, decodeCursor } = require('../../server/services/prospectService');
const { escapeCsv, neutralizeFormula } = require('../../server/services/csvService');

// Mulberry32 deterministic PRNG
function createPrng(seed = 0x1337cafe) {
  let a = seed >>> 0;
  return function next() {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Random generators
function createGenerators(prng) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 =+-@\t\r\n\'",;:/\\|<>~!#$%^&*()_+{}[]?.\u0000\u001f\u00ff\u00e6\u00f8\u00e5\u00c6\u00d8\u00c5\ud83d\ude00';

  function randInt(min, max) {
    return Math.floor(prng() * (max - min + 1)) + min;
  }

  function randChoice(arr) {
    return arr[Math.floor(prng() * arr.length)];
  }

  function randString(maxLen = 30) {
    const len = randInt(0, maxLen);
    let s = '';
    for (let i = 0; i < len; i++) {
      s += chars[Math.floor(prng() * chars.length)];
    }
    return s;
  }

  function randPhone() {
    const mode = randInt(0, 7);
    switch (mode) {
      case 0: return String(randInt(20000000, 99999999)); // Danish 8 digits
      case 1: return '+45 ' + randInt(20, 99) + ' ' + randInt(10, 99) + ' ' + randInt(10, 99) + ' ' + randInt(10, 99);
      case 2: return '0045' + randInt(20000000, 99999999);
      case 3: return '45' + randInt(20000000, 99999999);
      case 4: return '+1' + randInt(2000000000, 9999999999);
      case 5: return '+447911' + randInt(100000, 999999);
      case 6: return randChoice(['', ' ', 'N/A', 'null', 'none', '-', 'abc', '123', '+++', null, undefined]);
      default: return randString(20);
    }
  }

  function randAdversarialValue() {
    const mode = randInt(0, 10);
    switch (mode) {
      case 0: return null;
      case 1: return undefined;
      case 2: return randInt(-1000, 1000);
      case 3: return randChoice([NaN, Infinity, -Infinity]);
      case 4: return randChoice(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf']);
      case 5: return { [randChoice(['__proto__', 'polluted', 'id', 'constructor'])]: randString(10) };
      case 6: return [randString(5), randInt(0, 100)];
      case 7: return randChoice(['=CMD()', '+1-2', '-123', '@SUM(A1)', '\t=calc', '\r=evil']);
      case 8: return randString(50);
      case 9: return randChoice([true, false]);
      default: return '';
    }
  }

  return { randInt, randChoice, randString, randPhone, randAdversarialValue };
}

let passed = 0;
const ok = (msg) => { passed++; console.log(`    \u2713 ${msg}`); };

async function run() {
  console.log('  [property] generative property-based fuzz testing (10,000 iterations per suite)');
  const prng = createPrng(0xdeadbeef);
  const gen = createGenerators(prng);

  // Dynamically import ESM queue helpers
  const { appendPage, clampLimit } = await import('../../src/queue.js');

  const ITERS = 10000;

  // -------------------------------------------------------------------------
  // PROPERTY 1: Telephony Normalization & cleanStr Invariants
  // -------------------------------------------------------------------------
  // Invariant 1.1: Idempotence: normalizePhone(normalizePhone(x)) === normalizePhone(x)
  // Invariant 1.2: Crash-freedom across arbitrary random and adversarial inputs
  // Invariant 1.3: cleanStr idempotence and placeholder neutralization
  for (let i = 0; i < ITERS; i++) {
    const input = i % 2 === 0 ? gen.randPhone() : gen.randAdversarialValue();
    let norm1;
    try {
      norm1 = telephony.normalizePhone(input);
    } catch (err) {
      assert.fail(`normalizePhone crashed on iteration ${i} with input ${JSON.stringify(input)}: ${err.message}`);
    }

    assert.strictEqual(typeof norm1, 'string', `normalizePhone must always produce string at iteration ${i}`);
    assert.ok(!norm1.includes('[object Object]'), `normalizePhone leaked object representation at iteration ${i}`);

    const norm2 = telephony.normalizePhone(norm1);
    assert.strictEqual(norm2, norm1, `normalizePhone idempotence failed at iteration ${i} for input ${JSON.stringify(input)} (step1=${JSON.stringify(norm1)}, step2=${JSON.stringify(norm2)})`);

    // cleanStr idempotence
    const clean1 = telephony.cleanStr(input);
    assert.strictEqual(typeof clean1, 'string');
    const clean2 = telephony.cleanStr(clean1);
    assert.strictEqual(clean2, clean1, `cleanStr idempotence failed at iteration ${i}`);
  }
  ok(`Property 1 passed: normalizePhone and cleanStr are strictly idempotent and crash-free across ${ITERS} fuzz inputs`);

  // -------------------------------------------------------------------------
  // PROPERTY 2: Keyset Cursor Invertibility & Safe Boundary Hardening
  // -------------------------------------------------------------------------
  // Invariant 2.1: Invertibility: decodeCursor(encodeCursor({ id, idx })) reconstructs { id, idx }
  // Invariant 2.2: Boundary rejection: IDs > Number.MAX_SAFE_INTEGER, <= 0, or floats are rejected (null)
  // Invariant 2.3: Arbitrary corrupt string / base64 payloads safely decode to null without crashing
  for (let i = 0; i < ITERS; i++) {
    // 2.1 Round-trip valid safe integers
    const validId = gen.randInt(1, 10000000);
    const hasIdx = gen.randInt(0, 1) === 1;
    const validIdx = hasIdx ? gen.randInt(0, 500000) : undefined;

    const row = { id: validId };
    const enc = encodeCursor(row, validIdx);
    assert.ok(typeof enc === 'string' && enc.length > 0, `encodeCursor produced invalid token at iteration ${i}`);

    const dec = decodeCursor(enc);
    assert.ok(dec !== null, `decodeCursor failed to decode valid cursor at iteration ${i}`);
    assert.strictEqual(dec.id, validId, `Cursor id mismatch at iteration ${i}: expected ${validId}, got ${dec.id}`);
    if (hasIdx) {
      assert.strictEqual(dec.idx, validIdx, `Cursor idx mismatch at iteration ${i}: expected ${validIdx}, got ${dec.idx}`);
    } else {
      assert.strictEqual(dec.idx, undefined, `Cursor idx should be undefined when omitted at iteration ${i}`);
    }

    // 2.2 Boundary rejections
    const hugeId = Number.MAX_SAFE_INTEGER + gen.randInt(10, 10000000);
    const badEncHuge = Buffer.from(JSON.stringify({ id: hugeId }), 'utf8').toString('base64url');
    assert.strictEqual(decodeCursor(badEncHuge), null, `decodeCursor accepted unsafe integer > MAX_SAFE_INTEGER at iteration ${i}`);

    const nonSafeFloat = validId + 0.5;
    const badEncFloat = Buffer.from(JSON.stringify({ id: nonSafeFloat }), 'utf8').toString('base64url');
    assert.strictEqual(decodeCursor(badEncFloat), null, `decodeCursor accepted float id at iteration ${i}`);

    const negId = -gen.randInt(1, 10000);
    const badEncNeg = Buffer.from(JSON.stringify({ id: negId }), 'utf8').toString('base64url');
    assert.strictEqual(decodeCursor(badEncNeg), null, `decodeCursor accepted negative id at iteration ${i}`);

    // 2.3 Arbitrary corrupt string decoding crash freedom
    const corruptPayload = gen.randString(40);
    assert.strictEqual(decodeCursor(corruptPayload), null, `decodeCursor did not return null for corrupt string at iteration ${i}`);
  }
  ok(`Property 2 passed: Keyset cursor is 100% invertible for valid records and strictly rejects boundaries (>MAX_SAFE_INTEGER, negative, corrupt) across ${ITERS} tests`);

  // -------------------------------------------------------------------------
  // PROPERTY 3: CSV Formula Neutralization & Injection Defence
  // -------------------------------------------------------------------------
  // Invariant 3.1: Formula lead chars (=, +, -, @, \t, \r) are unconditionally prepended with '
  // Invariant 3.2: Quotes are safely doubled and values with delimiters are quoted
  const formulaChars = ['=', '+', '-', '@', '\t', '\r'];
  for (let i = 0; i < ITERS; i++) {
    const rawVal = gen.randString(25);
    const isFormula = formulaChars.includes(rawVal[0]);

    const neutralized = neutralizeFormula(rawVal);
    if (isFormula) {
      assert.ok(neutralized.startsWith("'"), `neutralizeFormula failed to prefix quote for formula lead at iteration ${i}: ${JSON.stringify(rawVal)}`);
      assert.strictEqual(neutralized.slice(1), rawVal);
    } else {
      assert.strictEqual(neutralized, rawVal, `neutralizeFormula mutated non-formula value at iteration ${i}: ${JSON.stringify(rawVal)}`);
    }

    const escaped = escapeCsv(rawVal);
    assert.strictEqual(typeof escaped, 'string');
    if (/[",\n\r]/.test(neutralized)) {
      assert.ok(escaped.startsWith('"') && escaped.endsWith('"'), `escapeCsv did not quote special chars at iteration ${i}`);
    }
  }
  ok(`Property 3 passed: CSV formula neutralization and quote escaping invariant verified across ${ITERS} iterations`);

  // -------------------------------------------------------------------------
  // PROPERTY 4: Queue Limits & AppendPage Deduplication Invariants
  // -------------------------------------------------------------------------
  // Invariant 4.1: clampLimit(n) is always in [1, 500] and is an integer
  // Invariant 4.2: appendPage never introduces duplicate IDs, preserves order, and is idempotent
  for (let i = 0; i < ITERS; i++) {
    const testVal = gen.randAdversarialValue();
    const clamped = clampLimit(testVal);
    assert.ok(Number.isInteger(clamped), `clampLimit did not return integer for input ${JSON.stringify(testVal)} at iteration ${i}`);
    assert.ok(clamped >= 1 && clamped <= 500, `clampLimit out of bounds [1, 500]: ${clamped} at iteration ${i}`);

    // Test appendPage deduplication
    const currentLen = gen.randInt(0, 15);
    const incomingLen = gen.randInt(0, 15);

    const current = [];
    for (let c = 0; c < currentLen; c++) {
      current.push({ id: gen.randInt(1, 20), name: `Prospect ${c}` });
    }

    const incoming = [];
    for (let inc = 0; inc < incomingLen; inc++) {
      if (gen.randInt(0, 3) === 0) {
        incoming.push(null); // hostile null row
      } else if (gen.randInt(0, 3) === 1) {
        incoming.push({ name: 'Missing ID' }); // hostile item without id
      } else {
        incoming.push({ id: gen.randInt(1, 20), name: `Inc Prospect ${inc}` });
      }
    }

    const merged = appendPage(current, incoming);
    assert.ok(Array.isArray(merged));

    // Invariant: strictly unique IDs in merged list
    const seenIds = new Set();
    for (const item of merged) {
      assert.ok(item && item.id != null, `appendPage result contained null/empty ID at iteration ${i}`);
      assert.ok(!seenIds.has(item.id), `appendPage result contained duplicate ID ${item.id} at iteration ${i}`);
      seenIds.add(item.id);
    }

    // Invariant: idempotence appendPage(merged, merged) === merged
    const mergedAgain = appendPage(merged, merged);
    assert.strictEqual(mergedAgain.length, merged.length, `appendPage is not idempotent at iteration ${i}`);
  }
  ok(`Property 4 passed: clampLimit bounded in [1, 500] and appendPage guarantees unique IDs across ${ITERS} fuzz permutations`);

  // -------------------------------------------------------------------------
  // PROPERTY 5: Prototype Pollution Invariance
  // -------------------------------------------------------------------------
  assert.strictEqual(Object.prototype.polluted, undefined, 'Object.prototype.polluted was poisoned');
  assert.strictEqual(Object.prototype.isAdmin, undefined, 'Object.prototype.isAdmin was poisoned');
  assert.strictEqual(Object.prototype.status, undefined, 'Object.prototype.status was poisoned');
  assert.strictEqual(Object.keys(Object.prototype).length, 0, 'Object.prototype keys leaked');
  ok('Property 5 passed: Object.prototype remains clean and unpolluted');

  console.log(`\n  [property] ${passed} property suites passed (50,000+ invariant checks)\n`);
}

run().catch((err) => {
  console.error('\nProperty test failed:', err);
  process.exit(1);
});
