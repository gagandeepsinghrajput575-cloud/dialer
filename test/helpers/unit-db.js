// Test bootstrap: every unit suite that touches a repository needs a schema before it can
// query one. Suites used to rely on whichever suite ran first having migrated the shared
// `data/` database, which made `npm run test:unit` fail on a clean checkout. This helper gives
// each suite its own throwaway DATA_DIR (unless the runner already provided one) and applies
// migrations + settings seeds exactly like server/index.js does at boot.
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-unit-'));
}
process.env.PULSE_TEST = process.env.PULSE_TEST || '1';

const migrate = require('../../server/db/migrate');
const settings = require('../../server/repositories/settingsRepo');

migrate.run();
settings.seedFromEnv();

module.exports = { dataDir: process.env.DATA_DIR };
