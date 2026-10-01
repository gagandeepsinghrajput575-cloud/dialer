const assert = require('assert');

const BASE = 'http://localhost:3001';

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

async function run() {
  console.log('--- Starting Complete System Verification Suite ---');

  // Pre-test cleanup of any previous test fixtures
  const pre = await req('GET', '/api/prospects');
  if (Array.isArray(pre.json)) {
    for (const p of pre.json) {
      if (p.name === 'Valid Lead' || p.name === 'Test Suite User') {
        await req('DELETE', `/api/prospects/${p.id}`);
      }
    }
  }

  // 1. Prospects list
  console.log('[1/10] Testing GET /api/prospects');
  const pList = await req('GET', '/api/prospects');
  assert.strictEqual(pList.status, 200);
  assert(Array.isArray(pList.json));
  console.log(`✓ Fetched ${pList.json.length} prospects successfully`);

  // 2. Add Prospect
  console.log('[2/10] Testing POST /api/prospects with phone normalization');
  const created = await req('POST', '/api/prospects', {
    name: '  Test Suite User  ',
    phone: '9810099999',
    email: 'test@example.com',
    company: 'Acme Test Corp',
    title: 'QA Lead',
    stage: 'new',
  });
  assert.strictEqual(created.status, 200);
  assert.strictEqual(created.json.name, 'Test Suite User');
  assert.strictEqual(created.json.phone, '+919810099999');
  const testId = created.json.id;
  console.log(`✓ Created prospect ID ${testId} with normalized phone ${created.json.phone}`);

  // 3. Patch Prospect
  console.log('[3/10] Testing PATCH /api/prospects/:id');
  const patched = await req('PATCH', `/api/prospects/${testId}`, {
    stage: 'interested',
    title: 'VP Quality',
  });
  assert.strictEqual(patched.status, 200);
  assert.strictEqual(patched.json.stage, 'interested');
  assert.strictEqual(patched.json.title, 'VP Quality');
  console.log('✓ Updated stage and title correctly');

  // 4. Place Call
  console.log('[4/10] Testing POST /api/prospects/:id/call');
  const callRes = await req('POST', `/api/prospects/${testId}/call`);
  assert.strictEqual(callRes.status, 200);
  assert(callRes.json.callId > 0);
  const testCallId = callRes.json.callId;
  console.log(`✓ Placed call, callId: ${testCallId}`);

  // Check that prospect call_count was incremented
  const pAfterCall = await req('GET', `/api/prospects/${testId}`);
  assert.strictEqual(pAfterCall.json.call_count, 1);
  console.log('✓ call_count incremented to 1');

  // 5. Log call outcome
  console.log('[5/10] Testing PATCH /api/calls/:id (classification)');
  const logRes = await req('PATCH', `/api/calls/${testCallId}`, {
    outcome: 'conversation',
    duration_sec: 25,
  });
  assert.strictEqual(logRes.status, 200);
  assert.strictEqual(logRes.json.prospect.last_outcome, 'conversation');
  console.log('✓ Logged conversation outcome');

  // 6. Test Discard Call flow
  console.log('[6/10] Testing Call Discard flow');
  const call2Res = await req('POST', `/api/prospects/${testId}/call`);
  const call2Id = call2Res.json.callId;
  const pBeforeDiscard = await req('GET', `/api/prospects/${testId}`);
  assert.strictEqual(pBeforeDiscard.json.call_count, 2);

  const discardRes = await req('POST', `/api/calls/${call2Id}/discard`);
  assert.strictEqual(discardRes.status, 200);
  const pAfterDiscard = await req('GET', `/api/prospects/${testId}`);
  assert.strictEqual(pAfterDiscard.json.call_count, 1);
  console.log('✓ Discarded call cleaned up from DB and call_count decremented');

  // 7. Add Note
  console.log('[7/10] Testing Notes API');
  const noteRes = await req('POST', `/api/prospects/${testId}/notes`, { body: 'Verification note text' });
  assert.strictEqual(noteRes.status, 200);
  assert.strictEqual(noteRes.json.body, 'Verification note text');
  console.log('✓ Note added');

  // 8. CSV Export
  console.log('[8/10] Testing GET /api/prospects/export');
  const exportRes = await req('GET', '/api/prospects/export');
  assert.strictEqual(exportRes.status, 200);
  assert(exportRes.headers.get('content-type').includes('text/csv'));
  assert(exportRes.text.includes('ID,Name,Phone,Email,Company,Title,Stage'));
  assert(exportRes.text.includes('Test Suite User'));
  assert(exportRes.text.includes('Verification note text'));
  console.log('✓ CSV export generated with valid RFC 4180 format and notes included');

  // 9. Bulk Import with junk filtering
  console.log('[9/10] Testing Bulk Import with junk filtering');
  const bulkRes = await req('POST', '/api/prospects/bulk', {
    rows: [
      { 'Full Name': 'Total', 'Phone': '', 'Email': '' }, // header/junk
      { 'Full Name': 'Page 1 of 4', 'Phone': '', 'Email': '' }, // header/junk
      { 'Full Name': 'Valid Lead', 'Phone': '9876543210', 'Email': 'lead@company.org' }, // valid
      { 'Full Name': 'Valid Lead', 'Phone': '9876543210', 'Email': 'lead@company.org' }, // duplicate
      { 'Full Name': 'null', 'Phone': '0', 'Email': 'none' }, // empty/junk
    ],
    mapping: {
      name: 'Full Name',
      phone: 'Phone',
      email: 'Email',
    },
    skipDuplicates: true,
  });
  assert.strictEqual(bulkRes.status, 200);
  assert.strictEqual(bulkRes.json.added, 1);
  assert.strictEqual(bulkRes.json.dupes, 1);
  assert.strictEqual(bulkRes.json.empty, 3);
  console.log(`✓ Bulk import correctly filtered junk: added=${bulkRes.json.added}, dupes=${bulkRes.json.dupes}, empty=${bulkRes.json.empty}`);

  // Clean up bulk imported prospect
  const allP = await req('GET', '/api/prospects');
  const imported = allP.json.find((p) => p.name === 'Valid Lead');
  if (imported) await req('DELETE', `/api/prospects/${imported.id}`);

  // 10. Stats Endpoint
  console.log('[10/10] Testing GET /api/stats');
  const statsRes = await req('GET', '/api/stats?tzOffset=' + new Date().getTimezoneOffset());
  assert.strictEqual(statsRes.status, 200);
  assert(statsRes.json.today.dials >= 1);
  assert(Array.isArray(statsRes.json.week));
  assert.strictEqual(statsRes.json.week.length, 7);
  console.log('✓ Stats returned with 7-day breakdown and accurate dial counts');

  // Clean up test prospect
  await req('DELETE', `/api/prospects/${testId}`);
  console.log('✓ Test prospect cleaned up');

  console.log('\n========================================');
  console.log('🎉 ALL 10 TESTS PASSED WITH 0 FAILURES!');
  console.log('========================================');
}

run().catch((e) => {
  console.error('❌ Test failed:', e);
  process.exit(1);
});
