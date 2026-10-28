// One press must place one call.
//
// `dial()` refuses when `standingCall()` is set — but it used to await a ~1.5 s carrier preflight
// *before* any dialog existed, so two dial commands arriving inside that window both passed the
// guard and both sent an INVITE. To the person on the other end that is the same number ringing
// twice for one click, and the operator has no way to tell it happened.
//
// The renderer latches its button before its first await, but the daemon is the last line of defence
// and must not depend on a caller getting that right.
const assert = require('assert');
const { EventEmitter } = require('events');

const { UserAgent } = require('../../desktop/daemon/lib/ua');
const { parse } = require('../../desktop/daemon/lib/sipMessage');

let passed = 0;
let failed = 0;
const ok = (m) => { passed++; console.log(`  \u2713 ${m}`); };
const bad = (m) => { failed++; console.log(`  \u2717 ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

const NUMBER = '+4512345678';

function fakeTransport() {
  const t = new EventEmitter();
  t.host = '203.0.113.7';
  t.port = 5060;
  t.localAddress = '0.0.0.0';
  t.sent = [];
  t.tx = [];
  t.send = async (buf, target) => { t.sent.push({ text: String(buf), target }); return target; };
  t.replyTo = async () => ({});
  t.peerFor = (_callId, fallback) => fallback;
  t.noteAck = () => {};
  t.close = () => {};
  t.request = (o) => { t.tx.push(o); return { key: 'k', stop() {}, stopRetransmit() {} }; };
  return t;
}

const audio = {
  name: 'stub', available: () => true, reason: '',
  describe: () => ({ name: 'stub' }),
  async open() {}, start() {}, stop() {}, write() { return true; },
};

/** A UA whose preflight takes `ms` — the window in which the old guard failed. */
function makeUa({ preflightMs = 60, reach = { ok: true, ms: 1 } } = {}) {
  const ua = new UserAgent({
    transport: fakeTransport(),
    audio,
    account: { domain: 'sip.example.test', port: 5060, user: 'agent', password: 'x', callerId: '+4532331610' },
  });
  ua.checkCarrier = async () => {
    await new Promise((r) => setTimeout(r, preflightMs));
    return reach;
  };
  return ua;
}

const invites = (ua) => ua.transport.tx.filter((o) => o.method === 'INVITE').length;

(async () => {
  console.log('\n=== VAL-SIP-020: one press, one INVITE ===\n');

  // 1. Two dials in the same tick, both landing inside the preflight window.
  {
    const ua = makeUa();
    check(ua.dialing === false, 'the latch starts clear');
    const [a, b] = await Promise.all([ua.dial(NUMBER), ua.dial(NUMBER)]);
    console.log(`  first: ${JSON.stringify(a)}`);
    console.log(`  second: ${JSON.stringify(b)}`);
    const wins = [a, b].filter((r) => r.ok).length;
    check(wins === 1, 'exactly one of the two dials is accepted');
    check(invites(ua) === 1, `exactly one INVITE leaves the machine (saw ${invites(ua)})`);
    check([a, b].some((r) => !r.ok && r.reason === 'busy'), 'the loser is refused as busy, not queued');
    check(/already being placed/.test([a, b].find((r) => !r.ok)?.error || ''),
      'and says a call is already being placed');
    check(ua.dialing === false, 'and the latch is released once the dial settles');

    // 2. Once that call is over, dialling again must work — the latch is not sticky.
    const live = [...ua.dialogs.values()][0];
    live.end('normal');
    const again = await ua.dial(NUMBER);
    check(again.ok === true, 'a later dial succeeds after the first call ended');
    check(invites(ua) === 2, `and places its own INVITE (saw ${invites(ua)})`);
    [...ua.dialogs.values()].forEach((d) => d.end('normal'));
    ua.close();
  }

  // 3. A preflight that fails must not leave the latch stuck: the operator has to be able to retry.
  {
    const ua = makeUa({ reach: { ok: false, reason: 'timeout', ms: 1500 } });
    const r = await ua.dial(NUMBER);
    check(r.ok === false && r.reason === 'carrier_unreachable', 'an unreachable carrier refuses the call');
    check(invites(ua) === 0, 'and sends no INVITE at all');
    check(ua.dialing === false, 'the latch is released after a failed preflight');

    ua.checkCarrier = async () => ({ ok: true, ms: 1 });
    const retry = await ua.dial(NUMBER);
    check(retry.ok === true, 'so the operator can simply try again');
    check(invites(ua) === 1, 'and that retry does place one INVITE');
    [...ua.dialogs.values()].forEach((d) => d.end('normal'));
    ua.close();
  }

  // 4. A cached challenge means the FIRST INVITE is already authenticated — one INVITE, one ring.
  //    Without it every call was INVITE → 407 → INVITE, and the callee's phone rang for both.
  {
    const ua = makeUa({ preflightMs: 0 });
    ua.authChallenge = {
      challenge: { params: { realm: 'sip.example.test', nonce: 'n-1', qop: 'auth', algorithm: 'MD5' } },
      proxy: true,
    };
    const r = await ua.dial(NUMBER);
    check(r.ok === true, 'the dial is accepted');
    check(invites(ua) === 1, `exactly one INVITE, no 407 round trip (saw ${invites(ua)})`);
    const msg = parse(ua.transport.tx[0].msg);
    const auth = msg.first('proxy-authorization') || '';
    console.log(`  ${auth.slice(0, 74)}…`);
    check(auth.startsWith('Digest '), 'the first INVITE carries Proxy-Authorization');
    check(/nonce="n-1"/.test(auth), 'built from the nonce the carrier issued at REGISTER');
    check(/uri="sip:\+4512345678@sip\.example\.test/.test(auth), "and from this INVITE's own URI");
    check(!msg.first('authorization'), 'and not Authorization, which a proxy ignores (§22.3)');
    [...ua.dialogs.values()].forEach((d) => d.end('normal'));
    ua.close();
  }

  // 5. With nothing cached, no credentials are invented — the 407 path answers the challenge instead.
  {
    const ua = makeUa({ preflightMs: 0 });
    await ua.dial(NUMBER);
    const msg = parse(ua.transport.tx[0].msg);
    check(!msg.first('proxy-authorization') && !msg.first('authorization'),
      'an un-challenged client sends no credentials on the first INVITE');
    check(invites(ua) === 1, 'and that is still one INVITE');
    [...ua.dialogs.values()].forEach((d) => d.end('normal'));
    ua.close();
  }

  assert.strictEqual(failed, 0, `${failed} dial-once check(s) failed`);
  console.log(`\n${failed ? '\u{1F4A5}' : '\u{1F389}'} ${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
