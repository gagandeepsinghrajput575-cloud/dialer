'use strict';
/**
 * API integration tests. Run by `npm test` (test/run.js) against a server on a
 * throwaway database. The first section preserves the original verification
 * suite; the rest covers the server-backed queue pagination contract.
 */
const assert = require('assert');
const { test, section, walkQueue } = require('./support');

const FIELDS = ['name', 'phone', 'email', 'company', 'title', 'location', 'website'];

/** Seed n prospects; every 5th deliberately has no phone number. */
async function seed(req, n) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    const noPhone = i % 5 === 0;
    rows.push({
      Name: `Lead ${String(i).padStart(4, '0')}`,
      Phone: noPhone ? '' : `98100${String(10000 + i)}`,
      Email: `lead${i}@example.org`,
      Company: `Company ${i}`,
    });
  }
  const r = await req('POST', '/api/prospects/bulk', {
    rows,
    mapping: { name: 'Name', phone: 'Phone', email: 'Email', company: 'Company' },
  });
  assert.strictEqual(r.status, 200, `bulk seed failed: ${r.text}`);
  return r.json;
}

async function listAll(req) {
  const r = await req('GET', '/api/prospects');
  assert.strictEqual(r.status, 200);
  return r.json;
}
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

// ---------------------------------------------------------------- core flows
async function runCoreTests(req) {
  section('Core flows (regression suite)');

  // keep the fixtures idempotent across runs
  for (const p of await listAll(req)) {
    if (p.name === 'Valid Lead' || p.name === 'Test Suite User') await req('DELETE', `/api/prospects/${p.id}`);
  }

  let testId = null;
  let testCallId = null;

  await test('GET /api/prospects returns an array', async () => {
    const r = await req('GET', '/api/prospects');
    assert.strictEqual(r.status, 200);
    assert(Array.isArray(r.json));
    return `${r.json.length} prospects`;
  });

  await test('POST /api/prospects trims name and normalizes phone to +91', async () => {
    const r = await req('POST', '/api/prospects', {
      name: '  Test Suite User  ',
      phone: '9810099999',
      email: 'test@example.com',
      company: 'Acme Test Corp',
      title: 'QA Lead',
      stage: 'new',
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.name, 'Test Suite User');
    assert.strictEqual(r.json.phone, '+919810099999');
    assert.strictEqual(r.json.dnc, false, 'dnc should be a boolean on the wire');
    testId = r.json.id;
    return `id ${testId}`;
  });

  await test('phone normalisation is stable when applied twice', async () => {
    // '00568' used to normalise to '+568' — long enough as raw input, too short
    // once the 00 access prefix was stripped. The stored value then normalised to
    // '' on any later PATCH, so the same number had two canonical forms. The
    // property suite caught it; this pins the HTTP contract.
    const cases = [
      ['00568', ''],            // 00 prefix leaves 3 digits
      ['00000', ''],            // nothing but padding
      ['+12', ''],              // under the 5-digit floor
      ['004520123456', '+4520123456'], // a real 00-prefixed international number
      ['09810099998', '+919810099998'], // trunk 0 with the default country code
    ];
    for (const [input, expected] of cases) {
      const r = await req('POST', '/api/prospects', { name: `Phone Case ${input}`, phone: input });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.phone, expected, `normalizePhone(${JSON.stringify(input)}) -> ${JSON.stringify(r.json.phone)}, expected ${JSON.stringify(expected)}`);
      // Whatever was stored must survive a second pass unchanged.
      const again = await req('PATCH', `/api/prospects/${r.json.id}`, { phone: r.json.phone || 'n/a' });
      if (r.json.phone) {
        assert.strictEqual(again.json.phone, r.json.phone, `not idempotent for ${JSON.stringify(input)}: ${r.json.phone} -> ${again.json.phone}`);
      }
      await req('DELETE', `/api/prospects/${r.json.id}`);
    }
    return `${cases.length} cases, all stable under re-normalisation`;
  });

  await test('PATCH /api/prospects/:id updates stage and title', async () => {
    const r = await req('PATCH', `/api/prospects/${testId}`, { stage: 'interested', title: 'VP Quality' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.stage, 'interested');
    assert.strictEqual(r.json.title, 'VP Quality');
  });

  await test('PATCH rejects an unknown stage', async () => {
    const r = await req('PATCH', `/api/prospects/${testId}`, { stage: 'not-a-stage' });
    // This used to assert 200 + "unknown stage must be ignored", which pinned
    // the bug rather than the behaviour the test name describes: the client was
    // told the write succeeded while the row never changed.
    assert.strictEqual(r.status, 400, `an unknown stage should be refused, got ${r.status}`);
    assert.match(r.json.error, /Unknown stage/);
    const after = await req('GET', `/api/prospects/${testId}`);
    assert.strictEqual(after.json.stage, 'interested', 'a rejected PATCH must leave the row untouched');
  });

  await test('POST /api/prospects/:id/call logs a call and bumps call_count', async () => {
    const r = await req('POST', `/api/prospects/${testId}/call`);
    assert.strictEqual(r.status, 200);
    assert(r.json.callId > 0);
    assert.strictEqual(r.json.dryRun, true, 'dry_run defaults to on, so no real dial');
    testCallId = r.json.callId;
    const after = await req('GET', `/api/prospects/${testId}`);
    assert.strictEqual(after.json.call_count, 1);
    return `callId ${testCallId}`;
  });

  await test('PATCH /api/calls/:id classifies and updates last_outcome', async () => {
    const r = await req('PATCH', `/api/calls/${testCallId}`, { outcome: 'conversation', duration_sec: 25 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.prospect.last_outcome, 'conversation');
  });

  await test('PATCH /api/calls/:id rejects a bad outcome', async () => {
    const r = await req('PATCH', `/api/calls/${testCallId}`, { outcome: 'banana' });
    assert.strictEqual(r.status, 400);
  });

  await test('call discard removes the row and decrements call_count', async () => {
    const c2 = await req('POST', `/api/prospects/${testId}/call`);
    const before = await req('GET', `/api/prospects/${testId}`);
    assert.strictEqual(before.json.call_count, 2);
    const d = await req('POST', `/api/calls/${c2.json.callId}/discard`);
    assert.strictEqual(d.status, 200);
    const after = await req('GET', `/api/prospects/${testId}`);
    assert.strictEqual(after.json.call_count, 1);
  });

  await test('DELETE /api/calls/:id removes the row and decrements call_count', async () => {
    // This route had no coverage at all, and was an exact copy of the discard
    // route above; both now share dropCall() in server/index.js.
    const c3 = await req('POST', `/api/prospects/${testId}/call`);
    assert.strictEqual(c3.status, 200);
    const before = await req('GET', `/api/prospects/${testId}`);
    const d = await req('DELETE', `/api/calls/${c3.json.callId}`);
    assert.strictEqual(d.status, 200);
    const after = await req('GET', `/api/prospects/${testId}`);
    assert.strictEqual(after.json.call_count, before.json.call_count - 1, 'the dial was not given back');
    assert.strictEqual(after.json.calls.some((c) => c.id === c3.json.callId), false, 'the call row survived');
  });

  await test('discarding a call twice is harmless, and neither route 404s', async () => {
    const c4 = await req('POST', `/api/prospects/${testId}/call`);
    const first = await req('POST', `/api/calls/${c4.json.callId}/discard`);
    const second = await req('POST', `/api/calls/${c4.json.callId}/discard`);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(second.status, 200, 'a double-discard should stay idempotent');
    assert.strictEqual((await req('DELETE', '/api/calls/999999')).status, 200);
    const after = await req('GET', `/api/prospects/${testId}`);
    assert.ok(after.json.call_count >= 0, 'call_count went negative');
    return `call_count floored at ${after.json.call_count}`;
  });

  await test('notes can be added to a prospect', async () => {
    const r = await req('POST', `/api/prospects/${testId}/notes`, { body: 'Verification note text' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.body, 'Verification note text');
  });

  await test('empty note is rejected', async () => {
    const r = await req('POST', `/api/prospects/${testId}/notes`, { body: '   ' });
    assert.strictEqual(r.status, 400);
  });

  await test('CSV export is RFC4180-ish and carries notes', async () => {
    const r = await req('GET', '/api/prospects/export');
    assert.strictEqual(r.status, 200);
    assert(r.headers.get('content-type').includes('text/csv'));
    assert(r.text.includes('ID,Name,Phone,Email,Company,Title,Stage'));
    assert(r.text.includes('Test Suite User'));
    assert(r.text.includes('Verification note text'));
  });

  await test('bulk import filters junk rows and duplicates', async () => {
    const r = await req('POST', '/api/prospects/bulk', {
      rows: [
        { 'Full Name': 'Total', Phone: '', Email: '' },
        { 'Full Name': 'Page 1 of 4', Phone: '', Email: '' },
        { 'Full Name': 'Valid Lead', Phone: '9876543210', Email: 'lead@company.org' },
        { 'Full Name': 'Valid Lead', Phone: '9876543210', Email: 'lead@company.org' },
        { 'Full Name': 'null', Phone: '0', Email: 'none' },
      ],
      mapping: { name: 'Full Name', phone: 'Phone', email: 'Email' },
      skipDuplicates: true,
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.added, 1);
    assert.strictEqual(r.json.dupes, 1);
    assert.strictEqual(r.json.empty, 3);
    const imported = (await listAll(req)).find((p) => p.name === 'Valid Lead');
    if (imported) await req('DELETE', `/api/prospects/${imported.id}`);
  });

  await test('stats expose a 7-day week and today dial count', async () => {
    const r = await req('GET', `/api/stats?tzOffset=${new Date().getTimezoneOffset()}`);
    assert.strictEqual(r.status, 200);
    assert(r.json.today.dials >= 1);
    assert(Array.isArray(r.json.week));
    assert.strictEqual(r.json.week.length, 7);
    assert(typeof r.json.total === 'number');
  });

  await test('unknown prospect returns 404', async () => {
    const r = await req('GET', '/api/prospects/99999999');
    assert.strictEqual(r.status, 404);
  });

  await test('cleanup: test fixture deleted', async () => {
    const r = await req('DELETE', `/api/prospects/${testId}`);
    assert.strictEqual(r.status, 200);
    const after = await req('GET', `/api/prospects/${testId}`);
    assert.strictEqual(after.status, 404);
  });
}

// ------------------------------------------------------------ queue contract
async function runQueueTests(req) {
  section('Server-backed queue: response contract');

  await test('seeded fixtures for queue tests', async () => {
    const s = await seed(req, 27);
    assert.strictEqual(s.added, 27);
    return `${s.added} prospects`;
  });

  // vary stages so every tab has members, and mark one Do Not Call
  const all0 = await listAll(req);
  const ids0 = all0.map((p) => p.id).sort((a, b) => a - b);
  await req('PATCH', `/api/prospects/${ids0[1]}`, { stage: 'contacted' });
  await req('PATCH', `/api/prospects/${ids0[2]}`, { stage: 'interested' });
  await req('PATCH', `/api/prospects/${ids0[3]}`, { stage: 'followup' });
  await req('PATCH', `/api/prospects/${ids0[4]}`, { stage: 'won' });
  await req('PATCH', `/api/prospects/${ids0[6]}`, { stage: 'meeting' });
  const dncId = ids0[8];
  await req('PATCH', `/api/prospects/${dncId}`, { dnc: true });

  await test('GET /api/queue returns the documented envelope', async () => {
    const r = await req('GET', '/api/queue?tab=all&limit=5');
    assert.strictEqual(r.status, 200);
    for (const k of ['items', 'total', 'counts', 'hasMore', 'limit', 'tab', 'q', 'nextCursor']) {
      assert(k in r.json, `response is missing "${k}"`);
    }
    assert(Array.isArray(r.json.items));
    assert.strictEqual(r.json.limit, 5);
    assert.strictEqual(r.json.tab, 'all');
    assert.strictEqual(r.json.q, '');
    assert.strictEqual(r.json.items.length, 5);
    assert.strictEqual(r.json.hasMore, true);
    assert(typeof r.json.nextCursor === 'string' && r.json.nextCursor.length > 0);
    return `total ${r.json.total}, counts ${JSON.stringify(r.json.counts)}`;
  });

  await test('defaults to tab=all and limit=50 when no params are sent', async () => {
    const r = await req('GET', '/api/queue');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.tab, 'all');
    assert.strictEqual(r.json.limit, 50);
    assert(r.json.items.length <= 50);
  });

  await test('queue items are byte-identical to /api/prospects rows', async () => {
    const q = await req('GET', '/api/queue?limit=3');
    const list = byId(await listAll(req));
    for (const item of q.json.items) {
      assert.deepStrictEqual(item, list[item.id], `item ${item.id} differs from the full-list shape`);
      assert.deepStrictEqual(Object.keys(item).sort(), Object.keys(list[item.id]).sort());
      assert(!('has_phone' in item), 'internal sort helper leaked into the response');
    }
    return `${q.json.items.length} items compared`;
  });

  await test('rejects an unknown tab', async () => {
    const r = await req('GET', '/api/queue?tab=bogus');
    assert.strictEqual(r.status, 400);
    assert(/tab/i.test(r.json.error));
  });

  await test('rejects a non-numeric or sub-1 limit', async () => {
    for (const bad of ['0', '-3', 'abc', '1.5e9999']) {
      const r = await req('GET', `/api/queue?limit=${bad}`);
      assert.strictEqual(r.status, 400, `limit=${bad} should be rejected, got ${r.status}`);
    }
  });

  await test('clamps an oversized limit instead of failing', async () => {
    const r = await req('GET', '/api/queue?limit=99999');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.limit, 500);
  });

  await test('rejects a malformed cursor', async () => {
    const garbage = [
      '!!!not-base64!!!',
      Buffer.from('{"p":9,"i":1}').toString('base64url'),   // bad has_phone flag
      Buffer.from('{"p":1,"i":-4}').toString('base64url'),   // negative id
      Buffer.from('{"p":1}').toString('base64url'),          // missing id
      Buffer.from('[]').toString('base64url'),
      Buffer.from('null').toString('base64url'),
      // Beyond 2^53 the JSON round-trip is lossy, so the codec cannot promise a
      // faithful page. Found by the property suite; see test/unit/property.test.js.
      Buffer.from('{"p":1,"i":9007199254740993}').toString('base64url'),
      Buffer.from('{"p":1,"i":1e308}').toString('base64url'),
      Buffer.from('{"p":1,"i":9223372036854775807}').toString('base64url'),
    ];
    for (const c of garbage) {
      const r = await req('GET', `/api/queue?cursor=${encodeURIComponent(c)}`);
      assert.strictEqual(r.status, 400, `cursor ${c} should be rejected`);
    }
    return `${garbage.length} bad cursors rejected`;
  });

  section('Server-backed queue: pagination correctness');

  await test('walking every page returns each prospect exactly once', async () => {
    const walk = await walkQueue(req, { tab: 'all', limit: 5 });
    const expected = (await listAll(req)).filter((p) => !p.dnc).map((p) => p.id).sort((a, b) => a - b);
    assert.deepStrictEqual([...walk.ids].sort((a, b) => a - b), expected);
    assert.strictEqual(walk.total, expected.length);
    assert.strictEqual(walk.pages.length, Math.ceil(expected.length / 5));
    return `${walk.ids.length} rows over ${walk.pages.length} pages`;
  });

  await test('ordering is has-phone-first then ascending id', async () => {
    const walk = await walkQueue(req, { tab: 'all', limit: 4 });
    const rows = byId(await listAll(req));
    const keys = walk.ids.map((id) => ({ id, hp: rows[id].phone && rows[id].phone.trim() ? 1 : 0 }));
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1];
      const b = keys[i];
      const ok = a.hp > b.hp || (a.hp === b.hp && a.id < b.id);
      assert(ok, `order broken at position ${i}: ${JSON.stringify(a)} then ${JSON.stringify(b)}`);
    }
    const firstPhoneless = keys.findIndex((k) => k.hp === 0);
    if (firstPhoneless !== -1) {
      assert(keys.slice(firstPhoneless).every((k) => k.hp === 0), 'phoneless rows must all sort last');
    }
    return `${keys.filter((k) => k.hp).length} dialable, ${keys.length - keys.filter((k) => k.hp).length} without a number`;
  });

  await test('a page never exceeds the requested limit', async () => {
    for (const limit of [1, 2, 7]) {
      const r = await req('GET', `/api/queue?limit=${limit}`);
      assert.strictEqual(r.json.items.length, limit);
    }
  });

  await test('the last page reports hasMore=false and nextCursor=null', async () => {
    const total = (await req('GET', '/api/queue?limit=1')).json.total;
    const walk = await walkQueue(req, { tab: 'all', limit: total }); // one page holds everything
    assert.strictEqual(walk.pages.length, 1);
    assert.strictEqual(walk.meta.hasMore, false);
    assert.strictEqual(walk.meta.nextCursor, null);
    assert.strictEqual(walk.ids.length, total);
  });

  await test('Do Not Call prospects are excluded from every tab', async () => {
    const walk = await walkQueue(req, { tab: 'all', limit: 6 });
    assert(!walk.ids.includes(dncId), 'DNC prospect leaked into the queue');
    const list = await listAll(req);
    assert(list.some((p) => p.id === dncId && p.dnc), 'DNC prospect should still exist in the full list');
    assert.strictEqual(walk.total, list.filter((p) => !p.dnc).length);
  });

  await test('tab=new returns only stage "new" and matches its count', async () => {
    const walk = await walkQueue(req, { tab: 'new', limit: 3 });
    const rows = byId(await listAll(req));
    for (const id of walk.ids) assert.strictEqual(rows[id].stage, 'new', `id ${id} has stage ${rows[id].stage}`);
    const expected = (await listAll(req)).filter((p) => !p.dnc && p.stage === 'new').length;
    assert.strictEqual(walk.total, expected);
    assert.strictEqual(walk.counts.new, expected);
    return `${walk.total} to call`;
  });

  await test('tab=follow returns contacted/interested/followup only', async () => {
    const walk = await walkQueue(req, { tab: 'follow', limit: 2 });
    const rows = byId(await listAll(req));
    const allowed = ['contacted', 'interested', 'followup'];
    for (const id of walk.ids) assert(allowed.includes(rows[id].stage), `id ${id} stage ${rows[id].stage} is not a follow-up`);
    const expected = (await listAll(req)).filter((p) => !p.dnc && allowed.includes(p.stage)).length;
    assert.strictEqual(walk.total, expected);
    assert.strictEqual(walk.counts.follow, expected);
    return `${walk.total} follow-ups`;
  });

  await test('counts are identical across tabs (they describe the whole queue)', async () => {
    const a = (await req('GET', '/api/queue?tab=new&limit=1')).json.counts;
    const b = (await req('GET', '/api/queue?tab=follow&limit=1')).json.counts;
    const c = (await req('GET', '/api/queue?tab=all&limit=1')).json.counts;
    assert.deepStrictEqual(a, b);
    assert.deepStrictEqual(b, c);
    assert.deepStrictEqual(Object.keys(c).sort(), ['all', 'follow', 'new']);
  });

  await test('logging an outcome moves the prospect out of tab=new into tab=follow', async () => {
    const before = await walkQueue(req, { tab: 'new', limit: 100 });
    const target = before.ids[0];
    const call = await req('POST', `/api/prospects/${target}/call`);
    await req('PATCH', `/api/calls/${call.json.callId}`, { outcome: 'conversation', duration_sec: 12 });
    const afterNew = await walkQueue(req, { tab: 'new', limit: 100 });
    const afterFollow = await walkQueue(req, { tab: 'follow', limit: 100 });
    assert(!afterNew.ids.includes(target), 'prospect should have left the To call tab');
    assert(afterFollow.ids.includes(target), 'prospect should now be a follow-up');
    assert.strictEqual(afterNew.total, before.total - 1);
  });

  section('Server-backed queue: search');

  await test('search is case-insensitive and covers name/company/phone/email', async () => {
    const rows = await listAll(req);
    const withPhone = rows.find((p) => p.phone && !p.dnc);
    const nameHit = await req('GET', `/api/queue?q=${encodeURIComponent('lEaD 0007')}`);
    assert(nameHit.json.items.some((p) => p.name === 'Lead 0007'));
    const companyHit = await req('GET', `/api/queue?q=${encodeURIComponent('company 2')}`);
    assert(companyHit.json.total >= 1);
    const digits = withPhone.phone.replace(/\D/g, '').slice(4, 9);
    const phoneHit = await req('GET', `/api/queue?q=${digits}`);
    assert(phoneHit.json.items.some((p) => p.id === withPhone.id), `phone fragment ${digits} did not match`);
    // Pick a live (non-DNC) row rather than hardcoding an id: DNC prospects are
    // deliberately absent from the queue, so a fixed fixture would be brittle.
    const withEmail = rows.find((p) => !p.dnc && p.email);
    assert(withEmail, 'no non-DNC prospect with an email to search for');
    const emailHit = await req('GET', `/api/queue?q=${encodeURIComponent(`${withEmail.email.split('@')[0]}@`)}`);
    assert(
      emailHit.json.items.some((p) => p.id === withEmail.id),
      `email fragment for ${withEmail.email} did not match (got ${emailHit.json.items.length} rows)`
    );
    const dncRow = rows.find((p) => p.dnc && p.email);
    if (dncRow) {
      const dncHit = await req('GET', `/api/queue?q=${encodeURIComponent(dncRow.email.split('@')[0])}`);
      assert(!dncHit.json.items.some((p) => p.id === dncRow.id), 'a matching DNC prospect must stay out of the queue');
    }
    return 'name/company/phone/email all matched, DNC still filtered';
  });

  await test('LIKE wildcards in the search term are escaped, not honoured', async () => {
    for (const needle of ['%', '_', '%%', '%_%']) {
      const r = await req('GET', `/api/queue?q=${encodeURIComponent(needle)}`);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.total, 0, `search "${needle}" matched ${r.json.total} rows (wildcard leak)`);
    }
  });

  await test('a backslash in the search term is treated literally', async () => {
    const r = await req('GET', `/api/queue?q=${encodeURIComponent('\\')}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.total, 0);
  });

  await test('a search with no hits returns an empty, terminal page', async () => {
    const r = await req('GET', '/api/queue?q=zzz-not-present-zzz&limit=5');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.items, []);
    assert.strictEqual(r.json.total, 0);
    assert.strictEqual(r.json.hasMore, false);
    assert.strictEqual(r.json.nextCursor, null);
    assert.deepStrictEqual(r.json.counts, { new: 0, follow: 0, all: 0 });
    assert.strictEqual(r.json.q, 'zzz-not-present-zzz');
  });

  await test('search echoes back trimmed and counts stay search-aware', async () => {
    const r = await req('GET', `/api/queue?q=${encodeURIComponent('   company 1   ')}&limit=3`);
    assert.strictEqual(r.json.q, 'company 1');
    const unfiltered = (await req('GET', '/api/queue?limit=1')).json.counts.all;
    assert(r.json.counts.all < unfiltered, 'search should narrow the counts');
    assert.strictEqual(r.json.total, r.json.counts.all);
  });

  await test('paging through a filtered search yields exactly the matching rows', async () => {
    const walk = await walkQueue(req, { tab: 'all', limit: 2, q: 'company 1' });
    const expected = (await listAll(req))
      .filter((p) => !p.dnc && `${p.name} ${p.company} ${p.phone} ${p.email} ${p.title}`.toLowerCase().includes('company 1'))
      .map((p) => p.id)
      .sort((a, b) => a - b);
    assert.deepStrictEqual([...walk.ids].sort((a, b) => a - b), expected);
    return `${walk.ids.length} matches over ${walk.pages.length} pages`;
  });

  section('Server-backed queue: cursor stability under mutation');

  await test('deleting a row mid-walk neither duplicates nor skips the rest', async () => {
    const p1 = await req('GET', '/api/queue?limit=4');
    const victim = p1.json.items[2].id;
    await req('DELETE', `/api/prospects/${victim}`);
    const p2 = await req('GET', `/api/queue?limit=4&cursor=${p1.json.nextCursor}`);
    assert.strictEqual(p2.status, 200);
    const overlap = p2.json.items.filter((i) => p1.json.items.some((x) => x.id === i.id));
    assert.strictEqual(overlap.length, 0, 'page 2 repeated rows from page 1');
    const walk = await walkQueue(req, { tab: 'all', limit: 4 });
    assert(!walk.ids.includes(victim), 'deleted prospect is still in the queue');
  });

  await test('inserting a row mid-walk does not corrupt the walk', async () => {
    const p1 = await req('GET', '/api/queue?limit=4');
    const created = await req('POST', '/api/prospects', { name: 'Mid Walk Insert', phone: '9810055555', email: 'mid@walk.io' });
    const p2 = await req('GET', `/api/queue?limit=4&cursor=${p1.json.nextCursor}`);
    const overlap = p2.json.items.filter((i) => p1.json.items.some((x) => x.id === i.id));
    assert.strictEqual(overlap.length, 0);
    const walk = await walkQueue(req, { tab: 'all', limit: 4 });
    assert(walk.ids.includes(created.json.id), 'newly inserted prospect never appeared');
    await req('DELETE', `/api/prospects/${created.json.id}`);
  });

  await test('replaying a stale cursor is still safe (keyset, not offset)', async () => {
    const p1 = await req('GET', '/api/queue?limit=3');
    const a = await req('GET', `/api/queue?limit=3&cursor=${p1.json.nextCursor}`);
    const b = await req('GET', `/api/queue?limit=3&cursor=${p1.json.nextCursor}`);
    assert.deepStrictEqual(a.json.items.map((i) => i.id), b.json.items.map((i) => i.id));
  });

  await test('GET /api/prospects still returns the complete list (no regression)', async () => {
    const list = await listAll(req);
    const queue = await walkQueue(req, { tab: 'all', limit: 100 });
    assert.strictEqual(list.length, queue.total + 1, 'full list = queue + the one DNC prospect');
    assert(list.some((p) => p.id === dncId));
  });
}

// -------------------------------------------------------------- scale checks
async function runScaleTests(req) {
  section('Server-backed queue: empty database and scale');

  await test('an empty database returns a well-formed empty page', async () => {
    const r = await req('GET', '/api/queue?tab=all&limit=50');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.items, []);
    assert.strictEqual(r.json.total, 0);
    assert.deepStrictEqual(r.json.counts, { new: 0, follow: 0, all: 0 });
    assert.strictEqual(r.json.hasMore, false);
    assert.strictEqual(r.json.nextCursor, null);
  });

  const N = 2000;
  await test(`bulk-seeding ${N} prospects`, async () => {
    const s = await seed(req, N);
    assert.strictEqual(s.added, N);
    return `${s.added} rows`;
  });

  await test('a page is a page: 50 rows returned out of 2000', async () => {
    const r = await req('GET', '/api/queue?limit=50');
    assert.strictEqual(r.json.items.length, 50);
    assert.strictEqual(r.json.total, N);
    assert.strictEqual(r.json.hasMore, true);
    const full = await req('GET', '/api/prospects');
    assert.strictEqual(full.json.length, N, 'sanity: the unpaginated endpoint still returns everything');
    const pageSize = JSON.stringify(r.json).length;
    const fullSize = JSON.stringify(full.json).length;
    assert(pageSize < fullSize / 10, `page payload ${pageSize}B should dwarf-shrink vs ${fullSize}B`);
    return `${(pageSize / 1024).toFixed(1)}KB per page vs ${(fullSize / 1024).toFixed(0)}KB for the full list`;
  });

  await test('walking 2000 rows at limit=500 stays consistent', async () => {
    const walk = await walkQueue(req, { tab: 'all', limit: 500 });
    assert.strictEqual(walk.ids.length, N);
    assert.strictEqual(walk.pages.length, Math.ceil(N / 500));
    assert.strictEqual(new Set(walk.ids).size, N, 'duplicate ids across pages');
    return `${walk.pages.length} pages, no duplicates`;
  });

  await test('page latency stays flat while paging deeper', async () => {
    const time = async (cursor) => {
      const url = `/api/queue?limit=50${cursor ? `&cursor=${cursor}` : ''}`;
      const t0 = Date.now();
      const r = await req('GET', url);
      assert.strictEqual(r.status, 200);
      return { ms: Date.now() - t0, cursor: r.json.nextCursor };
    };
    const first = await time(null);
    let cur = first.cursor;
    for (let i = 0; i < 10; i++) cur = (await time(cur)).cursor; // ~550 rows deep
    const deep = await time(cur);
    assert(first.ms < 1500, `first page took ${first.ms}ms`);
    assert(deep.ms < 1500, `deep page took ${deep.ms}ms`);
    return `first ${first.ms}ms, deep ${deep.ms}ms`;
  });

  await test('search over 2000 rows still returns a correct, bounded page', async () => {
    const r = await req('GET', `/api/queue?q=${encodeURIComponent('company 19')}&limit=10`);
    assert.strictEqual(r.status, 200);
    assert(r.json.items.length <= 10);
    assert(r.json.items.every((p) => `${p.name} ${p.company} ${p.email}`.toLowerCase().includes('company 19')));
    assert.strictEqual(r.json.total, r.json.counts.all);
    return `${r.json.total} matches`;
  });
}

module.exports = { runCoreTests, runQueueTests, runScaleTests, seed, FIELDS };
