'use strict';
/**
 * Legacy entry point, kept so `node test/all-tests.js` still works against an
 * already-running server on http://localhost:3001.
 *
 * Prefer `npm test`: it boots its own server on a throwaway database, so it can
 * never read or write your real data/dialer.db.
 */
const { client, summarize } = require('./support');
const { runCoreTests } = require('./api.test');

const BASE = process.env.BASE || 'http://localhost:3001';

async function main() {
  console.log(`Running the core regression suite against ${BASE}`);
  console.log('WARNING: this writes to whatever database that server is using.');
  await runCoreTests(client(BASE));
  process.exit(summarize('Core tests') ? 1 : 0);
}

main().catch((e) => {
  console.error('\nHarness failure:', e);
  process.exit(1);
});
