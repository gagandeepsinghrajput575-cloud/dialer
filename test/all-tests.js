// Pulse Dialer — full system verification suite.
// Boots the API on a free port against a throwaway SQLite database (unless API_BASE is set),
// then exercises every endpoint the UI depends on.
//
//   node test/all-tests.js          # self-hosted run
//   API_BASE=http://localhost:3001 node test/all-tests.js   # run against a live instance
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const EXTERNAL_BASE = process.env.API_BASE || '';
const SAMPLE = '20123456'; // Danish 8-digit mobile
const E164 = '+4520123456';

let BASE = EXTERNAL_BASE || 'http://127.0.0.1:3001';
let child = null;
let tmpDir = null;
let passed = 0;

const ok = (msg) => { passed++; console.log(`  \u2713 ${msg}`); };
const step = (n, total, title) => console.log(`\n[${n}/${total}] ${title}`);

// Retries only what is safe to repeat. While a spawnSync child (the unit or UI suite) runs,
// this process's event loop is blocked and the server closes idle keep-alive sockets; the
// first request afterwards can then fail with ECONNRESET before it is ever sent.
const RETRYABLE = new Set(['GET', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']);

async function req(method, urlPath, body, attempt = 1) {
  try {
    const res = await fetch(`${BASE}${urlPath}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, headers: res.headers, text, json };
  } catch (e) {
    const retryable = RETRYABLE.has(method.toUpperCase()) || /ECONNREFUSED/.test(String(e.cause?.code || e.message));
    if (retryable && attempt < 3) {
      await new Promise((r) => setTimeout(r, 150 * attempt));
      return req(method, urlPath, body, attempt + 1);
    }
    throw e;
  }
}

// For endpoints that demand the session token even on a GET (currently only the WebRTC
// session descriptor, which returns SIP credentials). The browser client fetches the token
// once and echoes it on every request; this mirrors that.
let cachedToken = '';
async function tokened(method, urlPath, body) {
  if (!cachedToken) cachedToken = (await req('GET', '/api/session')).json.token;
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      'x-pulse-token': cachedToken,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

// Same retry as req(), for the hand-built attack requests in the security group.
// Retries only on transport errors — a 403/401 answer means nothing was mutated.
async function raw(url, init, attempt = 1) {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (attempt < 4) {
      await new Promise((r) => setTimeout(r, 120 * attempt));
      return raw(url, init, attempt + 1);
    }
    throw e;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(base, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/settings`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

// A database from the VOIP.SO era, in the directory the server is about to boot against.
// The fixture is built by the real migration runner with the Telnyx migration removed (see
// test/helpers/legacy-db.js), so the schema is exactly what the previous release produced —
// and the boot that follows is the genuine upgrade path, purge included.
function seedLegacyDatabase() {
  const helper = path.join(REPO, 'test', 'helpers', 'legacy-db.js');
  const seeded = spawnSync(process.execPath, [helper, tmpDir], { encoding: 'utf8' });
  if (seeded.status !== 0) {
    throw new Error(`could not build the legacy database fixture:\n${seeded.stderr || seeded.stdout}`);
  }
  const info = JSON.parse(String(seeded.stdout).trim().split('\n').pop());
  assert.strictEqual(info.total, 6, 'the fixture carries the six migrations that predate the cutover');
}

async function bootServer() {
  const port = await freePort();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-dialer-test-'));
  BASE = `http://127.0.0.1:${port}`;
  // Deliberately *not* seeding from the environment here: a fresh install must land on the
  // Telnyx defaults on its own, and the seeded legacy database above proves the upgrade path.
  seedLegacyDatabase();
  child = spawn(process.execPath, [path.join(REPO, 'server', 'index.js')], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), DATA_DIR: tmpDir, PULSE_TEST: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.on('exit', (code) => { child = null; if (code) console.error(log); });
  if (!(await waitForServer(BASE))) throw new Error(`API did not start on ${BASE}\n${log}`);
  console.log(`  \u2713 API booted on ${BASE} (database: ${tmpDir})`);
}

function shutdown() {
  if (child) { try { child.kill('SIGTERM'); } catch { /* already gone */ } child = null; }
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } tmpDir = null; }
}

const TOTAL = 38;

async function run() {
  console.log('--- Pulse Dialer: Telnyx + softphone verification suite ---');

  if (EXTERNAL_BASE) {
    BASE = EXTERNAL_BASE;
    if (!(await waitForServer(BASE, 3000))) throw new Error(`No API responding at ${BASE}`);
    console.log(`  \u2713 Using running API at ${BASE}`);
  } else {
    await bootServer();
  }

  // ---------------------------------------------------------------- settings
  step(1, TOTAL, 'GET /api/settings — Telnyx defaults, legacy carrier migrated and purged, secret masked');
  const s1 = await req('GET', '/api/settings');
  assert.strictEqual(s1.status, 200);
  const s = s1.json;
  assert.strictEqual(s.telephony_mode, 'softphone');
  assert.strictEqual(s.softphone_protocol, 'sip');
  assert.strictEqual(s.telnyx_sip_server, 'sip.telnyx.com');
  assert.strictEqual(s.default_country_code, '45');
  assert.strictEqual(s.dry_run, '1');
  assert.strictEqual(s.daily_goal, '80');
  assert.strictEqual(s.daily_cap, '150');
  assert.strictEqual(s.telnyx_sip_password, '', 'SIP secret must never reach the browser');
  // ---- Migration 7: what the legacy database carried over, and what it lost ----
  assert.strictEqual(s.telnyx_sip_user, 'old-extension-42', 'the legacy SIP username was carried across');
  assert.strictEqual(s.has_password, true, 'and so was the legacy SIP secret');
  assert.strictEqual(s.webrtc_ws_url, '', 'a gateway pointing at the retired carrier was cleared, not kept');
  assert.strictEqual(s.telnyx_api_key, '', 'no API key is exposed, only the flag');
  assert.strictEqual(s.has_api_key, false, 'and the flag says so honestly');
  assert.strictEqual(s.ai_api_key, '', 'the AI key is masked as well');
  assert.strictEqual(s.has_ai_key, false, 'under its own flag, not the Telnyx one');
  const legacyKeys = Object.keys(s).filter((k) => /voip/i.test(k));
  assert.deepStrictEqual(legacyKeys, [], `no legacy carrier key survives in the API: ${legacyKeys.join(', ')}`);
  // Exact key set proves no retired setting (old callback credentials, "ring me first" number) survives.
  assert.deepStrictEqual(Object.keys(s).sort(), [
    'agent_name', 'ai_api_key', 'ai_model', 'ai_provider',
    'business_days', 'business_hours_end', 'business_hours_start', 'business_tz',
    'caller_id', 'caller_id_cursor', 'caller_id_pool',
    'daily_cap', 'daily_goal', 'default_country_code', 'dry_run', 'email_verify_deep',
    'followup_email_template', 'has_ai_key', 'has_api_key', 'has_password', 'has_smtp_pass', 'meet_link',
    'queue_smart_sort', 'sales_script', 'smtp_from', 'smtp_host', 'smtp_pass', 'smtp_port', 'smtp_reply_to',
    'smtp_secure', 'smtp_user', 'softphone_protocol', 'sound_cues', 'telephony_mode',
    'telnyx_api_key', 'telnyx_connection_id', 'telnyx_sip_password', 'telnyx_sip_server', 'telnyx_sip_user',
    'vm_auto_advance', 'vm_greeting',
    'webrtc_credential_handoff', 'webrtc_mic_device', 'webrtc_speaker_device', 'webrtc_ws_url',
  ]);
  assert.strictEqual(s.ai_provider, 'local', 'copilot defaults to the local summarizer');
  assert.strictEqual(s.business_tz, 'Europe/Copenhagen');
  assert.strictEqual(s.business_hours_start, '08:30');
  assert.strictEqual(s.business_hours_end, '16:30');
  ok(`legacy VOIP.SO settings migrated to Telnyx, old keys purged, secrets masked (country code +${s.default_country_code})`);

  // ---------------------------------------------------------------- settings write
  step(2, TOTAL, 'PUT /api/settings — telephony config round-trips, blank secret keeps the old one');
  const w1 = await req('PUT', '/api/settings', {
    telephony_mode: 'softphone',
    softphone_protocol: 'sip',
    telnyx_sip_server: 'sip.telnyx.com',
    telnyx_sip_user: '1001',
    telnyx_sip_password: 'super-secret',
    caller_id: '+45 20 12 34 56',
    default_country_code: '45',
    daily_goal: '90',
    daily_cap: '160',
  });
  assert.strictEqual(w1.status, 200);
  assert.strictEqual(w1.json.sampleDialUri, `sip:${E164}`);
  const s2 = (await req('GET', '/api/settings')).json;
  assert.strictEqual(s2.telnyx_sip_user, '1001');
  assert.strictEqual(s2.caller_id, '+45 20 12 34 56');
  assert.strictEqual(s2.daily_goal, '90');
  assert.strictEqual(s2.has_password, true);
  assert.strictEqual(s2.telnyx_sip_password, '');
  await req('PUT', '/api/settings', { telnyx_sip_password: '' }); // blank = keep
  const s3 = (await req('GET', '/api/settings')).json;
  assert.strictEqual(s3.has_password, true, 'blank password must not wipe the stored secret');

  // The settings schema is a whitelist and strips unknown keys, so a setting that exists in
  // DEFAULTS but not in the schema is silently un-settable — the PUT returns 200 and the value
  // never persists. Assert the two lists agree, so adding a setting cannot half-land again.
  {
    const { SETTING_KEYS } = require('../server/config/defaults');
    const { settingsUpdate } = require('../server/validation/schemas');
    const schemaKeys = new Set(Object.keys(settingsUpdate.shape || {}));
    const unschemaed = SETTING_KEYS.filter((k) => !schemaKeys.has(k));
    assert.deepStrictEqual(unschemaed, [],
      `settings exist in DEFAULTS but are stripped by the settingsUpdate schema: ${unschemaed.join(', ')}`);
  }

  // The in-browser softphone settings must round-trip rather than be silently dropped.
  await req('PUT', '/api/settings', {
    webrtc_ws_url: 'wss://gateway.example.dk:8089/ws',
    webrtc_credential_handoff: '1',
    webrtc_mic_device: 'mic-abc',
    webrtc_speaker_device: 'spk-xyz',
  });
  const s4 = (await req('GET', '/api/settings')).json;
  assert.strictEqual(s4.webrtc_ws_url, 'wss://gateway.example.dk:8089/ws', 'webrtc_ws_url persists');
  assert.strictEqual(s4.webrtc_credential_handoff, '1', 'webrtc_credential_handoff persists');
  assert.strictEqual(s4.webrtc_mic_device, 'mic-abc', 'the microphone choice persists');
  assert.strictEqual(s4.webrtc_speaker_device, 'spk-xyz', 'the speaker choice persists');
  await req('PUT', '/api/settings', { webrtc_ws_url: '', webrtc_credential_handoff: '0', webrtc_mic_device: '', webrtc_speaker_device: '' });
  ok('telephony + Telnyx keys saved, caller ID kept, secret never echoed back (every setting the schema accepts round-trips)');

  // ---------------------------------------------------------------- Danish normalization
  step(3, TOTAL, 'POST /api/prospects — Danish number normalization (+45)');
  const created = await req('POST', '/api/prospects', {
    name: '  Test Suite User  ',
    phone: '20 12 34 56',
    email: 'test@example.dk',
    company: 'Acme Test ApS',
    title: 'QA Lead',
    stage: 'new',
  });
  assert.strictEqual(created.status, 200);
  assert.strictEqual(created.json.name, 'Test Suite User');
  assert.strictEqual(created.json.phone, E164, '8-digit Danish number must become +45XXXXXXXX');
  const testId = created.json.id;
  ok(`"20 12 34 56" normalized to ${created.json.phone} (prospect ${testId})`);

  step(4, TOTAL, 'Phone normalization variants (spaces, +45, 0045, junk)');
  const variants = ['20123456', '+45 20 12 34 56', '004520123456', '4520123456', '0045 20 12 34 56'];
  for (const v of variants) {
    const p = await req('PATCH', `/api/prospects/${testId}`, { phone: v });
    assert.strictEqual(p.json.phone, E164, `"${v}" should normalize to ${E164}, got ${p.json.phone}`);
  }
  // Sub-5-digit junk used to be silently stored as "", producing leads that could never be
  // dialled. It is refused now — see group 34. The existing good number must survive.
  const junk = await req('PATCH', `/api/prospects/${testId}`, { phone: '1234' });
  assert.strictEqual(junk.status, 400, 'sub-5-digit junk must be refused, not blanked');
  assert.match(junk.json.error, /not a diallable phone number/);
  const stillGood = await req('GET', `/api/prospects/${testId}`);
  assert.strictEqual(stillGood.json.phone, E164, 'a rejected patch leaves the stored number untouched');
  await req('PATCH', `/api/prospects/${testId}`, { phone: SAMPLE });
  ok(`${variants.length} input formats all normalize to ${E164}; junk "1234" dropped`);

  // ---------------------------------------------------------------- patch
  step(5, TOTAL, 'PATCH /api/prospects/:id — stage and field updates');
  const patched = await req('PATCH', `/api/prospects/${testId}`, { stage: 'interested', title: 'VP Quality' });
  assert.strictEqual(patched.status, 200);
  assert.strictEqual(patched.json.stage, 'interested');
  assert.strictEqual(patched.json.title, 'VP Quality');
  ok('stage + title updated');

  // ---------------------------------------------------------------- direct dial (sip:)
  step(6, TOTAL, 'POST /api/prospects/:id/call — returns a dial URI for the softphone');
  const callRes = await req('POST', `/api/prospects/${testId}/call`);
  assert.strictEqual(callRes.status, 200);
  assert.ok(callRes.json.callId > 0);
  assert.strictEqual(callRes.json.dryRun, true);
  assert.strictEqual(callRes.json.protocol, 'sip');
  assert.strictEqual(callRes.json.dialUri, `sip:${E164}`);
  assert.strictEqual(callRes.json.dialUriFull, `sip:${E164}@sip.telnyx.com`);
  assert.strictEqual(callRes.json.telephonyMode, 'softphone');
  const testCallId = callRes.json.callId;
  const afterCall = await req('GET', `/api/prospects/${testId}`);
  assert.strictEqual(afterCall.json.call_count, 1);
  assert.strictEqual(afterCall.json.calls[0].dial_uri, `sip:${E164}`, 'dial URI is kept in call history');
  ok(`callId ${testCallId} → dispatches ${callRes.json.dialUri}, call_count = 1`);

  // ---------------------------------------------------------------- live mode + tel: scheme
  step(7, TOTAL, 'Live mode and the tel: scheme');
  await req('PUT', '/api/settings', { dry_run: '0', softphone_protocol: 'tel' });
  const live = await req('POST', `/api/prospects/${testId}/call`);
  assert.strictEqual(live.status, 200);
  assert.strictEqual(live.json.dryRun, false);
  assert.strictEqual(live.json.dialUri, `tel:${E164}`);
  assert.strictEqual(live.json.warning, null, 'the Telnyx SIP account is configured, so no warning');
  const liveClassified = await req('PATCH', `/api/calls/${live.json.callId}`, { outcome: 'conversation', duration_sec: 41 });
  assert.strictEqual(liveClassified.json.prospect.last_outcome, 'conversation');
  await req('PUT', '/api/settings', { dry_run: '1', softphone_protocol: 'sip' });
  ok(`live call dispatched ${live.json.dialUri} and logged a 41s conversation`);

  // ---------------------------------------------------------------- softphone test endpoint
  step(8, TOTAL, 'POST /api/settings/test-softphone — protocol verification');
  const t = await req('POST', '/api/settings/test-softphone', { number: SAMPLE });
  assert.strictEqual(t.status, 200);
  assert.strictEqual(t.json.ok, true);
  assert.strictEqual(t.json.configured, true);
  assert.strictEqual(t.json.sampleNumber, E164);
  assert.strictEqual(t.json.dialUri, `sip:${E164}`);
  assert.strictEqual(t.json.sipServer, 'sip.telnyx.com');
  assert.strictEqual(t.json.inBrowser, false, 'a softphone launch is not an in-browser session');

  // ------------------------------------------------- in-browser WebRTC session descriptor
  // The endpoint can hand out live SIP credentials, so it demands the session token even
  // though it is a GET.
  assert.strictEqual((await req('GET', '/api/telephony/webrtc-session')).status, 401,
    'the WebRTC session endpoint refuses a caller with no token');

  const sess = await tokened('GET', '/api/telephony/webrtc-session');
  assert.strictEqual(sess.status, 200);
  assert.strictEqual(sess.json.mode, 'webrtc');
  assert.ok(sess.json.wsUrl.startsWith('wss://'), `the signalling gateway is a wss URL (got ${sess.json.wsUrl})`);
  assert.strictEqual(sess.json.provider, 'telnyx', 'the descriptor names the carrier it is aiming at');
  assert.strictEqual(sess.json.server, 'sip.telnyx.com');
  assert.strictEqual(sess.json.wsUrl, 'wss://rtc.telnyx.com', "an unset gateway means Telnyx's own");
  assert.strictEqual(sess.json.username, '1001');

  // The SIP secret stays on the server unless the agent explicitly opts into the handoff —
  // a browser cannot register without it, so the descriptor says so instead of omitting it.
  await req('PUT', '/api/settings', { webrtc_credential_handoff: '0' });
  const closed = await tokened('GET', '/api/telephony/webrtc-session');
  assert.strictEqual(closed.json.password, '', 'the SIP secret is withheld while the handoff is off');
  assert.strictEqual(closed.json.hasPassword, true, 'the descriptor still reports that a secret exists');
  assert.strictEqual(closed.json.canRegister, false, 'the browser cannot register without the secret');

  await req('PUT', '/api/settings', { webrtc_credential_handoff: '1' });
  const open = await tokened('GET', '/api/telephony/webrtc-session');
  assert.strictEqual(open.json.password, 'super-secret', 'an explicit handoff releases the secret to the same-origin tab');
  assert.strictEqual(open.json.canRegister, true);
  assert.strictEqual((await req('GET', '/api/settings')).json.telnyx_sip_password, '',
    'even with the handoff on, /api/settings keeps masking the secret');
  await req('PUT', '/api/settings', { webrtc_credential_handoff: '0' });

  // A configured gateway beats the default; with none set, the URL is Telnyx's and labelled.
  await req('PUT', '/api/settings', { webrtc_ws_url: 'wss://gw.example.dk:7443/sip' });
  const customGw = await tokened('GET', '/api/telephony/webrtc-session');
  assert.strictEqual(customGw.json.wsUrl, 'wss://gw.example.dk:7443/sip', 'a configured gateway overrides the Telnyx default');
  assert.strictEqual(customGw.json.wsUrlSource, 'settings');
  await req('PUT', '/api/settings', { webrtc_ws_url: '' });
  assert.strictEqual((await tokened('GET', '/api/telephony/webrtc-session')).json.wsUrlSource, 'telnyx_default');

  // A webrtc dial addresses the SIP server over the gateway and never degrades to tel:.
  // Its own prospect, so the shared fixture's call counter stays exactly as later groups
  // expect it (the same reason the email group uses a throwaway prospect).
  const webrtcProspect = await req('POST', '/api/prospects', { name: 'Browser Call', phone: '20334455' });
  assert.strictEqual(webrtcProspect.status, 200);
  await req('PUT', '/api/settings', { telephony_mode: 'webrtc', dry_run: '1' });
  const webCall = await req('POST', `/api/prospects/${webrtcProspect.json.id}/call`);
  assert.strictEqual(webCall.status, 200);
  assert.strictEqual(webCall.json.telephonyMode, 'webrtc');
  assert.strictEqual(webCall.json.inBrowser, true, 'the client is told to open an in-browser session');
  assert.strictEqual(webCall.json.protocol, 'webrtc');
  assert.strictEqual(webCall.json.dialUri, 'sip:+4520334455@sip.telnyx.com;transport=ws',
    `webrtc dial URI (got ${webCall.json.dialUri})`);
  assert.ok(!/^tel:/.test(webCall.json.dialUri), 'a webrtc dial never degrades to a tel: URI');
  assert.strictEqual(webCall.json.callerId, '+4520123456', 'caller-ID rotation still applies in webrtc mode');
  assert.strictEqual((await req('GET', `/api/prospects/${webrtcProspect.json.id}`)).json.calls[0].dial_uri,
    'sip:+4520334455@sip.telnyx.com;transport=ws', 'the gateway URI is what lands in call history');
  await req('DELETE', `/api/prospects/${webrtcProspect.json.id}`);

  // The test-launch endpoint used to answer "configured: true" for webrtc unconditionally.
  const wt = await req('POST', '/api/settings/test-softphone', { number: SAMPLE });
  assert.strictEqual(wt.json.inBrowser, true);
  assert.strictEqual(wt.json.protocol, 'webrtc');
  assert.strictEqual(wt.json.dialUri, `sip:${E164}@sip.telnyx.com;transport=ws`, 'the test launch shows the gateway URI');
  assert.strictEqual(wt.json.configured, false, 'webrtc readiness is not claimed while the handoff is off');
  assert.match(wt.json.message, /handoff|Settings/i);

  await req('PUT', '/api/settings', { telephony_mode: 'softphone', dry_run: '1' });
  ok(`test launch dispatches ${t.json.dialUri} (configured=${t.json.configured}); the WebRTC descriptor is token-gated and its secret is opt-in`);

  // ---------------------------------------------------------------- outcome logging
  step(9, TOTAL, 'PATCH /api/calls/:id — outcome classification and pipeline stage');
  await req('PATCH', `/api/prospects/${testId}`, { stage: 'new' });
  const logRes = await req('PATCH', `/api/calls/${testCallId}`, { outcome: 'meeting_booked', duration_sec: 25 });
  assert.strictEqual(logRes.status, 200);
  assert.strictEqual(logRes.json.prospect.last_outcome, 'meeting_booked');
  assert.strictEqual(logRes.json.prospect.stage, 'meeting', 'meeting_booked must move the stage to meeting');
  const badOutcome = await req('PATCH', `/api/calls/${testCallId}`, { outcome: 'not_a_real_outcome' });
  assert.strictEqual(badOutcome.status, 400);
  ok('meeting_booked → stage "meeting"; invalid outcome rejected (400)');

  // ---------------------------------------------------------------- discard
  step(10, TOTAL, 'POST /api/calls/:id/discard — accidental dials leave no trace');
  const call2 = await req('POST', `/api/prospects/${testId}/call`);
  const before = (await req('GET', `/api/prospects/${testId}`)).json;
  assert.strictEqual(before.call_count, 3);
  const discardRes = await req('POST', `/api/calls/${call2.json.callId}/discard`);
  assert.strictEqual(discardRes.status, 200);
  const after = await req('GET', `/api/prospects/${testId}`);
  assert.strictEqual(after.json.call_count, 2, 'discard must decrement call_count');
  assert.ok(!after.json.calls.some((c) => c.id === call2.json.callId), 'discarded call must be gone');
  ok('discarded call removed from history and call_count rolled back');

  // ---------------------------------------------------------------- notes
  step(11, TOTAL, 'POST /api/prospects/:id/notes');
  const noteRes = await req('POST', `/api/prospects/${testId}/notes`, { body: 'Wants the deck in Danish, call back Thursday.' });
  assert.strictEqual(noteRes.status, 200);
  assert.strictEqual(noteRes.json.body, 'Wants the deck in Danish, call back Thursday.');
  const emptyNote = await req('POST', `/api/prospects/${testId}/notes`, { body: '   ' });
  assert.strictEqual(emptyNote.status, 400);
  ok('note saved; empty note rejected');

  // ---------------------------------------------------------------- export
  step(12, TOTAL, 'GET /api/prospects/export — CSV with notes');
  const exportRes = await req('GET', '/api/prospects/export');
  assert.strictEqual(exportRes.status, 200);
  assert.ok(exportRes.headers.get('content-type').includes('text/csv'));
  assert.ok(exportRes.text.startsWith('ID,Name,Phone,Email,Company,Title,Stage'));
  assert.ok(exportRes.text.includes('Test Suite User'));
  assert.ok(exportRes.text.includes(E164));
  assert.ok(exportRes.text.includes('Wants the deck in Danish'));
  ok('CSV export includes the prospect, its +45 number and its notes');

  // ---------------------------------------------------------------- bulk import
  step(13, TOTAL, 'POST /api/prospects/bulk — junk filtering, dedupe, Danish numbers');
  const bulkRes = await req('POST', '/api/prospects/bulk', {
    rows: [
      { 'Full Name': 'Total', Phone: '', Email: '' },
      { 'Full Name': 'Page 1 of 4', Phone: '', Email: '' },
      { 'Full Name': 'Valid Lead', Phone: '22 34 56 78', Email: 'lead@company.dk' },
      { 'Full Name': 'Valid Lead', Phone: '22345678', Email: 'lead@company.dk' },
      { 'Full Name': 'null', Phone: '0', Email: 'none' },
    ],
    mapping: { name: 'Full Name', phone: 'Phone', email: 'Email' },
    skipDuplicates: true,
  });
  assert.strictEqual(bulkRes.status, 200);
  assert.strictEqual(bulkRes.json.added, 1);
  assert.strictEqual(bulkRes.json.dupes, 1);
  assert.strictEqual(bulkRes.json.empty, 3);
  const all = (await req('GET', '/api/prospects')).json;
  const imported = all.find((p) => p.name === 'Valid Lead');
  assert.ok(imported, 'valid row should be imported');
  assert.strictEqual(imported.phone, '+4522345678', 'imported Danish number must be normalized too');
  await req('DELETE', `/api/prospects/${imported.id}`);
  ok(`bulk import: added=1 dupes=1 empty=3, phone normalized to ${imported.phone}`);

  // ---------------------------------------------------------------- stats
  step(14, TOTAL, 'GET /api/stats — funnel, week buckets, pipeline counts');
  const statsRes = await req('GET', `/api/stats?tzOffset=${new Date().getTimezoneOffset()}`);
  assert.strictEqual(statsRes.status, 200);
  assert.strictEqual(statsRes.json.today.dials, 2, 'the discarded call must not count as a dial');
  // conversation + meeting_booked are both "conversations"; meeting_booked is also a meeting
  assert.strictEqual(statsRes.json.today.pickups, 2);
  assert.strictEqual(statsRes.json.today.conversations, 2);
  assert.strictEqual(statsRes.json.today.meetings, 1);
  assert.strictEqual(statsRes.json.today.avgTalkSec, 33, 'avg of the 25s and 41s conversations');
  assert.strictEqual(statsRes.json.week.length, 7);
  assert.strictEqual(statsRes.json.goal, 90);

  // The day labels are the *client's* calendar dates. Deriving them from the UTC instant of
  // local midnight captioned every bar one day early for anyone east of Greenwich — which is
  // every Danish user this app is built for. tzOffset=-330 (IST) is the discriminating case:
  // there the local date and the UTC date of that instant never agree.
  const localDate = (tz) => new Date(Date.now() - tz * 60000).toISOString().slice(0, 10);
  for (const tz of [-330, -120, 0, 300]) {
    const s = (await req('GET', `/api/stats?tzOffset=${tz}`)).json;
    const last = s.week[6];
    assert.match(last.date, /^\d{4}-\d{2}-\d{2}$/, `week[6].date is a plain calendar date, got "${last.date}"`);
    assert.strictEqual(last.date, localDate(tz), `week[6] is labelled in the client's calendar for tzOffset=${tz}`);
    assert.strictEqual(last.dials, s.today.dials, `the last week bucket and "today" agree for tzOffset=${tz}`);
  }
  // Every bucket must also be a distinct, ascending day — a shift would collapse two of them.
  const weekSeries = (await req('GET', '/api/stats?tzOffset=-330')).json.week;
  assert.strictEqual(new Set(weekSeries.map((d) => d.date)).size, 7, 'seven distinct days');
  assert.deepStrictEqual([...weekSeries.map((d) => d.date)].sort(), weekSeries.map((d) => d.date), 'and they run oldest to newest');
  assert.strictEqual(statsRes.json.cap, 160);
  assert.strictEqual(statsRes.json.recent.length, 2);
  ok(`stats: 2 dials / 2 pickups / 2 conversations / 1 meeting, avg talk ${statsRes.json.today.avgTalkSec}s, goal 90 / cap 160`);

  // ---------------------------------------------------------------- validation
  step(15, TOTAL, 'Input validation (Zod) — bad payloads are rejected with field details');
  const invalidOutcome = await req('PATCH', `/api/calls/${testCallId}`, { outcome: 'maybe_later' });
  assert.strictEqual(invalidOutcome.status, 400);
  assert.ok(Array.isArray(invalidOutcome.json.details), 'details array returned');
  assert.strictEqual(invalidOutcome.json.details[0].field, 'outcome');
  const badCc = await req('PUT', '/api/settings', { default_country_code: 'dk' });
  assert.strictEqual(badCc.status, 400);
  assert.match(badCc.json.details[0].message, /1-4 digits/);
  const badGoal = await req('PUT', '/api/settings', { daily_goal: -5 });
  assert.strictEqual(badGoal.status, 400);
  const badWindow = await req('PUT', '/api/settings', { business_hours_start: 'half nine' });
  assert.strictEqual(badWindow.status, 400);
  // A SIP domain with a scheme or a path produces a dial URI no softphone can parse, and the
  // failure would surface as a silent non-call, so it is refused at the boundary instead.
  for (const bad of ['https://sip.telnyx.com/', 'sip.telnyx.com/ws', 'localhost', 'not a host']) {
    const r = await req('PUT', '/api/settings', { telnyx_sip_server: bad });
    assert.strictEqual(r.status, 400, `"${bad}" must be refused as a SIP domain`);
    assert.strictEqual(r.json.details[0].field, 'telnyx_sip_server');
  }
  assert.strictEqual((await req('PUT', '/api/settings', { telnyx_sip_server: 'sip.telnyx.com:5061' })).status, 200,
    'a domain with a port is accepted');
  await req('PUT', '/api/settings', { telnyx_sip_server: 'sip.telnyx.com' });
  assert.strictEqual((await req('GET', '/api/settings')).json.default_country_code, '45', 'rejected writes change nothing');
  assert.strictEqual((await req('POST', '/api/prospects/999999/call', {})).status, 404);
  assert.strictEqual((await req('POST', '/api/nope', {})).status, 404);
  ok('invalid outcome, country code, goal and calling window all rejected with per-field messages');

  // ---------------------------------------------------------------- DID rotation
  step(16, TOTAL, 'Multi-DID caller ID rotation (spam shield)');
  await req('PUT', '/api/settings', { caller_id: '+45 20 12 34 56', caller_id_pool: '+4520987654, 31 45 67 89', caller_id_cursor: '0' });
  const poolRes = await req('GET', '/api/telephony/caller-ids');
  assert.deepStrictEqual(poolRes.json.pool, ['+4520123456', '+4520987654', '+4531456789']);
  const rotated = [];
  for (let i = 0; i < 4; i++) {
    const r = await req('POST', `/api/prospects/${testId}/call`);
    assert.strictEqual(r.status, 200);
    rotated.push(r.json.callerId);
    assert.strictEqual(r.json.callerIdPoolSize, 3);
    await req('POST', `/api/calls/${r.json.callId}/discard`);
  }
  assert.deepStrictEqual(rotated, ['+4520123456', '+4520987654', '+4531456789', '+4520123456'], 'round-robin wraps');
  ok(`caller IDs rotated ${rotated.join(' → ')}`);

  // ---------------------------------------------------------------- voicemail drop
  step(17, TOTAL, 'Voicemail drop (V) — logged, flagged and a callback scheduled');
  await req('PATCH', `/api/prospects/${testId}`, { stage: 'contacted' });
  const vmCall = await req('POST', `/api/prospects/${testId}/call`);
  const vm = await req('POST', `/api/calls/${vmCall.json.callId}/voicemail-drop`, { duration_sec: 9 });
  assert.strictEqual(vm.status, 200);
  assert.strictEqual(vm.json.call.outcome, 'voicemail');
  assert.strictEqual(vm.json.call.vm_dropped, 1);
  assert.strictEqual(vm.json.call.follow_up_at, vm.json.followUpAt);
  assert.strictEqual(vm.json.prospect.stage, 'followup');
  assert.strictEqual(vm.json.autoAdvance, true, 'UI advances straight to the next prospect');
  assert.strictEqual(vm.json.voicemail.file, 'vm_danish.mp3');
  assert.strictEqual(vm.json.voicemail.expectedPath, 'data/audio/vm_danish.mp3');
  const meta = await req('GET', '/api/telephony/voicemail-greeting');
  assert.strictEqual(meta.json.file, 'vm_danish.mp3');
  assert.strictEqual(typeof meta.json.exists, 'boolean');
  const noFile = await req('GET', '/api/telephony/voicemail-greeting/file');
  if (!meta.json.exists) assert.strictEqual(noFile.status, 404, 'missing greeting is a clean 404');
  ok(`voicemail drop logged, callback scheduled for ${vm.json.followUpAt}`);

  // ---------------------------------------------------------------- follow-up scheduler
  step(18, TOTAL, 'Follow-up scheduler + 1-click email template');
  // Regression: a settings save that never mentions the template must not blank it.
  await req('PUT', '/api/settings', { daily_goal: '90' });
  const tmplAfter = await req('GET', '/api/settings');
  assert.ok(tmplAfter.json.followup_email_template.includes('{{name}}'), 'an unrelated settings save leaves the email template intact');

  const emailFirst = await req('POST', `/api/telephony/prospects/${testId}/follow-up-email`, { noteText: 'Sender det korte oplæg som aftalt.' });
  assert.strictEqual(emailFirst.status, 200);
  assert.strictEqual(emailFirst.json.to, 'test@example.dk');
  assert.ok(emailFirst.json.subject.includes('Acme Test ApS'));
  assert.ok(emailFirst.json.body.includes('Hej Test,'), 'first-name placeholder resolved');
  assert.ok(emailFirst.json.body.includes('Sender det korte oplæg som aftalt.'));
  assert.ok(!emailFirst.json.body.includes('{{'), 'no unresolved placeholders left');
  const scheduled = await req('POST', `/api/telephony/prospects/${testId}/follow-up`, { at: '2026-11-02 09:30:00' });
  assert.strictEqual(scheduled.json.prospect.follow_up_at, '2026-11-02 09:30:00');
  const overdueAt = new Date(Date.now() - 3600000).toISOString().slice(0, 19).replace('T', ' ');
  await req('POST', `/api/telephony/prospects/${testId}/follow-up`, { at: overdueAt });
  const dueRes = await req('GET', '/api/prospects/follow-ups');
  assert.ok(dueRes.json.due.some((p) => p.id === testId), 'overdue follow-up shows up in the due list');
  assert.ok(dueRes.json.due.find((p) => p.id === testId).overdueHours >= 0);
  assert.strictEqual(dueRes.json.businessHours.tz, 'Europe/Copenhagen');
  ok('email template rendered with real values; overdue follow-up is listed');

  // ---------------------------------------------------------------- smart queue
  step(19, TOTAL, 'Danish smart queue + calling window');
  const queueRes = await req('GET', '/api/queue?tab=all');
  assert.strictEqual(queueRes.status, 200);
  assert.strictEqual(queueRes.json.smartSort, true);
  assert.strictEqual(queueRes.json.businessHours.tz, 'Europe/Copenhagen');
  assert.strictEqual(queueRes.json.businessHours.startsAt, '08:30');
  assert.strictEqual(queueRes.json.businessHours.endsAt, '16:30');
  assert.ok(queueRes.json.rows.length >= 1);
  const due = queueRes.json.rows.find((r) => r.reason === 'follow_up_due');
  const never = queueRes.json.rows.find((r) => r.reason === 'never_called');
  assert.ok(due, 'the overdue follow-up is in the queue');
  assert.ok(!never || due.score > never.score, 'follow-ups outrank never-called prospects');
  assert.strictEqual(queueRes.json.rows[0].id, due.id, 'most urgent prospect is first');
  ok(`queue ranked by urgency (${Object.entries(queueRes.json.reasons).map(([k, v]) => `${k}:${v}`).join(', ')})`);

  // ---------------------------------------------------------------- copilot
  step(20, TOTAL, 'Post-call copilot — local extractive summary');
  const coCall = await req('POST', `/api/prospects/${testId}/call`);
  await req('POST', `/api/prospects/${testId}/notes`, { body: 'Vil gerne have en demo i næste uge. Budget ligger hos CFO.' });
  await req('PATCH', `/api/calls/${coCall.json.callId}`, { outcome: 'conversation', duration_sec: 205 });
  const sum = await req('POST', `/api/calls/${coCall.json.callId}/summary`, {});
  assert.strictEqual(sum.status, 200);
  assert.strictEqual(sum.json.provider, 'local');
  assert.match(sum.json.summary, /Test Suite User/);
  assert.match(sum.json.summary, /Acme Test ApS/);
  assert.match(sum.json.summary, /conversation/);
  assert.strictEqual(sum.json.talkTimeSec, 205);
  assert.ok(sum.json.nextSteps.length >= 1, 'next step extracted from the notes');
  assert.ok(sum.json.highlights.some((h) => /demo|Budget/i.test(h)));
  assert.ok(sum.json.followUpSuggested);
  assert.ok(sum.json.call.summary, 'summary persisted on the call row');
  assert.ok(sum.json.call.next_step.includes('demo'), 'next step persisted on the call row');
  ok(`copilot summary stored: "${sum.json.summary.slice(0, 64)}…"`);

  // ---------------------------------------------------------------- backups + health
  step(21, TOTAL, 'Snapshots, health and the migration ledger');
  const health = await req('GET', '/api/health');
  assert.strictEqual(health.json.ok, true);
  assert.strictEqual(health.json.db.journal_mode, 'wal');
  assert.strictEqual(health.json.db.busy_timeout, 5000);
  assert.ok(health.json.db.migrations >= 5);
  const snap = await req('POST', '/api/settings/backups', { reason: 'test' });
  assert.strictEqual(snap.status, 200);
  assert.ok(snap.json.bytes > 0);
  assert.match(snap.json.file, /^dialer-backup-\d{4}-\d{2}-\d{2}-.*-test\.db$/);
  const snaps = await req('GET', '/api/settings/backups');
  assert.ok(snaps.json.backups.length >= 1);
  assert.ok(snaps.json.backups[0].created_at >= snaps.json.backups[snaps.json.backups.length - 1].created_at, 'newest first');

  // The snapshot must be downloadable so the database can live off this machine.
  const dl = await fetch(`${BASE}/api/settings/backups/${encodeURIComponent(snap.json.file)}`);
  assert.strictEqual(dl.status, 200, 'snapshot downloads');
  const dlBytes = new Uint8Array(await dl.arrayBuffer());
  assert.strictEqual(dlBytes.length, snap.json.bytes, 'downloaded every byte');
  assert.strictEqual(Buffer.from(dlBytes.slice(0, 15)).toString('utf8'), 'SQLite format 3',
    'the download is a real SQLite database');
  assert.strictEqual(dlBytes[15], 0, 'SQLite header terminator byte present');
  assert.strictEqual((await req('GET', '/api/settings/backups/../../dialer.db')).status, 404, 'a traversal name is not served');
  assert.strictEqual((await req('GET', '/api/settings/backups/dialer.db')).status, 404, 'the live database is not downloadable by name');
  assert.strictEqual((await req('GET', '/api/settings/backups/nope.db')).status, 404);
  ok(`snapshot ${snap.json.file} (${Math.round(snap.json.bytes / 1024)} KB) downloads intact; traversal names refused`);

  // ---------------------------------------------------------------- JSON export
  step(22, TOTAL, 'JSON export with full call history and talk time');
  const jsonRes = await req('GET', '/api/prospects/export?format=json');
  assert.strictEqual(jsonRes.status, 200);
  assert.ok(jsonRes.headers.get('content-type').includes('application/json'));
  const payload = JSON.parse(jsonRes.text);
  assert.ok(payload.exported_at);
  assert.strictEqual(payload.telephony.sip_server, 'sip.telnyx.com');
  assert.strictEqual(payload.telephony.protocol, 'sip');
  const exported = payload.prospects.find((p) => p.id === testId);
  assert.ok(exported.calls.length >= 3, `call history included (${exported.calls.length} calls)`);
  assert.ok(exported.notes.length >= 2);
  assert.ok(exported.totalTalkSec >= 205, `talk time aggregated, got ${exported.totalTalkSec}`);
  assert.ok(exported.calls.some((c) => c.vm_dropped === 1), 'voicemail drop is visible in the export');
  ok(`JSON export: ${payload.prospects.length} prospects, ${exported.calls.length} calls, ${exported.totalTalkSec}s talk time`);

  // ---------------------------------------------------------------- fuzzing
  step(23, TOTAL, 'Phone normalization under adversarial input (API level)');
  // Values that must survive normalization unchanged.
  const fuzzCases = [
    ['20 12 34 56', E164], ['+45 20 12 34 56', E164], ['004520123456', E164], ['020123456', E164],
    ['+45 (20) 12-34-56', E164], ['+45.20.12.34.56', E164], ['31123456', '+4531123456'],
    ['+447911123456', '+447911123456'], ['+14155552671', '+14155552671'],
    ['+4915123456789', '+4915123456789'], ['07911123456', '07911123456'],
  ];
  for (const [input, expected] of fuzzCases) {
    const r = await req('POST', '/api/prospects', { name: `Fuzz ${input}`, phone: input });
    assert.strictEqual(r.status, 200, `create with ${JSON.stringify(input)}`);
    assert.strictEqual(r.json.phone, expected, `phone ${JSON.stringify(input)} -> ${r.json.phone}`);
    await req('DELETE', `/api/prospects/${r.json.id}`);
  }

  // Values that look like a number but are not one. These used to be stored as "" — a lead
  // that could never be dialled — and are refused now (see group 34).
  const fuzzRejected = ['+45 123', '+45201234567', '1234', 'abcde'];
  for (const input of fuzzRejected) {
    const r = await req('POST', '/api/prospects', { name: `Fuzz ${input}`, phone: input });
    assert.strictEqual(r.status, 400, `"${input}" must be refused, got ${r.status}`);
    assert.match(r.json.error, /not a diallable phone number/, `error text for ${JSON.stringify(input)}`);
  }

  // Placeholders are a deliberate "no value", not a broken number, so they stay empty.
  const fuzzPlaceholders = [['N/A', ''], ['', '']];
  for (const [input, expected] of fuzzPlaceholders) {
    const r = await req('POST', '/api/prospects', { name: `Fuzz ${input || 'blank'}`, phone: input });
    assert.strictEqual(r.status, 200, `placeholder ${JSON.stringify(input)} is accepted`);
    assert.strictEqual(r.json.phone, expected, `placeholder ${JSON.stringify(input)} -> ${r.json.phone}`);
    await req('DELETE', `/api/prospects/${r.json.id}`);
  }
  const nullPhone = await req('POST', '/api/prospects', { name: 'Null Phone', phone: null });
  assert.strictEqual(nullPhone.json.phone, '', 'null phone is stored empty, not "null"');
  await req('DELETE', `/api/prospects/${nullPhone.json.id}`);
  ok(`${fuzzCases.length + fuzzRejected.length + fuzzPlaceholders.length + 1} adversarial phone inputs normalized, refused or blanked correctly`);

  // ---------------------------------------------------------------- hostile input
  step(24, TOTAL, 'Hostile input, injection defence and clean error envelopes');
  const traversal = await req('POST', '/api/settings/backups', { reason: '../../../../../../../../tmp/pulse-traversal-probe' });
  assert.strictEqual(traversal.status, 200);
  assert.ok(!/\.\./.test(traversal.json.file), `reason slugified into a safe filename: ${traversal.json.file}`);
  assert.ok(!fs.existsSync('/tmp/pulse-traversal-probe.db'), 'no file written outside data/backups');

  // res.text() strips a leading BOM by spec, so the BOM has to be checked on the raw bytes.
  const csvRaw = new Uint8Array(await (await fetch(`${BASE}/api/prospects/export?format=csv`)).arrayBuffer());
  assert.deepStrictEqual([csvRaw[0], csvRaw[1], csvRaw[2]], [0xEF, 0xBB, 0xBF], 'CSV export carries a UTF-8 BOM for Excel');
  const csvHead = await req('GET', '/api/prospects/export?format=csv');
  assert.ok(!/"=/.test(csvHead.text.replace(/""/g, '')), 'no CSV cell still starts with a formula');

  const badJson = await fetch(`${BASE}/api/prospects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"x",}' });
  assert.strictEqual(badJson.status, 400);
  assert.ok((await badJson.json()).error, 'malformed JSON gets a structured 400, never an HTML stack');
  const emptyProspect = await req('POST', '/api/prospects', {});
  assert.strictEqual(emptyProspect.status, 400, 'a completely blank prospect is rejected');
  const badFollowUp = await req('PATCH', `/api/prospects/${testId}`, { follow_up_at: 'not-a-date!!' });
  assert.strictEqual(badFollowUp.status, 400, 'junk follow-up dates are rejected');
  assert.strictEqual(badFollowUp.json.details[0].field, 'follow_up_at');
  // …but an *empty* value is how the UI says "no follow-up any more": the date input posts ''
  // when it is cleared, and rejecting that made a scheduled follow-up impossible to un-schedule
  // (it kept re-ranking to the top of the queue at score 95 forever).
  const scheduledFu = await req('PATCH', `/api/prospects/${testId}`, { follow_up_at: '2026-11-02' });
  assert.strictEqual(scheduledFu.json.follow_up_at, '2026-11-02', 'a follow-up can be scheduled');
  const unScheduled = await req('PATCH', `/api/prospects/${testId}`, { follow_up_at: '' });
  assert.strictEqual(unScheduled.status, 200, "clearing with '' is accepted");
  assert.strictEqual(unScheduled.json.follow_up_at, null, 'and it stores as null, not as an invalid date');
  const clearedNull = await req('PATCH', `/api/prospects/${testId}`, { follow_up_at: null });
  assert.strictEqual(clearedNull.json.follow_up_at, null, 'null means the same thing');
  assert.strictEqual((await req('GET', `/api/prospects/${testId}`)).json.follow_up_at, null, 'and it persists');
  const badSchedule = await req('POST', `/api/telephony/prospects/${testId}/follow-up`, { at: 'garbage!!' });
  assert.strictEqual(badSchedule.status, 400);
  const badTab = await req('GET', '/api/queue?tab=bogus');
  assert.strictEqual(badTab.status, 400, '/api/queue validates its query string');
  const missingNote = await req('PATCH', '/api/notes/9999999', { body: 'x' });
  assert.strictEqual(missingNote.status, 404, 'patching a missing note is a 404, not an empty 200');
  const missingNoteDel = await req('DELETE', '/api/notes/9999999');
  assert.strictEqual(missingNoteDel.status, 404);
  const huge = Buffer.alloc(31 * 1024 * 1024, 65);
  const fd = new FormData();
  fd.append('file', new Blob([huge], { type: 'text/csv' }), 'big.csv');
  const oversize = await fetch(`${BASE}/api/import/parse`, { method: 'POST', body: fd });
  assert.strictEqual(oversize.status, 413, 'an over-limit upload is a 413');
  assert.ok((await oversize.json()).error.includes('too large'));
  const zip = new FormData();
  zip.append('file', new Blob([Buffer.from([0x50, 0x4b, 3, 4])], { type: 'application/zip' }), 'evil.zip');
  const zipRes = await fetch(`${BASE}/api/import/parse`, { method: 'POST', body: zip });
  assert.strictEqual(zipRes.status, 400, 'non-spreadsheet uploads are refused');
  ok('path traversal, CSV formulas, junk dates, oversize uploads and missing notes all handled');

  // ---------------------------------------------------------------- import at scale
  step(25, TOTAL, 'Bulk import at scale — 50k rows, duplicates and atomicity');
  // 31000000+ stays clear of the +4520123456 prospect the earlier groups created, so every
  // one of these 50k numbers is genuinely new.
  const bigRows = Array.from({ length: 50000 }, (_, i) => ({ n: `Scale ${i}`, p: String(31000000 + i) }));
  const t0 = Date.now();
  const bigImport = await req('POST', '/api/prospects/bulk', { rows: bigRows, mapping: { name: 'n', phone: 'p' } });
  const ms = Date.now() - t0;
  assert.strictEqual(bigImport.status, 200, `50k-row import accepted (${bigImport.text.slice(0, 120)})`);
  assert.strictEqual(bigImport.json.added, 50000);
  assert.strictEqual(bigImport.json.dupes, 0);
  assert.strictEqual(bigImport.json.empty, 0);
  assert.ok(bigImport.json.backup && bigImport.json.backup.bytes > 0, 'a snapshot is taken before a bulk write');
  assert.ok(ms < 60000, `import finished in ${ms}ms`);
  const dupes = await req('POST', '/api/prospects/bulk', {
    rows: [{ n: 'Dupe A', p: '20123456' }, { n: 'Dupe B', p: '+45 20 12 34 56' }, { n: 'Dupe C', p: '004520123456' }],
    mapping: { name: 'n', phone: 'p' },
  });
  assert.strictEqual(dupes.json.added, 0, 'the same number in three formats is one duplicate');
  assert.strictEqual(dupes.json.dupes, 3);
  const csvRes = await fetch(`${BASE}/api/import/parse`, { method: 'POST', body: (() => {
    const f = new FormData();
    f.append('file', new Blob(['\uFEFFName,Phone,Company\r\n"Jensen, Anders",20123456,ApS\r\nBom Bom,+45 31 12 34 56,"Line1\nLine2"\r\n'], { type: 'text/csv' }), 'list.csv');
    return f;
  })() });
  const parsed = await csvRes.json();
  assert.deepStrictEqual(parsed.headers, ['Name', 'Phone', 'Company'], 'BOM stripped from the header');
  assert.strictEqual(parsed.rows[0].Name, 'Jensen, Anders', 'quoted comma handled');
  assert.strictEqual(parsed.rows[1].Company, 'Line1\nLine2', 'embedded newline handled');
  assert.strictEqual(parsed.rows[1].Phone, '+45 31 12 34 56');
  ok(`50,000 rows imported in ${(ms / 1000).toFixed(1)}s; duplicates and CRLF/BOM CSVs handled`);

  // ---------------------------------------------------------------- timezone maths
  step(26, TOTAL, 'Danish timezone maths — DST, midnight and the calling window');
  const bh = await req('GET', '/api/telephony/business-hours');
  assert.strictEqual(bh.json.tz, 'Europe/Copenhagen');
  assert.strictEqual(bh.json.startsAt, '08:30');
  assert.strictEqual(bh.json.endsAt, '16:30');
  if (!bh.json.open) {
    assert.ok(bh.json.minutesUntilOpen > 0, `after close it counts forward (${bh.json.minutesUntilOpen} min), never 0`);
  }
  const fuNow = await req('POST', `/api/telephony/prospects/${testId}/follow-up`, { at: '2026-12-24 09:30:00' });
  assert.strictEqual(fuNow.json.prospect.follow_up_at, '2026-12-24 09:30:00');
  const emailWinter = await req('POST', `/api/telephony/prospects/${testId}/follow-up-email`, { at: '2026-12-24 09:30:00' });
  assert.ok(emailWinter.json.body.includes('2026-12-24 09:30'), 'winter follow-up renders the requested wall-clock time');
  const dueRes2 = await req('GET', '/api/prospects/follow-ups');
  for (const d of dueRes2.json.due) assert.ok(Number.isFinite(d.overdueHours), 'overdueHours is never NaN/null');
  const queueRes2 = await req('GET', '/api/queue?tab=all');
  assert.strictEqual(queueRes2.json.businessHours.tz, 'Europe/Copenhagen');
  for (const row of queueRes2.json.rows) assert.ok(typeof row.score === 'number' && Number.isFinite(row.score), 'every queue score is a real number');
  ok('business hours, follow-up times and queue scores survive DST and midnight boundaries');

  // ---------------------------------------------------------------- copilot fault tolerance
  step(27, TOTAL, 'Copilot fault tolerance — zero-length calls and missing data');
  const quiet = await req('POST', '/api/prospects', { name: 'Quiet Prospect', phone: '31998877' });
  const quietCall = await req('POST', `/api/prospects/${quiet.json.id}/call`);
  await req('PATCH', `/api/calls/${quietCall.json.callId}`, { outcome: 'no_answer', duration_sec: 0 });
  const quietSum = await req('POST', `/api/calls/${quietCall.json.callId}/summary`, {});
  assert.strictEqual(quietSum.status, 200);
  assert.strictEqual(quietSum.json.talkTimeSec, 0);
  assert.ok(quietSum.json.summary.length > 0, 'a placeholder summary instead of a crash');
  assert.deepStrictEqual(quietSum.json.nextSteps, []);
  assert.ok(quietSum.json.followUpSuggested, 'a callback is still suggested');
  const gone = await req('POST', '/api/calls/9999999/summary', {});
  assert.strictEqual(gone.status, 404, 'summarizing a missing call is a clean 404');
  await req('DELETE', `/api/prospects/${quiet.json.id}`);
  ok('0-second calls with no notes summarize cleanly; missing calls 404');

  // ---------------------------------------------------------------- unit layer
  step(28, TOTAL, 'Repository + service unit layer (in-process, throwaway database)');
  const unit = spawnSync(process.execPath, [path.join(__dirname, 'unit', 'repositories.test.js')], {
    cwd: REPO,
    env: { ...process.env, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-unit-')), PULSE_TEST: '1' },
    encoding: 'utf8',
  });
  process.stdout.write(unit.stdout || '');
  if (unit.status !== 0) throw new Error(`unit tests failed:\n${unit.stderr || unit.stdout}`);
  assert.match(unit.stdout, /unit checks passed/);

  const importUnit = spawnSync(process.execPath, [path.join(__dirname, 'unit', 'import-map.test.js')], {
    cwd: REPO, env: { ...process.env, PULSE_TEST: '1' }, encoding: 'utf8',
  });
  process.stdout.write(importUnit.stdout || '');
  if (importUnit.status !== 0) throw new Error(`import mapping unit tests failed:\n${importUnit.stderr || importUnit.stdout}`);
  assert.match(importUnit.stdout, /mapping checks passed/);
  ok('repository, migration, backup, telephony, copilot, inbound-engine and import-mapping unit checks all green');

  // ---------------------------------------------------------------- hardening unit layer
  step(29, TOTAL, 'Hardening unit layer (fuzzing, timezones, injection, fault tolerance)');
  const hardening = spawnSync(process.execPath, [path.join(__dirname, 'unit', 'hardening.test.js')], {
    cwd: REPO,
    env: { ...process.env, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-hard-')), PULSE_TEST: '1' },
    encoding: 'utf8',
  });
  process.stdout.write(hardening.stdout || '');
  if (hardening.status !== 0) throw new Error(`hardening tests failed:\n${hardening.stderr || hardening.stdout}`);
  assert.match(hardening.stdout, /hardening checks passed/);

  const propertySuite = spawnSync(process.execPath, [path.join(__dirname, 'unit', 'property.test.js')], {
    cwd: REPO, env: { ...process.env, PULSE_TEST: '1' }, encoding: 'utf8',
  });
  process.stdout.write(propertySuite.stdout || '');
  if (propertySuite.status !== 0) throw new Error(`property tests failed:\n${propertySuite.stderr || propertySuite.stdout}`);
  assert.match(propertySuite.stdout, /property suites passed/);
  ok('adversarial input, timezone maths, injection defences and generative property invariants verified');

  // ---------------------------------------------------------------- UI race layer
  step(30, TOTAL, 'Dialer UI race suite (real bundle driven in jsdom)');
  const ui = spawnSync(process.execPath, [path.join(__dirname, 'ui', 'dialer-race.test.js')], {
    cwd: REPO, env: { ...process.env, PULSE_TEST: '1' }, encoding: 'utf8', timeout: 180000,
  });
  process.stdout.write(ui.stdout || '');
  if (ui.status !== 0) throw new Error(`UI race suite failed:\n${ui.stderr || ui.stdout}`);
  assert.ok(/UI race checks passed|skipped/.test(ui.stdout), 'UI race suite reported a result');
  ok(/skipped/.test(ui.stdout) ? 'UI race suite skipped (no dist/ or jsdom)' : 'keyboard race conditions, focus traps and console hygiene verified');

  // ---------------------------------------------------------------- repo hygiene
  step(31, TOTAL, 'Repository hygiene — retired providers purged, Telnyx the only carrier');
  const skip = new Set(['node_modules', '.git', 'dist', 'data', '.cache', 'package-lock.json']);
  const scannable = (name) => /\.(js|jsx|mjs|json|md|css|html|txt|example)$/i.test(name) || name.startsWith('.env');
  const scan = (needle) => {
    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (scannable(entry.name)) {
          const body = fs.readFileSync(full, 'utf8');
          body.split('\n').forEach((line, i) => {
            if (needle.test(line)) found.push({ file: path.relative(REPO, full), line: i + 1 });
          });
        }
      }
    };
    walk(REPO);
    return found;
  };

  const legacyClientHits = scan(new RegExp('sone' + 'tel', 'i')).map((h) => `${h.file}:${h.line}`);
  assert.deepStrictEqual(legacyClientHits, [], `legacy provider still referenced in: ${legacyClientHits.join(', ')}`);
  const legacyModule = path.join(REPO, 'server', `sone${'tel'}.js`); // legacy 2-legged callback client
  assert.ok(!fs.existsSync(legacyModule), 'legacy telephony client module must be deleted');

  // The VOIP.SO cutover is complete when the retired carrier survives in exactly the places
  // that must still know about it: the migration that carries the data forward, and the tests
  // that prove the carry actually happens. Anywhere else — a service, a schema, the UI, the
  // docs — a leftover reference is a call that lands nowhere.
  const retiredAllowed = new Set([
    path.join('server', 'db', 'migrate.js'),          // the migration that reads the old keys
    path.join('test', 'helpers', 'legacy-db.js'),     // the fixture that recreates an old database
    'test/all-tests.js',                              // and the assertions about both
    path.join('test', 'unit', 'repositories.test.js'),
  ]);
  const retiredHits = scan(/voip\.so|voip\.ms|voipso/i)
    .filter((h) => !retiredAllowed.has(h.file))
    .map((h) => `${h.file}:${h.line}`);
  assert.deepStrictEqual(retiredHits, [], `retired carrier still referenced in: ${retiredHits.join(', ')}`);

  // …and the carrier that replaced it must actually be named where it matters, so this test
  // cannot pass by the whole app simply having gone quiet about telephony.
  for (const file of ['server/config/defaults.js', 'server/services/telephonyService.js', 'src/pages/Settings.jsx']) {
    const body = fs.readFileSync(path.join(REPO, file), 'utf8');
    assert.match(body, /telnyx/i, `${file} names the Telnyx carrier`);
  }
  ok('no retired provider survives outside the migration and its tests; Telnyx wired end to end');

  // ---------------------------------------------------------------- cross-site attack surface
  step(32, TOTAL, 'Cross-site attack surface — a website you visit cannot touch the dialer');
  const evil = 'https://evil.example.com';
  const localOrigin = BASE; // http://127.0.0.1:<port> — the app's own tab

  // A malicious page firing a request at http://localhost:3001 from its own origin.
  const evilWrite = await raw(`${BASE}/api/prospects/clear`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: evil }, body: '{}',
  });
  assert.strictEqual(evilWrite.status, 403, 'a cross-site write is refused');
  const evilRead = await raw(`${BASE}/api/prospects`, { headers: { Origin: evil } });
  assert.strictEqual(evilRead.status, 403, 'a cross-site read is refused');
  assert.strictEqual(evilRead.headers.get('access-control-allow-origin'), null, 'no CORS header for an unlisted origin');

  // The token must never be readable by that page.
  const evilSession = await raw(`${BASE}/api/session`, { headers: { Origin: evil } });
  assert.strictEqual(evilSession.status, 403, 'the session token is not handed to another origin');

  // DNS rebinding: evil.com resolves to 127.0.0.1, so Origin and Host look local to each other.
  const rebind = await raw(`${BASE}/api/prospects`, { headers: { Origin: 'http://evil.com:3001', Host: 'evil.com:3001' } });
  assert.strictEqual(rebind.status, 403, 'a rebound Host header is refused');

  // A real browser tab of the app itself: same origin, but it still needs the token to write.
  const noToken = await raw(`${BASE}/api/prospects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: localOrigin }, body: JSON.stringify({ name: 'Should Fail' }),
  });
  assert.strictEqual(noToken.status, 401, 'a same-origin write without a token is refused');

  const sessionRes = await req('GET', '/api/session');
  assert.strictEqual(sessionRes.status, 200);
  assert.match(sessionRes.json.token, /^[0-9a-f]{48}$/, 'session token is a 24-byte random hex');
  assert.strictEqual(sessionRes.json.tokenHeader, 'x-pulse-token');

  const withToken = await raw(`${BASE}/api/prospects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: localOrigin, 'x-pulse-token': sessionRes.json.token },
    body: JSON.stringify({ name: 'Trusted Browser Tab', phone: '20123456' }),
  });
  assert.strictEqual(withToken.status, 200, 'the real app, with its token, still works');
  const trustedId = (await withToken.json()).id;
  await raw(`${BASE}/api/prospects/${trustedId}`, {
    method: 'DELETE', headers: { Origin: localOrigin, 'x-pulse-token': sessionRes.json.token },
  });

  // A bad token must not be accepted.
  const badToken = await raw(`${BASE}/api/prospects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: localOrigin, 'x-pulse-token': 'deadbeef' },
    body: JSON.stringify({ name: 'Nope' }),
  });
  assert.strictEqual(badToken.status, 401, 'a forged token is refused');

  // The multi-select endpoints are writes like any other: a page the agent happens to visit
  // must not be able to wipe a selection, and the app's own tab still needs its token.
  const evilBulk = await raw(`${BASE}/api/prospects/bulk-delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: evil }, body: JSON.stringify({ ids: [testId] }),
  });
  assert.strictEqual(evilBulk.status, 403, 'a cross-site bulk delete is refused');
  const untokenedBulk = await raw(`${BASE}/api/prospects/bulk-stage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: localOrigin }, body: JSON.stringify({ ids: [testId], stage: 'lost' }),
  });
  assert.strictEqual(untokenedBulk.status, 401, 'a same-origin bulk stage move without the token is refused');
  const tokenedBulk = await raw(`${BASE}/api/prospects/bulk-stage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: localOrigin, 'x-pulse-token': sessionRes.json.token },
    body: JSON.stringify({ ids: [2147483000], stage: 'lost' }),
  });
  assert.strictEqual(tokenedBulk.status, 200, 'with the token, the real app can use it');
  assert.strictEqual((await tokenedBulk.json()).updated, 0, 'and a bulk action reports 0 rather than inventing a row');

  const stillThere = await req('GET', '/api/prospects');
  assert.ok(stillThere.json.some((p) => p.id === testId), 'the attack attempts destroyed nothing');
  ok('cross-site writes, reads, token theft and DNS rebinding all refused; the app\u2019s own tab still works');

  // ---------------------------------------------------------------- email
  step(33, TOTAL, 'Email — verification, attachments and SMTP guards');

  const st0 = await req('GET', '/api/email/status');
  assert.strictEqual(st0.status, 200);
  assert.strictEqual(st0.json.configured, false, 'SMTP starts unconfigured');
  assert.deepStrictEqual(st0.json.missing, ['host', 'user', 'pass']);

  // Verification is real: a throwaway inbox, a typo and a dead domain each get a verdict.
  const vThrow = await req('POST', '/api/email/verify', { email: 'lead@mailinator.com' });
  assert.strictEqual(vThrow.status, 200);
  assert.strictEqual(vThrow.json.level, 'invalid');
  assert.strictEqual(vThrow.json.checks.disposable, true);

  const vTypo = await req('POST', '/api/email/verify', { email: 'lead@gmial.com' });
  assert.strictEqual(vTypo.json.suggestion, 'lead@gmail.com', 'a typo gets a corrected address');

  const vGood = await req('POST', '/api/email/verify', { email: 'lead@gmail.com' });
  assert.strictEqual(vGood.json.level, 'valid');
  assert.strictEqual(vGood.json.suggestion, null, 'a known-good domain is never second-guessed');

  assert.strictEqual((await req('POST', '/api/email/verify', { email: 'nonsense' })).status, 400);

  const vBatch = await req('POST', '/api/email/verify-batch', {
    emails: ['a@gmail.com', 'b@mailinator.com', 'c@nodomain-zzz9.com'],
  });
  assert.strictEqual(vBatch.status, 200);
  assert.strictEqual(vBatch.json.checked, 3);
  assert.strictEqual(vBatch.json.summary.valid, 1);
  assert.strictEqual(vBatch.json.summary.invalid, 2);

  // Sending must fail cleanly while SMTP is unconfigured — never a 500, never a hang.
  const noSmtp = await req('POST', '/api/email/send', { to: 'lead@gmail.com', subject: 'Hej', body: 'Test' });
  assert.strictEqual(noSmtp.status, 400);
  assert.match(noSmtp.json.error, /SMTP is not configured/);

  // A dead recipient is refused even before SMTP is considered, unless explicitly forced.
  const deadTo = await req('POST', '/api/email/send', { to: 'x@nodomain-zzz9.com', subject: 'Hej', body: 'Test' });
  assert.strictEqual(deadTo.status, 400);
  assert.match(deadTo.json.error, /will not receive mail/);

  // Validation
  assert.strictEqual((await req('POST', '/api/email/send', { to: 'a@b.co', body: 'x' })).status, 400);
  assert.strictEqual((await req('POST', '/api/email/send', { to: 'nope', subject: 's', body: 'b' })).status, 400);
  assert.strictEqual((await req('POST', '/api/email/send', { to: 'a@b.co, nope', subject: 's', body: 'b' })).status, 400,
    'every address in a pasted list must be valid');
  assert.strictEqual((await req('POST', '/api/email/test', {})).status, 400);

  // Attachments: stage, list, drop, and a dropped id cannot be dropped twice.
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(2048)], { type: 'application/pdf' }), 'Tilbud.pdf');
  const up = await fetch(`${BASE}/api/email/attachments`, { method: 'POST', body: form });
  assert.strictEqual(up.status, 200);
  const upJson = await up.json();
  assert.strictEqual(upJson.filename, 'Tilbud.pdf');
  assert.strictEqual(upJson.bytes, 2048);

  const listed = await req('GET', '/api/email/attachments');
  assert.ok(listed.json.attachments.some((a) => a.id === upJson.id));
  assert.ok(listed.json.attachments[0].expiresInSeconds > 0, 'staged files advertise their expiry');
  assert.strictEqual((await req('DELETE', `/api/email/attachments/${upJson.id}`)).status, 200);
  assert.strictEqual((await req('DELETE', `/api/email/attachments/${upJson.id}`)).status, 404, 'an expired id is not reusable');
  assert.strictEqual((await req('DELETE', '/api/email/attachments/doesnotexist')).status, 404);

  // The draft endpoint fills the template and reports whether SMTP is ready.
  const mailProspect = await req('POST', '/api/prospects', { name: 'Email Test', email: 'lead@gmail.com', phone: '20999888' });
  const draft = await req('POST', `/api/email/prospects/${mailProspect.json.id}/draft`, {});
  assert.strictEqual(draft.status, 200);
  assert.strictEqual(draft.json.to, 'lead@gmail.com');
  assert.ok(draft.json.subject.length > 0);
  assert.strictEqual(draft.json.smtpConfigured, false);
  assert.strictEqual(draft.json.verification.level, 'valid');
  assert.strictEqual((await req('POST', '/api/email/prospects/99999999/draft', {})).status, 404);

  // The SMTP password must never leave the server in plaintext.
  await req('PUT', '/api/settings', {
    smtp_host: 'smtp.gmail.com', smtp_port: '587', smtp_user: 'agent@firma.dk',
    smtp_pass: 'app-password-12345', meet_link: 'https://meet.google.com/abc-defg-hij',
  });
  const pub = await req('GET', '/api/settings');
  assert.strictEqual(pub.json.smtp_pass, '', 'the SMTP password is masked');
  assert.strictEqual(pub.json.has_smtp_pass, true);
  assert.strictEqual(pub.json.meet_link, 'https://meet.google.com/abc-defg-hij');
  const st1 = await req('GET', '/api/email/status');
  assert.strictEqual(st1.json.configured, true, 'SMTP is configured once credentials exist');
  assert.strictEqual(st1.json.host, 'smtp.gmail.com');

  // The standing meeting link is injected once — not twice when the template already places it.
  const draftWithMeet = await req('POST', `/api/email/prospects/${mailProspect.json.id}/draft`, {});
  assert.strictEqual(draftWithMeet.status, 200);
  const meetOccurrences = draftWithMeet.json.body.split('https://meet.google.com/abc-defg-hij').length - 1;
  assert.strictEqual(meetOccurrences, 1, `the meet link appears exactly once (got ${meetOccurrences})`);
  assert.ok(draftWithMeet.json.placeholders.includes('meet_link'), 'meet_link is an advertised placeholder');
  assert.ok(draftWithMeet.json.placeholders.includes('agent_name'), 'agent_name is an advertised placeholder');

  // A custom template that places {{meet_link}} itself must still not duplicate it, and no
  // placeholder may survive into the body.
  await req('PUT', '/api/settings', {
    agent_name: 'Gagan',
    followup_email_template: 'Hej {{name}} fra {{company}} ({{title}})\nMøde: {{meet_link}}\n/ {{agent_name}}',
  });
  const custom = await req('POST', `/api/email/prospects/${mailProspect.json.id}/draft`, { noteText: 'Snakkede om priser' });
  assert.strictEqual(custom.status, 200);
  assert.ok(custom.json.body.includes('Gagan'), '{{agent_name}} is substituted end-to-end');
  assert.strictEqual(custom.json.body.split('https://meet.google.com/abc-defg-hij').length - 1, 1,
    'a template that places {{meet_link}} does not get a second copy appended');
  assert.ok(!/\{\{/.test(custom.json.body), 'no placeholder is left literal in the draft body');
  // Put the shipped template back — the settings PUT stores exactly what it is given, so a
  // null here would leave an empty template behind for every later group.
  await req('PUT', '/api/settings', {
    agent_name: '',
    followup_email_template: require('../server/config/defaults').DEFAULT_FOLLOWUP_EMAIL,
  });

  // A subject carrying CRLF is inert — it must not become a header. (send() refuses before
  // the network when SMTP is unconfigured, so the sanitizer is asserted directly here.)
  const headerProbe = require('../server/services/emailService');
  assert.strictEqual(headerProbe.sanitizeHeader('Hej\r\nBcc: attacker@evil.dk'), 'Hej Bcc: attacker@evil.dk',
    'CRLF in a header is neutralised, not executed');

  await req('DELETE', `/api/email/prospects/${mailProspect.json.id}/draft`, {});

  // ---- local catch-all mail sink ------------------------------------------------------
  // An EMPTY host must stay an error (asserted above, and it must stay that way). The sink is
  // the deliberate alternative: host "local" captures mail into the outbox instead of
  // transmitting it, which is what makes the compose → send → preview loop demonstrable with
  // no credentials and no network at all.
  const sinkOn = await req('PUT', '/api/settings', { smtp_host: 'local', smtp_port: '1025', smtp_user: 'agent@firma.dk' });
  assert.strictEqual(sinkOn.status, 200);
  const sinkStatus = await req('GET', '/api/email/status');
  assert.strictEqual(sinkStatus.json.configured, true, 'the sink is configured with no credentials at all');
  assert.strictEqual(sinkStatus.json.localSink, true, 'and it says which mode it is in');
  assert.deepStrictEqual(sinkStatus.json.missing, [], 'nothing is missing for the sink');
  assert.strictEqual(sinkStatus.json.outboxCount, 0, 'the outbox starts empty');

  const sinkTest = await req('POST', '/api/email/test', {});
  assert.strictEqual(sinkTest.status, 200);
  assert.strictEqual(sinkTest.json.host, 'local');
  assert.strictEqual(sinkTest.json.message, 'Local Outbox Sink ready');

  // A real message with a real attachment, linked to a real prospect.
  const sinkForm = new FormData();
  sinkForm.append('file', new Blob([Buffer.from('PDF-BYTES')], { type: 'application/pdf' }), 'Sink-Tilbud.pdf');
  const sinkUp = await fetch(`${BASE}/api/email/attachments`, { method: 'POST', body: sinkForm });
  const sinkUpJson = await sinkUp.json();

  const captured = await req('POST', '/api/email/send', {
    to: 'lead@gmail.com',
    subject: 'Sink capture {{name}}',
    body: 'Plain text body',
    html: '<h1>Rendered</h1>',
    attachments: [sinkUpJson.id],
    prospectId: mailProspect.json.id,
  });
  assert.strictEqual(captured.status, 200);
  assert.strictEqual(captured.json.local, true, 'a captured send reports itself as local');
  assert.match(captured.json.messageId, /^local-\d+-[0-9a-f]+@pulse\.dialer$/, 'the synthetic Message-ID is unmistakably local');
  assert.deepStrictEqual(captured.json.accepted, ['lead@gmail.com']);
  assert.deepStrictEqual(captured.json.rejected, []);
  assert.strictEqual(captured.json.loggedAsNote, true, 'a captured send still lands in the prospect history');

  const outboxList = await req('GET', '/api/email/outbox');
  assert.strictEqual(outboxList.status, 200);
  assert.strictEqual(outboxList.json.total, 1);
  const msg = outboxList.json.messages[0];
  assert.strictEqual(msg.subject, 'Sink capture {{name}}', 'the subject is stored verbatim, placeholders and all');
  assert.deepStrictEqual(msg.to, ['lead@gmail.com']);
  assert.strictEqual(msg.prospectId, mailProspect.json.id);
  assert.strictEqual(msg.prospectName, 'Email Test', 'the captured row links back to its prospect');
  assert.strictEqual(msg.isLocalSink, true);
  assert.strictEqual(msg.text, 'Plain text body');
  assert.strictEqual(msg.html, '<h1>Rendered</h1>');
  assert.strictEqual(msg.attachments.length, 1);
  assert.strictEqual(msg.attachments[0].filename, 'Sink-Tilbud.pdf');
  assert.strictEqual(msg.attachments[0].contentBase64, undefined, 'a listing carries metadata, not payloads');

  // The row is on disk, not just in the process that wrote it.
  const onDisk = new (require('better-sqlite3'))(path.join(tmpDir, 'dialer.db'), { readonly: true });
  const diskRow = onDisk.prepare('SELECT subject, html_body, attachments_json FROM outbox WHERE id = ?').get(msg.id);
  onDisk.close();
  assert.ok(diskRow, 'the captured message is persisted in SQLite');
  assert.strictEqual(diskRow.html_body, '<h1>Rendered</h1>');

  // The previewer's three panes, all served from that one row.
  const detail = await req('GET', `/api/email/outbox/${msg.id}`);
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.json.headers['Message-ID'], captured.json.messageId);
  assert.strictEqual(detail.json.headers.From, 'agent@firma.dk');
  assert.strictEqual(detail.json.headers.To, 'lead@gmail.com');
  assert.strictEqual(detail.json.headers['X-Pulse-Transport'], 'local-sink');
  assert.strictEqual(detail.json.attachments[0].stored, true, 'the detail view can download what the list only describes');
  assert.match(detail.json.attachments[0].contentBase64, /^[A-Za-z0-9+/=]+$/);

  const attDl = await fetch(`${BASE}/api/email/outbox/${msg.id}/attachments/0`);
  assert.strictEqual(attDl.status, 200);
  assert.strictEqual(await attDl.text(), 'PDF-BYTES', 'the stored attachment round-trips byte for byte');
  const attDl2 = await fetch(`${BASE}/api/email/outbox/${msg.id}/attachments/0?download=1`);
  assert.match(attDl2.headers.get('content-disposition') || '', /^attachment;/, '?download=1 forces a save');
  assert.strictEqual((await fetch(`${BASE}/api/email/outbox/${msg.id}/attachments/9`)).status, 404);
  assert.strictEqual((await req('GET', '/api/email/outbox/999999')).status, 404);

  // The activity ledger line is the same one a live send writes.
  const withNote = await req('GET', `/api/prospects/${mailProspect.json.id}`);
  assert.ok((withNote.json.notes || []).some((n) => /Sent email/.test(n.body) && /attachments: 1/.test(n.body)),
    'the captured send is logged in the prospect feed like any other');

  // Search covers the fields an agent remembers: subject, recipient, and attachment name.
  assert.strictEqual((await req('GET', '/api/email/outbox?q=Sink-Tilbud')).json.total, 1);
  assert.strictEqual((await req('GET', '/api/email/outbox?q=Sink%20capture')).json.total, 1);
  assert.strictEqual((await req('GET', '/api/email/outbox?q=nothing-matches-this')).json.total, 0);
  const paged = await req('GET', '/api/email/outbox?limit=1&offset=1');
  assert.strictEqual(paged.json.messages.length, 0, 'offset pages past the end without losing the total');
  assert.strictEqual(paged.json.total, 1);
  assert.strictEqual((await req('GET', '/api/email/outbox?limit=0')).status, 400, 'a nonsensical page size is refused');
  assert.strictEqual((await req('GET', '/api/email/outbox?limit=abc')).status, 400);

  // Pruning: one message, then the whole ledger. A gone id is a 404, not a silent success.
  const pruned = await req('DELETE', `/api/email/outbox/${msg.id}`);
  assert.strictEqual(pruned.status, 200);
  assert.strictEqual(pruned.json.deleted, 1);
  assert.strictEqual(pruned.json.total, 0);
  assert.strictEqual((await req('DELETE', `/api/email/outbox/${msg.id}`)).status, 404, 'deleting twice is not silently fine');

  await req('POST', '/api/email/send', { to: 'lead@gmail.com', subject: 'Second capture', body: 'x' });
  await req('POST', '/api/email/send', { to: 'lead@gmail.com', subject: 'Third capture', body: 'x' });
  const beforeClear = await req('GET', '/api/email/status');
  assert.strictEqual(beforeClear.json.outboxCount, 2, 'the status count tracks the ledger');
  const cleared = await req('DELETE', '/api/email/outbox');
  assert.strictEqual(cleared.status, 200);
  assert.strictEqual(cleared.json.deleted, 2);
  assert.strictEqual((await req('GET', '/api/email/outbox')).json.total, 0);

  // The sink must not have leaked into the *unconfigured* behaviour asserted at the top of
  // this group: clearing the host takes sending back to a 400.
  await req('PUT', '/api/settings', { smtp_host: '' });
  const afterSinkOff = await req('POST', '/api/email/send', { to: 'lead@gmail.com', subject: 'Hej', body: 'x' });
  assert.strictEqual(afterSinkOff.status, 400, 'turning the sink off restores "not configured"');
  assert.match(afterSinkOff.json.error, /SMTP is not configured/);

  await req('DELETE', `/api/prospects/${mailProspect.json.id}`);
  await req('PUT', '/api/settings', { smtp_host: '', smtp_user: '', smtp_from: '', meet_link: null });
  ok('verify/typo/throwaway/dead-domain verdicts, attachment lifecycle, SMTP guards and password masking all correct');

  // ---------------------------------------------------------------- data-integrity guards
  step(34, TOTAL, 'Un-diallable leads are refused, not silently stored');

  // A junk phone used to normalize to "" and be saved with a cheerful "Prospect added",
  // leaving leads that could never be dialled. It is a 400 now.
  for (const junk of ['+45 123', 'abcde', 'garbage!!', '123']) {
    const r = await req('POST', '/api/prospects', { name: 'Junk Phone', phone: junk });
    assert.strictEqual(r.status, 400, `"${junk}" must be refused, got ${r.status}`);
    assert.match(r.json.error, /not a diallable phone number/);
    assert.strictEqual(r.json.details[0].field, 'phone');
  }
  // A blank phone is legitimate — plenty of real leads have no number yet.
  const blank = await req('POST', '/api/prospects', { name: 'No Number Yet', phone: '' });
  assert.strictEqual(blank.status, 200, 'a blank phone is still allowed');
  assert.strictEqual(blank.json.phone, '');
  await req('DELETE', `/api/prospects/${blank.json.id}`);

  const goodPhone = await req('POST', '/api/prospects', { name: 'Good Phone', phone: '20123456' });
  assert.strictEqual(goodPhone.json.phone, '+4520123456');
  assert.strictEqual((await req('PATCH', `/api/prospects/${goodPhone.json.id}`, { phone: 'nonsense' })).status, 400,
    'a patch cannot degrade a good number into junk either');
  await req('DELETE', `/api/prospects/${goodPhone.json.id}`);

  // Imports must never lose a row to a typo: the row is kept and the bad number is counted.
  const mixed = await req('POST', '/api/prospects/bulk', {
    rows: [
      { Navn: 'Good Row', Telefon: '+45 31 55 66 77', Email: 'good@row.dk' },
      { Navn: 'Junk Row', Telefon: 'abcde', Email: 'junk@row.dk' },
      { Navn: 'Blank Row', Telefon: '', Email: 'blank@row.dk' },
      { Navn: 'Placeholder Row', Telefon: 'N/A', Email: 'ph@row.dk' },
    ],
    mapping: { name: 'Navn', phone: 'Telefon', email: 'Email' },
  });
  assert.strictEqual(mixed.status, 200);
  assert.strictEqual(mixed.json.added, 4, 'no row is dropped because of a bad phone');
  // 'abcde' is a broken number; 'N/A' is a placeholder that cleanStr maps to "no value",
  // so only the first is counted. Pinning this keeps the distinction deliberate.
  assert.strictEqual(mixed.json.badPhones, 1, 'exactly the unparseable number is counted');
  const afterMixed = await req('GET', '/api/prospects');
  const junkRow = afterMixed.json.find((p) => p.name === 'Junk Row');
  assert.ok(junkRow, 'the row with the bad number was still imported');
  assert.strictEqual(junkRow.phone, '', 'its phone is empty rather than a fake one');
  for (const p of afterMixed.json.filter((x) => ['Good Row', 'Junk Row', 'Blank Row', 'Placeholder Row'].includes(x.name))) {
    await req('DELETE', `/api/prospects/${p.id}`);
  }
  // Bulk actions are the same promise at scale: the prospects go, and their calls and notes go
  // with them in one transaction, while the count that comes back describes what really happened.
  const bulkA = await req('POST', '/api/prospects', { name: 'Bulk Cascade A', phone: '+4555990001' });
  const bulkB = await req('POST', '/api/prospects', { name: 'Bulk Cascade B', phone: '+4555990002' });
  await req('POST', `/api/prospects/${bulkA.json.id}/notes`, { body: 'note one' });
  await req('POST', `/api/prospects/${bulkA.json.id}/notes`, { body: 'note two' });
  await req('POST', `/api/prospects/${bulkA.json.id}/call`, {});
  const beforeBulk = await req('GET', `/api/prospects/${bulkA.json.id}`);
  assert.strictEqual(beforeBulk.json.notes.length, 2, 'two notes are attached before the bulk delete');
  assert.strictEqual(beforeBulk.json.calls.length, 1, 'and one call record');

  const stageAll = await req('POST', '/api/prospects/bulk-stage', { ids: [bulkA.json.id, bulkB.json.id], stage: 'interested' });
  assert.strictEqual(stageAll.status, 200);
  assert.strictEqual(stageAll.json.updated, 2, 'both selected prospects moved');
  assert.strictEqual(stageAll.json.stage, 'interested');
  assert.strictEqual((await req('GET', `/api/prospects/${bulkB.json.id}`)).json.stage, 'interested', 'the change is on the record, not just in the reply');

  // Every way a bulk write can be nonsense has to bounce before anything is touched.
  assert.strictEqual((await req('POST', '/api/prospects/bulk-stage', { ids: [bulkA.json.id], stage: 'meeting_booked' })).status, 400, 'an unknown stage is refused');
  assert.strictEqual((await req('POST', '/api/prospects/bulk-stage', { ids: [], stage: 'interested' })).status, 400, 'an empty selection is refused');
  assert.strictEqual((await req('POST', '/api/prospects/bulk-delete', { ids: ['junk', -5, 0] })).status, 400, 'junk ids are refused');
  const stillBoth = await req('GET', `/api/prospects/${bulkA.json.id}`);
  assert.strictEqual(stillBoth.status, 200, 'and a refused bulk action deleted nothing');

  const bulkDel = await req('POST', '/api/prospects/bulk-delete', { ids: [bulkA.json.id, bulkB.json.id] });
  assert.strictEqual(bulkDel.status, 200);
  assert.strictEqual(bulkDel.json.deleted, 2, 'both prospects are gone');
  assert.strictEqual(bulkDel.json.calls, 1, 'the call record went with its prospect');
  assert.strictEqual(bulkDel.json.notes, 2, 'and both notes');
  assert.strictEqual(bulkDel.json.requested, 2, 'the reply reports what was asked for as well');
  assert.strictEqual((await req('GET', `/api/prospects/${bulkA.json.id}`)).status, 404, 'the detail endpoint agrees');
  // Nothing may be left pointing at a row that no longer exists.
  const orphanCheck = await req('GET', '/api/prospects/search?q=Bulk%20Cascade&limit=10');
  assert.strictEqual(orphanCheck.json.length, 0, 'no orphan row is left behind by the search either');
  ok('junk phones rejected on create/patch; imports keep the row and report badPhones; bulk stage and bulk delete stay atomic');

  // ---------------------------------------------------------------- Danish cost ranges
  step(35, TOTAL, 'Premium / shared-cost / freephone numbers are flagged before dialing');

  const costCases = [
    ['+4590123456', 'premium', true],
    ['+4570123456', 'shared_cost', true],
    ['+4580123456', 'freephone', false],
  ];
  for (const [phone, kind, expensive] of costCases) {
    const p = await req('POST', '/api/prospects', { name: `Cost ${kind}`, phone });
    assert.strictEqual(p.status, 200);
    assert.ok(p.json.number_kind, `number_kind present for ${phone}`);
    assert.strictEqual(p.json.number_kind.kind, kind);
    assert.strictEqual(p.json.number_kind.expensive, expensive);
    assert.ok(p.json.number_kind.note.length > 10, 'a human explanation is attached');
    await req('DELETE', `/api/prospects/${p.json.id}`);
  }

  // Ordinary Danish mobiles and foreign numbers must NOT be flagged — a false alarm on every
  // call would teach the agent to click through the warning without reading it.
  for (const phone of ['+4520123456', '+4531123456', '+447911123456', '+4915123456789']) {
    const p = await req('POST', '/api/prospects', { name: `Plain ${phone}`, phone });
    assert.strictEqual(p.json.number_kind, null, `${phone} must not be flagged`);
    await req('DELETE', `/api/prospects/${p.json.id}`);
  }

  // The flag must reach every surface the dialer reads, not just the create response.
  const prem = await req('POST', '/api/prospects', { name: 'Premium Pia', phone: '+4590123456' });
  assert.strictEqual((await req('GET', `/api/prospects/${prem.json.id}`)).json.number_kind.kind, 'premium', 'detail');
  const q = await req('GET', '/api/queue?tab=all');
  const qRow = q.json.rows.find((r) => r.id === prem.json.id);
  assert.ok(qRow && qRow.number_kind && qRow.number_kind.kind === 'premium', 'queue row');
  const dial = await req('POST', `/api/prospects/${prem.json.id}/call`, {});
  assert.strictEqual(dial.json.numberKind.kind, 'premium', 'dial response');
  assert.match(dial.json.numberKind.note, /premium-rate/i);
  await req('DELETE', `/api/prospects/${prem.json.id}`);
  ok('70/80/90 ranges flagged on list, detail, queue and dial; ordinary numbers left alone');

  // ---------------------------------------------------------------- duplicate detection
  step(36, TOTAL, 'Duplicates are caught by email as well as phone');

  const dedupe = await req('POST', '/api/prospects/bulk', {
    rows: [
      // Numbers here must not collide with +4520123456, which the suite's main prospect
      // already owns — otherwise the first row is deduped by phone before email is tested.
      { Navn: 'Mette Jensen', Telefon: '+4561220011', Email: 'mette@firma.dk' },
      { Navn: 'Mette Jensen (mobil)', Telefon: '+4561220022', Email: 'mette@firma.dk' },  // same email, new phone
      { Navn: 'Mette J', Telefon: '+4561220011', Email: 'mette.j@andet.dk' },             // same phone, new email
      { Navn: 'Anders Hansen', Telefon: '+4561220033', Email: 'anders@firma.dk' },        // genuinely new
      { Navn: 'Anders H kopi', Telefon: '+4561220044', Email: 'anders@firma.dk' },        // dup of the row above
    ],
    mapping: { name: 'Navn', phone: 'Telefon', email: 'Email' },
  });
  assert.strictEqual(dedupe.status, 200);
  assert.strictEqual(dedupe.json.added, 2, 'exactly the two genuinely new people are added');
  assert.strictEqual(dedupe.json.dupes, 3, 'email-only and phone-only matches both count');

  // Never list every prospect here: the 50k-row scale group leaves its rows behind, so
  // GET /api/prospects is a 16 MB payload and diffing it against two names OOMs the run.
  // Search for the exact people this group created instead.
  const mette = await req('GET', '/api/prospects/search?q=mette%40firma.dk&limit=10');
  const anders = await req('GET', '/api/prospects/search?q=anders%40firma.dk&limit=10');
  assert.strictEqual(mette.json.length, 1, 'exactly one Mette survives (email deduped)');
  assert.strictEqual(anders.json.length, 1, 'exactly one Anders survives (email deduped)');
  assert.strictEqual(mette.json[0].name, 'Mette Jensen', 'the first occurrence won');

  // Case and surrounding whitespace must not defeat the match.
  const caseDedupe = await req('POST', '/api/prospects/bulk', {
    rows: [{ Navn: 'Case Test', Telefon: '+4561220055', Email: '  METTE@Firma.dk  ' }],
    mapping: { name: 'Navn', phone: 'Telefon', email: 'Email' },
  });
  assert.strictEqual(caseDedupe.json.dupes, 1, 'email matching is case- and whitespace-insensitive');

  // A Danish list, with the header row exactly as a Danish CRM exports it. The mapping names
  // the columns (that is what the import page now guesses) and the notes column has to arrive
  // as each prospect's first note rather than being filed away as "more details".
  const danish = await req('POST', '/api/prospects/bulk', {
    rows: [
      { Navn: 'Freja Nielsen', Telefon: '+45 30 44 55 66', 'E-mail': 'freja@nordisk.dk', Firma: 'Nordisk A/S', Stilling: 'Indkøbschef', Postnr: '2100', Noter: 'Mødt på messe i Herning' },
      { Navn: 'Søren Bak', Mobil: '+45 30 44 55 67', 'E-mail': 'soeren@bak.dk', Firma: 'Bak & Søn', Stilling: 'Direktør', Postnr: '8000', Noter: 'Henvist af Sofie' },
    ],
    mapping: { name: 'Navn', phone: 'Telefon', email: 'E-mail', company: 'Firma', title: 'Stilling', location: 'Postnr', notes: 'Noter' },
  });
  assert.strictEqual(danish.status, 200);
  // The second row's number is under "Mobil", which this mapping does not name — the row must
  // still arrive (it has a company), and the unmapped column must survive as extra detail.
  assert.strictEqual(danish.json.added, 2, 'both Danish rows are imported');
  assert.strictEqual(danish.json.notesCreated, 2, 'and both notes ride along with them');

  const frejaRow = (await req('GET', '/api/prospects/search?q=Freja%20Nielsen&limit=5')).json[0];
  const soerenRow = (await req('GET', '/api/prospects/search?q=S%C3%B8ren%20Bak&limit=5')).json[0];
  assert.ok(frejaRow && soerenRow, 'both Danes are searchable by name');
  const frejaDetail = await req('GET', `/api/prospects/${frejaRow.id}`);
  assert.strictEqual(frejaDetail.json.company, 'Nordisk A/S', 'the Danish company column is a real field');
  assert.strictEqual(frejaDetail.json.title, 'Indkøbschef', 'and so is the title');
  assert.strictEqual(frejaDetail.json.notes.length, 1, 'the notes column became exactly one note');
  assert.strictEqual(frejaDetail.json.notes[0].body, 'Mødt på messe i Herning', 'with its Danish text intact');
  assert.ok(!('Noter' in frejaDetail.json.extra), 'and it is not duplicated into the extra details');
  assert.strictEqual(soerenRow.phone, '', 'an unmapped "Mobil" column leaves the phone empty rather than wrong');
  const soerenDetail = await req('GET', `/api/prospects/${soerenRow.id}`);
  assert.strictEqual(soerenDetail.json.extra.Mobil, '+45 30 44 55 67', 'but the column is kept as extra detail');

  // Files come as UTF-8 (web exports) and as cp1252 (Danish Excel). Both must read as Danish
  // rather than as mojibake — "Mødt" turning into "MÃ¸dt" is data loss that looks like a typo.
  const parseUpload = async (buf, name) => {
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'text/csv' }), name);
    const res = await fetch(`${BASE}/api/import/parse`, { method: 'POST', body: form });
    return { status: res.status, json: await res.json() };
  };
  const utf8File = await parseUpload(Buffer.from('Navn,Telefon,Noter\nFreja Nielsen,+4530445566,Mødt på messe i Herning\n', 'utf8'), 'kunder-utf8.csv');
  assert.strictEqual(utf8File.status, 200, 'a UTF-8 csv parses');
  assert.strictEqual(utf8File.json.rows[0].Noter, 'Mødt på messe i Herning', 'æøå survive a UTF-8 file');
  const legacyFile = await parseUpload(Buffer.from('Navn,Telefon,Noter\nSøren Bak,+4530445567,Henvist af Sofie\n', 'latin1'), 'kunder-cp1252.csv');
  assert.strictEqual(legacyFile.json.rows[0].Noter, 'Henvist af Sofie', 'and so do they in a genuine cp1252 export');
  const asciiFile = await parseUpload(Buffer.from('Navn,Telefon\nPeter Holm,+4530445568\n', 'utf8'), 'kunder-ascii.csv');
  assert.strictEqual(asciiFile.json.rows[0].Navn, 'Peter Holm', 'plain ASCII files are unaffected');

  for (const row of [frejaRow, soerenRow]) await req('DELETE', `/api/prospects/${row.id}`);

  // Only delete what this group created. The 50k-row scale group runs earlier and leaves its
  // rows behind, so looping over every prospect here means 50,000 sequential DELETEs.
  for (const p of [...mette.json, ...anders.json]) await req('DELETE', `/api/prospects/${p.id}`);
  ok('email + phone duplicate detection, including within a single file and across case; Danish headers, notes and file encoding all survive the import');

  // ---------------------------------------------------------------- inbound calls
  step(37, TOTAL, 'Inbound calls — the phone rings in the browser, the ledger stays honest');

  // The outbound half must be untouched by the new column: a dial is still a dial.
  const outbound = await req('POST', `/api/prospects/${testId}/call`, {});
  assert.strictEqual(outbound.status, 200);
  assert.strictEqual(outbound.json.direction, undefined, 'the outbound dial contract is unchanged');
  const outboundRow = (await req('GET', `/api/prospects/${testId}`)).json.calls
    .find((c) => c.id === outbound.json.callId);
  assert.strictEqual(outboundRow.direction, 'outbound', 'an outbound dial is recorded as outbound');
  await req('POST', `/api/calls/${outbound.json.callId}/discard`, {});

  // A known customer calls back. The server must find them by number alone — the agent is
  // holding a phone, not a search box.
  const statsBefore = (await req('GET', '/api/stats')).json.today;
  const ring = await req('POST', '/api/calls/inbound', { callerPhone: E164 });
  assert.strictEqual(ring.status, 200);
  assert.strictEqual(ring.json.reused, false);
  assert.strictEqual(ring.json.direction, 'inbound');
  assert.strictEqual(ring.json.callerId, E164, 'the caller ID is normalised to the stored form');
  assert.strictEqual(ring.json.matched, true, 'the caller is matched to the prospect on file');
  assert.strictEqual(ring.json.provisional, false);
  assert.strictEqual(ring.json.prospect.id, testId, 'and the modal gets that prospect');
  assert.strictEqual(ring.json.call.status, 'ringing', 'the ledger row is open until the ring resolves');
  ok('inbound, matched by caller ID: one open ledger row and the prospect the agent is about to greet');

  // A forked INVITE / a retried socket is the *same* ring, not a second caller.
  const retry = await req('POST', '/api/calls/inbound', { callerPhone: E164 });
  assert.strictEqual(retry.json.reused, true, 'a duplicate INVITE reuses the ringing row');
  assert.strictEqual(retry.json.callId, ring.json.callId);
  const afterRetry = (await req('GET', `/api/prospects/${testId}`)).json.calls
    .filter((c) => c.direction === 'inbound');
  assert.strictEqual(afterRetry.length, 1, 'no second inbound row was written for the same ring');
  ok('a repeated INVITE inside the window is the same ring — reused, never double-logged');

  // A complete stranger. Nobody on file, so a placeholder lead exists for the length of the
  // ring — and answering is what turns it into a real record.
  const stranger = '+4599000011';
  const unknown = await req('POST', '/api/calls/inbound', { callerPhone: stranger });
  assert.strictEqual(unknown.json.matched, false);
  assert.strictEqual(unknown.json.provisional, true, 'an unknown caller is provisioned, not dropped');
  assert.strictEqual(unknown.json.prospect.phone, stranger);
  assert.strictEqual(unknown.json.prospect.stage, 'new');
  ok('an unknown caller becomes a placeholder lead the agent can answer instead of retyping');

  // The caller hangs up before anyone picks up: the ring closes, and the placeholder goes with
  // it — nothing about that person is kept, because there is nothing about that person to keep.
  const swept = await req('POST', `/api/calls/${unknown.json.callId}/missed`, { reason: 'missed' });
  assert.strictEqual(swept.status, 200);
  assert.strictEqual(swept.json.alreadyResolved, false);
  assert.strictEqual(swept.json.status, 'missed');
  assert.strictEqual(swept.json.cleanedUp, true, 'the placeholder lead is swept with the ring');
  const sweptLead = await req('GET', `/api/prospects/search?q=${encodeURIComponent(stranger)}&limit=5`);
  assert.strictEqual(sweptLead.json.length, 0, 'a missed call from a stranger leaves no ghost lead behind');
  ok('a missed call from a stranger is closed and its placeholder swept — no ghost leads');

  // Lost call, declined on purpose: same row, different terminal state.
  const declined = await req('POST', `/api/calls/${ring.json.callId}/missed`, { reason: 'declined' });
  assert.strictEqual(declined.json.status, 'declined', 'a declined ring is a decline, not a miss');
  assert.strictEqual(declined.json.cleanedUp, false, 'a real prospect is never swept');

  // CANCEL and the Decline button can both land; the second one must be a no-op, and a replay
  // after the row is gone must not 404 a UI that is already tearing the call down.
  const replay = await req('POST', `/api/calls/${ring.json.callId}/missed`, { reason: 'missed' });
  assert.strictEqual(replay.status, 200);
  assert.strictEqual(replay.json.alreadyResolved, true, 'replaying the teardown is idempotent');
  assert.strictEqual(replay.json.status, undefined, 'and it does not rewrite the settled row');
  const ghostReplay = await req('POST', `/api/calls/${unknown.json.callId}/missed`, { reason: 'missed' });
  assert.strictEqual(ghostReplay.status, 200, 'the replay of a swept row is not a 404');
  assert.strictEqual(ghostReplay.json.missing, true);
  // A numeric id with no row is indistinguishable from a ring that was already swept — both
  // resolve quietly. A malformed id is a client bug and gets the 404 it deserves.
  const unknownId = await req('POST', '/api/calls/99999999/missed', { reason: 'missed' });
  assert.strictEqual(unknownId.status, 200, 'a call id with no row resolves as already handled');
  assert.strictEqual(unknownId.json.missing, true);
  const badId = await req('POST', '/api/calls/not-a-number/missed', { reason: 'missed' });
  assert.strictEqual(badId.status, 404, 'a malformed call id never mutates anything');
  ok('the teardown is idempotent for a CANCEL/Decline race, and a swept row never 404s the UI');

  // A ring that nobody answered is not a dial and not a conversation. The daily numbers are
  // the manager's view of the floor; an inbound miss must not inflate them.
  const statsAfter = (await req('GET', '/api/stats')).json.today;
  assert.strictEqual(statsAfter.dials, statsBefore.dials, 'an unanswered inbound ring is not a dial');
  assert.strictEqual(statsAfter.pickups, statsBefore.pickups, 'and it is not a pickup');
  assert.strictEqual(statsAfter.conversations, statsBefore.conversations, 'and it is not a conversation');
  ok('unanswered inbound rings stay out of the daily dials/pickups/conversations');

  // Garbage in, 400 out — and the mutation surface needs the session token like every other
  // write (the browser can be tricked into ringing a stranger's number otherwise).
  const noNumber = await req('POST', '/api/calls/inbound', { callerPhone: '   ' });
  assert.strictEqual(noNumber.status, 400, 'a ring with no caller number is refused');
  assert.match(noNumber.text, /caller number is required/i);
  const junkNumber = await req('POST', '/api/calls/inbound', { callerPhone: '++--??' });
  assert.strictEqual(junkNumber.status, 400, 'an unusable caller number is refused');
  const notInbound = await req('POST', `/api/calls/${(await req('POST', `/api/prospects/${testId}/call`, {})).json.callId}/missed`, { reason: 'missed' });
  assert.strictEqual(notInbound.status, 400, 'only an inbound ring can be missed');
  const sessionToken = (await req('GET', '/api/session')).json.token;
  const untokened = await raw(`${BASE}/api/calls/inbound`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ callerPhone: E164 }),
  });
  assert.strictEqual(untokened.status, 401, 'the inbound endpoint demands the session token');
  const tokenedRing = await raw(`${BASE}/api/calls/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE, 'x-pulse-token': sessionToken },
    body: JSON.stringify({ callerPhone: E164 }),
  });
  assert.strictEqual(tokenedRing.status, 200, 'and accepts the same ring with it');
  const lastRing = await tokenedRing.json();
  const evilRing = await raw(`${BASE}/api/calls/inbound`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' }, body: JSON.stringify({ callerPhone: E164 }),
  });
  assert.strictEqual(evilRing.status, 403, 'another origin cannot ring this phone');
  assert.ok(!/password|token/i.test(JSON.stringify(lastRing)), 'the ring response carries no credentials');
  await req('POST', `/api/calls/${lastRing.callId}/missed`, { reason: 'missed' });
  ok('inbound validates its input, requires the token, refuses other origins and leaks nothing');

  // ---------------------------------------------------------------- enriched lead sheets
  step(38, TOTAL, 'Enriched lead sheets — registry columns, notes and no silent data loss');

  // A sheet of the shape this feature exists for: Danish headers, an owner column, marketing
  // notes, and a pile of registry metadata (CVR, protection, provenance links). The mapping is
  // the one the header matcher produces — posted explicitly so this group tests the server half
  // of the contract (the matcher itself is pinned in test/unit/import-map.test.js).
  const enrichedRows = [
    {
      'Owner Name(s)': 'Bent Kristensen', 'Company Name': 'Kristensen Tag & Facade',
      'Category': 'Tagdækker', 'Phone': '20770011', 'E-mail': 'bent@kristensen-tag.dk',
      'Marketing Notes': 'Ringe tilbage efter 15 — er på taget om formiddagen', 'Website': 'https://kristensen-tag.dk',
      'Location': 'Roskilde', 'CVR': '41234567', 'CVR Advertising Protection': 'Ja',
      'Current CVR Status': 'Aktiv', 'Owner Source URL(s)': 'https://www.proff.dk/firma/kristensen-tag/41234567',
      'Phone Source URL(s)': 'https://www.krak.dk/kristensen-tag', 'Marketing Outreach Flag': 'Ja',
    },
    {
      'Owner Name(s)': 'Lone Bertelsen', 'Company Name': 'Bertelsen VVS',
      'Category': 'VVS-montør', 'Phone': '20770012', 'E-mail': 'lone@bertelsen-vvs.dk',
      'Marketing Notes': '', 'Website': '', 'Location': 'Køge', 'CVR': '41234568',
      'CVR Advertising Protection': 'Nej', 'Current CVR Status': 'Aktiv',
      'Owner Source URL(s)': '', 'Phone Source URL(s)': '', 'Marketing Outreach Flag': '',
    },
  ];
  const enrichedMapping = {
    name: 'Owner Name(s)', company: 'Company Name', title: 'Category', phone: 'Phone',
    email: 'E-mail', notes: 'Marketing Notes', website: 'Website', location: 'Location',
  };
  const enrichedImport = await req('POST', '/api/prospects/bulk', { rows: enrichedRows, mapping: enrichedMapping, skipDuplicates: true });
  assert.strictEqual(enrichedImport.status, 200);
  assert.strictEqual(enrichedImport.json.added, 2, 'both enriched rows import');
  assert.strictEqual(enrichedImport.json.noted, 1, 'exactly the row that carried notes got a note (the blank one did not)');
  ok('an enriched sheet imports and the notes column is reported as attached');

  const found = await req('GET', '/api/prospects/search?q=bent%40kristensen-tag.dk&limit=3');
  assert.strictEqual(found.json.length, 1);
  const bent = await req('GET', `/api/prospects/${found.json[0].id}`);
  assert.strictEqual(bent.json.name, 'Bent Kristensen', 'the owner column became the name');
  assert.strictEqual(bent.json.company, 'Kristensen Tag & Facade');
  assert.strictEqual(bent.json.title, 'Tagdækker', 'the trade/category column became the job title');
  assert.strictEqual(bent.json.location, 'Roskilde');
  assert.strictEqual(bent.json.website, 'https://kristensen-tag.dk', 'the real website column is the website');
  ok('name, company, trade, city and website all land in their proper fields');

  // Nothing from the sheet may be silently dropped: every unmapped column is in `extra`.
  const sheetExtra = bent.json.extra || {};
  assert.strictEqual(sheetExtra.CVR, '41234567', 'the CVR number is kept verbatim');
  assert.strictEqual(sheetExtra['CVR Advertising Protection'], 'Ja');
  assert.strictEqual(sheetExtra['Current CVR Status'], 'Aktiv');
  assert.strictEqual(sheetExtra['Owner Source URL(s)'], 'https://www.proff.dk/firma/kristensen-tag/41234567');
  assert.strictEqual(sheetExtra['Phone Source URL(s)'], 'https://www.krak.dk/kristensen-tag');
  assert.strictEqual(sheetExtra['Marketing Outreach Flag'], 'Ja');
  assert.strictEqual(sheetExtra['Marketing Notes'], undefined, 'the notes column is not duplicated into the metadata blob');
  assert.strictEqual(sheetExtra.Website, undefined, 'and neither is a mapped contact field');
  assert.strictEqual(sheetExtra['E-mail'], undefined);
  ok('every registry column round-trips into the prospect metadata, and mapped fields are not duplicated');

  // The notes column is prospecting history and has to be readable on the call.
  assert.strictEqual(bent.json.notes.length, 1, 'the marketing note arrived in the activity feed');
  assert.match(bent.json.notes[0].body, /Ringe tilbage efter 15/, 'verbatim, not summarised or truncated');
  const lone = await req('GET', '/api/prospects/search?q=lone%40bertelsen-vvs.dk&limit=3');
  const loneDetail = await req('GET', `/api/prospects/${lone.json[0].id}`);
  assert.strictEqual(loneDetail.json.notes.length, 0, 'an empty notes cell creates no empty note');
  assert.strictEqual(loneDetail.json.extra['CVR'], '41234568');
  assert.strictEqual(loneDetail.json.extra['CVR Advertising Protection'], 'Nej', 'a "Nej" is stored so the cockpit can say so');
  ok('notes land in the feed, empty note cells are skipped, and a "Nej" flag is preserved');

  // A note that would break the notes API must not break the import.
  const longNote = 'A'.repeat(25000);
  const clipped = await req('POST', '/api/prospects/bulk', {
    rows: [{ Navn: 'Note Grænse', Telefon: '20770013', 'Marketing Notes': longNote }],
    mapping: { name: 'Navn', phone: 'Telefon', notes: 'Marketing Notes' },
    skipDuplicates: true,
  });
  assert.strictEqual(clipped.status, 200, 'an over-long note does not fail the import');
  assert.strictEqual(clipped.json.added, 1);
  const clippedHit = await req('GET', '/api/prospects/search?q=Note%20Gr%C3%A6nse&limit=3');
  const clippedRow = await req('GET', `/api/prospects/${clippedHit.json[0].id}`);
  assert.ok(clippedRow.json.notes[0].body.length <= 20000, `the note was clipped to what the API allows (${clippedRow.json.notes[0].body.length})`);
  ok('an over-long note is clipped to the note API’s own limit instead of failing the whole import');

  // Same file twice: the second run must not create a duplicate, and must not double the notes.
  const reimport = await req('POST', '/api/prospects/bulk', { rows: enrichedRows, mapping: enrichedMapping, skipDuplicates: true });
  assert.strictEqual(reimport.json.added, 0, 're-importing the same sheet adds nobody');
  assert.strictEqual(reimport.json.dupes, 2, 'both rows are recognised as duplicates');
  const afterRepeat = await req('GET', `/api/prospects/${found.json[0].id}`);
  assert.strictEqual(afterRepeat.json.notes.length, 1, 'and the note was not attached a second time');
  ok('re-importing the same sheet is a no-op for both prospects and notes');

  // A sheet with no phone at all still imports (the matcher returns what it finds), and a sheet
  // where every row is a joker is rejected by the row-level guards rather than stored as junk.
  const junkRows = await req('POST', '/api/prospects/bulk', {
    rows: [{ Navn: 'Total', Telefon: '' }, { Navn: '', Telefon: '' }],
    mapping: { name: 'Navn', phone: 'Telefon' },
    skipDuplicates: true,
  });
  assert.strictEqual(junkRows.json.added, 0, 'header rows and blank rows are counted as empty, not imported');
  assert.ok(junkRows.json.empty >= 2, `both junk rows are ignored (${junkRows.json.empty})`);
  ok('header rows and blank rows are counted, never imported as prospects');

  for (const p of [found.json[0], lone.json[0], clippedHit.json[0]]) await req('DELETE', `/api/prospects/${p.id}`);
  ok('enriched fixtures cleaned up');

  await req('DELETE', `/api/prospects/${testId}`);
  console.log('\n  \u2713 test fixtures cleaned up');

  console.log('\n========================================');
  console.log(`\uD83C\uDF89 ALL ${TOTAL} TEST GROUPS PASSED (${passed} checks, 0 failures)`);
  console.log('========================================');
}

run()
  .catch((e) => {
    console.error('\n\u274C Test failed:', e && e.message ? e.message : e);
    process.exitCode = 1;
  })
  .finally(shutdown);
