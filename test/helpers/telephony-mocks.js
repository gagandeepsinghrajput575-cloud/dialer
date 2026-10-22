// Shared harness for the telephony chaos suite (test/unit/telephony-chaos-part1/2.test.js).
//
// Two kinds of stand-in live here, and both exist so a check can assert on *real bytes* without a
// carrier, a socket or a browser:
//
//   mockUa()        — a user agent that records instead of sending. Everything a dialog would put on
//                     the wire lands in `transport.sent`, `transport.replies` and `transport.tx`, so
//                     the ACK/BYE/CANCEL checks read actual serialized SIP.
//   protocolWith()  — a control channel whose output is captured in an array instead of stdout.
//   nativeHarness() — the `window.pulseNativeSip` bridge desktop/preload.js would have installed.
//
// Nothing here asserts anything: the invariants belong in the checks, so a failure always names the
// behaviour that broke rather than the fixture that produced it.
'use strict';

const { sipBuf } = require('../../test/unit/telephony-chaos-part1.test.js');

const CRLF = '\r\n';
const text = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b || ''));
const tick = () => new Promise((r) => setImmediate(r));

// The headers of an inbound INVITE from a carrier proxy: compact-free, tagged, with a body.
const INVITE_HEADERS = {
  Via: 'SIP/2.0/UDP 138.197.42.26:5060;branch=z9hG4bKin1;rport',
  From: '"Alice" <sip:alice@atlanta.com>;tag=rem9',
  To: '<sip:15551234567@sip.flynumber.com>',
  'Call-ID': 'in-call-1',
  CSeq: '7 INVITE',
  Contact: '<sip:alice@138.197.42.26:5060>',
  'Content-Type': 'application/sdp',
};

function mockUa(opts = {}) {
  const {
    domain = 'sip.flynumber.com', user = '15551234567', password = 'pw',
    callerId = '+15551234567', mediaPort = 16384,
  } = opts;
  const ua = {
    account: { domain, user, password, callerId, port: 5060 },
    transport: { host: '203.0.113.7', port: 5060, sent: [], replies: [], tx: [], peerHints: new Map() },
    userAgent: 'Pulse Dialer/1.0',
    publicIp: '',
    events: [], ended: [], confirmed: [], logs: [], sockets: 0, acksNoted: 0,
    openMediaSocket: async () => { ua.sockets += 1; return { port: mediaPort }; },
    emit: (ev, data) => ua.events.push({ ev, data }),
    log: (kind, msg) => ua.logs.push(`${kind}: ${msg}`),
    onDialogEnded: (d, info) => ua.ended.push(info),
    onCallConfirmed: (d, res) => ua.confirmed.push({ callId: d.callId, status: res?.status ?? null }),
    startEarlyMedia: () => {},
  };
  const t = ua.transport;
  t.send = async (msg, target) => { t.sent.push({ text: text(msg), target }); return target; };
  t.replyTo = async (req, msg, remote, key) => { t.replies.push({ text: text(msg), remote, key }); return remote; };
  t.noteAck = () => { ua.acksNoted += 1; };
  t.peerFor = (callIdHeader, fallback) => t.peerHints.get(callIdHeader) || fallback;
  t.request = (o) => { t.tx.push(o); return o; };
  // Dialog timers are 32 s each (Timer H / no-answer); a check that leaves one armed would hold the
  // runner's event loop open long after the suite has printed its verdict.
  ua.clearTimers = (d) => { for (const id of d.timers) clearTimeout(id); d.timers.clear(); };
  ua.states = () => ua.events.filter((e) => e.ev === 'state').map((e) => e.data.state);
  return ua;
}

function protocolWith(dispatch) {
  const acted = [];
  const out = [];
  const { Protocol } = require('../../desktop/daemon/lib/protocol');
  const p = new Protocol({
    input: null,
    output: { write: () => {} },
    errorOutput: { write: () => {} },
    onEof: () => {},
    dispatch: (action, msg) => { acted.push({ action, msg }); return dispatch ? dispatch(action, msg) : { ok: true }; },
  });
  p.onOutput = (line) => out.push(line);
  return { p, out, acted, last: () => JSON.parse(out[out.length - 1]) };
}

/** Install (or remove) the preload bridge the renderer engine looks for. */
function nativeHarness(reply = () => ({ ok: true })) {
  const sent = [];
  const stub = {
    available: true,
    command: async (action, payload) => { sent.push([action, payload]); return reply(action, payload); },
    onEvent: () => () => {},
  };
  globalThis.window = { pulseNativeSip: stub };
  return { sent, stub, drop: () => { delete globalThis.window; } };
}

const NATIVE_SESSION = {
  domain: 'sip.flynumber.com', port: 5060, username: '15551234567', callerId: '+15551234567',
  provider: 'flynumber', carrierName: 'FlyNumber', transport: 'udp', wsUrlSource: 'native_daemon',
};

/** Build an engine wired to plain variables, so a check can read what the UI would have seen. */
function makeEngine(native, session = NATIVE_SESSION) {
  const st = {};
  const set = (k) => (v) => { st[k] = v; };
  const fired = [];
  const callbacksRef = {
    current: {
      onActive: (d) => fired.push(['active', d]),
      onEnded: (d) => fired.push(['ended', d]),
      onIncoming: (e) => fired.push(['incoming', e.callId]),
      onIncomingEnded: (e) => fired.push(['incomingEnded', e.reason]),
    },
  };
  const engine = native.createNativeEngine({
    session, callbacksRef, countryCode: '45',
    setState: set('state'), setStandby: set('standby'), setLevel: set('level'), setMuted: set('muted'),
    setError: set('error'), setTarget: set('target'), setDirection: set('direction'),
    setIncomingCall: set('incoming'), setStandbyNote: set('note'), setMicLabel: set('mic'),
  });
  return { engine, st, fired };
}

/** An inbound INVITE datagram, parsed the way the transport would hand it to a dialog. */
function inboundInvite(sdpBody = '') {
  const msg = sipBuf('INVITE sip:15551234567@sip.flynumber.com SIP/2.0', INVITE_HEADERS, sdpBody);
  const sip = require('../../desktop/daemon/lib/sipMessage');
  const parsed = sip.parse(msg);
  parsed.remote = { host: '138.197.42.26', port: 5060 };
  return parsed;
}

// A 200 OK to our INVITE: the peer's tag, its Contact, and the media it wants to use.
function ok200(extra = {}, body = '') {
  const sip = require('../../desktop/daemon/lib/sipMessage');
  return sip.parse(sipBuf('SIP/2.0 200 OK', Object.assign({}, INVITE_HEADERS, {
    To: '<sip:+4520123456@sip.flynumber.com>;tag=srv77',
    Contact: '<sip:fs@138.197.42.26:5060;transport=udp>',
  }, extra), body));
}

/**
 * Place an outbound call and let the INVITE actually reach the (mock) transaction layer.
 * `invite()` awaits the media socket before it serializes, so `tx` only exists after a tick.
 */
async function dial(ua, opts = {}) {
  const { Dialog } = require('../../desktop/daemon/lib/dialog');
  const d = new Dialog(Object.assign({ ua, direction: 'outbound', number: '+4520123456' }, opts));
  const done = d.invite();
  await tick();
  return { d, done, tx: ua.transport.tx[0] };
}

/** mockUa() + dial() in one step: an outbound leg sitting on its first INVITE, awaiting a response. */
async function outbound(opts) {
  const ua = mockUa(opts && opts.ua);
  const leg = await dial(ua, opts);
  return Object.assign({ ua }, leg);
}

/**
 * The native engine needs the preload bridge and nothing else. This installs a stub one, loads the
 * module fresh, builds an engine wired to plain variables, and hands back everything a check reads.
 * `delete globalThis.window` first: a bridge left over from the previous check would hide the
 * "no daemon here" path, which is the one a browser tab actually takes.
 */
async function withNative(reply, session) {
  delete globalThis.window;
  const native = await import('../../src/nativeSip.js');
  const harness = reply ? nativeHarness(reply) : null;
  const built = makeEngine(native, session);
  return Object.assign({ native, harness, sent: harness ? harness.sent : [], drop: () => harness && harness.drop() }, built);
}

/**
 * Run a list of `[n, title, fn]` checks and report them one per line. Shared by both halves of the
 * suite and by the aggregator, so all three print a failure the same way and a part can always be
 * proved on its own with `node test/unit/telephony-chaos-partN.test.js`.
 *
 * @returns {Promise<{passed: number, failed: number, total: number}>}
 */
async function runChecks(checks, label = '') {
  let failed = 0;
  for (const [n, title, run] of checks) {
    try {
      await run();
      console.log(`  ✓ ${n}. ${title}`);
    } catch (e) {
      failed += 1;
      console.log(`  ✗ ${n}. ${title}\n      ${String(e && e.message ? e.message : e).split('\n').slice(0, 5).join('\n      ')}`);
    }
  }
  const passed = checks.length - failed;
  const tag = label ? ` ${label}:` : '';
  console.log(failed ? `\n💥${tag} ${passed}/${checks.length} passed` : `\n🎉${tag} all ${checks.length} checks passed`);
  return { passed, failed, total: checks.length };
}

module.exports = {
  CRLF, tick, text, INVITE_HEADERS, NATIVE_SESSION,
  mockUa, protocolWith, nativeHarness, makeEngine, inboundInvite, sipBuf, ok200, dial, outbound,
  withNative, runChecks,
};
