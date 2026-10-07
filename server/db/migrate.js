// Versioned migrations. Every entry runs exactly once, inside a transaction, and is
// recorded in _migrations — so upgrading an existing database never loses data.
const { db } = require('./index');
const { BASELINE_SQL } = require('./schema');
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

module.exports = { run, MIGRATIONS, purgeUnknownSettings, addColumn };
