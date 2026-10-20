// Single better-sqlite3 connection for the whole process, hardened for concurrent readers.
const Database = require('better-sqlite3');
const { dbPath } = require('../config/env');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Busy-retry wrapper for burst contention (G-8). Under heavy write bursts (e.g., bulk import
// interleaved with inbound ring webhook) SQLite can return SQLITE_BUSY despite busy_timeout.
// Exponential backoff with jitter keeps the event loop responsive.
function withBusyRetry(fn, maxRetries = 5, baseDelay = 40) {
  let attempt = 0;
  while (true) {
    try {
      return fn();
    } catch (err) {
      const isBusy = err && (err.code === 'SQLITE_BUSY' || /busy|locked/i.test(err.message || ''));
      if (!isBusy || attempt >= maxRetries) throw err;
      attempt++;
      const jitter = Math.floor(Math.random() * baseDelay);
      const delay = (baseDelay * Math.pow(2, attempt - 1)) + jitter;
      // Synchronous sleep using Atomics.wait on a shared buffer so callers remain synchronous
      // (compatible with better-sqlite3 sync API) without pinning CPU.
      try {
        const buf = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(buf, 0, 0, Math.min(delay, 500));
      } catch {
        const start = Date.now();
        while (Date.now() - start < Math.min(delay, 500)) { /* spin fallback */ }
      }
    }
  }
}

module.exports = { db, dbPath, withBusyRetry };
