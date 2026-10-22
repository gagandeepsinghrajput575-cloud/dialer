// The call path, end to end: registration, both INVITE directions, hang-up, re-INVITE, media.
//
// Every check here was a confirmed defect, found by probing the real modules and quoted in
// .agents/rfcs/call-path-bug-sweep.md. They are the faults that do not show up in a unit test of a
// single function, because each one is a contract *between* two: `end()` and `cancel()`, `register()`
// and `failRegistration()`, the busy guard and the moment `active` is assigned.
//
// What they have in common is that the app looks healthy while the call is broken. Nothing throws.
// The daemon reports `ended`, the UI clears, and somewhere a customer's phone is still ringing.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON test/unit/call-path.test.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const M = require('../helpers/telephony-mocks');
const sip = require('../../desktop/daemon/lib/sipMessage');
const sdp = require('../../desktop/daemon/lib/sdp');
const registration = require('../../desktop/daemon/lib/register');
const { UserAgent } = require('../../desktop/daemon/lib/ua');
const nullAudio = require('../../desktop/daemon/lib/audio/null');

const ok = (v, m) => assert.ok(v, m);
const ck = (a, b, m) => assert.deepStrictEqual(a, b, m);

/** A real UserAgent on a transport that records bytes instead of sending them. */
function liveUa(opts = {}) {
  const t = new EventEmitter();
  t.host = '203.0.113.7'; t.port = 5060; t.localAddress = '0.0.0.0';
  t.sent = []; t.replies = []; t.tx = []; t.peerHints = new Map();
  t.send = async (m, target) => { t.sent.push(String(m)); return target; };
  t.replyTo = async (req, m) => { t.replies.push(String(m)); return null; };
  t.request = (o) => { t.tx.push(o); return o; };
  t.noteAck = () => {}; t.close = () => {};
  t.peerFor = (c, fb) => t.peerHints.get(c) || fb;
  const ua = new UserAgent(Object.assign({
    transport: t, audio: nullAudio.create(), log: () => {},
    account: { domain: 'sip.flynumber.com', user: '15551234567', password: 'pw', callerId: '+15551234567' },
  }, opts));
  ua.ev = [];
  for (const e of ['registered', 'unregistered', 'registering', 'registration_failed', 'connected',
    'ended', 'error', 'media_timeout', 'incoming', 'ringing', 'rejected_incoming']) {
    ua.on(e, (d) => ua.ev.push([e, d]));
  }
  ua.startLines = () => t.sent.concat(t.replies).map((m) => m.split('\r\n')[0]);
  ua.reasons = () => ua.ev.filter((e) => e[0] === 'ended').map((e) => e[1] && e[1].reason);
  ua.cleanup = () => { try { ua.stopPump(); } catch { /* nothing running */ } };
  return ua;
}

/** A registration-only agent: the real register.js on a recording transport. */
function regUa() {
  const t = new EventEmitter();
  t.host = '203.0.113.7'; t.port = 5060;
  t.tx = [];
  t.request = (o) => { t.tx.push(o); return o; };
  const ua = {
    transport: t, tx: t.tx, cseq: 1, ev: [], log: () => {}, validateAccount: () => [],
    account: { domain: 'sip.flynumber.com', user: '15551234567', password: 'pw', port: 5060, expires: 300 },
    userAgent: 'PulseSIP/1.0',
  };
  ua.emit = (n, d) => ua.ev.push([n, d]);
  registration.attach(ua);
  return ua;
}

const ok200Expires = (v) => ({ status: 200, reason: 'OK', first: (h) => (h.toLowerCase() === 'expires' ? String(v) : '') });

/** Capture every delay a retry ladder asks for, without waiting any of them out. */
function captureDelays(fn) {
  const delays = []; const cbs = [];
  const real = global.setTimeout;
  global.setTimeout = (f, ms) => { delays.push(ms); cbs.push(f); return { unref() {} }; };
  try { fn(cbs); } finally { global.setTimeout = real; }
  return delays;
}

/** An inbound INVITE, and a re-INVITE on the same Call-ID with a fresh branch and CSeq. */
function inbound(body = '', callIdHeader = 'in-call-1') {
  const msg = sip.parse(M.sipBuf('INVITE sip:15551234567@sip.flynumber.com SIP/2.0',
    Object.assign({}, M.INVITE_HEADERS, { 'Call-ID': callIdHeader }), body));
  msg.remote = { host: '138.197.42.26', port: 5060 };
  return msg;
}
function reinvite(body, callIdHeader = 'in-call-1') {
  const msg = sip.parse(M.sipBuf('INVITE sip:15551234567@sip.flynumber.com SIP/2.0',
    Object.assign({}, M.INVITE_HEADERS, {
      'Call-ID': callIdHeader, CSeq: '8 INVITE',
      Via: 'SIP/2.0/UDP 138.197.42.26:5060;branch=z9hG4bKin2;rport',
    }), body));
  msg.remote = { host: '138.197.42.26', port: 5060 };
  return msg;
}
const CTX = { reply: () => {} };

const checks = [
  [1, 'unregister releases the phone instead of taking out a new 300 s registration', async () => {
    const ua = regUa();
    ua.registration.state = 'registered';
    ua.unregister();
    ua.tx[ua.tx.length - 1].onFinal(ok200Expires(0));       // the carrier confirms Expires: 0
    ck(ua.ev.map((e) => e[0]), ['registering', 'unregistered'], 'one release, reported once');
    ck(ua.registration.state, 'unregistered');
    ck(ua.registration.expires, 0, 'a granted 0 is a value, not an absence');
    ck(ua.registration.timer, null, 'and nothing is armed to take the registration back');
  }],

  [2, 'a granted Expires is honoured, and 300 still registers normally', async () => {
    const ua = regUa();
    const delays = captureDelays((cbs) => {
      ua.sendRegister(300, null);
      ua.tx[ua.tx.length - 1].onFinal(ok200Expires(120));   // the carrier grants less than we asked
    });
    ck(ua.registration.state, 'registered');
    ck(ua.registration.expires, 120, 'the granted lifetime wins over the requested one');
    ck(ua.ev.map((e) => e[0]), ['registering', 'registered']);
    ok(delays.length === 1 && delays[0] === 96000, `refresh at 80% of 120 s, got ${delays}`);
    ua.stopRegistrationTimer();
    // A missing Expires header must still fall back, not become NaN.
    const u2 = regUa();
    u2.sendRegister(300, null);
    u2.tx[u2.tx.length - 1].onFinal({ status: 200, reason: 'OK', first: () => '' });
    ck(u2.registration.expires, 300);
    u2.stopRegistrationTimer();
  }],

  [3, 'a failing registration backs off 5/10/20/45 and caps instead of hammering every 5 s', async () => {
    const ua = regUa();
    const delays = captureDelays((cbs) => {
      for (let i = 0; i < 5; i += 1) {
        ua.failRegistration(`403 attempt ${i}`);
        const cb = cbs[cbs.length - 1];
        if (cb) cb();                                        // the retry timer firing
      }
    });
    ck(delays, [5000, 10000, 20000, 45000, 45000], 'climbs the ladder, then caps');
    ck(ua.registration.attempt, 5, 'the counter survives the retry it drives');
  }],

  [4, 'a human pressing register after failures starts the backoff over', async () => {
    const ua = regUa();
    ua.registration.attempt = 3;
    captureDelays(() => ua.register({ expires: 300 }));
    ck(ua.registration.attempt, 0, 'a deliberate retry must not inherit the ladder');
  }],

  [5, 'hanging up while the customer is ringing sends CANCEL', async () => {
    const ua = liveUa();
    const r = await ua.dial('+4520123456');
    await M.tick(); await M.tick();
    const d = ua.dialogs.get(r.callId);
    ck(d.state, 'calling');
    await ua.hangup(r.callId);
    await M.tick(); await M.tick();
    const lines = ua.startLines();
    ok(lines.some((l) => /^CANCEL /.test(l)), `no CANCEL went out: ${JSON.stringify(lines)}`);
    ok(!lines.some((l) => /^BYE /.test(l)), 'a call that was never answered is cancelled, not bye-d');
    ck(ua.reasons(), ['canceled']);
    const cancel = lines.find((l) => /^CANCEL /.test(l));
    ok(/CANCEL sip:\+4520123456@/.test(cancel), cancel);
    ua.cleanup();
  }],

  [6, 'hanging up a connected call still sends BYE and never CANCEL', async () => {
    const ua = liveUa();
    const r = await ua.dial('+4520123456');
    await M.tick(); await M.tick();
    const d = ua.dialogs.get(r.callId);
    d.state = 'confirmed';                                   // the 200 OK landed
    ua.transport.sent.length = 0;
    await ua.hangup(r.callId);
    await M.tick(); await M.tick();
    const lines = ua.startLines();
    ok(lines.some((l) => /^BYE /.test(l)), `no BYE went out: ${JSON.stringify(lines)}`);
    ok(!lines.some((l) => /^CANCEL /.test(l)), 'CANCEL on a confirmed call is a protocol error');
    ck(ua.reasons(), ['normal']);
    ua.cleanup();
  }],

  [7, 'hanging up a ringing inbound call tells the caller 603 Decline', async () => {
    const ua = liveUa();
    await ua.onRequest(inbound(), CTX);
    await M.tick(); await M.tick();
    const d = [...ua.dialogs.values()][0];
    ck(d.state, 'proceeding', '180 Ringing is out');
    ok(ua.startLines().some((l) => /180 Ringing/.test(l)));
    await ua.hangup(d.id);
    await M.tick(); await M.tick();
    ok(ua.startLines().some((l) => /603 Decline/.test(l)),
      `the caller was left ringing: ${JSON.stringify(ua.startLines())}`);
    ck(ua.reasons(), ['rejected'], 'a human declined, which is not the same as busy');
    ua.cleanup();
  }],

  [8, 'a missed ring and an explicit decline still answer 486 Busy Here', async () => {
    const ua = liveUa();
    await ua.onRequest(inbound('', 'in-call-486'), CTX);
    await M.tick(); await M.tick();
    const d = [...ua.dialogs.values()][0];
    const sent = await d.reject(486);
    await M.tick();
    ck(sent, true);
    ok(ua.startLines().some((l) => /486 Busy Here/.test(l)));
    ck(ua.reasons(), ['busy']);
    ck(await d.reject(486), false, 'a refusal is sent once');
    ck(await d.answer(), false, 'and cannot be answered afterwards');
    ua.cleanup();
  }],

  [9, 'a second INVITE while the first is ringing is refused and never rings twice', async () => {
    const ua = liveUa();
    await ua.onRequest(inbound('', 'in-call-a'), CTX);
    await M.tick(); await M.tick();
    ck(ua.dialogs.size, 1, 'the first leg is ringing, not yet active');
    ck(ua.active, null, '`active` is only set on the 200 OK — the old guard tested nothing here');
    const replies = [];
    await ua.onRequest(inbound('', 'in-call-b'), { reply: (m) => replies.push(String(m)) });
    await M.tick();
    ck(ua.dialogs.size, 1, 'one sound card, one call');
    ok(replies.some((m) => /^SIP\/2\.0 486 Busy Here/.test(m)), 'the second caller is told busy');
    ck(ua.ev.filter((e) => e[0] === 'incoming').length, 1, 'the operator sees one incoming call');
    ck(ua.ev.filter((e) => e[0] === 'rejected_incoming').length, 1);
    ua.cleanup();
  }],

  [10, 'once the first call is over the line is free again', async () => {
    const ua = liveUa();
    await ua.onRequest(inbound('', 'in-call-c'), CTX);
    await M.tick(); await M.tick();
    const d = [...ua.dialogs.values()][0];
    await ua.hangup(d.id);
    await M.tick(); await M.tick();
    ck(ua.dialogs.size, 0, 'a terminated leg is removed, so it cannot block the next one');
    ck(ua.standingCall(), null);
    await ua.onRequest(inbound('', 'in-call-d'), CTX);
    await M.tick();
    ck(ua.dialogs.size, 1, 'the next caller rings');
    ck(ua.ev.filter((e) => e[0] === 'incoming').length, 2, 'both callers rang — one after the other');
    ua.cleanup();
  }],

  [11, 'an outbound dial on top of a ringing inbound call is refused', async () => {
    const ua = liveUa();
    await ua.onRequest(inbound('', 'in-call-e'), CTX);
    await M.tick(); await M.tick();
    const r = await ua.dial('+4520123456');
    ck(r.ok, false); ck(r.reason, 'busy');
    ck(ua.dialogs.size, 1, 'no second leg was created');
    ok(!ua.startLines().some((l) => /^INVITE /.test(l)), 'nothing was put on the wire');
    ua.cleanup();
  }],

  [12, 'a re-INVITE is answered with SDP, because a 200 OK without it means "my media is gone"', async () => {
    const ua = liveUa();
    await ua.onRequest(inbound('', 'in-call-re'), CTX);
    await M.tick(); await M.tick();
    const d = [...ua.dialogs.values()][0];
    ok(await d.answer(), 'the call is answered first, so there is media to renegotiate');
    await M.tick();
    ok(d.media && d.media.port > 0, 'answering opened a media socket');
    const offer = sdp.build({ ip: '138.197.42.26', port: 30000, sessionId: '99' });
    const replies = [];
    await ua.onRequest(reinvite(offer, 'in-call-re'), { reply: (m) => replies.push(String(m)) });
    await M.tick(); await M.tick();

    const raw = replies[replies.length - 1];
    ok(raw, `the re-INVITE was not answered at all (wire: ${JSON.stringify(ua.startLines())})`);
    ok(!replies.some((m) => /^SIP\/2\.0 486/.test(m)),
      'a re-INVITE from the same caller must not be treated as a second caller');
    ok(/^SIP\/2\.0 200 OK/.test(raw), raw.split('\r\n')[0]);
    ok(/content-type:\s*application\/sdp/i.test(raw), `no Content-Type: ${raw.split('\r\n').slice(0, 12).join(' | ')}`);
    ok(/m=audio \d+ RTP\/AVP/.test(raw), `no media line in the answer: ${raw.slice(-200)}`);
    ok(raw.includes(`m=audio ${d.media.port}`), 'the answer names the port we are actually listening on');
    const answered = sdp.parse(raw.slice(raw.indexOf('\r\n\r\n') + 4));
    ck(answered.port, d.media.port);
    ck(d.remoteSdp.port, 30000, 'their new offer was parsed, not ignored');
    ua.cleanup();
  }],

  [13, 'end() can put a refusal on the wire at all — the ordering bug behind checks 5 and 7', async () => {
    // end() set `ended = true` before calling cancel()/reject(), and both refuse an ended dialog.
    // So the missed-call timer, which is end('missed', { sendReject: 486 }), sent nothing either.
    const ua = liveUa();
    await ua.onRequest(inbound('', 'in-call-order'), CTX);
    await M.tick(); await M.tick();
    const d = [...ua.dialogs.values()][0];
    ua.transport.replies.length = 0;
    d.end('missed', { sendReject: 486 });
    await M.tick(); await M.tick();
    ok(ua.startLines().some((l) => /486 Busy Here/.test(l)),
      `end() swallowed the refusal: ${JSON.stringify(ua.startLines())}`);
    ck(ua.reasons(), ['missed'], 'and the reason end() was given wins, not reject()\'s own');
    ck(ua.ev.filter((e) => e[0] === 'ended').length, 1, 'exactly one ended event, re-entrancy included');
    ua.cleanup();
  }],
];

async function main() {
  console.log('--- Unit: the call path (registration, INVITE both ways, hang-up, re-INVITE) ---');
  const r = await M.runChecks(checks, '[unit:call-path]');
  if (r.failed) console.log(`\n💥 ${r.failed} check(s) failed`);
  return r;
}

if (require.main === module) {
  main().then((r) => {
    if (!r.failed) console.log('\n🎉 [unit:call-path] all checks passed');
    process.exit(r.failed ? 1 : 0);            // media sockets and dialog timers would otherwise hold the loop
  }).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { checks, main };
