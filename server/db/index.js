// Single better-sqlite3 connection for the whole process, hardened for concurrent readers.
const Database = require('better-sqlite3');
const { dbPath } = require('../config/env');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Helper for transactions that may contend with bulk imports:
// retries transient SQLITE_BUSY with exponential backoff instead of surfacing 500.
function withBusyRetry(fn, retries = 3) {
  return (...args) => {
    for (let i = 0; i < retries; i++) {
      try { return fn(...args); }
      catch (e) {
        const busy = e && (e.code === 'SQLITE_BUSY' || /SQLITE_BUSY|busy/i.test(String(e.message)));
        if (busy && i < retries - 1) {
          // Sleep without blocking event loop? In better-sqlite3 sync context we busy-wait briefly.
          const start = Date.now(); while (Date.now() - start < 15 * Math.pow(2, i)) { /* spin */ }
          continue;
        }
        throw e;
      }
    }
  };
}

module.exports = { db, dbPath, withBusyRetry };
