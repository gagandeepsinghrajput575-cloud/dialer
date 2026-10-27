// FlyNumber Copenhagen DID (+45 32 33 16 10) & Hybrid VoIP Architecture Unit Tests
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-flynumber-test-'));
process.env.DATA_DIR = tmp;

const { db } = require('../../server/db');
const migrate = require('../../server/db/migrate');
migrate.run();

const { DEFAULTS, SECRET_KEYS } = require('../../server/config/defaults');
const settingsRepo = require('../../server/repositories/settingsRepo');
const telephony = require('../../server/services/telephonyService');

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

console.log('[unit:flynumber] testing FlyNumber hybrid telephony service & settings');

// 1. Defaults verification
assert.strictEqual(DEFAULTS.flynumber_did, '+4532331610', 'Default Copenhagen DID is +45 32 33 16 10');
assert.strictEqual(DEFAULTS.flynumber_status, 'pending', 'Default status is pending');
assert.strictEqual(DEFAULTS.flynumber_sip_server, 'sip.flynumber.com', 'Default SIP server is sip.flynumber.com');
assert.strictEqual(SECRET_KEYS.flynumber_sip_password, 'has_flynumber_password', 'FlyNumber SIP password secret is masked');
ok('FlyNumber defaults and secret masking keys are registered');

// 2. Initial Config State
const initialCfg = telephony.flynumberConfig();
assert.strictEqual(initialCfg.did, '+4532331610', 'normalized DID');
assert.strictEqual(initialCfg.status, 'pending');
assert.strictEqual(initialCfg.sipHost, 'sip.flynumber.com');
assert.strictEqual(initialCfg.hasPassword, false);
assert.strictEqual(initialCfg.monthlyCost, '$2.95');
assert.strictEqual(initialCfg.inboundCost, '$0.00 / min (Free Unlimited Inbound SIP)');
assert.strictEqual(initialCfg.bridgeSteps.length, 4, '4-step verification bridge');
assert.strictEqual(initialCfg.completedCount, 0, 'no steps completed initially');
assert.strictEqual(initialCfg.allCompleted, false);
ok('telephonyService.flynumberConfig() produces initial pending state with 4 bridge steps');

// 3. Step 1: Activation
settingsRepo.set('flynumber_status', 'active');
const activeCfg = telephony.flynumberConfig();
assert.strictEqual(activeCfg.status, 'active');
assert.strictEqual(activeCfg.bridgeSteps[0].completed, true, 'step 1 activation completed');
ok('Step 1 (FlyNumber Activation) marks completed upon status change');

// 4. Step 2: Linphone SIP Credentials
settingsRepo.set('flynumber_sip_user', 'scalix_agent');
settingsRepo.set('flynumber_sip_password', 'ultra_secret_sip_pass');
settingsRepo.set('flynumber_linphone_configured', '1');

// Verify secret is masked from settingsRepo.publicView()
const exposedSettings = settingsRepo.publicView();
assert.strictEqual(exposedSettings.flynumber_sip_password, '', 'raw password masked in publicView()');
assert.strictEqual(exposedSettings.has_flynumber_password, true, 'has_flynumber_password flag is true');

const linphoneCfg = telephony.flynumberConfig();
assert.strictEqual(linphoneCfg.sipUser, 'scalix_agent');
assert.strictEqual(linphoneCfg.hasPassword, true);
assert.strictEqual(linphoneCfg.linphoneSipAddress, 'sip:scalix_agent@sip.flynumber.com');
assert.strictEqual(linphoneCfg.bridgeSteps[1].completed, true, 'step 2 completed');
ok('Step 2 (Linphone SIP) provides sip:<user>@host URI and masks secret password');

// 5. Step 3: Telnyx Verification Call & PIN
settingsRepo.set('telnyx_caller_id_verified', '1');
const verifiedCfg = telephony.flynumberConfig();
assert.strictEqual(verifiedCfg.telnyxVerified, true);
assert.strictEqual(verifiedCfg.bridgeSteps[2].completed, true, 'step 3 completed');
ok('Step 3 (Telnyx Verification) completes when verified flag is set');

// 6. Step 4: Outbound Caller ID Override
settingsRepo.set('caller_id', '+45 32 33 16 10');
const finalCfg = telephony.flynumberConfig();
assert.strictEqual(finalCfg.bridgeSteps[3].completed, true, 'step 4 completed');
assert.strictEqual(finalCfg.completedCount, 4, 'all 4 steps completed');
assert.strictEqual(finalCfg.allCompleted, true, 'allCompleted flag is true');
ok('Step 4 (Caller ID Override) completes when Copenhagen DID is stamped as active caller ID');

// 7. In-Browser WebRTC Forwarding URI
settingsRepo.set('telephony_mode', 'webrtc');
settingsRepo.set('inbound_routing_mode', 'webrtc');
settingsRepo.set('flynumber_sip_user', 'fly_cph_agent');
const webrtcCfg = telephony.flynumberConfig();
assert.strictEqual(webrtcCfg.isWebRtcMode, true);
assert.strictEqual(webrtcCfg.webrtcForwardingUri, 'sip:fly_cph_agent@sip.flynumber.com');
assert.strictEqual(webrtcCfg.bridgeSteps[1].id, 'forwarding');
assert.strictEqual(webrtcCfg.bridgeSteps[1].title, 'Route FlyNumber to Built-in App');
assert.ok(webrtcCfg.bridgeSteps[1].description.includes('sip:fly_cph_agent@sip.flynumber.com'));
ok('In-Browser WebRTC mode generates correct FlyNumber forwarding URI and dynamic bridge steps');

// Clean up
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n🎉 [unit:flynumber] all ${passed} checks passed successfully!`);
