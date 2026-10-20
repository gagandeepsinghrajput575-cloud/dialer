#!/usr/bin/env node
// Prints which in-app telephony engine this machine will use, before a call is at stake.
// `npm run desktop:check`
const fs = require('fs');
const { resolveBinary, BINARY_CANDIDATES } = require('../telephony/linphoneDaemon');

const binary = resolveBinary();
const configured = String(process.env.PULSE_DESKTOP_ENGINE || 'auto').toLowerCase();

console.log('Pulse Dialer — telephony engine check\n');
console.log(`  PULSE_DESKTOP_ENGINE = ${configured}`);
console.log(`  in-app engine        = ${binary ? `linphone (${binary})` : 'not installed — the in-window WebRTC engine will be used'}`);
if (!binary) {
  console.log('\n  Looked for:');
  for (const candidate of BINARY_CANDIDATES.filter(Boolean)) console.log(`    ${candidate}`);
  console.log('\n  To install the in-app engine:');
  console.log('    brew install --cask linphone            # provides the Linphone app + core libs');
  console.log('    # then drop a headless build here and re-run this check:');
  console.log('    #   desktop/bin/linphone-daemon   (or `brew install linphone` for linphonec)');
  console.log('  A missing engine never blocks calling: the shell falls back to the window engine,');
  console.log('  and Settings → Native macOS app shows which engine is live.');
}
console.log('\n  Engine files:');
for (const file of ['main.js', 'bridge.js', 'telephony/linphoneDaemon.js', 'telephony/daemonProtocol.js']) {
  const full = require('path').join(__dirname, '..', file);
  console.log(`    ${fs.existsSync(full) ? '✓' : '✗'} desktop/${file}`);
}
