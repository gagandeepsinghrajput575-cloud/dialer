// Single better-sqlite3 connection for the whole process, hardened for concurrent readers.
const Database = require('better-sqlite3');
const { dbPath } = require('../config/env');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

module.exports = { db, dbPath };
