// The outbound ledger: what an attempt that never connected leaves behind.
//
// Two rules are pinned here, because both decide money and morale:
//   1. A rejected or cancelled dial is recorded with its reason — it is not deleted, and it is
//      not allowed to look like a conversation.
//   2. Neither `failed` nor `canceled` counts toward `daily_cap`, which is meant to measure
//      completed outreach, not nervous mis-clicks.
require('../helpers/unit-db');
const assert = require('assert');
const callRepo = require('../../server/repositories/callRepo');
const prospectRepo = require('../../server/repositories/prospectRepo');
const callService = require('../../server/services/callService');
const { buildClassifyFields } = require('../../server/services/callFields');
const schemas = require('../../server/validation/schemas');

console.log('--- Unit: Outbound ledger lifecycle (failed vs canceled) ---');

const p = prospectRepo.insert({ name: 'Ledger Test', phone: '+4520998877', stage: 'new' });
const make = (status) => callRepo.insert({
  prospect_id: p.id,
  status,
  dry_run: 0,
  dial_uri: 'sip:+4520998877@sip.telnyx.com',
  caller_id: '+4532331610',
  direction: 'outbound',
});

// ---- what a PATCH may say ----------------------------------------------------------------
{
  assert.strictEqual(schemas.callPatch.parse({ status: 'failed', error: 'busy' }).status, 'failed');
  assert.strictEqual(schemas.callPatch.parse({ status: 'canceled' }).status, 'canceled');
  assert.throws(() => schemas.callPatch.parse({ status: 'missed' }), /status/i, 'unknown terminal states stay out');
  assert.throws(() => schemas.callPatch.parse({ error: 'x'.repeat(501) }), /error|500/i, 'the reason is bounded');
  console.log('  ✓ PATCH accepts failed/canceled with a bounded reason, and nothing else');
}

// ---- how the columns are built -----------------------------------------------------------
{
  const at = '2026-01-01 10:00:00';
  const rejected = buildClassifyFields({ direction: 'outbound', status: 'placed' }, { status: 'failed', error: '486 busy' }, at);
  assert.strictEqual(rejected.status, 'failed');
  assert.strictEqual(rejected.error, '486 busy');
  assert.strictEqual(rejected.ended_at, at, 'a terminal attempt is closed');

  const canceled = buildClassifyFields({ direction: 'outbound', status: 'placed' }, { status: 'canceled' }, at);
  assert.strictEqual(canceled.status, 'canceled');

  const connected = buildClassifyFields({ direction: 'outbound', status: 'placed' }, { status: 'connected' }, at);
  assert.strictEqual(connected.ended_at, undefined, 'a call in progress is not closed');

  const completed = buildClassifyFields({ direction: 'outbound', status: 'connected' }, { status: 'completed' }, at);
  assert.strictEqual(completed.status, 'completed');

  const inbound = buildClassifyFields({ direction: 'inbound', status: 'connected' }, {}, at);
  assert.strictEqual(inbound.status, 'completed', 'ending an answered inbound call completes it');

  const late = buildClassifyFields({ direction: 'outbound', status: 'completed', duration_sec: 34 }, { status: 'canceled' }, at);
  assert.strictEqual(late.status, undefined, 'a late cancel cannot demote a call that really happened');
  console.log('  ✓ the field builder keeps mid-call PATCHes open and closes terminal ones');
}

// ---- the service applies them without touching the lead ----------------------------------
{
  const failed = make('placed');
  const before = prospectRepo.get(p.id);
  const res = callService.classify(failed.id, { status: 'failed', error: '503 no route' });
  assert.strictEqual(res.call.status, 'failed');
  assert.strictEqual(res.call.error, '503 no route');
  assert.ok(res.call.ended_at, 'the row is closed');
  assert.strictEqual(res.call.duration_sec, 0, 'nothing connected, so there is no talk time');
  assert.strictEqual(prospectRepo.get(p.id).stage, before.stage, 'a failed dial does not move the lead');

  const canceled = make('placed');
  assert.strictEqual(callService.classify(canceled.id, { status: 'canceled' }).call.status, 'canceled');
  console.log('  ✓ failed/canceled close the row with a reason and leave the prospect alone');
}

// ---- the daily cap ignores both ----------------------------------------------------------
{
  const counted = make('placed');
  const failed = make('placed');
  const canceled = make('placed');
  const discarded = make('placed');
  callService.classify(failed.id, { status: 'failed', error: '404' });
  callService.classify(canceled.id, { status: 'canceled' });
  callRepo.patch(discarded.id, { status: 'discarded' });

  const since = '2000-01-01 00:00:00';
  const remaining = callRepo.countSince(since).valueOf();
  const rows = callRepo.since(since);
  assert.ok(rows.some((r) => r.id === counted.id), 'a real dial is still counted');
  assert.ok(!rows.some((r) => r.id === failed.id), 'a carrier rejection is not a dial for the cap');
  assert.ok(!rows.some((r) => r.id === canceled.id), 'an agent cancel is not a dial for the cap');
  assert.ok(!rows.some((r) => r.id === discarded.id), 'a discarded phantom is not a dial for the cap');
  assert.strictEqual(remaining, rows.length, 'countSince and since agree on the same set');

  const recent = callRepo.recent(50);
  assert.ok(!recent.some((r) => r.id === canceled.id), 'canceled attempts stay out of the stats feed');
  assert.ok(recent.some((r) => r.id === counted.id), 'while real dials remain');
  const history = callRepo.listHistory({ limit: 200 });
  assert.ok(!history.some((r) => r.id === canceled.id), 'and out of the history funnel');
  assert.ok(!history.some((r) => r.id === discarded.id), 'while a discarded phantom stays hidden');
  assert.ok(history.some((r) => r.id === failed.id), 'but a rejection is still reviewable there');
  assert.strictEqual(callRepo.countHistory({}), history.length, 'list and count agree');
  assert.ok(callRepo.listByProspect(p.id).some((r) => r.id === canceled.id),
    'the prospect timeline still shows every attempt made on it');
  console.log('  ✓ failed/canceled/discarded are excluded from the cap and the stats feed');
}

// ---- what the cockpit records when a dial dies --------------------------------------------
(async () => {
  const { unconnectedPatch, recordUnconnected } = await import('../../src/outboundLedger.mjs');
  assert.deepStrictEqual(unconnectedPatch('outbound', 'That number is busy (486).'),
    { status: 'failed', error: 'That number is busy (486).' }, 'a rejection keeps its reason');
  assert.deepStrictEqual(unconnectedPatch('outbound', ''), { status: 'canceled' }, 'a bare cancel is canceled');
  assert.strictEqual(unconnectedPatch('inbound', ''), null, 'an answered inbound call is never touched from there');
  assert.strictEqual(unconnectedPatch('inbound', 'The caller hung up'), null, 'nor is a missed one');

  const sent = [];
  const fakeApi = { logCall: (id, body) => { sent.push([id, body]); return Promise.resolve(); } };
  recordUnconnected(fakeApi, 7, 'outbound', '');
  recordUnconnected(fakeApi, 8, 'inbound', '');
  assert.deepStrictEqual(sent, [[7, { status: 'canceled' }]], 'exactly one row is touched, and only outbound');

  const failing = { logCall: () => Promise.reject(new Error('offline')) };
  assert.doesNotThrow(() => recordUnconnected(failing, 9, 'outbound', 'no route'),
    'a ledger hiccup never breaks the teardown');

  console.log('\n🎉 [unit:ledger] all checks passed\n');
})();

