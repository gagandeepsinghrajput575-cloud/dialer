// The native SIP engine, as the server sees it.
//
// test/unit/sip-daemon.test.js proves the daemon itself speaks SIP: registration, dialogs, RTP,
// DTMF, teardown, against a mock carrier on a real UDP socket. This suite proves the other half
// of the promise — that the *app* hands the phone to that daemon only when the daemon is really
// there, and gives it back the moment it is not.
//
// Both halves matter because the failure mode is silent: a renderer that believes a native phone
// exists dials into nothing, and a server that hands the SIP secret to a browser breaks the one
// rule the settings screen makes about it.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-native-sip-'));
process.env.DATA_DIR = tmp;
process.env.PULSE_TEST = '1';
// A unit test must not inherit the operator's trunk choice from .env: this suite asserts the UDP
// wiring (5060), while test/unit/tls-transport.test.js covers the secure path.
process.env.PULSE_SIP_TRANSPORT = 'udp';

const migrate = require('../../server/db/migrate');
migrate.run();

const { createApp } = require('../../server/app');
const settings = require('../../server/repositories/settingsRepo');
const carrierAccount = require('../../server/services/carrierAccount');
const softphoneSession = require('../../server/services/softphoneSession');

let passed = 0;
const ok = (msg) => { passed++; console.log(`  \u2713 ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FLY_USER = 'flynumber-4532';
const FLY_PASS = 'copenhagen-sip-secret';
const DAEMON_TOKEN = 'unit-only-desktop-capability-token';

async function main() {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = '';

  const call = async (method, url, body, opts = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (token && opts.anonymous !== true) headers['x-pulse-token'] = token;
    Object.assign(headers, opts.headers || {});
    const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch { /* an empty body is a valid answer */ }
    return { status: res.status, json };
  };

  try {
    console.log('[unit:native-sip] the server hands the in-app phone to the native daemon');

    token = (await call('GET', '/api/session')).json.token;
    assert.ok(token, 'the session token is handed to a local caller');

    // A carrier with no WebRTC gateway: FlyNumber SIP is saved, so the native engine has an
    // account to register. The legacy Telnyx settings are saved too, and must lose.
    await call('PUT', '/api/settings', {
      telephony_mode: 'webrtc',
      flynumber_sip_server: 'sip.flynumber.com',
      flynumber_sip_user: FLY_USER,
      flynumber_sip_password: FLY_PASS,
      flynumber_did: '+4532331610',
      telnyx_sip_server: 'sip.telnyx.com',
      telnyx_sip_user: '1001',
      telnyx_sip_password: 'super-secret',
      caller_id: '+4520123456',
      dry_run: '1',
    });

    // ------------------------------------------------------------------ 1. inert by default
    let sess = (await call('GET', '/api/telephony/webrtc-session')).json;
    assert.strictEqual(sess.provider, 'flynumber', 'no daemon: the descriptor is the browser one');
    assert.strictEqual(sess.wsUrl, 'wss://rtc.telnyx.com');
    assert.strictEqual(sess.wsUrlSource, 'flynumber_default');
    assert.strictEqual(softphoneSession.isNative(sess), false, 'and it is not mistaken for native');
    assert.strictEqual(carrierAccount.isActive(), false, 'the native engine is off until asked for');
    ok('with no supervisor the browser descriptor is returned untouched');

    await call('PUT', '/api/settings', {
      native_sip_engine: carrierAccount.NATIVE_ENGINE,
      native_daemon_last_seen: String(Date.now()), native_daemon_pid: '999', native_daemon_audio: 'forged',
    });
    assert.strictEqual(settings.get('native_sip_engine'), '', 'a settings-form PUT cannot opt into native mode');
    assert.strictEqual(settings.get('native_daemon_last_seen'), '0', 'a settings-form PUT cannot forge liveness');
    assert.strictEqual(settings.get('native_daemon_pid'), '0', 'a settings-form PUT cannot forge the pid');
    ok('supervisor-owned engine/liveness fields are read-only through Settings PUT');

    // A dial in that state is still the gateway URI
    const prospect = await call('POST', '/api/prospects', { name: 'Native Test', phone: '20334455' });
    const pid = prospect.json.id;
    let dial = await call('POST', `/api/prospects/${pid}/call`);
    assert.strictEqual(dial.json.dialUri, 'sip:+4520334455@sip.flynumber.com;transport=ws', 'gateway URI');
    assert.strictEqual(dial.json.engine, 'webrtc');
    assert.strictEqual(dial.json.native, null, 'no native leg is claimed');
    ok('a dial before the daemon starts addresses the WebSocket gateway');

    // ------------------------------------------------------------------ 2. the opt-in + beat
    let beat = await call('POST', '/api/telephony/native-heartbeat', {
      engine: carrierAccount.NATIVE_ENGINE, daemonToken: DAEMON_TOKEN, pid: 4242, version: '1.0.0', audio: 'coreaudio',
    });
    assert.strictEqual(beat.status, 200);
    assert.strictEqual(beat.json.engine, 'native', 'the beat answers with the descriptor it enabled');
    assert.strictEqual(beat.json.active, true);
    assert.strictEqual(settings.get('native_sip_engine'), carrierAccount.NATIVE_ENGINE, 'the opt-in persisted');
    assert.strictEqual(settings.get('native_daemon_pid'), '4242', 'and so did the supervisor pid');

    sess = (await call('GET', '/api/telephony/webrtc-session')).json;
    assert.strictEqual(softphoneSession.isNative(sess), true, 'the same endpoint now describes the daemon');
    assert.strictEqual(sess.provider, 'flynumber', 'FlyNumber wins over the dormant Telnyx settings');
    assert.strictEqual(sess.server, 'sip.flynumber.com');
    assert.strictEqual(sess.port, 5060);
    assert.strictEqual(sess.transport, 'udp');
    assert.strictEqual(sess.username, FLY_USER);
    assert.strictEqual(sess.callerId, '+4532331610', 'the DID is the caller ID the carrier expects');
    assert.strictEqual(sess.wsUrl, 'sip:sip.flynumber.com:5060', 'the real endpoint replaces the stale wss URL');
    assert.strictEqual(sess.webrtcWsUrl, 'wss://rtc.telnyx.com', 'the browser gateway is kept, not deleted');
    assert.strictEqual(sess.password, '', 'the secret never rides in the renderer descriptor');
    assert.strictEqual(sess.hasPassword, true, '…but the UI can still say one is saved');
    assert.strictEqual(sess.credentialHandoff, false);
    assert.strictEqual(sess.canRegister, true, 'a native engine needs no handoff to register');
    assert.deepStrictEqual(sess.missing, []);
    ok('one heartbeat switches the in-app phone to FlyNumber UDP SIP');

    // ------------------------------------------------------------------ 3. the secret channel
    const anon = await call('GET', '/api/telephony/carrier-credentials', null, { anonymous: true });
    assert.strictEqual(anon.status, 401, 'the credentials endpoint refuses a caller with no session token');
    const renderer = await call('GET', '/api/telephony/carrier-credentials');
    assert.strictEqual(renderer.status, 401, 'a renderer session token alone cannot read the SIP secret');
    const browserBeat = await call('POST', '/api/telephony/native-heartbeat', {
      engine: carrierAccount.NATIVE_ENGINE, daemonToken: 'renderer-chosen-token',
    }, { headers: { origin: base } });
    assert.strictEqual(browserBeat.status, 403, 'browser-origin code cannot provision a daemon capability');
    const daemonHeaders = { 'x-pulse-daemon-token': DAEMON_TOKEN };
    const creds = (await call('GET', '/api/telephony/carrier-credentials', null, { headers: daemonHeaders })).json;
    assert.strictEqual(creds.password, FLY_PASS, 'the supervisor gets the secret it must register with');
    assert.strictEqual(creds.domain, 'sip.flynumber.com');
    assert.strictEqual(creds.user, FLY_USER);
    assert.strictEqual(creds.expires, 300);
    const redacted = (await call('GET', '/api/telephony/carrier-credentials?secret=0')).json;
    assert.strictEqual(redacted.password, undefined, '?secret=0 withholds it for diagnostics');
    assert.strictEqual(redacted.hasPassword, true);
    const publicSettings = (await call('GET', '/api/settings')).json;
    assert.strictEqual(publicSettings.flynumber_sip_password, '', 'the settings view still masks the secret');
    assert.strictEqual(publicSettings.native_sip_engine, carrierAccount.NATIVE_ENGINE, 'and reports the engine honestly');
    ok('only the no-Origin supervisor with its ephemeral capability can read the SIP secret');

    // ------------------------------------------------------------------ 4. dialing natively
    dial = await call('POST', `/api/prospects/${pid}/call`);
    assert.strictEqual(dial.json.engine, 'native');
    assert.strictEqual(dial.json.dialUri, `sip:+4520334455@${creds.domain}`, 'the address the daemon will dial');
    assert.strictEqual(dial.json.inBrowser, true, 'still an in-app call, not an OS hand-off');
    assert.strictEqual(dial.json.protocol, 'webrtc', 'the cockpit branch is unchanged');
    assert.strictEqual(dial.json.native.carrier, 'flynumber');
    assert.strictEqual(dial.json.native.transport, 'udp');
    const history = (await call('GET', `/api/prospects/${pid}`)).json;
    assert.strictEqual(history.calls[history.calls.length - 1].dial_uri,
      'sip:+4520334455@sip.flynumber.com;transport=ws',
      'call history records the number, not the engine of the moment');
    ok('a dial while the daemon is alive is addressed to the carrier over UDP SIP');

    const test = await call('POST', '/api/settings/test-softphone', { number: '20123456' });
    assert.strictEqual(test.json.engine, 'native');
    assert.strictEqual(test.json.configured, true);
    assert.strictEqual(test.json.dialUri, `sip:+4520123456@${creds.domain}`);
    assert.strictEqual(test.json.needsCredentialHandoff, false, 'the native engine never asks for a handoff');
    assert.match(test.json.message, /UDP SIP/, 'the message names the transport it will use');
    ok('the test-launch endpoint describes the native leg instead of the browser one');

    // ------------------------------------------------------------------ 5. fallback + gaps
    settings.set('flynumber_sip_user', '');
    let account = carrierAccount.activeAccount();
    assert.strictEqual(account.carrier, 'flynumber');
    assert.strictEqual(account.domain, 'sip.flynumber.com');
    settings.set('flynumber_sip_user', FLY_USER);

    settings.set('flynumber_sip_password', '');
    account = carrierAccount.activeAccount();
    assert.strictEqual(account.carrier, 'flynumber');
    settings.set('flynumber_sip_password', FLY_PASS);
    settings.set('flynumber_sip_server', 'sip.flynumber.com:5070');
    account = carrierAccount.activeAccount();
    assert.strictEqual(account.domain, 'sip.flynumber.com', 'a host:port setting is split…');
    assert.strictEqual(account.port, 5070, '…and the port is honoured');
    settings.set('flynumber_sip_server', 'sip.flynumber.com');
    ok('FlyNumber carrier activeAccount handles credentials and host:port parsing');

    // ------------------------------------------------------------------ 6. giving it back
    settings.set('native_daemon_last_seen', String(Date.now() - carrierAccount.HEARTBEAT_TTL_MS - 5000));
    sess = (await call('GET', '/api/telephony/webrtc-session')).json;
    assert.strictEqual(softphoneSession.isNative(sess), false, 'a stale beat is a dead daemon');
    assert.strictEqual(sess.provider, 'flynumber', 'so the app falls back to the browser engine');
    dial = await call('POST', `/api/prospects/${pid}/call`);
    assert.strictEqual(dial.json.engine, 'webrtc', 'and a dial goes back to the gateway URI');
    assert.strictEqual(dial.json.dialUri, 'sip:+4520334455@sip.flynumber.com;transport=ws');
    ok('when the heartbeat lapses the phone returns to the browser engine');

    await call('POST', '/api/telephony/native-heartbeat', { engine: carrierAccount.NATIVE_ENGINE, daemonToken: DAEMON_TOKEN, pid: 4242 });
    assert.strictEqual(carrierAccount.isActive(), true, 'beating again restores it');
    await call('POST', '/api/telephony/native-heartbeat', { clear: true });
    assert.strictEqual(carrierAccount.heartbeat().alive, false, 'an explicit goodbye drops the claim');
    assert.strictEqual(carrierAccount.daemonAuthorized(DAEMON_TOKEN), false, 'goodbye expires the daemon capability too');
    assert.strictEqual(settings.get('native_sip_engine'), carrierAccount.NATIVE_ENGINE,
      'but the opt-in stays: restarting the desktop app is enough to get the phone back');
    sess = (await call('GET', '/api/telephony/webrtc-session')).json;
    assert.strictEqual(sess.engine, undefined, 'the browser descriptor has no engine field at all');
    ok('the supervisor can release the phone without losing the agent’s choice');

    // ------------------------------------------------------------------ 7. readiness wording
    const missing = carrierAccount.readiness();
    assert.deepStrictEqual(missing.missing, ['daemon'], 'only the daemon is missing now');
    assert.match(carrierAccount.hintText(missing), /desktop app/i, 'and the hint says how to fix it');
    await call('POST', '/api/telephony/native-heartbeat', { engine: carrierAccount.NATIVE_ENGINE, daemonToken: DAEMON_TOKEN, pid: 7 });
    assert.deepStrictEqual(carrierAccount.readiness().missing, [], 'configured once it beats');
    // Empty both carriers: only then is there truly no SIP user to register with.
    settings.set('flynumber_sip_user', '');
    settings.set('telnyx_sip_user', '');
    const noUser = carrierAccount.readiness();
    assert.ok(noUser.missing.includes('user'), 'a missing SIP user is reported…');
    assert.ok(!noUser.missing.includes('daemon'), '…without hiding behind the daemon check');
    assert.ok(!noUser.missing.includes('password'), 'the FlyNumber secret is still saved, so it is not blamed');
    assert.strictEqual(noUser.configured, false);
    assert.match(carrierAccount.hintText(noUser), /missing: user/, 'the hint names what to add');
    settings.set('flynumber_sip_user', FLY_USER);
    settings.set('telnyx_sip_user', '1001');
    ok('readiness names exactly what is missing, the way the browser engine does');

    await sleep(10);
    console.log(`\n🎉 [unit:native-sip] all ${passed} checks passed`);
  } finally {
    await new Promise((r) => server.close(r));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((e) => {
  console.error(`\n❌ [unit:native-sip] ${e && e.message}`);
  if (process.env.SIP_TEST_DEBUG) console.error(e);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
