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
  assert.strictEqual(settings.get('voipso_sip_server'), 'sip.voip.so');
  settings.set('voipso_sip_password', 's3cret');
  const view = settings.publicView();
  assert.strictEqual(view.voipso_sip_password, '', 'secret is masked in the public view');
  assert.strictEqual(view.has_password, true);
  assert.strictEqual(view.ai_api_key, '');
  assert.strictEqual(view.has_api_key, false);
  // unknown keys are purged so retired settings never linger
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('retired_key', 'x');
  migrate.purgeUnknownSettings();
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM settings WHERE key = 'retired_key'").get().c, 0);
  ok('settings defaults, secret masking and unknown-key purge all behave');

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

  // ---- telephony service ----
  const cases = [
    ['20123456', '+4520123456'], ['20 12 34 56', '+4520123456'], ['+45 20 12 34 56', '+4520123456'],
    ['004520123456', '+4520123456'], ['4520123456', '+4520123456'], ['0045 20 12 34 56', '+4520123456'],
    ['1234', ''], ['', ''], ['mette@sip.voip.so', 'mette@sip.voip.so'],
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(telephony.normalizePhone(input), expected, `normalizePhone(${JSON.stringify(input)})`);
  }
  assert.strictEqual(telephony.buildDialUri('+4520123456', 'sip'), 'sip:+4520123456');
  assert.strictEqual(telephony.buildDialUri('+4520123456', 'tel'), 'tel:+4520123456');
  assert.strictEqual(telephony.buildDialUriFull('+4520123456'), 'sip:+4520123456@sip.voip.so');
  ok('normalization table (9 cases) + dial URI builders');

  // ---- in-browser softphone session (WebRTC) ----
  // The browser leg is addressed over the provider's WebSocket gateway, and the SIP secret
  // only leaves the server when the operator explicitly turned the handoff on.
  settings.set('voipso_sip_server', 'sip.voip.so');
  settings.set('voipso_sip_user', '1001');
  settings.set('voipso_sip_password', 'super-secret');
  settings.set('webrtc_ws_url', '');
  settings.set('webrtc_credential_handoff', '0');
  assert.strictEqual(telephony.buildWebRtcUri('+4520123456'), 'sip:+4520123456@sip.voip.so;transport=ws');
  assert.strictEqual(telephony.webrtcWsUrl(), 'wss://sip.voip.so:8089/ws', 'the gateway is derived when no URL is set');
  const handoffOff = telephony.webrtcSession();
  assert.strictEqual(handoffOff.password, '', 'the password must not be in the descriptor while the handoff is off');
  assert.strictEqual(handoffOff.hasPassword, true);
  assert.strictEqual(handoffOff.canRegister, false, 'a browser cannot register without the secret');
  assert.strictEqual(handoffOff.wsUrlSource, 'derived');
  settings.set('caller_id', '+45 20 12 34 56');
  settings.set('webrtc_credential_handoff', '1');
  const handoffOn = telephony.webrtcSession();
  assert.strictEqual(handoffOn.password, 'super-secret');
  assert.strictEqual(handoffOn.canRegister, true);
  assert.strictEqual(handoffOn.callerId, '+4520123456');
  settings.set('webrtc_ws_url', 'wss://edge.voip.so/live');
  assert.strictEqual(telephony.webrtcWsUrl(), 'wss://edge.voip.so/live', 'an explicit gateway wins');
  assert.strictEqual(telephony.webrtcSession().wsUrlSource, 'settings');
  settings.set('webrtc_ws_url', '');
  settings.set('voipso_sip_password', '');
  const unconfigured = telephony.webrtcSession();
  assert.deepStrictEqual(unconfigured.missing, ['password']);
  assert.strictEqual(unconfigured.configured, false);
  ok('webrtc session: derived gateway, credential handoff gate, readiness reasons');

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
