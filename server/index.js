// Bootstrap: migrations -> settings seed -> daily snapshot -> listen.
const { createApp } = require('./app');
const migrate = require('./db/migrate');
const settings = require('./repositories/settingsRepo');
const backup = require('./db/backup');
const { db } = require('./db');
const { port, isTest, dbPath } = require('./config/env');

async function main() {
  const { applied } = migrate.run();
  settings.seedFromEnv();

  if (applied.length && !isTest) console.log(`Migrations applied: ${applied.join(', ')}`);

  const app = createApp();
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Pulse Dialer running on http://localhost:${port}`);
    if (!isTest) console.log(`Database: ${dbPath}`);
  });

  // One snapshot per day, taken after the server is accepting requests.
  backup.ensureDaily()
    .then((b) => { if (b && !isTest) console.log(`Daily snapshot: ${b.file} (${Math.round(b.bytes / 1024)} KB)`); })
    .catch((e) => console.error('Backup failed:', e.message));

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const finish = () => {
      // Flush the WAL into the main database so a copy of data/ is always consistent, then
      // let SQLite release its locks cleanly.
      try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { console.error('checkpoint failed:', e.message); }
      try { db.close(); } catch { /* already closed */ }
      process.exit(0);
    };
    server.close(finish);
    setTimeout(finish, 3000); // don't hang forever on a stuck keep-alive connection
    if (!isTest) console.log(`Received ${signal}, shutting down…`);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // A stray rejection must be logged, not silently swallowed (or crash the process).
  process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${port} is already in use — stop the other Pulse Dialer or set PORT.`);
    else console.error('[server]', e.message);
    process.exit(1);
  });
  return server;
}

if (require.main === module) main();

module.exports = { main };
