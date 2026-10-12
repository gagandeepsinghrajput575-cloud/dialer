// Versioned migrations. Every entry runs exactly once, inside a transaction, and is
// recorded in _migrations — so upgrading an existing database never loses data.
const { db } = require('./index');
const { BASELINE_SQL, OUTBOX_SQL } = require('./schema');
const { SETTING_KEYS } = require('../config/defaults');

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}
function addColumn(table, column, ddl) {
  if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
// Drops settings rows for keys the app no longer knows about. In practice this is what
// wipes the retired 2-legged callback credentials from pre-2.0 databases.
function purgeUnknownSettings() {
  const stale = db.prepare('SELECT key FROM settings').all().map((r) => r.key).filter((k) => !SETTING_KEYS.includes(k));
  const del = db.prepare('DELETE FROM settings WHERE key = ?');
  db.transaction(() => stale.forEach((k) => del.run(k)))();
  return stale;
}

// Hosts that used to be this app's carrier. A stored SIP server pointing at one of these is
// not a configuration — it is the old default, and it must not survive the cutover.
const LEGACY_SIP_HOSTS = /voip\.so|voip\.ms|voip\.so:|voipms/i;

// Migration 7: VOIP.SO -> Telnyx.
//
// Three things have to happen here rather than in application code, because the very next
// thing the boot sequence does is purge settings the app no longer knows about — once
// purgeUnknownSettings() has run, the legacy rows are gone for good.
//
//   1. copy the SIP account (server/user/password) onto the telnyx_* keys,
//   2. replace a stored legacy host with the Telnyx FQDN, keeping a genuinely custom server,
//   3. drop a stored legacy WebSocket gateway so the Telnyx gateway default takes over.
//
// Running it against a database that never had a legacy carrier is a no-op plus the default.
function migrateTelephonyToTelnyx(db) {
  const read = (key) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row && row.value !== null && row.value !== undefined ? String(row.value) : '';
  };
  const write = (key, value) => db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value ?? ''));

  const legacyServer = read('voipso_sip_server').trim();
  const legacyUser = read('voipso_sip_user').trim();
  const legacyPass = read('voipso_sip_password');

  // A server the agent chose deliberately (their own PBX, a reseller) is preserved; the old
  // vendor default is not a choice and becomes the new vendor.
  const carriedServer = legacyServer && !LEGACY_SIP_HOSTS.test(legacyServer) ? legacyServer : '';
  if (!read('telnyx_sip_server').trim()) write('telnyx_sip_server', carriedServer || 'sip.telnyx.com');
  if (legacyUser && !read('telnyx_sip_user').trim()) write('telnyx_sip_user', legacyUser);
  if (legacyPass && !read('telnyx_sip_password')) write('telnyx_sip_password', legacyPass);

  // A gateway left pointing at the retired provider is worse than no gateway: the browser
  // would dial a host that no longer answers, and the failure would look like a credentials
  // problem. Clearing it restores the documented Telnyx default.
  const legacyWs = read('webrtc_ws_url').trim();
  if (legacyWs && LEGACY_SIP_HOSTS.test(legacyWs)) write('webrtc_ws_url', '');
}

const MIGRATIONS = [
  { version: 1, name: 'baseline-schema', up: () => db.exec(BASELINE_SQL) },
  { version: 2, name: 'calls-dial-uri', up: () => addColumn('calls', 'dial_uri', 'TEXT') },
  {
    version: 3,
    name: 'calls-caller-id-and-voicemail-drop',
    up: () => {
      addColumn('calls', 'caller_id', 'TEXT');
      addColumn('calls', 'vm_dropped', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    version: 4,
    name: 'calls-copilot-and-follow-up',
    up: () => {
      addColumn('calls', 'summary', 'TEXT');
      addColumn('calls', 'next_step', 'TEXT');
      addColumn('calls', 'follow_up_at', 'TEXT');
    },
  },
  { version: 5, name: 'purge-legacy-settings', up: () => purgeUnknownSettings() },
  // The local mail sink's ledger. A pure addition, so it cannot disturb a database in use.
  { version: 6, name: 'outbox-local-mail-sink', up: () => db.exec(OUTBOX_SQL) },
  // The carrier cutover. Runs before the purge on purpose — see migrateTelephonyToTelnyx.
  { version: 7, name: 'telnyx-telephony-migration', up: (d) => migrateTelephonyToTelnyx(d) },
  // Inbound calls land in the same ledger as outbound ones. A column with a default is an
  // O(1), rewrite-free ALTER on SQLite, so every row a running database already holds keeps
  // reading back as 'outbound' — nothing to backfill, nothing to lose.
  { version: 8, name: 'calls-direction-inbound', up: () => addColumn('calls', 'direction', "TEXT NOT NULL DEFAULT 'outbound'") },
];

function run() {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(db.prepare('SELECT version FROM _migrations').all().map((r) => r.version));
  const pending = MIGRATIONS.filter((m) => !applied.has(m.version)).sort((a, b) => a.version - b.version);
  const insert = db.prepare('INSERT INTO _migrations(version, name) VALUES(?,?)');
  for (const m of pending) {
    db.transaction(() => { m.up(db); insert.run(m.version, m.name); })();
  }
  // Safety net: keep settings in sync with the current defaults even between releases.
  purgeUnknownSettings();
  return { applied: pending.map((m) => `${m.version}:${m.name}`), total: MIGRATIONS.length };
}

module.exports = { run, MIGRATIONS, purgeUnknownSettings, addColumn, migrateTelephonyToTelnyx, LEGACY_SIP_HOSTS };
