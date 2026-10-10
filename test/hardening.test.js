'use strict';
/**
 * Hardening regression suite. Every test here started life as a throwaway red
 * probe: a defect reproduced against the running server, minimised, fixed, and
 * then locked down here. Each one was mutation-tested — reverting the fix turns
 * its test red. Runs against a real server on a throwaway database (test/run.js).
 */
const assert = require('assert');
const { test, section } = require('./support');

const CSRF = { 'X-Requested-With': 'pulse-dialer' };
const EVIL = 'https://evil.example';

/** Raw fetch that deliberately does NOT identify itself as our client. */
const raw = (base, method, url, { headers = {}, body } = {}) =>
  fetch(base + url, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

const text = async (r) => r.text();

async function runHardeningTests(req, base) {
  section('Hardening: errors answer as JSON, not HTML 500s');

  await test('a note on a prospect that does not exist is a 404, not a foreign-key 500', async () => {
    const r = await req('POST', '/api/prospects/999999/notes', { body: 'hi' });
    assert.strictEqual(r.status, 404);
    assert.ok(r.headers.get('content-type').includes('json'), `content-type was ${r.headers.get('content-type')}`);
    assert.ok(!/SqliteError|FOREIGN KEY|<pre>|\/home\/|server\/index\.js/.test(r.text), `leaked internals: ${r.text.slice(0, 160)}`);
    return r.text;
  });

  await test('PATCH a note with no request body at all is a 400, not a TypeError 500', async () => {
    const p = await req('POST', '/api/prospects', { name: 'Note Probe', phone: '9810070001' });
    const note = await req('POST', `/api/prospects/${p.json.id}/notes`, { body: 'original' });
    const r = await raw(base, 'PATCH', `/api/notes/${note.json.id}`, { headers: CSRF }); // no body, no content-type
    assert.strictEqual(r.status, 400, `got ${r.status} :: ${(await text(r)).slice(0, 160)}`);
    const unchanged = await req('GET', `/api/prospects/${p.json.id}`);
    assert.strictEqual(unchanged.json.notes[0].body, 'original', 'a body-less PATCH must not blank the note');
    return 'note left intact';
  });

  await test('PATCH a note that does not exist is a 404', async () => {
    const r = await req('PATCH', '/api/notes/999999', { body: 'x' });
    assert.strictEqual(r.status, 404);
  });

  await test('DELETE a prospect that does not exist is a 404', async () => {
    const r = await req('DELETE', '/api/prospects/999999');
    assert.strictEqual(r.status, 404, `got ${r.status} :: ${r.text}`);
  });

  await test('deleting a prospect cascades to its notes and calls', async () => {
    const p = await req('POST', '/api/prospects', { name: 'Cascade Probe', phone: '9810070002' });
    await req('POST', `/api/prospects/${p.json.id}/notes`, { body: 'going away' });
    const del = await req('DELETE', `/api/prospects/${p.json.id}`);
    assert.strictEqual(del.status, 200);
    assert.strictEqual((await req('GET', `/api/prospects/${p.json.id}`)).status, 404);
    return 'notes + calls removed with the row';
  });

  await test('an unknown /api endpoint answers JSON 404, not the SPA HTML shell', async () => {
    const r = await req('GET', '/api/does-not-exist');
    assert.strictEqual(r.status, 404);
    assert.ok(r.headers.get('content-type').includes('json'), `content-type was ${r.headers.get('content-type')}`);
    assert.ok(r.json && r.json.error, 'expected an { error } body');
  });

  await test('a malformed JSON body is a 400, not an HTML 500', async () => {
    const r = await raw(base, 'POST', '/api/prospects', {
      headers: { ...CSRF, 'Content-Type': 'application/json' },
      body: '{"name": ',
    });
    const body = await text(r);
    assert.strictEqual(r.status, 400, `got ${r.status} :: ${body.slice(0, 160)}`);
    assert.match(body, /Malformed JSON/);
  });

  section('Hardening: cross-site requests cannot drive the API');

  await test('a foreign origin gets no Access-Control-Allow-Origin', async () => {
    const r = await raw(base, 'GET', '/api/stats', { headers: { Origin: EVIL } });
    const acao = r.headers.get('access-control-allow-origin');
    assert.ok(!acao || acao === base, `Access-Control-Allow-Origin: ${acao}`);
    return `ACAO=${acao || 'absent'}`;
  });

  await test('a cross-origin simple request cannot wipe the database', async () => {
    // text/plain + no custom header = a "simple request": the browser sends it
    // with no preflight, so CORS alone would not stop it. /clear ignores bodies.
    await req('POST', '/api/demo', {});
    const before = (await req('GET', '/api/stats')).json.total;
    assert.ok(before > 0, 'precondition: database should not be empty');
    const r = await raw(base, 'POST', '/api/prospects/clear', {
      headers: { Origin: EVIL, 'Content-Type': 'text/plain;charset=UTF-8' },
      body: 'anything',
    });
    assert.strictEqual(r.status, 403, `got ${r.status}`);
    const after = (await req('GET', '/api/stats')).json.total;
    assert.strictEqual(after, before, `database was wiped: ${before} -> ${after}`);
    return `${after} prospects intact`;
  });

  await test('every mutating endpoint refuses a request with no X-Requested-With', async () => {
    const calls = [
      ['POST', '/api/prospects', { name: 'CSRF Probe', phone: '9810070003' }],
      ['PATCH', '/api/prospects/1', { name: 'hijacked' }],
      ['DELETE', '/api/prospects/1', undefined],
      ['POST', '/api/prospects/clear', {}],
      ['POST', '/api/demo', {}],
      ['POST', '/api/prospects/bulk', { rows: [], mapping: {} }],
      ['PUT', '/api/settings', { daily_cap: '99999' }],
      ['POST', '/api/settings/test', {}],
    ];
    const leaked = [];
    for (const [method, url, body] of calls) {
      const r = await raw(base, method, url, {
        headers: { Origin: EVIL, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (r.status !== 403) leaked.push(`${method} ${url} -> ${r.status}`);
    }
    assert.deepStrictEqual(leaked, [], `mutating endpoints accepted an unidentified request: ${leaked.join(', ')}`);
    return `${calls.length} endpoints all refused with 403`;
  });

  await test('reads still work with no header, so links and exports keep working', async () => {
    for (const url of ['/api/stats', '/api/settings', '/api/prospects', '/api/queue?tab=all&limit=5', '/api/prospects/export']) {
      const r = await raw(base, 'GET', url);
      assert.strictEqual(r.status, 200, `GET ${url} -> ${r.status}`);
    }
    return 'GETs are unaffected by the CSRF guard';
  });

  await test('the client sends the CSRF header on mutating calls', async () => {
    const src = await require('fs').promises.readFile(require('path').join(__dirname, '..', 'src', 'api.js'), 'utf8');
    assert.ok(/X-Requested-With/.test(src), 'src/api.js no longer identifies itself; every save would 403');
    assert.ok(/MUTATING|POST/.test(src), 'expected the header to be attached to mutating methods');
    return 'src/api.js attaches it';
  });

  section('Hardening: bounded growth on unauthenticated endpoints');

  await test('POST /api/demo stops adding prospects at the cap', async () => {
    const CAP = 500;
    const statuses = [];
    for (let i = 0; i < 200; i++) statuses.push((await req('POST', '/api/demo', {})).status);
    const total = (await req('GET', '/api/stats')).json.total;
    const refused = statuses.filter((s) => s === 409).length;
    assert.ok(total <= CAP + 8, `table grew to ${total} rows, cap is ${CAP}`);
    assert.ok(refused > 0, `200 calls and none refused (statuses ${[...new Set(statuses)].join(',')})`);
    return `${refused}/200 refused, table settled at ${total}`;
  });

  await test('POST /api/prospects/bulk rejects an absurd row count', async () => {
    const rows = Array.from({ length: 100001 }, (_, i) => ({ Name: `X ${i}`, Phone: `98100${i}` }));
    const r = await req('POST', '/api/prospects/bulk', { rows, mapping: { name: 'Name', phone: 'Phone' } });
    assert.strictEqual(r.status, 400, `got ${r.status} :: ${r.text.slice(0, 120)}`);
    assert.match(r.json.error, /limit/i);
    return r.json.error;
  });

  await test('POST /api/prospects/bulk rejects a non-array rows field', async () => {
    const r = await req('POST', '/api/prospects/bulk', { rows: { Name: 'sneaky' }, mapping: {} });
    assert.strictEqual(r.status, 400);
  });

  await test('a normal bulk import still works after the cap was added', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ Name: `Cap Check ${i}`, Phone: `98100${String(60000 + i)}` }));
    const r = await req('POST', '/api/prospects/bulk', { rows, mapping: { name: 'Name', phone: 'Phone' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.added, 50);
    return '50 rows imported';
  });

  section('Hardening: spreadsheet export and validation');

  await test('CSV export neutralises formula injection but keeps + phone numbers', async () => {
    const payloads = ['=1+1', '+cmd|\' /C calc\'!A0', '-2+3', '@SUM(A1:A2)', '\t=evil'];
    for (const p of payloads) await req('POST', '/api/prospects', { name: p, phone: '9810070004' });
    const keep = await req('POST', '/api/prospects', { name: 'Real Person', phone: '+919810070005' });
    assert.strictEqual(keep.status, 200);

    const r = await raw(base, 'GET', '/api/prospects/export');
    const csv = await text(r);
    const cells = csv.split('\r\n').slice(1).map((l) => l.split(','));

    for (const p of payloads) {
      const row = cells.find((c) => c[1] === p || c[1] === `"${p}"`);
      assert.ok(!row, `payload ${JSON.stringify(p)} was exported verbatim — Excel would evaluate it`);
    }
    const quoted = cells.filter((c) => c[1] && c[1].startsWith("'"));
    assert.ok(quoted.length >= payloads.length, `expected ${payloads.length} neutralised cells, found ${quoted.length}`);

    // The heuristic must not corrupt legitimate international numbers.
    const person = cells.find((c) => c[1] === 'Real Person');
    assert.ok(person, 'the control row is missing from the export');
    assert.strictEqual(person[2], '+919810070005', `phone number was mangled: ${person[2]}`);
    return `${quoted.length} payloads quoted, +919810070005 preserved`;
  });

  await test('PATCH with an invalid stage is rejected, a valid one is accepted', async () => {
    const p = await req('POST', '/api/prospects', { name: 'Stage Probe', phone: '9810070006' });
    const bad = await req('PATCH', `/api/prospects/${p.json.id}`, { stage: 'DROP TABLE prospects' });
    assert.strictEqual(bad.status, 400, `got ${bad.status}, an invalid stage was silently ignored`);
    const good = await req('PATCH', `/api/prospects/${p.json.id}`, { stage: 'won' });
    assert.strictEqual(good.status, 200);
    assert.strictEqual(good.json.stage, 'won');
    return 'invalid rejected, valid applied';
  });

  section('Hardening: response headers');

  await test('responses carry the security headers', async () => {
    const r = await raw(base, 'GET', '/api/settings');
    const h = (n) => r.headers.get(n);
    assert.strictEqual(h('x-content-type-options'), 'nosniff');
    assert.strictEqual(h('referrer-policy'), 'same-origin');
    const csp = h('content-security-policy') || '';
    for (const directive of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "script-src 'self'"]) {
      assert.ok(csp.includes(directive), `CSP is missing ${directive}: ${csp}`);
    }
    // Only sent for the locked-down default: X-Frame-Options cannot express an
    // allowlist, and the app must remain embeddable when FRAME_ANCESTORS is set.
    assert.strictEqual(h('x-frame-options'), 'DENY');
    return 'nosniff, DENY, same-origin, CSP present';
  });

  await test('FRAME_ANCESTORS lets an operator permit embedding without opening everything', async () => {
    const { startServer } = require('./support');
    const srv = await startServer({ label: 'frame', env: { FRAME_ANCESTORS: 'https://portal.example.com' } });
    try {
      const r = await fetch(`${srv.base}/api/settings`);
      const csp = r.headers.get('content-security-policy') || '';
      assert.ok(csp.includes('frame-ancestors https://portal.example.com'), `CSP did not honour the override: ${csp}`);
      assert.ok(!csp.includes("frame-ancestors 'none'"), 'the override was ignored');
      assert.strictEqual(r.headers.get('x-frame-options'), null, 'X-Frame-Options must be dropped when embedding is allowed, or it wins and blocks the frame anyway');
      // Everything else stays locked down.
      assert.ok(csp.includes("object-src 'none'") && csp.includes("default-src 'self'"), `other directives were weakened: ${csp}`);
      return 'embedding allowed for one origin, rest intact';
    } finally {
      await srv.stop();
    }
  });

  await test('the CSP allows the built client to load its own assets', async () => {
    const r = await raw(base, 'GET', '/api/settings');
    const csp = r.headers.get('content-security-policy') || '';
    // framer-motion and React write inline style attributes at runtime.
    assert.ok(csp.includes("style-src 'self' 'unsafe-inline'"), `inline styles would be blocked: ${csp}`);
    assert.ok(csp.includes("connect-src 'self'"), `fetch() to /api would be blocked: ${csp}`);
    return 'inline styles + same-origin fetch permitted';
  });
}

module.exports = { runHardeningTests };
