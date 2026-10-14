// Chaos Bug Hunter & Adversarial Fuzz Drilling Suite
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-chaos-'));
process.env.DATA_DIR = tmp;

const { db } = require('../../server/db');
const migrate = require('../../server/db/migrate');
migrate.run();

const telephony = require('../../server/services/telephonyService');
const settingsRepo = require('../../server/repositories/settingsRepo');
const prospectRepo = require('../../server/repositories/prospectRepo');
const s = require('../../server/validation/schemas');

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

console.log('[chaos:driller] running chaos testing, fuzzing, and adversarial drilling');

// 1. Chaotic & Adversarial Phone Drilling (1,000 randomized permutations)
const adversarialTokens = [
  '', '   ', null, undefined,
  "'; DROP TABLE prospects; --",
  '<script>alert("xss")</script>',
  '\u0000', '\u200B\u200C\u200D', '🇩🇰+45 20 12 34 56',
  '📞 20123456', 'tel:+4520123456', 'sip:prospect@firma.dk',
  'A'.repeat(5000), '9'.repeat(5000), '0'.repeat(50),
  '-1', 'NaN', 'Infinity', 'undefined', 'null',
  '+45 20 12 34 56 ext 101', '004520123456', '+45 (0) 20 12 34 56',
  '__proto__', 'constructor', '[object Object]'
];

for (let i = 0; i < 1000; i++) {
  const token = adversarialTokens[i % adversarialTokens.length];
  const noise = String.fromCharCode(Math.floor(Math.random() * 256));
  const candidate = (i % 2 === 0 ? token + noise : noise + token);
  
  // Must never crash or throw unhandled exceptions
  let result;
  assert.doesNotThrow(() => {
    result = telephony.normalizePhone(candidate);
  }, `normalizePhone threw on candidate: ${candidate}`);
  assert.strictEqual(typeof result, 'string');
}
ok('1,000 chaotic phone inputs processed without a single crash or unhandled error');

// 2. Prototype Pollution & Malicious Schema Injection
const poisonPayloads = [
  JSON.parse('{"__proto__": {"polluted": true}}'),
  JSON.parse('{"constructor": {"prototype": {"polluted": true}}}'),
  { name: '<img src=x onerror=alert(1)>', phone: '+4520123456', extra: { malicious: 'data' } },
  { name: 'X'.repeat(50000), phone: '+4520123456' }, // Oversized name
];

for (const payload of poisonPayloads) {
  assert.strictEqual(Object.prototype.polluted, undefined, 'prototype remains clean');
  const res = s.prospectCreate.safeParse(payload);
  if (res.success && res.data.name && res.data.name.length > 200) {
    assert.fail('Oversized name should have failed schema validation');
  }
}
ok('Prototype pollution and schema overflow injections neutralized');

// 3. Database Integrity Under Random Prospect Mutations
for (let i = 0; i < 50; i++) {
  const randomName = `Prospect_${Math.random().toString(36).substring(7)}`;
  const randomCompany = `Firma_${Math.random().toString(36).substring(7)} ApS`;
  const randomPhone = `+4520${Math.floor(100000 + Math.random() * 900000)}`;

  const created = prospectRepo.insert({
    name: randomName,
    company: randomCompany,
    phone: randomPhone,
    stage: 'new',
  });
  assert.ok(created.id, 'created prospect has valid ID');
  assert.strictEqual(created.name, randomName);
  assert.strictEqual(created.company, randomCompany);

  // Random patch mutation
  const patched = prospectRepo.update(created.id, {
    stage: i % 2 === 0 ? 'contacted' : 'interested',
  });
  assert.strictEqual(patched.id, created.id);
}
ok('50 randomized prospect creation and patch cycles executed with relational integrity');

// 4. FlyNumber & Telephony Config Boundary Drilling
const chaoticConfigs = [
  { status: 'ACTIVE', server: '  sip.flynumber.com  ', did: '+45 32 33 16 10' },
  { status: 'invalid_status', server: 'unknown', did: 'junk' },
  { status: 'pending', server: '', did: '' },
];

for (const cfg of chaoticConfigs) {
  assert.doesNotThrow(() => {
    settingsRepo.set('flynumber_status', cfg.status.toLowerCase());
    settingsRepo.set('flynumber_sip_server', cfg.server);
    if (cfg.did) settingsRepo.set('flynumber_did', cfg.did);
    const resolved = telephony.flynumberConfig();
    assert.ok(resolved.did);
    assert.ok(Array.isArray(resolved.bridgeSteps));
  });
}
ok('FlyNumber boundary configurations tested and validated');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n🎉 [chaos:driller] all ${passed} checks passed successfully!`);
