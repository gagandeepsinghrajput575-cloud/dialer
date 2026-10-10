'use strict';
/**
 * `npm test` — boots the real server twice on throwaway SQLite files
 * (never data/dialer.db) and runs the API suites against it.
 */
const { client, startServer, summarize } = require('./support');
const { runCoreTests, runQueueTests, runScaleTests } = require('./api.test');
const { runHardeningTests } = require('./hardening.test');

async function main() {
  console.log('Pulse Dialer \u2014 API integration tests');

  const core = await startServer({ label: 'core' });
  console.log(`server on ${core.base} (db: ${core.dbPath})`);
  try {
    const req = client(core.base);
    await runCoreTests(req);
    await runQueueTests(req);
  } finally {
    await core.stop();
  }

  // Its own server: the hardening suite deliberately grows the table to the demo
  // cap and posts oversized payloads, which would skew the scale timings.
  const hardening = await startServer({ label: 'hardening' });
  console.log(`\nserver on ${hardening.base} (db: ${hardening.dbPath})`);
  try {
    const req = client(hardening.base);
    await runHardeningTests(req, hardening.base);
  } finally {
    await hardening.stop();
  }

  const scale = await startServer({ label: 'scale' });
  console.log(`\nserver on ${scale.base} (db: ${scale.dbPath})`);
  try {
    const req = client(scale.base);
    await runScaleTests(req);
  } finally {
    await scale.stop();
  }

  process.exit(summarize('API tests') ? 1 : 0);
}

main().catch((e) => {
  console.error('\nHarness failure:', e);
  process.exit(1);
});
