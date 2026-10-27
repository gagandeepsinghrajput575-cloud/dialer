// The engine descriptor: one field, two layers, and the witnesses that decide which engine owns
// the in-app phone.
//
// This suite exists because `softphoneSession.isNative()` compared the descriptor's `engine` field
// against `NATIVE_ENGINE` ('pulse-sip-daemon') while `carrierAccount.webrtcSession()` emits
// `engine: 'native'`. The primary witness was therefore always false and only the `transport === 'udp'`
// fallback kept the native phone working. The renderer's own `isNativeSession()` in src/nativeSip.js
// tests `engine === 'native'`, so the two halves of the app disagreed about the meaning of one field.
//
// The checks below are written to be SENSITIVE to that class of bug: the decisive one deletes the
// fallback witnesses from the real descriptor so nothing but the primary one can carry the decision.
// A green run here means the primary witness works on its own, not that some fallback happened to
// cover for it.
//
// Isolated DB: DATA_DIR must be set before any server module is required, or the suite would flip
// `native_sip_engine` in the real settings table and leave the app claiming a native phone exists.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-engine-'));
process.env.DATA_DIR = dataDir;
process.env.PULSE_TEST = '1';

const { db } = require('../../server/db');
const migrate = require('../../server/db/migrate');
migrate.run();

const carrierAccount = require('../../server/services/carrierAccount');
const softphone = require('../../server/services/softphoneSession');

console.log('--- Unit: Engine Descriptor Witnesses (server/renderer agreement) ---');

let checks = 0;
const ok = (m) => { checks += 1; console.log('  ✓', m); };

// The browser descriptor's key set, captured verbatim from GET /api/telephony/webrtc-session on a
// live server with no daemon heartbeat BEFORE any fix in this mission landed. It is the oracle for
// "the browser fallback is unchanged": if a native-engine fix leaks into this shape, the key set
// moves and the check fails.
const BROWSER_KEYS = [
  'callerId', 'canRegister', 'configured', 'credentialHandoff', 'hasPassword', 'micDevice',
  'missing', 'mode', 'password', 'provider', 'server', 'speakerDevice', 'username', 'wsUrl',
  'wsUrlSource',
];

// ---------------------------------------------------------------------------
// 1. No engine selected, no heartbeat: the browser descriptor, exactly as before.
// ---------------------------------------------------------------------------
{
  carrierAccount.setEngine(false);
  carrierAccount.clearBeat();

  const s = softphone.resolve();
  assert.deepStrictEqual(Object.keys(s).sort(), BROWSER_KEYS,
    'browser descriptor key set must be unchanged (VAL-ENGINE-002 oracle)');
  ok(`browser descriptor key set unchanged (${BROWSER_KEYS.length} keys)`);

  assert.strictEqual(s.mode, 'webrtc', 'browser descriptor mode');
  assert.strictEqual(s.provider, 'flynumber', 'browser descriptor provider is flynumber');
  assert.strictEqual(s.wsUrlSource, 'flynumber_default', 'browser descriptor gateway source');
  assert.strictEqual(s.engine, undefined, 'browser descriptor must not grow an `engine` field');
  assert.strictEqual(s.transport, undefined, 'browser descriptor must not grow a `transport` field');
  ok('browser descriptor carries neither `engine` nor `transport`, so no witness can fire on it');

  assert.strictEqual(s.password, '', 'renderer-facing descriptor must never carry a password');
  assert.strictEqual(s.hasPassword, false, 'renderer-facing descriptor must not claim a password');
  ok('renderer-facing browser descriptor leaks no credential');

  assert.strictEqual(softphone.isNative(s), false, 'browser descriptor must not be mistaken for native');
  assert.strictEqual(softphone.engineOf(s), 'webrtc', 'engineOf on a browser descriptor');
  ok('isNative(browser) === false and engineOf(browser) === "webrtc"');
}

// ---------------------------------------------------------------------------
// 2. Engine selected and daemon beating: the native descriptor.
// ---------------------------------------------------------------------------
let nativeDescriptor;
{
  carrierAccount.setEngine(true);
  carrierAccount.beat({ pid: 4242, version: 'test', audio: 'coreaudio' });
  assert.strictEqual(carrierAccount.isActive(), true, 'engine selected + fresh heartbeat must be active');

  nativeDescriptor = softphone.resolve();
  assert.strictEqual(nativeDescriptor.engine, 'native',
    'native descriptor declares engine:"native" — this literal is what the renderer tests');
  assert.strictEqual(nativeDescriptor.wsUrlSource, 'native_daemon', 'native descriptor gateway source');
  assert.ok(nativeDescriptor.transport, 'native descriptor carries a transport');
  // The daemon fetches the secret itself, so the renderer-facing descriptor must carry an empty one.
  // (First written as `=== undefined`; the real descriptor uses `password: ''` to keep the browser
  // shape's key set, which is the correct behaviour — the probe was wrong, not the product.)
  assert.strictEqual(nativeDescriptor.password, '',
    'native descriptor must not carry a password; the daemon fetches it itself');
  ok(`native descriptor: engine=${nativeDescriptor.engine} transport=${nativeDescriptor.transport} `
    + 'wsUrlSource=native_daemon password=absent');

  assert.strictEqual(softphone.isNative(nativeDescriptor), true,
    'isNative must recognise the real native descriptor');
  ok('isNative(native descriptor) === true with all witnesses present');
}

// ---------------------------------------------------------------------------
// 3. THE DECISIVE CHECK: strip every fallback witness so only `engine` can carry the decision.
//    This is the check that failed before the fix. With `transport` and `wsUrlSource` deleted,
//    the old `session.engine === NATIVE_ENGINE` comparison had nothing left to succeed on.
// ---------------------------------------------------------------------------
{
  const stripped = { ...nativeDescriptor };
  delete stripped.transport;
  delete stripped.wsUrlSource;

  assert.strictEqual(softphone.isNative(stripped), true,
    'the PRIMARY witness must carry the decision on its own (VAL-ENGINE-001)');
  ok('isNative(descriptor with transport+wsUrlSource DELETED) === true — primary witness carries it');

  assert.strictEqual(softphone.engineOf(stripped), stripped.engine,
    'engineOf must agree with the descriptor it was handed, not with the settings-key constant');
  ok(`engineOf agrees with the descriptor: both "${stripped.engine}"`);
}

// ---------------------------------------------------------------------------
// 4. Cross-layer agreement, read from the renderer's own source.
//    src/nativeSip.js cannot be required in plain node (it pulls React through src/utils.js), so
//    the literal the renderer compares against is extracted from its source instead. That is the
//    real contract: if the server emits 'native' and the renderer tests something else, the phone
//    silently takes the browser path.
// ---------------------------------------------------------------------------
{
  const rendererSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'nativeSip.js'), 'utf8');
  const m = rendererSrc.match(/session\.engine\s*===\s*'([^']+)'/);
  assert.ok(m, 'src/nativeSip.js must compare session.engine against a literal');
  const rendererLiteral = m[1];

  assert.strictEqual(nativeDescriptor.engine, rendererLiteral,
    `server emits engine:"${nativeDescriptor.engine}" but the renderer tests "${rendererLiteral}"`);
  ok(`server descriptor and renderer witness agree on engine:"${rendererLiteral}"`);

  assert.strictEqual(softphone.engineOf(nativeDescriptor), rendererLiteral,
    'engineOf must return the same identity the renderer records');
  ok(`engineOf(native) === "${rendererLiteral}", matching src/nativeSip.js and callService's row value`);

  // callService writes the engine into the call-history row directly, bypassing engineOf. Both must
  // agree or the row and the descriptor describe the same call with two different engine names.
  const callServiceSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'server', 'services', 'callService.js'), 'utf8');
  const cs = callServiceSrc.match(/useNative\s*\?\s*'([^']+)'\s*:\s*'webrtc'/);
  assert.ok(cs, 'callService must write an engine literal for the native branch');
  assert.strictEqual(cs[1], rendererLiteral,
    `callService writes "${cs[1]}" but the renderer and descriptor say "${rendererLiteral}"`);
  ok(`callService's call-history value "${cs[1]}" agrees with descriptor and renderer`);
}

// ---------------------------------------------------------------------------
// 5. The daemon-facing credential object keeps its own identity, and is still recognised.
//    credentials() serves a local process behind the session token and uses NATIVE_ENGINE as its
//    engine value. That contract must not change, and accepting both identities must not turn it
//    into a false negative.
// ---------------------------------------------------------------------------
{
  const creds = carrierAccount.credentials({ includeSecret: false });
  assert.strictEqual(creds.engine, carrierAccount.NATIVE_ENGINE,
    'daemon-facing credentials keep engine:"pulse-sip-daemon"');
  ok(`daemon-facing credentials unchanged: engine="${creds.engine}"`);

  assert.strictEqual(softphone.isNative(creds), true,
    'isNative must also recognise the daemon-facing identity, not produce a false negative');
  ok('isNative(daemon credentials) === true — both identities recognised');

  assert.strictEqual(creds.hasPassword, false,
    'includeSecret:false must not leak the password');
  ok('credentials({includeSecret:false}) leaks no secret');
}

// ---------------------------------------------------------------------------
// 6. Losing the heartbeat must return the phone to the browser descriptor, unchanged.
// ---------------------------------------------------------------------------
{
  carrierAccount.clearBeat();
  assert.strictEqual(carrierAccount.isActive(), false, 'a stale heartbeat must drop the native claim');
  const s = softphone.resolve();
  assert.deepStrictEqual(Object.keys(s).sort(), BROWSER_KEYS,
    'after the daemon goes away the browser descriptor must be byte-for-byte the old shape');
  assert.strictEqual(softphone.isNative(s), false, 'and must not be mistaken for native');
  ok('heartbeat lost -> browser descriptor restored, key set identical, isNative false');
}

db.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`--- Engine descriptor witnesses: ${checks} checks passed ---`);
