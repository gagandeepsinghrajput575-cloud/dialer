'use strict';
/**
 * Property-based fuzz suite for the algorithmic and security cores.
 *
 * Deterministic assertions only cover inputs somebody thought of. This file
 * generates hostile ones instead and checks invariants that must hold for ALL of
 * them: crash freedom, idempotence, round-trip invertibility, boundedness, and
 * the sanitisation guarantees that keep a spreadsheet import from becoming code
 * execution.
 *
 * Determinism matters more than volume here: the PRNG is seeded, so a failure
 * reproduces exactly, and every failing input is shrunk to a minimal
 * counterexample and printed as JSON so it can be pasted into a test.
 *
 * Run: `npm run test:property` (also part of `npm test`).
 */
const assert = require('assert');
const { ROOT, section, summarize, test } = require('../support');

const { cleanStr, PLACEHOLDERS } = require('../../server/services/text');
const { normalizePhone } = require('../../server/services/telephony');
const { escapeCsv, isFormulaRisk, NEUTRALISED_PREFIX } = require('../../server/services/csv');
const { isJunkName, isEmptyRow } = require('../../server/services/imports');
const {
  QUEUE_MAX_LIMIT, QUEUE_DEFAULT_LIMIT, escapeLike, queueSearch,
  encodeCursor, decodeCursor, cursorPredicate,
} = require('../../server/services/queue');

// ------------------------------------------------------------------ the PRNG
// mulberry32: tiny, fast, and — unlike Math.random — reproducible across runs.
const SEED = Number(process.env.FUZZ_SEED || 0x9e3779b9);
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(SEED);
const int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const chance = (p) => rng() < p;

const fmt = (n) => n.toLocaleString('en-US');

// ------------------------------------------------------- hostile generators
const CONTROL = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i));
const ALPHABET = [
  ...'0123456789', ...'0123456789', ...'0123456789', // digits are over-represented on purpose
  ...' +-.()[]<>{}|"\'`,;:/\\@#$_=%&*!?~^',
  ...'\t\n\r ', ...CONTROL,
  ...'abcXYZ', ...'åæøÅÆØ', ...'अआकख', ...'中文', ...'日本語',
  ...'𝟙𝟚🎉👍🏽', ...'‮‏⁠﻿',
];
const INJECTIONS = [
  "' OR 1=1--", '"; DROP TABLE prospects;--', '/*', '*/', '%', '_', '\\', "\\'",
  '<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', '=cmd|\' /C calc\'!A0',
  '@SUM(A1:A2)', '=HYPERLINK("http://evil","click")', '+cmd|\' /C calc\'!A0', '-2+3*cmd',
  'sip:attacker@evil.example', 'user@domain.com', 'null', 'undefined', 'N/A', 'NaN',
  'Infinity', '-Infinity', '[object Object]', '__proto__', 'constructor', 'toString',
  '0000000000000000000', '+'.repeat(40), '9'.repeat(60), `${'page '}1${'9'.repeat(30)}`,
];

function randomString(maxLen = 40) {
  if (chance(0.12)) return pick(INJECTIONS);
  const n = int(0, maxLen);
  let s = '';
  for (let i = 0; i < n; i++) s += chance(0.06) ? pick(INJECTIONS).slice(0, int(1, 6)) : pick(ALPHABET);
  return s;
}

function randomJsonValue(depth = 0) {
  const r = rng();
  if (depth > 3 || r < 0.35) return pick([0, 1, -1, 2 ** 53, -(2 ** 53), 1.5, null, true, false, '', 'x', NaN]);
  if (r < 0.6) return Array.from({ length: int(0, 3) }, () => randomJsonValue(depth + 1));
  const o = {};
  for (let i = 0; i < int(0, 3); i++) o[pick(['p', 'i', '__proto__', 'constructor', 'prototype', 'hasOwnProperty'])] = randomJsonValue(depth + 1);
  return o;
}

/** Shrink a failing string to something small enough to read and paste. */
function shrink(s, predicate) {
  let best = String(s);
  let changed = true;
  while (changed) {
    changed = false;
    for (let len = 0; len < best.length; len++) {
      const cut = best.slice(0, len) + best.slice(len + 1);
      if (predicate(cut)) { best = cut; changed = true; break; }
    }
    if (!changed && best.length > 1) {
      const half = best.slice(0, Math.ceil(best.length / 2));
      if (predicate(half)) { best = half; changed = true; }
    }
  }
  return best;
}

/** RFC4180 single-field parse, so assertions test the cell a spreadsheet sees. */
function parseField(raw) {
  const s = String(raw);
  if (!s.startsWith('"')) return s;
  assert.ok(s.endsWith('"') && s.length >= 2, `unterminated quoted CSV field: ${JSON.stringify(s)}`);
  return s.slice(1, -1).replace(/""/g, '"');
}

const snapshotPrototype = () => Object.getOwnPropertyNames(Object.prototype).sort().join(',');

// --------------------------------------------------------------------- suite
async function main() {
  console.log(`Pulse Dialer — property-based fuzz suite (seed 0x${SEED.toString(16)})`);

  // src/queue.js is ESM inside a CommonJS package, so Node cannot require() it
  // directly. Vite already loads it for the UI suites; reuse that path.
  const { createServer } = await import('vite');
  const vite = await createServer({ root: ROOT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  const clientQueue = await vite.ssrLoadModule('/src/queue.js');
  await vite.close();
  const { clampLimit, appendPage } = clientQueue;

  const protoBefore = snapshotPrototype();
  let iterations = 0;
  const count = (n) => { iterations += n; return n; };

  // ------------------------------------------------ Property 1: telephony
  section('Property 1 — telephony: crash freedom, idempotence, output shape');

  await test(`[${fmt(1000)} runs] normalizePhone never throws and always returns a string`, () => {
    const N = count(1000);
    for (let i = 0; i < N; i++) {
      const input = randomString();
      const cc = chance(0.5) ? pick(['91', '45', '1', '44', '', '0', 'abc', null, undefined, '+45', ' 45 ']) : undefined;
      let out;
      try {
        out = normalizePhone(input, cc);
      } catch (e) {
        throw new Error(`threw on ${JSON.stringify(input)} (cc=${JSON.stringify(cc)}): ${e.message}`);
      }
      const bad = () => `input ${JSON.stringify(input)} cc ${JSON.stringify(cc)} -> ${JSON.stringify(out)}`;
      if (typeof out !== 'string') throw new Error(`returned ${typeof out}, not a string: ${bad()}`);
      if (/NaN|\[object Object\]|undefined|null/.test(out) && !/@|sip:/i.test(out)) {
        throw new Error(`leaked a coercion artefact: ${bad()}`);
      }
    }
    return 'no throws, no NaN or [object Object] leakage';
  });

  await test(`[${fmt(1000)} runs] normalizePhone is idempotent: f(f(x)) === f(x)`, () => {
    const N = count(1000);
    for (let i = 0; i < N; i++) {
      const input = randomString();
      const cc = pick(['91', '45', '1', '']);
      const once = normalizePhone(input, cc);
      if (once === '') continue;
      const twice = normalizePhone(once, cc);
      if (twice !== once) {
        const minimal = shrink(input, (s) => {
          const a = normalizePhone(s, cc);
          return a !== '' && normalizePhone(a, cc) !== a;
        });
        throw new Error(`not idempotent for ${JSON.stringify(minimal)} (cc=${cc}): ${JSON.stringify(once)} -> ${JSON.stringify(twice)}`);
      }
    }
    return 're-normalising a result never changes it';
  });

  await test(`[${fmt(1000)} runs] normalizePhone output is E.164 or an untouched SIP target`, () => {
    // The brief asked to assert the result "never contains spaces, brackets or
    // dashes". That is false for this codebase by design: SIP addresses and
    // email-style call targets are passed through verbatim, and a SIP URI may
    // legitimately contain dashes. The real invariant is the disjunction below.
    const N = count(1000);
    let passthroughs = 0;
    for (let i = 0; i < N; i++) {
      const input = randomString();
      const cc = pick(['91', '45', '1', '']);
      const out = normalizePhone(input, cc);
      if (out === '') continue;
      if (/@/.test(out) || /^sip:/i.test(out)) { passthroughs++; continue; }
      const bad = () => `input ${JSON.stringify(input)} cc ${cc} -> ${JSON.stringify(out)}`;
      if (!/^\+\d+$/.test(out)) throw new Error(`neither E.164 nor a SIP target: ${bad()}`);
      if (/[ \-()[\]]/.test(out)) throw new Error(`E.164 output contains punctuation: ${bad()}`);
      if (out.length < 2) throw new Error(`E.164 output is impossibly short: ${bad()}`);
    }
    return `every result was +digits or a SIP target (${passthroughs} passthroughs seen)`;
  });

  await test(`[${fmt(500)} runs] cleanStr never throws, is idempotent, and honours its placeholders`, () => {
    const N = count(500);
    for (let i = 0; i < N; i++) {
      const input = chance(0.2) ? pick([null, undefined, 0, false, NaN, {}, [], '', '  ', ...PLACEHOLDERS]) : randomString();
      let out;
      try { out = cleanStr(input); } catch (e) { throw new Error(`threw on ${JSON.stringify(input)}: ${e.message}`); }
      if (typeof out !== 'string') throw new Error(`returned ${typeof out} for ${JSON.stringify(input)}`);
      if (cleanStr(out) !== out) throw new Error(`not idempotent for ${JSON.stringify(input)}: ${JSON.stringify(out)}`);
      if (out !== out.trim()) throw new Error(`result is not trimmed for ${JSON.stringify(input)}`);
      if (PLACEHOLDERS.includes(out.toLowerCase()) && out !== '') {
        throw new Error(`placeholder ${JSON.stringify(out)} survived cleaning`);
      }
    }
    return 'string, trimmed, idempotent, placeholders collapsed to ""';
  });

  // ------------------------------------------------ Property 2: cursor codec
  section('Property 2 — keyset cursor: lossless invertibility and tamper rejection');

  await test(`[${fmt(1000)} runs] decodeCursor(encodeCursor(row)) round-trips exactly`, () => {
    const N = count(1000);
    for (let i = 0; i < N; i++) {
      // Ids stay inside the safe-integer range because that is the domain the
      // codec is contracted over; out-of-range ids are the next test's job.
      const row = { id: int(1, Number.MAX_SAFE_INTEGER - 1), has_phone: pick([0, 1]) };
      const token = encodeCursor(row);
      const back = decodeCursor(token);
      if (!back || back.id !== row.id || back.hp !== row.has_phone) {
        throw new Error(`round-trip failed for ${JSON.stringify(row)}: token ${token} -> ${JSON.stringify(back)}`);
      }
      if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error(`cursor is not base64url: ${JSON.stringify(token)}`);
      // The decoded values are bound straight into SQL, so they must be bindable.
      const pred = cursorPredicate(back);
      if (pred.params.some((p) => typeof p !== 'number' || !Number.isSafeInteger(p))) {
        throw new Error(`cursor produced an unbindable SQL parameter: ${JSON.stringify(pred.params)}`);
      }
    }
    return 'exact round-trip, base64url only, every value safe to bind';
  });

  await test(`[${fmt(300)} runs] cursors beyond the safe-integer range are rejected, not rounded`, () => {
    // Found by this suite: an id above 2^53 survives Number.isInteger() because
    // the float has no fractional part, but JSON round-tripping silently rounds
    // it, and better-sqlite3 refuses to bind it. Both are worse than a 400.
    const N = count(300);
    const unsafe = [2 ** 53, 2 ** 53 + 1, 2 ** 62, Number.MAX_SAFE_INTEGER + 1, 1e308, Infinity];
    for (let i = 0; i < N; i++) {
      const id = chance(0.5) ? pick(unsafe) : Number.MAX_SAFE_INTEGER + int(1, 1000000);
      const token = Buffer.from(JSON.stringify({ p: pick([0, 1]), i: id }), 'utf8').toString('base64url');
      const back = decodeCursor(token);
      if (back !== null) {
        throw new Error(`accepted an unsafe cursor id ${id} -> ${JSON.stringify(back)}; it would be rounded or would throw at the SQL binder`);
      }
    }
    return 'every out-of-range id decoded to null (HTTP 400)';
  });

  await test(`[${fmt(500)} runs] decodeCursor rejects corrupted and hostile tokens without throwing`, () => {
    const N = count(500);
    const valid = encodeCursor({ id: 4242, has_phone: 1 });
    for (let i = 0; i < N; i++) {
      let token;
      const r = rng();
      if (r < 0.25) {
        // random bytes, base64url-encoded
        token = Buffer.from(Array.from({ length: int(1, 48) }, () => int(0, 255))).toString('base64url');
      } else if (r < 0.5) {
        // a valid token with bits flipped, truncated or extended
        const at = int(0, valid.length - 1);
        token = valid.slice(0, at) + pick(['A', '!', '=', '"', "'", '%00', '..']) + valid.slice(at + (chance(0.5) ? 1 : 0));
      } else if (r < 0.75) {
        token = Buffer.from(JSON.stringify(randomJsonValue()), 'utf8').toString('base64url');
      } else {
        token = pick([null, undefined, 0, 1, -1, NaN, Infinity, true, false, {}, [], () => {}, Symbol('x'), '',
          ' ', 'e30', Buffer.from('{"p":1,"i":-5}').toString('base64url'),
          Buffer.from('{"p":1,"i":0}').toString('base64url'),
          Buffer.from('{"p":2,"i":7}').toString('base64url'),
          Buffer.from('{"p":"1","i":"7"}').toString('base64url'),
          Buffer.from('{"__proto__":{"polluted":true},"p":1,"i":7}').toString('base64url'),
          Buffer.from('[' + '9'.repeat(5000) + ']').toString('base64url')]);
      }
      let out;
      try {
        out = decodeCursor(token);
      } catch (e) {
        const label = typeof token === 'string' ? token.slice(0, 60) : String(typeof token);
        throw new Error(`threw on ${JSON.stringify(label)}: ${e.message}`);
      }
      if (out !== null) {
        const okShape = typeof out === 'object' && Number.isSafeInteger(out.id) && out.id > 0 && (out.hp === 0 || out.hp === 1);
        if (!okShape) throw new Error(`decoded to an invalid shape: ${JSON.stringify(out)} from ${JSON.stringify(String(token).slice(0, 60))}`);
      }
    }
    return 'null or a strictly valid {hp,id}; never a throw';
  });

  // ------------------------------------------------ Property 3: CSV defence
  section('Property 3 — CSV formula injection defence and phone preservation');

  await test(`[${fmt(400)} runs] every hostile formula payload is neutralised with a leading quote`, () => {
    const hostile = [
      '=cmd|\' /C calc\'!A0', '=1+1', '=@SUM(A1)', '=HYPERLINK("http://evil")',
      '@SUM(A1:A2)', '@import', '+cmd|\' /C calc\'!A0', '-2+3*cmd', '-1+1',
      '\tcalc', '\rcalc', '\t=evil', '\r\n=evil', '=1,2', '=a"b', "='x'",
      '  =1+1', // leading whitespace: trimmed by the importer before it reaches here
    ];
    const N = count(400);
    let checked = 0;
    for (let i = 0; i < N; i++) {
      const base = chance(0.5) ? pick(hostile) : pick(['=', '+', '-', '@', '\t', '\r']) + randomString(24);
      if (!isFormulaRisk(base)) continue; // a purely numeric +/- is legitimately safe
      checked++;
      const cell = parseField(escapeCsv(base));
      if (!cell.startsWith(NEUTRALISED_PREFIX)) {
        const minimal = shrink(base, (s) => isFormulaRisk(s) && !parseField(escapeCsv(s)).startsWith(NEUTRALISED_PREFIX));
        throw new Error(`formula survived for ${JSON.stringify(minimal)} -> cell ${JSON.stringify(cell)}`);
      }
      // Nothing but the quote may precede the payload, or the spreadsheet still
      // sees a formula first.
      if (cell.slice(1) !== base && cell.slice(1) !== String(base)) {
        throw new Error(`the quote was not simply prepended: ${JSON.stringify(base)} -> ${JSON.stringify(cell)}`);
      }
    }
    assert.ok(checked > 100, `only ${checked} hostile payloads were generated — the generator is not doing its job`);
    return `${checked} hostile cells all start with '`;
  });

  await test(`[${fmt(400)} runs] legitimate phone numbers and quantities are never corrupted`, () => {
    const legit = ['+4520123456', '+14155552671', '+919876543210', '+447911123456', '-150', '+1', '-0.5', '+0.75', '+00000'];
    const N = count(400);
    let checked = 0;
    for (let i = 0; i < N; i++) {
      const value = chance(0.5)
        ? pick(legit)
        : (chance(0.5) ? '+' : '-') + Array.from({ length: int(1, 15) }, () => int(0, 9)).join('');
      checked++;
      const cell = parseField(escapeCsv(value));
      if (cell.startsWith(NEUTRALISED_PREFIX)) {
        throw new Error(`a legitimate numeric value was quoted: ${JSON.stringify(value)} -> ${JSON.stringify(cell)}`);
      }
      if (cell !== value) throw new Error(`value was altered: ${JSON.stringify(value)} -> ${JSON.stringify(cell)}`);
    }
    return `${checked} numeric/phone values exported byte-identical`;
  });

  await test(`[${fmt(1000)} runs] escapeCsv round-trips through an RFC4180 field parse`, () => {
    // The stronger invariant behind the two above: whatever the input, a
    // spreadsheet parsing the field recovers exactly the intended text.
    const N = count(1000);
    for (let i = 0; i < N; i++) {
      const value = chance(0.15)
        ? pick([null, undefined, 0, 42, -7, 3.14, true, false, '', ',', '"', '\n', '\r\n', 'a,b', 'a"b', '"quoted"'])
        : randomString();
      const raw = escapeCsv(value);
      let cell;
      try { cell = parseField(raw); } catch (e) { throw new Error(`${e.message} (input ${JSON.stringify(value)})`); }
      const expected = value === null || value === undefined
        ? ''
        : (isFormulaRisk(value) ? NEUTRALISED_PREFIX + String(value) : String(value));
      if (cell !== expected) {
        const minimal = shrink(String(value), (s) => parseField(escapeCsv(s)) !== (isFormulaRisk(s) ? NEUTRALISED_PREFIX + s : s));
        throw new Error(`field did not round-trip for ${JSON.stringify(minimal)}: ${JSON.stringify(raw)} parsed to ${JSON.stringify(cell)}, expected ${JSON.stringify(expected)}`);
      }
      if (!isFormulaRisk(value) && /,|"|\r|\n/.test(raw) && !(raw.startsWith('"') && raw.endsWith('"'))) {
        throw new Error(`a field needing quotes was left bare: ${JSON.stringify(raw)}`);
      }
    }
    return 'parse(escape(v)) === intended text for every input';
  });

  // ------------------------------------------------ Property 4: pagination maths
  section('Property 4 — pagination clamping and page merging');

  await test(`[${fmt(1000)} runs] clampLimit always returns an integer in [1, ${QUEUE_MAX_LIMIT}]`, () => {
    const edges = [-Infinity, Infinity, NaN, -500, -1, 0, 0.5, 1, 50, 500, 501, 999999, 'foo', '', null, undefined, true, false, [], [50], {}, '50', '50.9', '0x10'];
    const N = count(1000);
    for (let i = 0; i < N; i++) {
      const input = chance(0.3) ? pick(edges) : (chance(0.5) ? rng() * 2000 - 1000 : String(rng() * 2000 - 1000));
      let out;
      try { out = clampLimit(input); } catch (e) { throw new Error(`threw on ${JSON.stringify(input)}: ${e.message}`); }
      const bad = () => `clampLimit(${JSON.stringify(input)}) -> ${JSON.stringify(out)}`;
      if (typeof out !== 'number') throw new Error(`returned ${typeof out}: ${bad()}`);
      if (!Number.isInteger(out)) throw new Error(`not an integer: ${bad()}`);
      if (out < 1 || out > QUEUE_MAX_LIMIT) throw new Error(`out of range: ${bad()}`);
    }
    return `always an integer in [1, ${QUEUE_MAX_LIMIT}], never a throw`;
  });

  await test(`[${fmt(500)} runs] appendPage deduplicates by id and preserves order`, () => {
    const N = count(500);
    for (let i = 0; i < N; i++) {
      // A stands in for the loaded window, which is duplicate-free by
      // construction. B is a hostile page that may repeat ids both against A and
      // within itself — appendPage promises the merged window has none.
      const unique = () => {
        const ids = new Set();
        const n = int(0, 20);
        while (ids.size < n) ids.add(int(1, 40));
        return [...ids].map((id) => ({ id, name: randomString(8) }));
      };
      const A = unique();
      const B = Array.from({ length: int(0, 25) }, () => ({ id: int(1, 40), name: randomString(8) }));
      const out = appendPage(A, B);
      const ids = out.map((r) => r.id);
      const dupes = ids.filter((id, at) => ids.indexOf(id) !== at);
      if (dupes.length) throw new Error(`duplicate ids ${JSON.stringify([...new Set(dupes)])} from A=${JSON.stringify(A.map((r) => r.id))} B=${JSON.stringify(B.map((r) => r.id))}`);
      // A's rows keep their relative order and stay at the front.
      const aIds = [...new Set(A.map((r) => r.id))];
      if (JSON.stringify(ids.slice(0, aIds.length)) !== JSON.stringify(aIds)) {
        throw new Error(`existing rows were reordered or displaced: ${JSON.stringify(ids)} vs ${JSON.stringify(aIds)}`);
      }
      // New rows arrive in B's order.
      const appended = ids.slice(aIds.length);
      const expectedAppended = [...new Set(B.map((r) => r.id))].filter((id) => !aIds.includes(id));
      if (JSON.stringify(appended) !== JSON.stringify(expectedAppended)) {
        throw new Error(`appended rows out of order: ${JSON.stringify(appended)} vs ${JSON.stringify(expectedAppended)}`);
      }
      // The inputs must not be mutated, and a no-op merge must keep identity.
      if (A.length !== out.length - appended.length) throw new Error('appendPage mutated the existing window');
      const noop = appendPage(out, out.slice(0, 1));
      if (noop !== out) throw new Error('a merge that adds nothing should return the same array reference');
    }
    return 'no duplicate ids, order preserved, inputs untouched, identity kept on no-op';
  });

  await test(`[${fmt(200)} runs] appendPage survives non-array and hostile arguments`, () => {
    const junk = [null, undefined, 0, '', 'abc', {}, { id: 1 }, [], [{ }], [{ id: null }], [{ id: 'x' }], [null], [1, 2, 3]];
    const N = count(200);
    for (let i = 0; i < N; i++) {
      const a = chance(0.5) ? pick(junk) : [{ id: int(1, 9) }];
      const b = chance(0.5) ? pick(junk) : [{ id: int(1, 9) }];
      let out;
      try { out = appendPage(a, b); } catch (e) { throw new Error(`threw on ${JSON.stringify(a)} + ${JSON.stringify(b)}: ${e.message}`); }
      if (!Array.isArray(out)) throw new Error(`returned ${typeof out} for ${JSON.stringify(a)} + ${JSON.stringify(b)}`);
      const ids = out.filter((r) => r && r.id !== undefined).map((r) => r.id);
      if (new Set(ids).size !== ids.length) throw new Error(`duplicates from ${JSON.stringify(a)} + ${JSON.stringify(b)}`);
    }
    return 'always an array with unique ids, whatever it is given';
  });

  // ------------------------------------------------ Property 5: search escaping
  section('Property 5 — LIKE escaping: user input never reaches the SQL text');

  await test(`[${fmt(500)} runs] queueSearch binds every needle and interpolates nothing`, () => {
    const REF_SEARCH_SQL = queueSearch('reference-needle').sql;
    const N = count(500);
    for (let i = 0; i < N; i++) {
      const needle = chance(0.25)
        ? pick(["' OR 1=1--", '%', '_', '\\', "'; DROP TABLE prospects;--", '%_%', '\\\\', "' ESCAPE '", 'name LIKE'])
        : randomString(30);
      const { sql, params } = queueSearch(needle);
      const trimmed = needle.trim();
      if (!trimmed) {
        if (sql !== '' || params.length !== 0) throw new Error(`an empty needle should produce no predicate, got ${JSON.stringify(sql)}`);
        continue;
      }
      if (params.length !== 5) throw new Error(`expected 5 bound params, got ${params.length} for ${JSON.stringify(needle)}`);
      // The five placeholders are the only holes in the statement.
      const holes = (sql.match(/\?/g) || []).length;
      if (holes !== 5) throw new Error(`expected 5 placeholders, found ${holes} in ${sql}`);
      // The strongest form of "nothing is interpolated": the SQL text must be
      // byte-identical for every needle. (Checking `sql.includes(needle)` is not
      // enough — the needle "name LIKE" legitimately appears in the static
      // column list and produced a false positive.)
      if (sql !== REF_SEARCH_SQL) {
        throw new Error(`the SQL text varied with input ${JSON.stringify(needle)}:\n${sql}\nvs\n${REF_SEARCH_SQL}`);
      }
      for (const p of params) {
        if (typeof p !== 'string') throw new Error(`a bound param is not a string: ${JSON.stringify(p)}`);
        if (!p.startsWith('%') || !p.endsWith('%')) throw new Error(`param is not wrapped for a substring match: ${JSON.stringify(p)}`);
      }
      // Wildcards in the needle must be escaped so they match literally.
      const inner = params[0].slice(1, -1);
      for (const wc of ['%', '_']) {
        const occurrences = inner.split(wc).length - 1;
        const escaped = inner.split(`\\${wc}`).length - 1;
        if (occurrences !== escaped) {
          throw new Error(`an unescaped ${wc} reached the LIKE pattern: ${JSON.stringify(params[0])} from ${JSON.stringify(needle)}`);
        }
      }
      if (escapeLike('') !== '') throw new Error('escapeLike("") must stay empty');
    }
    return '5 bound params, 5 placeholders, zero interpolation, wildcards escaped';
  });

  // ------------------------------------------------ Property 6: import filters
  section('Property 6 — import filters: crash freedom and no false rejections');

  await test(`[${fmt(1000)} runs] isJunkName and isEmptyRow always return a boolean`, () => {
    const N = count(1000);
    for (let i = 0; i < N; i++) {
      const name = chance(0.15) ? pick([null, undefined, 0, 42, true, false, {}, [], NaN]) : randomString(30);
      let junk;
      try { junk = isJunkName(name); } catch (e) { throw new Error(`isJunkName threw on ${JSON.stringify(name)}: ${e.message}`); }
      if (typeof junk !== 'boolean') throw new Error(`isJunkName returned ${typeof junk} for ${JSON.stringify(name)}`);

      const row = {
        phone: chance(0.5) ? '' : randomString(12),
        name: chance(0.5) ? '' : randomString(12),
        email: chance(0.5) ? '' : randomString(12),
        company: chance(0.5) ? '' : randomString(12),
      };
      let empty;
      try { empty = isEmptyRow(row); } catch (e) { throw new Error(`isEmptyRow threw on ${JSON.stringify(row)}: ${e.message}`); }
      if (typeof empty !== 'boolean') throw new Error(`isEmptyRow returned ${typeof empty} for ${JSON.stringify(row)}`);
      // A row with a phone number is never "empty", whatever else is missing.
      if (row.phone && empty) throw new Error(`a row with a phone was called empty: ${JSON.stringify(row)}`);
    }
    return 'boolean every time; a row with a phone is never dropped as empty';
  });

  await test(`[${fmt(300)} runs] real contact names are never mistaken for spreadsheet furniture`, () => {
    const first = ['Aarav', 'Priya', 'Jens', 'Mette', 'Rohan', 'Sofie', 'Anders', 'Neha', 'Karan', 'Frederik'];
    const last = ['Mehta', 'Sharma', 'Nielsen', 'Jensen', 'Gupta', 'Hansen', 'Kapoor', 'Christensen', 'Singh', 'Madsen'];
    const N = count(300);
    for (let i = 0; i < N; i++) {
      const name = `${pick(first)} ${pick(last)}`;
      if (isJunkName(name)) throw new Error(`a real person's name was rejected as junk: ${JSON.stringify(name)}`);
      // A row with a name and NO contact channel is dropped on purpose: the
      // import filter treats "no phone, no email, no company" as a header or a
      // label. That is a product rule from the original bulk-import work, not a
      // defect, so assert it holds rather than calling it a failure.
      if (!isEmptyRow({ name, phone: '', email: '', company: '' })) {
        throw new Error(`a name-only row should be filtered: ${JSON.stringify(name)}`);
      }
      // Add any one contact channel and the same name must be kept.
      for (const row of [{ phone: '+4520123456' }, { email: 'x@y.dk' }, { company: 'Acme ApS' }]) {
        if (isEmptyRow({ name, phone: '', email: '', company: '', ...row })) {
          throw new Error(`a contactable lead was dropped: ${JSON.stringify(name)} + ${JSON.stringify(row)}`);
        }
      }
    }
    return '300 generated names all accepted';
  });

  await test('the junk-name pattern does not backtrack catastrophically on hostile input', () => {
    // JUNK_ROW_PATTERN contains `page \\d+.*` and `sheet\\d*` — sequential
    // quantifiers over overlapping classes, which is the classic ReDoS shape.
    // The input is attacker-controlled (an uploaded spreadsheet), so bound it.
    const hostile = [
      'page ' + '9'.repeat(30000) + '\u0000',
      'page ' + '9'.repeat(30000) + '!',
      'sheet' + '1'.repeat(30000) + '\n',
      'workbook' + ' '.repeat(30000) + '\u0001',
      'total' + 'l'.repeat(30000) + '\r',
      'notes' + '9'.repeat(30000) + '9',
    ];
    count(hostile.length);
    const worst = { ms: 0, input: '' };
    for (const input of hostile) {
      const t0 = process.hrtime.bigint();
      isJunkName(input);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (ms > worst.ms) { worst.ms = ms; worst.input = input.slice(0, 20) + `…(${input.length} chars)`; }
    }
    const BUDGET = 250;
    if (worst.ms > BUDGET) {
      throw new Error(`isJunkName took ${worst.ms.toFixed(0)}ms on ${worst.input} (budget ${BUDGET}ms) — catastrophic backtracking`);
    }
    return `worst case ${worst.ms.toFixed(1)}ms on a 30k-char hostile name (budget ${BUDGET}ms)`;
  });

  // ------------------------------------------------ Property 7: no pollution
  section('Property 7 — prototype pollution');

  await test('no fuzzed input polluted Object.prototype', () => {
    assert.strictEqual(snapshotPrototype(), protoBefore, 'Object.prototype gained or lost a property during the run');
    const canary = {};
    // '__proto__' and 'constructor' resolve on every object by definition, so
    // they are not evidence of pollution; the prototype snapshot above and the
    // injected keys below are.
    for (const key of ['polluted', 'isAdmin', 'admin', 'role', 'prototype']) {
      if (canary[key] !== undefined) {
        throw new Error(`({}).${key} === ${JSON.stringify(canary[key])} — the prototype was polluted`);
      }
    }
    // Payloads that specifically asked for it.
    decodeCursor(Buffer.from('{"__proto__":{"polluted":true},"p":1,"i":1}').toString('base64url'));
    isJunkName('__proto__');
    cleanStr({ __proto__: { polluted: true } });
    queueSearch('__proto__');
    appendPage([{ id: 1 }], JSON.parse('{"__proto__":{"polluted":true}}'));
    assert.strictEqual(snapshotPrototype(), protoBefore, 'a hostile payload polluted Object.prototype');
    if ({}.polluted !== undefined) throw new Error('({}).polluted is set — prototype pollution succeeded');
    return 'Object.prototype unchanged after every hostile payload';
  });

  // ------------------------------------------------ not implemented
  section('Spec targets that do not exist in this repository');

  await test('rotateCallerId / parseEmail / suggestDomain are reported, not faked', () => {
    // The brief listed these under Target A and Target D, along with
    // server/services/{telephony,prospect,csv,email}Service.js and a Danish
    // (+45) locale. None of that exists here: no caller-ID rotation pool, no
    // email parsing or Levenshtein suggestion, and the default country code is
    // 91. Reporting a pass for functions that do not exist would be worse than
    // reporting the gap, so this suite asserts the gap is still a gap. If the
    // modules are ever added, this test fails and forces real coverage for them.
    const fs = require('fs');
    const path = require('path');
    const missing = ['telephonyService.js', 'prospectService.js', 'csvService.js', 'emailService.js']
      .filter((f) => fs.existsSync(path.join(ROOT, 'server', 'services', f)));
    assert.deepStrictEqual(missing, [], 'a *Service.js module appeared — add real property coverage for it and update this test');
    const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
    for (const fn of ['rotateCallerId', 'parseEmail', 'suggestDomain']) {
      assert.ok(!src.includes(fn), `${fn} now exists in server/index.js — write real property tests for it instead of skipping`);
    }
    return 'SKIPPED (not implemented): rotateCallerId, parseEmail, suggestDomain';
  });

  console.log(`\n${fmt(iterations)} pseudo-random iterations executed across the properties above`);
  assert.ok(iterations >= 5000, `expected at least 5,000 iterations, ran ${iterations}`);
  process.exit(summarize('Property tests') ? 1 : 0);
}

main().catch((e) => {
  console.error('\nHarness failure:', e);
  process.exit(1);
});
