// Produce a database exactly as the pre-Telnyx release left it.
//
// Fidelity is the whole point of this helper. Building the legacy schema by hand would mean
// re-stating migrations 2-6's DDL in a test, and any drift there would make the migration test
// prove something about a database no user ever had (that is exactly how the first version of
// this fixture broke: it marked 1-6 as applied without applying them, so `calls.dial_uri` did
// not exist and the migration test was measuring a lie).
//
// So the real migration runner is used, with the Telnyx migration removed from the list first,
// which applies migrations 1-6 exactly as the old release did. The caller then boots the
// untouched application against the result.
//
// Usage: node test/helpers/legacy-db.js <dataDir>
const path = require('path');
const fs = require('fs');

const dataDir = process.argv[2];
if (!dataDir) {
  console.error('usage: node test/helpers/legacy-db.js <dataDir>');
  process.exit(2);
}
fs.mkdirSync(dataDir, { recursive: true });
process.env.DATA_DIR = dataDir;
process.env.PULSE_TEST = '1';

const migrate = require(path.join(__dirname, '..', '..', 'server', 'db', 'migrate'));
const settings = require(path.join(__dirname, '..', '..', 'server', 'repositories', 'settingsRepo'));

// The release that shipped before the cutover had no version 7 to run; everything else is
// identical, including the purge that follows the migrations.
const telnyx = migrate.MIGRATIONS.pop();
if (!telnyx || telnyx.version !== 7) throw new Error('the Telnyx migration is not the last entry — update this helper');
const { applied, total } = migrate.run();

// A real account from that era: the vendor default, an extension, its secret, a saved
// WebSocket gateway and a Danish caller ID.
settings.set('voipso_sip_server', 'sip.voip.so');
settings.set('voipso_sip_user', 'old-extension-42');
settings.set('voipso_sip_password', 'legacy-secret');
settings.set('webrtc_ws_url', 'wss://sip.voip.so:8089/ws');
settings.set('caller_id', '+45 30 11 22 33');

console.log(JSON.stringify({ applied, total, legacyRows: 5 }));
