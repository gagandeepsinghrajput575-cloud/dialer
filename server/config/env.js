// Environment + filesystem layout. Everything the app writes lives under dataDir.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..', '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
const backupDir = path.join(dataDir, 'backups');
const audioDir = path.join(dataDir, 'audio');
for (const dir of [dataDir, backupDir, audioDir]) fs.mkdirSync(dir, { recursive: true });

module.exports = {
  root,
  dataDir,
  backupDir,
  audioDir,
  dbPath: path.join(dataDir, 'dialer.db'),
  port: parseInt(process.env.PORT || '3001', 10),
  // The test suite sets PULSE_TEST=1 to keep the logs quiet.
  isTest: process.env.PULSE_TEST === '1',
  logRequests: process.env.LOG_REQUESTS !== '0',
  backupRetention: parseInt(process.env.BACKUP_RETENTION || '14', 10),
};
