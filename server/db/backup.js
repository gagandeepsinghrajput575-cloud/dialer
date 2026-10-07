// Snapshot engine. Uses better-sqlite3's online backup API, which is safe while the
// WAL database is being written to — no need to stop the server.
const fs = require('fs');
const path = require('path');
const { db } = require('./index');
const { backupDir, backupRetention } = require('../config/env');

const today = () => new Date().toISOString().slice(0, 10);
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

// Only ever used as part of a file name inside backupDir — anything else is stripped, so a
// reason like "../../../../tmp/evil" can no longer write outside the backup folder.
const safeReason = (reason) => String(reason || 'manual').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'manual';

function list() {
  if (!fs.existsSync(backupDir)) return []; // deleted while running: degrade, don't crash
  return fs.readdirSync(backupDir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const st = fs.statSync(path.join(backupDir, f));
      return { file: f, bytes: st.size, created_at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function prune() {
  const keep = list().slice(backupRetention);
  for (const b of keep) { try { fs.unlinkSync(path.join(backupDir, b.file)); } catch { /* ignore */ } }
  return keep.length;
}

async function create(reason = 'manual') {
  const file = `dialer-backup-${stamp()}-${safeReason(reason)}.db`;
  const target = path.join(backupDir, file);
  await db.backup(target);
  prune();
  return { file, bytes: fs.statSync(target).size, created_at: new Date().toISOString(), reason };
}

// One snapshot per day, taken on boot (or on the first request of a new day).
async function ensureDaily() {
  if (list().some((b) => b.file.includes(today()))) return null;
  return create('daily');
}

// Called before destructive/bulk operations so a bad import is always recoverable.
async function beforeBulkWrite(reason = 'import') {
  return create(reason);
}

module.exports = { create, ensureDaily, beforeBulkWrite, list, prune, safeReason };
