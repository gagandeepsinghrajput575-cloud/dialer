// Baseline schema. Idempotent so it can also create a brand new database.
const BASELINE_SQL = `
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
  pronunciation TEXT NOT NULL DEFAULT '',
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
CREATE INDEX IF NOT EXISTS idx_prospects_follow_up ON prospects(follow_up_at);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_prospect ON notes(prospect_id);

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
CREATE INDEX IF NOT EXISTS idx_calls_prospect ON calls(prospect_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

// Captured mail for the local catch-all sink (Settings -> Email -> "Use Local Mail Sink").
// Bodies are stored verbatim so the outbox can render exactly what the recipient would have
// seen; attachment payloads are kept as base64 inside attachments_json, bounded by the repo.
const OUTBOX_SQL = `
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id INTEGER,
  to_address TEXT NOT NULL,
  from_address TEXT NOT NULL,
  reply_to TEXT,
  subject TEXT NOT NULL,
  text_body TEXT,
  html_body TEXT,
  attachments_json TEXT DEFAULT '[]',
  headers_json TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_outbox_prospect ON outbox(prospect_id);
CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox(created_at);
`;

// Call recordings ledger for zero-extra-charge local audio storage.
// Directly references calls and prospects, tracking filename on disk, duration, and file size.
const RECORDINGS_SQL = `
CREATE TABLE IF NOT EXISTS recordings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id INTEGER NOT NULL UNIQUE REFERENCES calls(id) ON DELETE CASCADE,
  prospect_id INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  duration_sec INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mime_type TEXT NOT NULL DEFAULT 'audio/webm',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recordings_call ON recordings(call_id);
CREATE INDEX IF NOT EXISTS idx_recordings_prospect ON recordings(prospect_id);
CREATE INDEX IF NOT EXISTS idx_recordings_created ON recordings(created_at);
`;

// AI Recording Coaching sessions and multi-turn chat messages.
// Foreign-key cascaded to calls so cleaning up a call cleans all associated AI sessions.
const RECORDING_CHATS_SQL = `
CREATE TABLE IF NOT EXISTS recording_chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Coaching Session',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recording_chats_call ON recording_chats(call_id);

CREATE TABLE IF NOT EXISTS recording_chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES recording_chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON recording_chat_messages(chat_id);
`;

module.exports = { BASELINE_SQL, OUTBOX_SQL, RECORDINGS_SQL, RECORDING_CHATS_SQL };
