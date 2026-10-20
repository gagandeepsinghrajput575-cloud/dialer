// Native desktop telephony — Option B (in-app audio shell) + Option E/A (native SIP signalling,
// media handed to the OS softphone).
//
// Everything here runs without Electron: the shell's pure layers (SIP codec, digest, transport,
// user agent, bridge, ledger client, contract descriptor) are exercised against fakes, so the
// phone can be proven on Linux CI while shipping for darwin.
require('../helpers/unit-db');

const assert = require('assert');
const { parse, serialize, header, frame, buildResponse } = require('../../desktop/sip/message');
const { authorization, parseChallenge } = require('../../desktop/sip/digest');
const { buildSdp } = require('../../desktop/sip/sdp');
const { SipTransport } = require('../../desktop/sip/transport');
const { SipUserAgent } = require('../../desktop/sip/ua');
const { TelephonyBridge } = require('../../desktop/bridge');
const { LedgerClient } = require('../../desktop/ledger');
const desktopConfig = require('../../desktop/config');
const { BUILD_METADATA } = require('../../server/config/buildInfo');
const desktopService = require('../../server/services/desktopBridgeService');

console.log('--- Unit: Native macOS desktop telephony (SIP, bridge, ledger, contract) ---');

const USER = 'usertanishkarajput43011498';
const DOMAIN = 'sip.telnyx.com';
const CALLER = '+4532331610';
let NOW = Date.UTC(2026, 9, 20, 9, 0, 0);
const clock = () => NOW;

// ---------------------------------------------------------------------------- SIP primitives
{
  const invite = [
    'INVITE sip:usertanishkarajput43011498@sip.telnyx.com SIP/2.0',
    'Via: SIP/2.0/UDP 203.0.113.9:5060;branch=z9hG4bK-abc;rport',
    'From: "FlyNumber CPH" <sip:+4532331610@sip.telnyx.com>;tag=caller-tag',
    'To: <sip:usertanishkarajput43011498@sip.telnyx.com>',
    'Call-ID: inbound-1@telnyx',
    'CSeq: 7 INVITE',
    'Contact: <sip:+4532331610@203.0.113.9:5060>',
    'Content-Type: application/sdp',
    'Content-Length: 4',
    '',
    'v=0\r\n',
  ].join('\r\n');

  const msg = parse(invite);
  assert.strictEqual(msg.method, 'INVITE');
  assert.strictEqual(msg.uri, 'sip:usertanishkarajput43011498@sip.telnyx.com');
  assert.strictEqual(header(msg, 'call-id'), 'inbound-1@telnyx');
  assert.strictEqual(header(msg, 'cseq'), '7 INVITE');
  assert.match(msg.body, /^v=0/);
  console.log('  ✓ INVITE parsed with headers, CSeq and SDP body');

  const compact = parse('SIP/2.0 180 Ringing\r\nv: SIP/2.0/UDP h;branch=z9hG4bK-1\r\ni: c-1\r\nm: <sip:a@h>\r\nl: 0\r\n\r\n');
  assert.strictEqual(compact.status, 180);
  assert.strictEqual(compact.reason, 'Ringing');
  assert.strictEqual(header(compact, 'via'), 'SIP/2.0/UDP h;branch=z9hG4bK-1');
  assert.strictEqual(header(compact, 'call-id'), 'c-1');
  assert.strictEqual(header(compact, 'content-length'), '0');
  console.log('  ✓ compact header aliases (v/i/m/l) and status line decoded');

  const folded = parse('INVITE sip:x@y SIP/2.0\r\nSubject: hello\r\n world\r\nCall-ID: f1\r\n\r\n');
  assert.strictEqual(header(folded, 'subject'), 'hello world');
  console.log('  ✓ folded header lines unfold, not silently dropped');

  const out = serialize({ startLine: 'OPTIONS sip:sip.telnyx.com SIP/2.0', headers: { 'call-id': 'o1', bodyless: 'yes' }, body: 'abc' });
  assert.match(out, /\r\ncontent-length: 3\r\n\r\nabc$/i, 'serialize computes Content-Length and terminates CRLF');
  assert.ok(out.indexOf('\r\n\r\n') > 0);
  console.log('  ✓ serialiser emits CRLF framing and an accurate Content-Length');

  const response = buildResponse(parse(invite), 180, 'Ringing', { toTag: 'local-tag' });
  assert.match(response, /^SIP\/2\.0 180 Ringing\r\n/);
  assert.match(response, /Call-ID: inbound-1@telnyx/i);
  assert.match(response, /To: <sip:usertanishkarajput43011498@sip\.telnyx\.com>;tag=local-tag/i);
  assert.match(response, /Content-Length: 0/);
  assert.match(response, /From: .*tag=caller-tag/i, 'From tag is echoed, never regenerated');
  console.log('  ✓ in-dialog responses echo Via/Call-ID/CSeq/From and add exactly one To tag');

  const body = 'v=0\r\n\r\nm=audio 0 RTP/AVP 0';
  const first = serialize({ startLine: 'INVITE sip:x@y SIP/2.0', headers: { 'call-id': 'm1' }, body: 'v=0\r\n' });
  const second = serialize({ startLine: 'SIP/2.0 200 OK', headers: { 'call-id': 'm2' }, body });
  const framed = frame(first + second);
  assert.strictEqual(framed.messages.length, 2, 'two complete messages in one datagram');
  assert.match(framed.messages[1], /m=audio 0 RTP\/AVP 0$/);
  assert.strictEqual(framed.rest, '');
  const partial = frame(invite.slice(0, 90));
  assert.strictEqual(partial.messages.length, 0);
  assert.strictEqual(partial.rest, invite.slice(0, 90));
  console.log('  ✓ stream/datagram framing honours Content-Length across split and coalesced reads');
}

// ---------------------------------------------------------------------------- digest auth
{
  // RFC 2617 §3.5 worked example — pins the response hash, not our own arithmetic.
  const challenge = parseChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  assert.strictEqual(challenge.realm, 'testrealm@host.com');
  assert.strictEqual(challenge.qop, 'auth,auth-int');
  const auth = authorization({
    username: 'Mufasa', password: 'Circle Of Life', method: 'GET', uri: '/dir/index.html',
    challenge, cnonce: '0a4f113b', nc: 1,
  });
  assert.match(auth, /response="6629fae49393a05397450978507c4ef1"/, 'RFC 2617 MD5-sess vector');
  assert.match(auth, /qop=auth/);
  assert.match(auth, /nc=00000001/);
  assert.match(auth, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
  console.log('  ✓ RFC 2617 digest response matches the published vector (qop=auth, nc, opaque)');

  const plain = authorization({
    username: 'u', password: 'p', method: 'REGISTER', uri: 'sip:sip.telnyx.com',
    challenge: 'Digest realm="sip.telnyx.com", nonce="n1", algorithm=MD5',
  });
  assert.ok(!/qop=/.test(plain), 'no qop when the server did not offer one');
  assert.match(plain, /algorithm=MD5/);
  console.log('  ✓ legacy no-qop challenge still produces a valid Authorization header');
}

// ---------------------------------------------------------------------------- SDP
{
  const hold = buildSdp({ host: '192.0.2.10', port: 0, sessionId: 42, version: 1 });
  assert.match(hold, /^v=0\r\n/);
  assert.match(hold, /m=audio 0 RTP\/AVP 0 8 101/);
  assert.match(hold, /a=rtpmap:0 PCMU\/8000/);
  assert.match(hold, /a=rtpmap:101 telephone-event\/8000/);
  assert.match(hold, /a=inactive/);
  const live = buildSdp({ host: '192.0.2.10', port: 40000, sessionId: 42, version: 2 });
  assert.match(live, /m=audio 40000 RTP\/AVP/);
  assert.match(live, /a=sendrecv/);
  console.log('  ✓ SDP: hold (port 0) and live media answers, PCMU/PCMA plus RFC 4733 DTMF');
}

// ---------------------------------------------------------------------------- transport
{
  class FakeSocket {
    constructor() { this.handlers = {}; this.sent = []; this.bound = null; this.closed = false; }
    on(event, fn) { (this.handlers[event] = this.handlers[event] || []).push(fn); return this; }
    emit(event, ...args) { (this.handlers[event] || []).forEach((fn) => fn(...args)); }
    bind(port, host) { this.bound = { port, host }; this.emit('listening'); }
    send(buf, port, host, cb) { this.sent.push({ text: String(buf), port, host }); if (cb) cb(); }
    close() { this.closed = true; this.emit('close'); }
    address() { return { port: 5062 }; }
  }
  const socket = new FakeSocket();
  const seen = [];
  const transport = new SipTransport({ host: DOMAIN, port: 5060, createSocket: () => socket, onMessage: (m) => seen.push(m) });
  transport.start();
  assert.deepStrictEqual(socket.bound, { port: 0, host: '0.0.0.0' });
  assert.strictEqual(transport.localPort, 5062);
  transport.send('OPTIONS sip:sip.telnyx.com SIP/2.0\r\n\r\n');
  assert.strictEqual(socket.sent.length, 1);
  assert.strictEqual(socket.sent[0].port, 5060);
  assert.strictEqual(socket.sent[0].host, DOMAIN);
  socket.emit('message', Buffer.from('SIP/2.0 200 OK\r\nCall-ID: a\r\n\r\n'));
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].status, 200);
  transport.stop();
  assert.ok(socket.closed);
  console.log('  ✓ UDP transport binds an ephemeral port, sends to the carrier, parses replies');
}

// ---------------------------------------------------------------------------- harness
const INVITE_HEAD = [
  'INVITE sip:usertanishkarajput43011498@sip.telnyx.com SIP/2.0',
  'Via: SIP/2.0/UDP 203.0.113.9:5060;branch=z9hG4bK-in-1',
  'From: "FlyNumber CPH" <sip:+4532331610@sip.telnyx.com>;tag=caller-tag',
  'To: <sip:usertanishkarajput43011498@sip.telnyx.com>',
  'Call-ID: inbound-1@telnyx',
  'CSeq: 1 INVITE',
  'Contact: <sip:+4532331610@203.0.113.9:5060>',
  'Content-Type: application/sdp',
];

function invite(callId = 'inbound-1@telnyx', from = CALLER, head = INVITE_HEAD) {
  return head
    .map((line) => (line.startsWith('Call-ID:') ? `Call-ID: ${callId}` : line.startsWith('From:') ? `From: "${from}" <sip:${from}@sip.telnyx.com>;tag=caller-tag` : line))
    .concat(['Content-Length: 0', '', '']).join('\r\n');
}

function reply(request, status, reason, extra = {}) {
  const req = typeof request === 'string' ? parse(request) : request;
  const { body = '', ...rest } = extra;
  const to = header(req, 'to');
  return serialize({
    startLine: `SIP/2.0 ${status} ${reason}`,
    headers: {
      via: header(req, 'via'),
      from: header(req, 'from'),
      to: /;tag=/.test(to) ? to : `${to};tag=server-tag`,
      'call-id': header(req, 'call-id'),
      cseq: header(req, 'cseq'),
      ...rest,
    },
    body,
  });
}

function harness({ password = 's3cret', expires = 300 } = {}) {
  const sent = [];
  const events = [];
  const transport = { start() {}, stop() {}, send(text) { sent.push(text); } };
  const ua = new SipUserAgent({
    config: { user: USER, password, domain: DOMAIN, port: 5060, displayName: 'Pulse Dialer' },
    transport,
    now: clock,
    expires,
    onEvent: (e) => events.push(e),
  });
  return { ua, sent, events, transport };
}

const lastRequest = (sent, method) => [...sent].reverse().find((m) => new RegExp(`^${method} `).test(m)) || '';
const responses = (sent, status) => sent.filter((m) => m.startsWith(`SIP/2.0 ${status} `));

// ---------------------------------------------------------------------------- registration
{
  const { ua, sent, events } = harness();
  ua.start();
  assert.strictEqual(parse(sent[0]).method, 'REGISTER');
  assert.strictEqual(header(parse(sent[0]), 'to'), `<sip:${USER}@${DOMAIN}>`);
  assert.match(header(parse(sent[0]), 'contact'), new RegExp(`sip:${USER}@`));
  console.log('  ✓ REGISTER addressed to sip.telnyx.com with the credential user and a local Contact');

  ua.handle(reply(sent[0], 401, 'Unauthorized', { 'www-authenticate': 'Digest realm="sip.telnyx.com", nonce="nonce-1", qop="auth", algorithm=MD5' }));
  const authed = lastRequest(sent, 'REGISTER');
  assert.match(authed, /^Authorization: Digest /m);
  assert.match(authed, new RegExp(`username="${USER}"`));
  assert.match(authed, /uri="sip:sip\.telnyx\.com"/);
  assert.ok(parse(authed).headers['cseq'].split(' ')[0] > parse(sent[0]).headers['cseq'].split(' ')[0], 'CSeq must advance on the retry');
  console.log('  ✓ 401 challenge answered with digest credentials and an incremented CSeq');

  ua.handle(reply(authed, 200, 'OK', { contact: `<sip:${USER}@192.0.2.5:5062>;expires=300` }));
  assert.strictEqual(ua.registered, true);
  assert.ok(events.some((e) => e.type === 'registration' && e.state === 'registered'));
  assert.ok(ua.refreshAt > NOW, 'a refresh must be booked before the registration expires');
  ua.stop();
  console.log('  ✓ 200 OK marks the agent registered and books the refresh before expiry');

  const bad = harness();
  bad.ua.start();
  bad.ua.handle(reply(bad.sent[0], 403, 'Forbidden'));
  assert.strictEqual(bad.ua.registered, false);
  assert.ok(bad.events.some((e) => e.type === 'registration' && e.state === 'failed'));
  assert.strictEqual(bad.sent.filter((m) => m.startsWith('REGISTER ')).length, 1, 'no infinite auth loop on 403');
  bad.ua.stop();
  console.log('  ✓ carrier rejection fails closed — one attempt, no credential-loop');
}

// ---------------------------------------------------------------------------- inbound lifecycle
{
  const { ua, sent, events } = harness();
  ua.start();
  sent.length = 0;
  ua.handle(invite());

  assert.strictEqual(responses(sent, 100).length, 1);
  const ringing = responses(sent, 180)[0];
  assert.ok(ringing, '180 Ringing must be sent immediately (SBC 10 s timer)');
  assert.strictEqual(header(parse(ringing), 'call-id'), 'inbound-1@telnyx');
  const incoming = events.find((e) => e.type === 'incoming');
  assert.strictEqual(incoming.callerPhone, CALLER);
  assert.strictEqual(ua.call.direction, 'inbound');
  assert.strictEqual(ua.call.state, 'ringing');
  console.log('  ✓ INVITE answered with 100 + 180 inside the ring window, caller resolved');

  assert.strictEqual(ua.answer(), true);
  const ok = responses(sent, 200)[0];
  assert.ok(ok, 'answer sends 200 OK');
  assert.match(ok, /Content-Type: application\/sdp/i);
  assert.match(ok, /m=audio 0 RTP\/AVP/);
  assert.ok(events.some((e) => e.type === 'answered' && e.direction === 'inbound'));
  assert.strictEqual(ua.answer(), false, 'a second answer is refused, not a second 200');
  console.log('  ✓ answer is one-shot: 200 OK carries the media answer, duplicate answers refused');

  assert.strictEqual(ua.dtmf('5'), true);
  const info = lastRequest(sent, 'INFO');
  assert.match(info, /Content-Type: application\/dtmf-relay/i);
  assert.match(info, /Signal=5\r?\n/m);
  assert.strictEqual(ua.dtmf('X'), false, 'non-DTMF characters never reach the carrier');
  console.log('  ✓ RFC 2976 INFO DTMF with digit validation');

  NOW += 42_000;
  ua.handle(reply(info, 200, 'OK'));
  const bye = serialize({
    startLine: 'BYE sip:pulse@192.0.2.5:5062 SIP/2.0',
    headers: {
      via: 'SIP/2.0/UDP 203.0.113.9:5060;branch=z9hG4bK-bye',
      from: `<sip:${CALLER}@${DOMAIN}>;tag=caller-tag`,
      to: `<sip:${USER}@${DOMAIN}>;tag=local-tag`,
      'call-id': 'inbound-1@telnyx',
      cseq: '2 BYE',
    },
  });
  ua.handle(bye);
  const ended = events.find((e) => e.type === 'ended');
  assert.strictEqual(ended.reason, 'remote');
  assert.strictEqual(ended.durationSec, 42);
  assert.strictEqual(responses(sent, 200).length, 2, 'INVITE 200 and BYE 200 are both sent');
  assert.strictEqual(ua.call, null);
  console.log('  ✓ remote BYE acknowledged, call closed with an honest 42-second duration');
}

// ---------------------------------------------------------------------------- decline + cancel race
{
  const { ua, sent, events } = harness();
  ua.start();
  sent.length = 0;
  ua.handle(invite());
  assert.strictEqual(ua.decline(), true);
  assert.strictEqual(responses(sent, 486).length, 1);
  const ended = events.filter((e) => e.type === 'ended');
  assert.strictEqual(ended.length, 1);
  assert.strictEqual(ended[0].reason, 'declined');
  assert.strictEqual(ua.decline(), false);
  console.log('  ✓ decline sends 486 Busy Here exactly once');

  const cancelled = harness();
  cancelled.ua.start();
  cancelled.sent.length = 0;
  cancelled.ua.handle(invite('race@telnyx'));
  const cancel = serialize({
    startLine: 'CANCEL sip:usertanishkarajput43011498@sip.telnyx.com SIP/2.0',
    headers: {
      via: 'SIP/2.0/UDP 203.0.113.9:5060;branch=z9hG4bK-in-1',
      from: header(parse(invite('race@telnyx')), 'from'),
      to: header(parse(invite('race@telnyx')), 'to'),
      'call-id': 'race@telnyx',
      cseq: '1 CANCEL',
    },
  });
  cancelled.ua.handle(cancel);
  assert.strictEqual(responses(cancelled.sent, 200).length, 1, 'CANCEL itself is 200 OK');
  assert.strictEqual(responses(cancelled.sent, 487).length, 1, 'its INVITE is 487 Request Terminated');
  cancelled.ua.handle(cancel);
  assert.strictEqual(cancelled.events.filter((e) => e.type === 'ended').length, 1, 'teardown is idempotent');
  console.log('  ✓ CANCEL race: 200 + 487, one ended event even when the CANCEL is retried');
}

// ---------------------------------------------------------------------------- outbound
{
  const { ua, sent, events } = harness();
  ua.start();
  sent.length = 0;
  const dialled = ua.dial({ phone: '+4520123456', callerId: CALLER });
  assert.strictEqual(dialled.ok, true);
  const inviteMsg = lastRequest(sent, 'INVITE');
  assert.match(inviteMsg, /^INVITE sip:\+4520123456@sip\.telnyx\.com SIP\/2\.0/);
  assert.ok(inviteMsg.includes(`From: "Pulse Dialer" <sip:${CALLER}@`), 'caller ID is stamped verbatim (no regex quantifier trap)');
  assert.strictEqual(ua.call.direction, 'outbound');
  console.log('  ✓ dial addresses the Telnyx SIP URI, stamps the Copenhagen caller ID');

  ua.handle(reply(inviteMsg, 100, 'Trying'));
  ua.handle(reply(inviteMsg, 180, 'Ringing'));
  assert.strictEqual(events.filter((e) => e.type === 'ringing').length, 1);
  ua.handle(reply(inviteMsg, 200, 'OK', { 'content-type': 'application/sdp', body: buildSdp({ host: '203.0.113.9', port: 40002, sessionId: 1, version: 1 }) }));
  assert.strictEqual(ua.call.state, 'connected');
  assert.strictEqual(lastRequest(sent, 'ACK').startsWith('ACK '), true);
  assert.ok(events.some((e) => e.type === 'answered' && e.direction === 'outbound'));
  NOW += 5_000;
  assert.strictEqual(ua.hangup(), true);
  assert.strictEqual(lastRequest(sent, 'BYE').startsWith('BYE '), true);
  const ended = events.find((e) => e.type === 'ended');
  assert.strictEqual(ended.reason, 'local');
  assert.strictEqual(ended.durationSec, 5);
  console.log('  ✓ outbound: INVITE → 180 → 200 → ACK → connected → BYE with duration');

  const rejected = harness();
  rejected.ua.start();
  rejected.sent.length = 0;
  rejected.ua.dial({ phone: '+4520123456' });
  rejected.ua.handle(reply(lastRequest(rejected.sent, 'INVITE'), 486, 'Busy Here'));
  assert.ok(rejected.events.some((e) => e.type === 'ended' && e.reason === 'rejected'));
  console.log('  ✓ rejected outbound INVITE closes the call instead of ringing forever');
}

// ---------------------------------------------------------------------------- bridge + ledger
(async () => {
  class FakeUa {
    constructor() { this.listeners = new Set(); this.call = null; this.commands = []; }
    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(event) { this.listeners.forEach((fn) => fn(event)); }
    dial(payload) { this.commands.push(['dial', payload]); return { ok: true, callId: 'out-1' }; }
    answer() { this.commands.push(['answer']); this.call = { state: 'connected' }; this.emit({ type: 'answered', direction: 'inbound', callId: 'in-9' }); return true; }
    decline() { this.commands.push(['decline']); return true; }
    hangup() { this.commands.push(['hangup']); return true; }
    dtmf(digit) { this.commands.push(['dtmf', digit]); return true; }
  }
  const ledgerCalls = [];
  const ledger = {
    inbound: async (p) => { ledgerCalls.push(['inbound', p]); return { callId: 77, prospect: { id: 1 } }; },
    answered: async (id) => { ledgerCalls.push(['answered', id]); },
    ended: async (id, d) => { ledgerCalls.push(['ended', id, d]); },
    missed: async (id, d) => { ledgerCalls.push(['missed', id, d]); },
  };
  const emitted = [];
  const forwarded = [];
  const ua = new FakeUa();
  const bridge = new TelephonyBridge({ ua, ledger, emit: (e) => emitted.push(e), forward: (action, payload) => forwarded.push([action, payload]), now: clock, handoff: (uri) => forwarded.push(['open-softphone', uri]) });
  bridge.start();

  ua.emit({ type: 'incoming', callerPhone: CALLER, callId: 'in-9', at: NOW });
  assert.ok(emitted.some((e) => e.type === 'incoming_call' && e.callerPhone === CALLER && e.callId === 'in-9'));
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(ledgerCalls[0], ['inbound', { callerPhone: CALLER }]);
  assert.strictEqual(bridge.status().callId, 77, 'ledger id is adopted for later transitions');

  bridge.answer();
  assert.deepStrictEqual(ua.commands[0], ['answer']);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(ledgerCalls[1], ['answered', 77]);

  NOW += 30_000;
  ua.emit({ type: 'ended', callId: 'in-9', reason: 'remote', durationSec: 30, direction: 'inbound' });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(ledgerCalls[2], ['ended', 77, { reason: 'remote', durationSec: 30 }]);
  assert.ok(emitted.some((e) => e.type === 'ended' && e.durationSec === 30));
  console.log('  ✓ bridge maps INVITE/answer/BYE onto incoming_call → answered → ended and the ledger');

  bridge.dial({ phone: '+4520123456', callerId: CALLER });
  assert.deepStrictEqual(ua.commands.at(-1), ['dial', { phone: '+4520123456', callerId: CALLER }]);
  bridge.dtmf({ digit: '9' });
  assert.deepStrictEqual(ua.commands.at(-1), ['dtmf', '9']);
  const fallback = bridge.openSoftphone('+4520123456');
  assert.strictEqual(fallback.uri, `sip:+4520123456@${DOMAIN}`);
  assert.deepStrictEqual(forwarded.at(-1), ['open-softphone', `sip:+4520123456@${DOMAIN}`]);
  console.log('  ✓ dial/DTMF forwarded to the engine; Option E/A opens Linphone with a full SIP URI');

  // A signalling-only engine must never answer into a silent call. Answering hands the caller
  // to Linphone and releases Pulse's fork; dialling hands the number over before it invites.
  const silentUa = new FakeUa();
  const handoffs = [];
  const silent = new TelephonyBridge({
    ua: silentUa, ledger: null, media: false,
    handoff: (uri) => handoffs.push(uri), emit: () => {},
  });
  silent.start();
  const outboundHandoff = silent.dial({ phone: '+4520123456' });
  assert.strictEqual(outboundHandoff.handoff, true);
  assert.strictEqual(handoffs.at(-1), `sip:+4520123456@${DOMAIN}`);
  silentUa.emit({ type: 'incoming', callerPhone: CALLER, callId: 'in-10' });
  const answered = silent.answer();
  assert.strictEqual(answered.ok, false);
  assert.strictEqual(answered.reason, 'no-media-engine');
  assert.strictEqual(answered.handoff, `sip:${CALLER}@${DOMAIN}`, 'the UI is told which URI to open');
  assert.strictEqual(silentUa.commands.some((c) => c[0] === 'decline'), false, 'answering never rejects the call');
  console.log('  ✓ signalling-only mode refuses to fake an answer and never declines the caller');

// ---------------------------------------------------------------------------- ledger client
{
  const requests = [];
  const fetchImpl = async (url, opts = {}) => {
    requests.push({ url, opts });
    if (url.endsWith('/api/session')) return { ok: true, status: 200, json: async () => ({ token: 'session-token-123' }) };
    if (url.includes('/api/calls/inbound')) return { ok: true, status: 200, json: async () => ({ callId: 12, prospect: { id: 3 } }) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const ledger = new LedgerClient({ baseUrl: 'http://127.0.0.1:3001', fetchImpl });
  const inbound = await ledger.inbound({ callerPhone: CALLER });
  assert.strictEqual(inbound.callId, 12);
  await ledger.answered(12);
  await ledger.ended(12, { reason: 'remote', durationSec: 30 });
  await ledger.missed(12, { reason: 'missed' });

  const tokenCall = requests.filter((r) => r.url.endsWith('/api/session'));
  assert.strictEqual(tokenCall.length, 1, 'the session token is fetched once and reused');
  for (const r of requests.filter((x) => !x.url.endsWith('/api/session'))) {
    assert.strictEqual(r.opts.headers['x-pulse-token'], 'session-token-123', 'every ledger write carries the token');
    assert.ok(r.url.startsWith('http://127.0.0.1:3001/api/'), 'writes stay on loopback');
  }
  const answered = requests.find((r) => r.url.endsWith('/api/calls/12') && r.opts.method === 'PATCH');
  assert.deepStrictEqual(JSON.parse(answered.opts.body), { status: 'connected' });
  const ended = requests.filter((r) => r.url.endsWith('/api/calls/12'))[1];
  assert.deepStrictEqual(JSON.parse(ended.opts.body), { status: 'completed', duration_sec: 30, outcome: 'conversation' });
  const missed = requests.at(-1);
  assert.match(missed.url, /\/api\/calls\/12\/missed$/);
  assert.deepStrictEqual(JSON.parse(missed.opts.body), { reason: 'missed', duration_sec: 0 });
  console.log('  ✓ ledger client: token once, loopback only, connected/completed/missed transitions');
}

// ---------------------------------------------------------------------------- contract + watermark
{
  assert.strictEqual(desktopConfig.CARRIER.user, USER);
  assert.strictEqual(desktopConfig.CARRIER.domain, DOMAIN);
  assert.strictEqual(desktopConfig.CARRIER.port, 5060);
  assert.strictEqual(desktopConfig.CARRIER.did, '+4532331610');
  assert.strictEqual(desktopConfig.sipUri('+4520123456'), 'sip:+4520123456@sip.telnyx.com');
  assert.strictEqual(desktopConfig.telUri('+4520123456'), 'tel:+4520123456');
  assert.deepStrictEqual(desktopConfig.parseDeepLink('pulse://dial?number=%2B4520123456'), { action: 'dial', phone: '+4520123456' });
  assert.strictEqual(desktopConfig.parseDeepLink('pulse://hangup'), null, 'only an explicit dial deep-link is honoured');
  assert.strictEqual(desktopConfig.parseDeepLink('pulse://dial?number=<script>'), null, 'deep links cannot inject');
  console.log('  ✓ carrier constants, SIP/tel URIs and a validating pulse:// parser');

  assert.strictEqual(BUILD_METADATA.version, '1.0.0-native');
  assert.strictEqual(BUILD_METADATA.targetRuntime, 'darwin-coreaudio-native');
  assert.ok(BUILD_METADATA.engineSignature && BUILD_METADATA.engineSignature.length > 4);
  assert.ok(!Number.isNaN(Date.parse(BUILD_METADATA.buildTimestamp)));
  console.log('  ✓ build watermark: version, engine signature and darwin runtime target');

  const descriptor = desktopService.descriptor();
  assert.strictEqual(descriptor.runtime, 'darwin-coreaudio-native');
  assert.strictEqual(descriptor.sip.host, DOMAIN);
  assert.strictEqual(descriptor.sip.port, 5060);
  assert.strictEqual(descriptor.sip.user, USER);
  assert.strictEqual(descriptor.inbound.did, '+4532331610');
  assert.strictEqual(descriptor.inbound.forwardingUri, `sip:${USER}@${DOMAIN}:5060`);
  assert.deepStrictEqual(descriptor.engines.map((e) => e.id), ['webrtc', 'native-sip', 'linphone']);
  assert.strictEqual(descriptor.fallback.linphone.username, USER);
  assert.strictEqual(descriptor.fallback.linphone.domain, `${DOMAIN}:5060`);
  assert.strictEqual(descriptor.fallback.linphone.transport, 'udp');
  assert.strictEqual(descriptor.fallback.linphone.callerId, '+45 32 33 16 10');
  assert.ok(!JSON.stringify(descriptor).match(/password|secret/i), 'the descriptor never carries a credential');
  assert.strictEqual(descriptor.guards.sessionHeader, 'x-pulse-token');
  console.log('  ✓ desktop descriptor: carrier endpoints, three engines, Linphone fallback, zero secrets');
}

console.log('\n🎉 [unit:desktop] all desktop telephony checks passed successfully!\n');
})().catch((err) => { console.error(err); process.exit(1); });
