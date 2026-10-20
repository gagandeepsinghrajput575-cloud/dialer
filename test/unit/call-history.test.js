const assert = require('assert');
const { db } = require('../../server/db');
const callRepo = require('../../server/repositories/callRepo');
const prospectRepo = require('../../server/repositories/prospectRepo');
const callService = require('../../server/services/callService');

console.log('--- Unit: Call History & Recents API ---');

// 1. Create fixture prospect
const p1 = prospectRepo.insert({
  name: 'Lars Mikkelsen',
  phone: '+4520112233',
  company: 'Nordic Clean ApS',
  title: 'Managing Director',
  stage: 'new',
});

const p2 = prospectRepo.insert({
  name: 'Mette Frederiksen',
  phone: '+4533112233',
  company: 'Cph Dental',
  title: 'Owner',
  stage: 'contacted',
});

// 2. Insert calls: outbound connected, outbound voicemail, inbound missed, inbound connected
const c1 = callRepo.insert({
  prospect_id: p1.id,
  status: 'placed',
  dry_run: 0,
  dial_uri: 'sip:+4520112233@sip.telnyx.com',
  caller_id: '+4532331610',
  direction: 'outbound',
});
callRepo.patch(c1.id, { outcome: 'interested', duration_sec: 145, summary: 'Discussed solar panel quote' });

const c2 = callRepo.insert({
  prospect_id: p1.id,
  status: 'placed',
  dry_run: 0,
  dial_uri: 'sip:+4520112233@sip.telnyx.com',
  caller_id: '+4532331610',
  direction: 'outbound',
});
callRepo.patch(c2.id, { outcome: 'voicemail', duration_sec: 25, vm_dropped: 1 });

const c3 = callRepo.createInbound({
  prospectId: p2.id,
  callerId: '+4533112233',
  status: 'missed',
  dryRun: 0,
});

const c4 = callRepo.createInbound({
  prospectId: p2.id,
  callerId: '+4533112233',
  status: 'ended',
  dryRun: 0,
});
callRepo.patch(c4.id, { outcome: 'meeting', duration_sec: 310, summary: 'Demo booked for Thursday' });

// 3. Test listHistory default
const resAll = callService.listHistory({ limit: 10 });
assert.ok(resAll.total >= 4, 'Total calls must be at least 4');
assert.ok(resAll.calls.length >= 4, 'Must return at least 4 calls');
console.log('  ✓ default history list returns calls with prospect join');

// Check fields on returned item
const item = resAll.calls.find(c => c.id === c1.id);
assert.strictEqual(item.prospect_name, 'Lars Mikkelsen');
assert.strictEqual(item.company, 'Nordic Clean ApS');
assert.strictEqual(item.outcome, 'interested');
assert.strictEqual(item.duration_sec, 145);
assert.strictEqual(item.direction, 'outbound');
console.log('  ✓ call fields correctly populated from calls and prospects tables');

// 4. Test direction filter
const resInbound = callService.listHistory({ direction: 'inbound' });
assert.ok(resInbound.calls.every(c => c.direction === 'inbound'), 'All items must be inbound');
console.log('  ✓ direction=inbound filter works');

const resOutbound = callService.listHistory({ direction: 'outbound' });
assert.ok(resOutbound.calls.every(c => c.direction === 'outbound'), 'All items must be outbound');
console.log('  ✓ direction=outbound filter works');

// 5. Test filter=missed
const resMissed = callService.listHistory({ filter: 'missed' });
assert.ok(resMissed.calls.some(c => c.id === c3.id), 'Must include missed inbound call c3');
assert.ok(resMissed.calls.every(c => c.direction === 'inbound' && ['ringing', 'missed', 'declined'].includes(c.status)), 'Must only match missed inbound calls');
console.log('  ✓ filter=missed returns only missed inbound calls');

// 6. Test filter=voicemail
const resVm = callService.listHistory({ filter: 'voicemail' });
assert.ok(resVm.calls.some(c => c.id === c2.id), 'Must include voicemail call c2');
console.log('  ✓ filter=voicemail returns dropped voicemails');

// 7. Test search filter
const resSearch = callService.listHistory({ search: 'Mikkelsen' });
assert.ok(resSearch.calls.every(c => c.prospect_name.includes('Mikkelsen') || c.company.includes('Mikkelsen')), 'Search matches prospect name');
console.log('  ✓ search by prospect name works');

// 8. Test summary metrics
assert.ok(resAll.summary.totalCalls >= 4, 'Summary total calls accurate');
assert.ok(resAll.summary.inboundCalls >= 2, 'Summary inbound calls accurate');
assert.ok(resAll.summary.outboundCalls >= 2, 'Summary outbound calls accurate');
assert.ok(resAll.summary.missedCalls >= 1, 'Summary missed calls accurate');
assert.ok(resAll.summary.totalDurationSec >= 480, 'Summary duration accurate');
console.log('  ✓ summary KPIs calculated accurately');

// Clean up fixtures
callRepo.remove(c1.id);
callRepo.remove(c2.id);
callRepo.remove(c3.id);
callRepo.remove(c4.id);
prospectRepo.remove(p1.id);
prospectRepo.remove(p2.id);

console.log('All 8 call history unit & integration checks passed!\n');
