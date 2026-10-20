const router = require('express').Router();
const backup = require('../db/backup');
const { db } = require('../db');
const { asyncHandler } = require('../middleware/errorHandler');
const { MIGRATIONS } = require('../db/migrate');
const { BUILD_METADATA } = require('../config/buildInfo');

router.get('/health', asyncHandler(async (req, res) => {
  res.json({
    ok: true,
    uptime_sec: Math.round(process.uptime()),
    db: {
      journal_mode: db.pragma('journal_mode', { simple: true }),
      busy_timeout: db.pragma('busy_timeout', { simple: true }),
      migrations: MIGRATIONS.length,
    },
    backups: backup.list().length,
    build: BUILD_METADATA,
  });
}));

module.exports = router;
