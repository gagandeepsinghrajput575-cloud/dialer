// Unit layer: repositories, migrations, backups and the pure service helpers.
// Runs in-process against a throwaway database (DATA_DIR must point at a temp folder).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-unit-'));
process.env.DATA_DIR = tmp;

const { db } = require('../../server/db');
const migrate = require('../../server/db/migrate');
const backup = require('../../server/db/backup');
const settings = require('../../server/repositories/settingsRepo');
const prospects = require('../../server/repositories/prospectRepo');
const calls = require('../../server/repositories/callRepo');
const notes = require('../../server/repositories/noteRepo');
const telephony = require('../../server/services/telephonyService');
const copilot = require('../../server/services/copilotService');
const callService = require('../../server/services/callService');
const { DEFAULTS, SETTING_KEYS } = require('../../server/config/defaults');

let passed = 0;
const ok = (msg) => { passed++; console.log(`    \u2713 ${msg}`); };

async function run() {
  console.log('  [unit] repositories, migrations, backups and service helpers');
  assert.ok(process.env.DATA_DIR && process.env.DATA_DIR !== path.join(__dirname, '..', '..', 'data'),
    'unit tests must run against a throwaway DATA_DIR');

  // ---- migrations ----
  const first = migrate.run();
  assert.strictEqual(first.applied.length, migrate.MIGRATIONS.length, 'fresh database applies every migration');
  const second = migrate.run();
  assert.strictEqual(second.applied.length, 0, 'migrations are idempotent');
  const ledger = db.prepare('SELECT version, name FROM _migrations ORDER BY version').all();
  assert.strictEqual(ledger.length, migrate.MIGRATIONS.length);
  assert.strictEqual(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.strictEqual(db.pragma('busy_timeout', { simple: true }), 5000);
  const cols = db.prepare('PRAGMA table_info(calls)').all().map((c) => c.name);
  for (const expected of ['dial_uri', 'caller_id', 'vm_dropped', 'summary', 'next_step', 'follow_up_at']) {
    assert.ok(cols.includes(expected), `calls.${expected} exists`);
  }
  ok(`${migrate.MIGRATIONS.length} migrations applied once, ledger has ${ledger.length} rows, WAL + busy_timeout on`);

  // ---- settings repo ----
  assert.strictEqual(Object.keys(DEFAULTS).length, SETTING_KEYS.length);
  assert.strictEqual(settings.get('default_country_code'), '45');
  assert.strictEqual(settings.get('telnyx_sip_server'), 'sip.telnyx.com');
  settings.set('telnyx_sip_password', 's3cret');
  settings.set('telnyx_api_key', 'KEY0123456789');
  settings.set('ai_api_key', 'ai-secret');
  const view = settings.publicView();
  assert.strictEqual(view.telnyx_sip_password, '', 'the SIP secret is masked in the public view');
  assert.strictEqual(view.telnyx_api_key, '', 'the Telnyx API key is masked too');
  assert.strictEqual(view.ai_api_key, '', 'and so is the AI key');
  assert.strictEqual(view.has_password, true);
  assert.strictEqual(view.has_api_key, true, 'has_api_key answers for the Telnyx key');
  assert.strictEqual(view.has_ai_key, true, 'the AI key has its own flag, so the two cannot be confused');
  assert.notStrictEqual(view.has_api_key, view.has_ai_key === false, 'the flags are independent');
  // unknown keys are purged so retired settings never linger
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('retired_key', 'x');
  migrate.purgeUnknownSettings();
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM settings WHERE key = 'retired_key'").get().c, 0);
  ok('settings defaults, secret masking and unknown-key purge all behave');

  // ---- migration 7: the VOIP.SO -> Telnyx cutover ----
  // The end-to-end upgrade is covered by the integration suite booting a legacy database. What
  // is only testable here is how the migration treats the three awkward cases: a host the
  // agent chose deliberately, a key that is already set, and running it twice.
  assert.ok(migrate.MIGRATIONS.some((m) => m.version === 7 && m.name === 'telnyx-telephony-migration'),
    'migration 7 is registered under its documented name');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM _migrations WHERE version = 7').get().c, 1,
    'and the ledger records that it ran');
  const rawPut = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);
  const rawGet = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;

  // Start from the state a pre-cutover database is in: the telnyx_* keys do not exist yet.
  // (The earlier masking test wrote some, and carrying a value over must never overwrite one
  // that is already there — that is the guard being exercised two paragraphs down.)
  settings.set('telnyx_sip_server', '');
  settings.set('telnyx_sip_user', '');
  settings.set('telnyx_sip_password', '');

  // A host the agent chose deliberately is carried across; the retired vendor default is not.
  rawPut('voipso_sip_server', 'pbx.kundens-eget.dk');
  rawPut('voipso_sip_user', 'weird-extension');
  rawPut('voipso_sip_password', 'legacy-pass');
  migrate.migrateTelephonyToTelnyx(db);
  assert.strictEqual(settings.get('telnyx_sip_server'), 'pbx.kundens-eget.dk', 'a custom SIP host survives the cutover');
  assert.strictEqual(settings.get('telnyx_sip_user'), 'weird-extension', 'the SIP username is carried across');
  assert.strictEqual(settings.get('telnyx_sip_password'), 'legacy-pass', 'and the secret too');

  // The vendor default is a placeholder, not a configuration.
  rawPut('voipso_sip_server', 'sip.voip.so');
  settings.set('telnyx_sip_server', '');
  migrate.migrateTelephonyToTelnyx(db);
  assert.strictEqual(settings.get('telnyx_sip_server'), 'sip.telnyx.com', 'the old vendor default becomes the new vendor default');

  // Running it again must not undo anything the agent has since changed.
  settings.set('telnyx_sip_server', 'sip.mit-eget-edge.dk');
  rawPut('voipso_sip_server', 'sip.voip.so');
  migrate.migrateTelephonyToTelnyx(db);
  assert.strictEqual(settings.get('telnyx_sip_server'), 'sip.mit-eget-edge.dk', 'a key already set is never overwritten');
  settings.set('telnyx_sip_server', 'sip.telnyx.com');

  // A gateway pointing at the retired carrier is cleared; a deliberate one is kept.
  settings.set('webrtc_ws_url', 'wss://sip.voip.so:8089/ws');
  migrate.migrateTelephonyToTelnyx(db);
  assert.strictEqual(settings.get('webrtc_ws_url'), '', 'a legacy WebSocket gateway is cleared');
  settings.set('webrtc_ws_url', 'wss://rtc.eu.telnyx.com');
  migrate.migrateTelephonyToTelnyx(db);
  assert.strictEqual(settings.get('webrtc_ws_url'), 'wss://rtc.eu.telnyx.com', 'a deliberate gateway is left alone');

  // Finally the purge a real boot performs: the retired keys are gone for good afterwards.
  migrate.purgeUnknownSettings();
  assert.strictEqual(rawGet('voipso_sip_server'), undefined, 'the legacy server key is purged');
  assert.strictEqual(rawGet('voipso_sip_user'), undefined, 'the legacy username key is purged');
  assert.strictEqual(rawGet('voipso_sip_password'), undefined, 'and the legacy secret key with it');
  assert.strictEqual(rawGet('telnyx_sip_password'), 'legacy-pass', 'while the value it carried lives on under the new name');
  // The environment names the Telnyx variables now (TELNYX_*), and seeding still only ever
  // fills a setting that is empty — a value saved in the UI must survive a later .env edit.
  settings.set('telnyx_sip_user', '');
  settings.set('telnyx_sip_password', '');
  process.env.TELNYX_SIP_USER = 'env-user';
  process.env.TELNYX_SIP_PASSWORD = 'env-secret';
  process.env.TELNYX_SIP_SERVER = 'sip.env.example.dk';
  settings.seedFromEnv();
  assert.strictEqual(settings.get('telnyx_sip_user'), 'env-user', 'TELNYX_SIP_USER seeds an empty setting');
  assert.strictEqual(settings.get('telnyx_sip_password'), 'env-secret', 'TELNYX_SIP_PASSWORD seeds an empty setting');
  assert.strictEqual(settings.get('telnyx_sip_server'), 'sip.telnyx.com', 'but a setting that already has a value is left alone');
  settings.set('telnyx_sip_user', 'saved-in-the-ui');
  settings.seedFromEnv();
  assert.strictEqual(settings.get('telnyx_sip_user'), 'saved-in-the-ui', 'a saved value beats the environment');
  delete process.env.TELNYX_SIP_USER;
  delete process.env.TELNYX_SIP_PASSWORD;
  delete process.env.TELNYX_SIP_SERVER;

  ok('migration 7 carries a custom host, respects an already-set key, clears a legacy gateway and lets the purge finish the job');

  // ---- prospect repo ----
  const p = prospects.insert({ name: 'Mette Jensen', phone: '+4520123456', email: 'mette@nordiclogistik.dk', company: 'Nordic Logistik', stage: 'new' });
  assert.strictEqual(p.dnc, false, 'dnc comes back as a boolean');
  assert.deepStrictEqual(p.extra, {});
  const updated = prospects.update(p.id, { stage: 'interested', dnc: false, follow_up_at: '2026-11-02 09:30:00' });
  assert.strictEqual(updated.stage, 'interested');
  assert.strictEqual(updated.follow_up_at, '2026-11-02 09:30:00');
  assert.strictEqual(prospects.search('nordic').length, 1);
  assert.strictEqual(prospects.search('nordic')[0].id, p.id);
  assert.deepStrictEqual(prospects.stageCounts().interested, 1);
  assert.ok(prospects.phones().has('+4520123456'));
  const inserted = prospects.bulkInsert([
    { name: 'A', phone: '+4522345678', email: '', company: '', title: '', location: '', website: '' },
    { name: 'B', phone: '+4531456789', email: '', company: '', title: '', location: '', website: '' },
  ]);
  assert.strictEqual(inserted, 2);
  assert.strictEqual(prospects.count(), 3);
  ok('prospect repo: insert, update, search, stage counts, bulk insert');

  // ---- call + note repos ----
  const call = calls.insert({ prospect_id: p.id, status: 'placed', dry_run: false, dial_uri: 'sip:+4520123456', caller_id: '+4520123456' });
  assert.strictEqual(call.dial_uri, 'sip:+4520123456');
  assert.strictEqual(call.vm_dropped, 0);
  const patched = calls.patch(call.id, { outcome: 'conversation', duration_sec: 42, vm_dropped: 0, ended_at: callService.sqlNow() });
  assert.strictEqual(patched.outcome, 'conversation');
  assert.strictEqual(patched.duration_sec, 42);
  assert.strictEqual(calls.countSince('2000-01-01 00:00:00'), 1);
  assert.strictEqual(calls.countSince('2000-01-01 00:00:00', 'AND dry_run = 0'), 1);
  assert.strictEqual(calls.countSince('2000-01-01 00:00:00', 'AND dry_run = 1'), 0);
  const note = notes.insert(p.id, 'Vil gerne have en demo.');
  assert.strictEqual(notes.listByProspect(p.id).length, 1);
  notes.update(note.id, 'Vil gerne have en demo i næste uge.');
  assert.strictEqual(notes.get(note.id).body, 'Vil gerne have en demo i næste uge.');
  ok('call + note repos: insert, patch, filters, updates');

  // ---- inbound call ledger (migration 8) ----
  // Inbound calls share the calls table; `direction` is what keeps them from being read as
  // outbound dials by the funnel. The column is additive with a default, so upgrading a live
  // database cannot rewrite a single existing row.
  const directionCol = db.prepare('PRAGMA table_info(calls)').all().find((c) => c.name === 'direction');
  assert.ok(directionCol, 'calls.direction exists after migration 8');
  assert.strictEqual(directionCol.dflt_value, "'outbound'", "the column default is the literal 'outbound'");
  assert.strictEqual(directionCol.notnull, 1, 'direction is NOT NULL');
  assert.ok(migrate.MIGRATIONS.some((m) => m.version === 8 && m.name === 'calls-direction-inbound'),
    'migration 8 is the inbound-direction migration');
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM calls WHERE direction IS NULL").get().c, 0,
    'every row written before the migration reads back as outbound');
  assert.strictEqual(calls.get(call.id).direction, 'outbound', 'the outbound dialer still writes direction=outbound');

  // A caller the CRM already knows: matched by normalised number, no new prospect invented.
  const known = callService.startInbound({ callerPhone: '20123456' });
  assert.strictEqual(known.matched, true, 'an existing prospect is matched by phone');
  assert.strictEqual(known.provisional, false, 'a matched caller provisions nothing');
  assert.strictEqual(known.prospect.id, p.id, 'the match is the real prospect');
  assert.strictEqual(known.callerId, '+4520123456', 'the caller number is normalised the same way dialing normalises');
  assert.strictEqual(known.call.direction, 'inbound');
  assert.strictEqual(known.call.status, 'ringing');
  assert.strictEqual(known.call.prospect_id, p.id);
  const again = callService.startInbound({ callerPhone: '+45 20 12 34 56' });
  assert.strictEqual(again.callId, known.callId, 'a re-delivered SIP INVITE reuses the same ringing row');

  // A caller nobody knows: one provisional lead, still exposed to the UI so the agent can see
  // who is ringing before answering.
  const before = callService.todaysDials();
  const unknown = callService.startInbound({ callerPhone: '+45 31 88 99 00' });
  assert.strictEqual(unknown.matched, false, 'an unknown caller does not pretend to match');
  assert.strictEqual(unknown.provisional, true, 'an unknown caller gets a provisional lead');
  assert.strictEqual(unknown.prospect.phone, '+4531889900');
  assert.strictEqual(unknown.prospect.extra.inbound, true, 'the provisional lead is marked as an inbound call');
  assert.strictEqual(prospects.count(), 4, 'the provisional lead is a single new row');
  assert.throws(() => callService.startInbound({ callerPhone: 'hej med dig' }), /caller number/i,
    'a call with no usable number is refused rather than logged against a junk row');

  // Declined / missed before pickup: the ring never became a conversation, so it must not
  // count as a dial — and the provisional lead is removed so spam cannot pollute the CRM.
  const missed = callService.markInboundMissed(unknown.callId, { reason: 'missed' });
  assert.strictEqual(missed.call.status, 'missed');
  assert.strictEqual(missed.call.duration_sec, 0);
  assert.ok(missed.call.ended_at, 'a missed call is closed out, not left ringing forever');
  assert.strictEqual(prospects.get(unknown.prospect.id), undefined, 'the provisional lead is cleaned up');
  assert.strictEqual(prospects.count(), 3);
  assert.strictEqual(callService.todaysDials(), before, 'a missed inbound call is not a dial');
  const already = callService.markInboundMissed(unknown.callId, { reason: 'missed' });
  assert.strictEqual(already.alreadyResolved, true, 'marking the same ring twice is a no-op');

  // Answered inbound calls run the exact outbound classification path: the same PATCH, the
  // same stage machine, the same duration bookkeeping.
  const answered = callService.startInbound({ callerPhone: '+4520123456' });
  const classified = callService.classify(answered.callId, { outcome: 'conversation', duration_sec: 91 });
  assert.strictEqual(classified.call.outcome, 'conversation');
  assert.strictEqual(classified.call.duration_sec, 91);
  assert.strictEqual(classified.call.direction, 'inbound', 'classification never rewrites the direction');
  ok('inbound ledger: migration 8, match/provision, idempotent ring, missed cleanup, classification');

  // ---- telephony service ----
  const cases = [
    ['20123456', '+4520123456'], ['20 12 34 56', '+4520123456'], ['+45 20 12 34 56', '+4520123456'],
    ['004520123456', '+4520123456'], ['4520123456', '+4520123456'], ['0045 20 12 34 56', '+4520123456'],
    ['1234', ''], ['', ''], ['mette@sip.telnyx.com', 'mette@sip.telnyx.com'],
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(telephony.normalizePhone(input), expected, `normalizePhone(${JSON.stringify(input)})`);
  }
  assert.strictEqual(telephony.buildDialUri('+4520123456', 'sip'), 'sip:+4520123456');
  assert.strictEqual(telephony.buildDialUri('+4520123456', 'tel'), 'tel:+4520123456');
  assert.strictEqual(telephony.buildDialUriFull('+4520123456'), 'sip:+4520123456@sip.telnyx.com');
  assert.strictEqual(telephony.sipServer(), 'sip.telnyx.com', 'the Telnyx FQDN is the default floor');
  ok('normalization table (9 cases) + dial URI builders');

  // ---- in-browser softphone session (WebRTC) ----
  // The browser leg is addressed over the provider's WebSocket gateway, and the SIP secret
  // only leaves the server when the operator explicitly turned the handoff on.
  settings.set('telnyx_sip_server', 'sip.telnyx.com');
  settings.set('telnyx_sip_user', '1001');
  settings.set('telnyx_sip_password', 'super-secret');
  settings.set('webrtc_ws_url', '');
  settings.set('webrtc_credential_handoff', '0');
  assert.strictEqual(telephony.buildWebRtcUri('+4520123456'), 'sip:+4520123456@sip.telnyx.com;transport=ws');
  assert.strictEqual(telephony.webrtcWsUrl(), 'wss://rtc.telnyx.com', "an empty gateway means Telnyx's own gateway");
  assert.strictEqual(telephony.webrtcSession().provider, 'telnyx');
  const handoffOff = telephony.webrtcSession();
  assert.strictEqual(handoffOff.password, '', 'the password must not be in the descriptor while the handoff is off');
  assert.strictEqual(handoffOff.hasPassword, true);
  assert.strictEqual(handoffOff.canRegister, false, 'a browser cannot register without the secret');
  assert.strictEqual(handoffOff.wsUrlSource, 'telnyx_default');
  settings.set('caller_id', '+45 20 12 34 56');
  settings.set('webrtc_credential_handoff', '1');
  const handoffOn = telephony.webrtcSession();
  assert.strictEqual(handoffOn.password, 'super-secret');
  assert.strictEqual(handoffOn.canRegister, true);
  assert.strictEqual(handoffOn.callerId, '+4520123456');
  settings.set('webrtc_ws_url', 'wss://rtc.eu.telnyx.com');
  assert.strictEqual(telephony.webrtcWsUrl(), 'wss://rtc.eu.telnyx.com', 'an explicit gateway wins (regional edge)');
  assert.strictEqual(telephony.webrtcSession().wsUrlSource, 'settings');
  settings.set('webrtc_ws_url', '');
  settings.set('telnyx_sip_password', '');
  const unconfigured = telephony.webrtcSession();
  assert.deepStrictEqual(unconfigured.missing, ['password']);
  assert.strictEqual(unconfigured.configured, false);
  ok('webrtc session: Telnyx gateway default, credential handoff gate, readiness reasons');

  settings.set('caller_id', '+45 20 12 34 56');
  settings.set('caller_id_pool', '+4520987654, 31 45 67 89');
  assert.deepStrictEqual(telephony.callerIdPool(), ['+4520123456', '+4520987654', '+4531456789']);
  settings.set('caller_id_cursor', '0');
  const rotation = [telephony.nextCallerId().callerId, telephony.nextCallerId().callerId, telephony.nextCallerId().callerId, telephony.nextCallerId().callerId];
  assert.deepStrictEqual(rotation, ['+4520123456', '+4520987654', '+4531456789', '+4520123456']);
  ok(`caller ID pool rotates round-robin and wraps: ${rotation.join(' → ')}`);

  const bh = telephony.businessHours(new Date('2026-10-07T08:00:00Z')); // 10:00 in Copenhagen (CEST)
  assert.strictEqual(bh.tz, 'Europe/Copenhagen');
  assert.strictEqual(bh.open, true, `expected the window open at ${bh.localTime} Copenhagen`);
  const closed = telephony.businessHours(new Date('2026-10-11T10:00:00Z')); // a Sunday
  assert.strictEqual(closed.isBusinessDay, false);
  assert.strictEqual(closed.open, false);
  ok(`business hours: open=${bh.open} at ${bh.localTime} Copenhagen on a Wednesday, closed on Sunday`);

  // ---- copilot ----
  const summary = copilot.localSummary({
    prospect: { name: 'Mette Jensen', company: 'Nordic Logistik', follow_up_at: '' },
    call: { outcome: 'conversation', duration_sec: 187, dial_uri: 'sip:+4520123456', vm_dropped: 0 },
    notes: [{ body: 'Vil gerne have en demo i næste uge. Budget ligger hos CFO.' }],
  });
  assert.strictEqual(summary.provider, 'local');
  assert.match(summary.summary, /Mette Jensen/);
  assert.match(summary.summary, /Nordic Logistik/);
  assert.strictEqual(summary.talkTimeSec, 187);
  assert.ok(summary.nextSteps.length >= 1);
  assert.ok(summary.highlights.some((h) => /Budget|demo/i.test(h)));
  assert.ok(summary.followUpSuggested);
  const vmSummary = copilot.localSummary({ prospect: { name: 'X' }, call: { outcome: 'voicemail', duration_sec: 10, vm_dropped: 1 }, notes: [] });
  assert.strictEqual(vmSummary.voicemailDrop, true);
  assert.match(vmSummary.summary, /Voicemail drop used/);
  ok('copilot: local summary, next steps, highlights and voicemail-drop wording');

  // ---- backups ----
  const snap = await backup.create('unit');
  assert.ok(snap.bytes > 0);
  assert.match(snap.file, /^dialer-backup-\d{4}-\d{2}-\d{2}-.*-unit\.db$/);
  assert.ok(fs.existsSync(path.join(tmp, 'backups', snap.file)));
  const daily = await backup.ensureDaily();
  assert.strictEqual(daily, null, 'only one snapshot per day');
  assert.ok(backup.list().length >= 1);
  ok(`snapshot written (${Math.round(snap.bytes / 1024)} KB) and the daily guard skips duplicates`);

  console.log(`  [unit] ${passed} unit checks passed`);
}

run()
  .catch((e) => { console.error('  \u274C unit failure:', e.message); process.exitCode = 1; })
  .finally(() => { try { db.close(); } catch { /* ignore */ } fs.rmSync(tmp, { recursive: true, force: true }); });
