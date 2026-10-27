// The carrier preflight: one OPTIONS instead of a 32 s stare at "Calling…".
//
// On a network whose SIP ALG mangles or swallows signalling, the INVITE client transaction runs
// all the way to Timer B (64 x T1 = 32 s) before the UI learns anything, and then says "timeout".
// The preflight answers "can this network carry SIP at all?" in about 200 ms, and fails in 1.5 s
// when it cannot — which is the difference between a dead call and an actionable message.
const assert = require('assert');
const dgram = require('dgram');

const { probeCarrier } = require('../../desktop/daemon/lib/reachability');
const { UserAgent } = require('../../desktop/daemon/lib/ua');

let passed = 0;
let failed = 0;
const ok = (m) => { passed++; console.log(`  \u2713 ${m}`); };
const bad = (m) => { failed++; console.log(`  \u2717 ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

async function fakeCarrier(reply) {
  const socket = dgram.createSocket('udp4');
  const seen = [];
  socket.on('message', (buf, rinfo) => {
    seen.push(String(buf));
    if (reply) socket.send(Buffer.from(reply), rinfo.port, rinfo.address);
  });
  await new Promise((r) => socket.bind(0, '127.0.0.1', r));
  return { socket, seen, port: socket.address().port };
}

(async () => {
  console.log('\n=== VAL-NET-010: carrier preflight (fail in 1.5 s, not Timer B) ===\n');

  // 1. A carrier that answers.
  {
    const carrier = await fakeCarrier('SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n');
    const started = Date.now();
    const r = await probeCarrier({ host: '127.0.0.1', port: carrier.port, timeoutMs: 1500 });
    const ms = Date.now() - started;
    console.log(`  answered   : ok=${r.ok} status="${r.status}" in ${ms} ms`);
    check(r.ok === true, 'a carrier that answers OPTIONS is reachable');
    check(/^SIP\/2\.0 200/.test(r.status || ''), 'the SIP status line is returned verbatim');
    check(ms < 500, 'it returns on the answer, not on the timeout');

    const sent = carrier.seen[0] || '';
    check(/^OPTIONS sip:127\.0\.0\.1 SIP\/2\.0/.test(sent), 'it sends a real OPTIONS request');
    check(/Via: SIP\/2\.0\/UDP \S+;branch=z9hG4bK[0-9a-f]+;rport/.test(sent),
      'the OPTIONS carries a Via with rport (so the reply is routable through NAT)');
    check(/CSeq: 1 OPTIONS/.test(sent) && /Content-Length: 0/.test(sent),
      'CSeq and Content-Length are well formed');
    carrier.socket.close();
  }

  // 2. A carrier that never answers — the SIP-ALG case.
  {
    const carrier = await fakeCarrier(null);
    const r = await probeCarrier({ host: '127.0.0.1', port: carrier.port, timeoutMs: 400 });
    console.log(`  silent     : ok=${r.ok} reason=${r.reason} in ${r.ms} ms`);
    check(r.ok === false && r.reason === 'timeout', 'a carrier that never answers times out');
    check(r.ms >= 350 && r.ms < 1500, `the wait is the budget, not Timer B (${r.ms} ms for a 400 ms budget)`);
    carrier.socket.close();
  }

  // 3. Nothing listening at all.
  {
    const r = await probeCarrier({ host: '127.0.0.1', port: 9, timeoutMs: 300 });
    console.log(`  dead port  : ok=${r.ok} reason=${r.reason} in ${r.ms} ms`);
    check(r.ok === false, 'a dead port is not reported reachable');
    check(r.ms < 1500, 'a dead port does not hang the caller');
  }

  // 4. Configuration errors are named, not lumped into "timeout".
  {
    const none = await probeCarrier({});
    check(none.ok === false && none.reason === 'no-host', 'an empty host is rejected without sending');
    const dnsFail = await probeCarrier({ host: 'no-such-host.invalid', timeoutMs: 300 });
    console.log(`  bad dns    : ok=${dnsFail.ok} reason=${dnsFail.reason}`);
    check(dnsFail.ok === false && dnsFail.reason === 'dns', 'an unresolvable carrier is reported as dns');
  }

  // 5. The gate in the user agent itself.
  {
    const carrier = await fakeCarrier(null);          // silent: the dial must not proceed
    const transport = {
      host: '127.0.0.1',
      port: 5099,
      send: async () => ({}),
      on: () => {},
      close: () => {},
    };
    const ua = new UserAgent({
      transport,
      audio: null,
      account: { domain: '127.0.0.1', port: carrier.port, user: 'alice', password: 'secret' },
    });
    assert.strictEqual(ua.registration.state, 'unregistered');

    const started = Date.now();
    const res = await ua.dial('+4512345678');
    const ms = Date.now() - started;
    console.log(`  dial gate  : ok=${res.ok} reason=${res.reason} in ${ms} ms`);
    check(res.ok === false && res.reason === 'carrier_unreachable',
      'dial refuses before INVITE when the carrier does not answer');
    check(ms < 2500, 'the operator is told in ~1.5 s, not after Timer B');
    check(/hotspot|SIP ALG/i.test(res.error || ''), 'the message says what to do about it');
    check(ua.dialogs.size === 0, 'no dialog was created for a call that could never connect');

    // A live registration is better evidence than a probe: the gate must not add latency.
    ua.registration.state = 'registered';
    const cached = await ua.checkCarrier();
    check(cached.ok === true && cached.cached === true && cached.ms === 0,
      'while registered the gate answers instantly and sends nothing');

    // ...unless a call already died on Timer B. Registration can still look fine when the ALG only
    // breaks dialog routing, so one timeout forces the next dial to probe instead of hanging again.
    ua.releaseMedia = () => {};
    ua.onDialogEnded({ id: 'stub', externalId: null, direction: 'outbound', durationSec: 0 },
      { reason: 'timeout' });
    check(ua.carrierSuspect === true, 'a Timer B timeout marks the carrier suspect despite registration');
    carrier.socket.close();

    const answering = await fakeCarrier('SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n');
    ua.account.port = answering.port;
    const afterSuspect = await ua.checkCarrier();
    console.log(`  after timeout: ok=${afterSuspect.ok} cached=${!!afterSuspect.cached} in ${afterSuspect.ms} ms`);
    check(afterSuspect.ok === true && !afterSuspect.cached,
      'a suspect carrier is probed even while registered');
    check(ua.carrierSuspect === false, 'a successful probe clears the suspicion');
    answering.socket.close();
  }

  // 6. Over TLS the gate must ask the socket, never send a UDP probe to 5061.
  {
    const tlsTransport = (connected, ensure) => ({
      mode: 'tls', connected, host: 'sip.example', port: 5061,
      send: async () => ({}), on: () => {}, close: () => {},
      ...(ensure ? { ensureConnected: ensure } : {}),
    });
    const ua2 = new UserAgent({
      transport: tlsTransport(true),
      audio: null,
      account: { domain: 'sip.example', port: 5061, user: 'alice', password: 'secret' },
    });
    const open = await ua2.checkCarrier();
    check(open.ok === true && open.via === 'tls',
      'an open TLS connection satisfies the gate without a UDP probe');

    let attempts = 0;
    const ua3 = new UserAgent({
      transport: tlsTransport(false, async () => { attempts += 1; throw new Error('connect refused'); }),
      audio: null,
      account: { domain: 'sip.example', port: 5061, user: 'alice', password: 'secret' },
    });
    const failedConnect = await ua3.checkCarrier({ timeoutMs: 500 });
    check(failedConnect.ok === false && attempts === 1,
      'a TLS connect failure fails the gate instead of pretending to probe');
  }

  console.log(`\n${failed ? '\u{1F4A5}' : '\u{1F389}'} ${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
