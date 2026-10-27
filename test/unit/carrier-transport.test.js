// Which transport the daemon is told to use, decided on the server.
//
// The daemon can speak UDP or TLS; the choice has to come from somewhere the operator can reach
// without editing code. `PULSE_SIP_TRANSPORT=tls` (or the `flynumber_sip_transport` setting) is
// that switch, and the port has to follow it: 5061 is TLS, and a trunk left on the 5060 default
// must not silently stay on the UDP port.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-carrier-transport-'));
process.env.DATA_DIR = tmp;
process.env.PULSE_TEST = '1';

require('../../server/db/migrate').run();
const carrierAccount = require('../../server/services/carrierAccount');

let passed = 0;
let failed = 0;
const ok = (m) => { passed++; console.log(`  \u2713 ${m}`); };
const bad = (m) => { failed++; console.log(`  \u2717 ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

console.log('\n=== VAL-NET-012: carrier transport selection ===\n');

delete process.env.PULSE_SIP_TRANSPORT;
{
  const account = carrierAccount.activeAccount();
  console.log(`  default    : ${account.transport}:${account.port}`);
  check(account.transport === 'udp', 'UDP stays the default');
  check(account.port === 5060, 'the default port is 5060 for UDP');
}

process.env.PULSE_SIP_TRANSPORT = 'tls';
{
  const account = carrierAccount.activeAccount();
  console.log(`  tls        : ${account.transport}:${account.port}`);
  check(account.transport === 'tls', 'PULSE_SIP_TRANSPORT=tls switches the transport');
  check(account.port === 5061, 'TLS moves the port to 5061, not the UDP default');
}

process.env.PULSE_SIP_TRANSPORT = 'TLS';
check(carrierAccount.activeAccount().transport === 'tls', 'the switch is case-insensitive');

process.env.PULSE_SIP_TRANSPORT = 'carrier-pigeon';
check(carrierAccount.activeAccount().transport === 'udp', 'an unknown value falls back to UDP');

delete process.env.PULSE_SIP_TRANSPORT;
fs.rmSync(tmp, { recursive: true, force: true });

assert.strictEqual(failed, 0, `${failed} transport-selection check(s) failed`);
console.log(`\n${failed ? '\u{1F4A5}' : '\u{1F389}'} ${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
