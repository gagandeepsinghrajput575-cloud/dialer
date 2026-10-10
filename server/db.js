const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// DB_PATH / DATA_DIR let tests boot the server against a throwaway database
// instead of the real data/dialer.db.
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const dbFile = process.env.DB_PATH || path.join(dataDir, 'dialer.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS prospects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  extra TEXT NOT NULL DEFAULT '{}',
  stage TEXT NOT NULL DEFAULT 'new',
  dnc INTEGER NOT NULL DEFAULT 0,
  follow_up_at TEXT,
  call_count INTEGER NOT NULL DEFAULT 0,
  last_called_at TEXT,
  last_outcome TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prospects_stage ON prospects(stage);
-- covers the dialer queue: dnc filter + stage tab filter + id keyset order
CREATE INDEX IF NOT EXISTS idx_prospects_queue ON prospects(dnc, stage, id);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  outcome TEXT,
  duration_sec INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'initiated',
  dry_run INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_started ON calls(started_at);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

const DEFAULTS = {
  sonetel_username: '',
  sonetel_password: '',
  my_number: '', // call1: your softphone SIP address / Sonetel email / mobile
  caller_id: 'automatic',
  default_country_code: '91',
  dry_run: '1',
  daily_goal: '80',
  daily_cap: '150',
};

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULTS[key];
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value ?? ''));
}
function allSettings() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = getSetting(k);
  return out;
}

module.exports = { db, getSetting, setSetting, allSettings, DEFAULTS };
