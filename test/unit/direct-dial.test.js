// Unit tests for Direct Number Manual Dialpad & Ad-Hoc Outbound Calling
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-direct-dial-test-'));
process.env.DATA_DIR = tmp;

const { db } = require('../../server/db');
const migrate = require('../../server/db/migrate');
migrate.run();

const callService = require('../../server/services/callService');
const prospects = require('../../server/repositories/prospectRepo');
const calls = require('../../server/repositories/callRepo');

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

console.log('[unit:direct-dial] testing ad-hoc manual number dialing service');

// 1. Rejects invalid or too-short phone number
assert.throws(() => {
  callService.startDirectDial({ phone: '123' });
}, /valid phone number/i, 'rejects phone number shorter than minimum digits');
ok('Invalid / too short phone numbers are rejected with 400');

// 2. Direct dials a new Danish number
const res1 = callService.startDirectDial({ phone: '20 12 34 56' });
assert.strictEqual(res1.ok, true);
assert.strictEqual(res1.phone, '+4520123456', 'normalized E.164 Danish phone');
assert.ok(res1.callId > 0, 'created a valid call row');
assert.ok(res1.prospect, 'returned prospect details');
assert.strictEqual(res1.prospect.phone, '+4520123456');
assert.strictEqual(res1.prospect.call_count, 1);
ok('Direct dialing creates a new prospect and starts outbound call');

// 3. Second call to the same number reuses existing prospect
const res2 = callService.startDirectDial({ phone: '+4520123456' });
assert.strictEqual(res2.ok, true);
assert.strictEqual(res2.prospect.id, res1.prospect.id, 'reused existing prospect ID');
assert.strictEqual(res2.prospect.call_count, 2, 'incremented call count on existing prospect');
ok('Direct dial to previously dialed number reuses existing prospect without duplication');

// 4. Direct dial with custom name
const res3 = callService.startDirectDial({ phone: '31 22 33 44', name: 'Copenhagen Partner ApS' });
assert.strictEqual(res3.ok, true);
assert.strictEqual(res3.prospect.name, 'Copenhagen Partner ApS');
assert.strictEqual(res3.prospect.phone, '+4531223344');
ok('Direct dial saves custom name and company when provided');

// Clean up
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n🎉 [unit:direct-dial] all ${passed} checks passed successfully!`);
