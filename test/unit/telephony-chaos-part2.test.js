// Telephony chaos suite, part 2 of 2 (checks 29-60): the control channel, the dialog, the renderer
// engine. Part 1 (1-28) covers the wire libraries; telephony-chaos-stress.test.js aggregates both.
//
// What decides whether a call survives a real carrier: the control channel must answer every command
// and never die on a bad line (the supervisor reads silence as a hung daemon and restarts it
// mid-call); a dialog must build an ACK whose To: is the 200 OK's To: verbatim, aimed where the
// response came from — FreeSWITCH severs a call with BYE four seconds after answer when it does not
// match (RFC 3261 §12.2.1.1, Timer H) — and a 407 must be answered with Proxy-Authorization (§22.4).
// The native engine must report the browser engine's contract, so Dialer.jsx never learns which one
// is driving. Fixtures live in test/helpers/telephony-mocks.js: every line below is an assertion.
'use strict';

const assert = require('assert');
const { ACTIONS } = require('../../desktop/daemon/lib/protocol');
const sip = require('../../desktop/daemon/lib/sipMessage');
const sdp = require('../../desktop/daemon/lib/sdp');
const M = require('../helpers/telephony-mocks');
const { STATES, parseTag, contactUri, ackKey, reasonForStatus, branch, tag, callId, Dialog } = require('../../desktop/daemon/lib/dialog');

const ck = assert.strictEqual;
const ok = assert.ok;
const deep = assert.deepStrictEqual;
const line = (raw, name) => raw.split(M.CRLF).find((l) => l.startsWith(name));   // one wire header
const answer = async (leg, res) => { await leg.tx.onFinal(res); await leg.done; };  // then let it settle

const checks = [
  [29, 'an unknown action is refused with a reason, and dispatch is never reached', async () => {
    const { p, out, acted, last } = M.protocolWith();
    p.feed('{"id":"x1","action":"teleport"}\n');
    ck(out.length, 1); ck(acted.length, 0, 'the allowlist runs before dispatch');
    ck(last().id, 'x1'); ck(last().ok, false); ok(/Unknown action "teleport"/.test(last().error), last().error);
  }],
  [30, 'ping and status are real actions and answer on the same channel', async () => {
    ok(ACTIONS.has('ping') && ACTIONS.has('status'), 'a liveness probe must not be an unknown action');
    const { p, out, acted } = M.protocolWith((a) => (a === 'status' ? { registration: { state: 'registered' } } : { pong: true }));
    p.feed('{"id":"p1","action":"ping"}\n{"id":"s1","action":"status"}\n');
    await M.tick();
    ck(acted.length, 2); ck(acted[0].action, 'ping'); ck(acted[1].action, 'status');
    ck(JSON.parse(out[0]).pong, true); ck(JSON.parse(out[0]).id, 'p1'); ck(out.length, 2);
    ck(JSON.parse(out[1]).registration.state, 'registered'); ck(JSON.parse(out[1]).id, 's1');
  }],
  [31, 'a command split across chunk boundaries is assembled, never dispatched twice', async () => {
    const { p, out, acted, last } = M.protocolWith();
    p.feed('{"id":"c1",');
    ck(out.length, 0, 'a partial line must not be answered'); ck(acted.length, 0); ck(p.buffer, '{"id":"c1",');
    p.feed('"action":"status"}\n');
    await M.tick();
    ck(acted.length, 1, 'exactly one dispatch for one command'); ck(p.received, 1); ck(last().id, 'c1');
    p.feed('{"action":"ping"}\n{"action":"ping"}\n');
    await M.tick();
    ck(acted.length, 3); ck(p.received, 3); ck(out.length, 3);
  }],
  [32, 'malformed JSON is answered and dropped, and the channel keeps working', async () => {
    const { p, out, acted } = M.protocolWith();
    p.feed('{not json at all\n[1,2,3]\n{"action":"ping"}\n');
    await M.tick();
    ck(p.parseErrors, 2); ck(acted.length, 1, 'the daemon survives the garbage and serves the next command');
    const bad = JSON.parse(out[0]);
    ck(bad.ok, false); ok(/Malformed JSON/.test(bad.error), out[0]); ok(!('id' in bad), 'no id to echo');
    ok(/must be a JSON object/.test(JSON.parse(out[1]).error), 'an array is not a command');
    ck(JSON.parse(out[2]).ok, true); ck(out.length, 3);
  }],
  [33, 'a circular reply is reported as an error instead of vanishing', async () => {
    const loop = {}; loop.self = loop;
    const { p, out, last } = M.protocolWith(() => loop);
    p.feed('{"id":"z9","action":"status"}\n');
    await M.tick();
    ck(out.length, 1); ck(last().id, 'z9'); ck(last().ok, false); ok(/Could not serialize this reply/.test(last().error), last().error);
  }],
  [34, 'a numeric id is answered as a string, so a supervisor map keyed on it matches', async () => {
    const { p, out } = M.protocolWith();
    p.feed('{"id":42,"action":"status"}\n{"action":"ping"}\n');
    await M.tick();
    ck(JSON.parse(out[0]).id, '42'); ck(typeof JSON.parse(out[0]).id, 'string'); ck(JSON.parse(out[0]).ok, true);
    ck(JSON.parse(out[1]).id, null, 'a command with no id still gets an answer');
  }],
  [35, 'a media-less offer (port 0) advertises no payload at all', () => {
    const body = sdp.build({ ip: '203.0.113.7', port: 0 });
    ok(body.includes('m=audio 0 RTP/AVP 0'), body);
    ok(!body.includes('rtpmap') && !body.includes('fmtp') && !body.includes('a=sendrecv'), 'a rejected stream offers nothing');
  }],
  [36, 'an offer we built parses back to the same media address', () => {
    const p = sdp.parse(sdp.build({ ip: '198.51.100.4', port: 20000, sessionId: 4242 }));
    ck(p.ip, '198.51.100.4'); ck(p.port, 20000); ck(p.dtmfPt, 101); ck(p.sessionId, '4242');
    deep(p.payloadTypes, [0, 8, 101]);
  }],
  [37, 'the state machine is explicit and every transition is announced', () => {
    deep(STATES, ['idle', 'calling', 'proceeding', 'early', 'confirmed', 'terminating', 'terminated']);
    const d = new Dialog({ ua: M.mockUa(), direction: 'outbound', number: '+4520123456' });
    ck(d.state, 'idle'); ck(d.ended, false); ck(d.callerPhone, '+4520123456'); ck(d.displayName, ''); ck(d.durationSec, 0);
    d.transition('calling'); d.transition('calling'); d.transition('proceeding');
    deep(d.ua.states(), ['calling', 'proceeding'], 'a no-op transition emits nothing');
    ck(d.ua.events[0].data.callId, d.id); ck(d.ua.events[0].data.direction, 'outbound');
    ok(/^[0-9a-f]{16}@sip\.flynumber\.com$/.test(d.callId), d.callId);
  }],
  [38, 'branch, tag and Call-ID are RFC-shaped and never collide', () => {
    const b = new Set(); const t = new Set(); const c = new Set();
    for (let i = 0; i < 2000; i += 1) { b.add(branch()); t.add(tag()); c.add(callId('sip.flynumber.com')); }
    ck(b.size, 2000, 'branches'); ck(t.size, 2000, 'tags'); ck(c.size, 2000, 'Call-IDs');
    ok([...b].every((x) => x.startsWith('z9hG4bK')), 'the RFC 3261 §8.1.1.7 magic cookie');
    ok([...t].every((x) => /^[0-9a-f]{12}$/.test(x)) && [...c].every((x) => /^[0-9a-f]{16}@sip\.flynumber\.com$/.test(x)));
    ck(ackKey({ first: () => 'SIP/2.0/UDP h:5060;branch=z9hG4bKk1;rport', method: 'INVITE' }), 'z9hG4bKk1|INVITE');
  }],
  [39, 'parseTag tolerates the whitespace a real trunk puts around the =', () => {
    ck(parseTag('sip:x@y; tag = def5678 ;user=phone'), 'def5678');
    ck(parseTag('<sip:a@b>;tag=abc'), 'abc'); ck(parseTag('"Alice" <sip:a@b>;tag=1928301774'), '1928301774');
    ck(parseTag('<sip:a@b>; tag\t=\tzz9'), 'zz9');
    ck(parseTag('<sip:a@b>'), '', 'no tag is an empty string, not undefined'); ck(parseTag(null), '');
  }],
  [40, 'contactUri returns the FIRST contact, with its URI parameters intact', () => {
    ck(contactUri('sip:user@host:5060, <sip:user2@host2>'), 'sip:user@host:5060', 'a whole-value regex hands back the second');
    ck(contactUri('<sip:user@10.0.0.1:5060;transport=udp>'), 'sip:user@10.0.0.1:5060;transport=udp');
    ck(contactUri('"Doe, John" <sip:j@h>;expires=3600'), 'sip:j@h', 'a comma in a display name is not a separator');
    ck(contactUri('<sip:a@h>, <sip:b@h2>'), 'sip:a@h'); ck(contactUri('sip:bare@host'), 'sip:bare@host');
    ck(contactUri(''), ''); ck(contactUri(null), '');
    ck(contactUri('https://not-sip.example/x'), '', 'a non-SIP target is refused, not forwarded');
  }],
  [41, 'reasonForStatus maps every way a call can fail onto one vocabulary', () => {
    const want = [[486, 'busy'], [600, 'busy'], [487, 'canceled'], [603, 'rejected'], [403, 'rejected'], [408, 'timeout'],
      [480, 'timeout'], [404, 'notfound'], [410, 'notfound'], [401, 'auth'], [407, 'auth'], [488, 'failed'],
      [503, 'failed'], [200, 'normal'], [0, 'normal'], [180, 'normal']];
    for (const [status, reason] of want) ck(reasonForStatus(status), reason, `${status} -> ${reason}`);
  }],
  [42, 'the outbound INVITE carries a tag, the magic cookie, SDP and user=phone', async () => {
    const { ua, d, tx } = await M.outbound();
    ck(d.state, 'calling'); ok(tx && tx.invite === true, 'registered as an INVITE transaction');
    const msg = sip.parse(tx.msg);
    ok(tx.msg.toString('utf8').startsWith('INVITE sip:+4520123456@sip.flynumber.com;user=phone SIP/2.0'), msg.uri);
    ck(msg.first('cseq'), `${d.cseq} INVITE`); ck(msg.first('max-forwards'), '70'); ck(msg.first('content-type'), 'application/sdp');
    ok(new RegExp(`;tag=${d.localTag}$`).test(msg.first('from')), msg.first('from'));
    ok(msg.first('to').endsWith('>'), `the first INVITE has no To tag: ${msg.first('to')}`);
    ok(msg.body.includes('m=audio 16384 RTP/AVP 0 8 101'), 'our media port goes in the offer');
    ck(d.localSdp.port, 16384); ck(ua.sockets, 1, 'one media socket per leg');
    ok(tx.branch.startsWith('z9hG4bK')); ck(tx.method, 'INVITE'); ok(/;branch=z9hG4bK/.test(msg.first('via')), msg.first('via'));
    tx.onFinal({ synthetic: true, status: 0, reason: 'transport: EINVAL', first: () => '' });
    await M.tick();
    ck(ua.ended.length, 1); ck(ua.ended[0].reason, 'failed'); ck(ua.ended[0].detail, 'transport: EINVAL');
    ck(d.state, 'terminated');
  }],
  [43, 'a 407 on the INVITE is answered with Proxy-Authorization exactly once', async () => {
    const { ua, d, tx } = await M.outbound();
    const challenge = 'Digest realm="sip.flynumber.com", nonce="n-407", qop="auth", algorithm=MD5';
    await tx.onFinal(sip.parse(M.sipBuf('SIP/2.0 407 Proxy Authentication Required', Object.assign({}, M.INVITE_HEADERS, { 'Proxy-Authenticate': challenge }))));
    ck(ua.transport.tx.length, 2, 'exactly one retry');
    const retry = sip.parse(ua.transport.tx[1].msg);
    const proxyAuth = retry.first('proxy-authorization');
    ok(proxyAuth, 'a 407 is answered with Proxy-Authorization');
    ok(!retry.first('authorization'), 'and not with Authorization, which a proxy ignores (§22.4)');
    ok(proxyAuth.includes('nonce="n-407"'), proxyAuth); ck(retry.first('call-id'), d.callId, 'same call');
    ok(retry.first('cseq').startsWith(`${d.cseq} INVITE`), 'with a fresh CSeq');
    ck(ua.transport.tx[1].branch === tx.branch, false, 'and a fresh branch');
    await ua.transport.tx[1].onFinal({ status: 407, synthetic: false, first: (h) => (h === 'proxy-authenticate' ? challenge : '') });
    ck(ua.transport.tx.length, 2, 'never a second retry: an auth loop would burn the account');
    ck(ua.ended.length, 1); ck(ua.ended[0].reason, 'auth'); ck(ua.ended[0].status, 407); ua.clearTimers(d);
  }],
  [44, 'a 200 OK forms the dialog and the ACK To: is that 200 OK To: verbatim', async () => {
    const leg = await M.outbound(); const { ua, d } = leg;
    await answer(leg, M.ok200({}, sdp.build({ ip: '138.197.42.26', port: 24000 })));
    ck(d.remoteTag, 'srv77'); ck(d.remoteTarget, 'sip:fs@138.197.42.26:5060;transport=udp');
    ck(ua.transport.sent.length, 1, 'the ACK is the only thing we send');
    const ack = ua.transport.sent[0].text;
    ok(ack.startsWith('ACK sip:fs@138.197.42.26:5060;transport=udp SIP/2.0'), ack.split(M.CRLF)[0]);
    ck(line(ack, 'To:'), 'To: <sip:+4520123456@sip.flynumber.com>;tag=srv77', 'Timer H: the ACK To must equal the 200 OK To or FreeSWITCH sends BYE at 4 s');
    ck(line(ack, 'CSeq:'), `CSeq: ${d.cseq} ACK`); ck(line(ack, 'Call-ID:'), `Call-ID: ${d.callId}`);
    ok(line(ack, 'Contact:'), 'a dialog-forming ACK carries our Contact');
    ok(!ack.includes('Allow:'), 'Allow describes requests that start a dialog');
    ck(d.state, 'confirmed'); ok(d.answeredAt > 0); ck(ua.confirmed.length, 1); ck(ua.confirmed[0].status, 200);
    ck(d.remoteSdp.port, 24000); ck(d.remoteSdp.ip, '138.197.42.26'); ua.clearTimers(d);
  }],
  [45, 'the ACK goes where the response came from, not back to the account domain', async () => {
    const leg = await M.outbound();
    leg.d.remoteAddress = { host: 'sip.flynumber.com', port: 5060 };
    leg.ua.transport.peerHints.set(leg.d.callId, { host: '138.197.42.26', port: 5060 });
    await answer(leg, M.ok200({ Contact: '<sip:fs@138.197.42.26:5060>' }));
    ck(leg.ua.transport.sent.length, 1);
    deep(leg.ua.transport.sent[0].target, { host: '138.197.42.26', port: 5060 }, 'the carrier proxy, not the registration domain');
    leg.ua.clearTimers(leg.d);
  }],
  [46, 'BYE targets the peer Contact with an incremented CSeq and the dialog tags', async () => {
    const leg = await M.outbound(); const { ua, d } = leg; const before = d.cseq;
    await answer(leg, M.ok200({ Contact: '<sip:fs@138.197.42.26:5060>' }));
    ck(d.state, 'confirmed', 'a BYE is only sent for a call that was actually answered');
    await d.bye();
    ck(d.cseq, before + 1, 'an in-dialog request increments CSeq');
    const bye = ua.transport.sent[ua.transport.sent.length - 1].text;
    ok(bye.startsWith('BYE sip:fs@138.197.42.26:5060 SIP/2.0'), bye.split(M.CRLF)[0]);
    ck(line(bye, 'To:'), 'To: <sip:+4520123456@sip.flynumber.com>;tag=srv77', 'the same dialog To the ACK used');
    ck(line(bye, 'CSeq:'), `CSeq: ${d.cseq} BYE`); ok(new RegExp(`From: .*;tag=${d.localTag}`).test(bye), bye);
    ck(d.state, 'terminating');
    await d.bye();
    ck(ua.transport.sent.length, 2, 'the ACK, the BYE, and no second BYE on a terminating dialog'); ua.clearTimers(d);
  }],
  [47, 'CANCEL shares the INVITE CSeq number and carries no To tag', async () => {
    const leg = await M.outbound(); const seq = leg.d.cseq;
    await leg.d.cancel();
    ck(leg.ua.transport.sent.length, 1, 'a CANCEL is the only thing an abandoned INVITE sends');
    const cancel = leg.ua.transport.sent[0].text;
    ok(cancel.startsWith('CANCEL sip:+4520123456@sip.flynumber.com;user=phone SIP/2.0'), cancel.split(M.CRLF)[0]);
    ck(line(cancel, 'CSeq:'), `CSeq: ${seq} CANCEL`, 'the INVITE CSeq number, method CANCEL (§9.1)');
    ck(line(cancel, 'To:'), 'To: <sip:+4520123456@sip.flynumber.com;user=phone>', 'no To tag: no dialog was formed');
    ck(line(cancel, 'Call-ID:'), `Call-ID: ${leg.d.callId}`, 'the same Call-ID as the INVITE it cancels');
    leg.ua.clearTimers(leg.d);
  }],
  [48, 'an inbound dialog echoes the peer Via and From and answers with our own tag', async () => {
    const ua = M.mockUa();
    const d = new Dialog({ ua, direction: 'inbound', request: M.inboundInvite(sdp.build({ ip: '138.197.42.26', port: 30000 })) });
    ck(d.callId, 'in-call-1', 'the inbound Call-ID is the dialog identity');
    ck(d.remoteTag, 'rem9'); ck(d.cseq, 7); ck(d.requestUri, 'sip:15551234567@sip.flynumber.com');
    ck(d.callerPhone, 'alice', 'the peer user, not our own number'); ck(d.displayName, 'Alice'); ck(d.remoteSdp.port, 30000);
    await d.ring();
    const r = ua.transport.replies[0].text;
    ok(r.startsWith('SIP/2.0 180 Ringing'), r.split(M.CRLF)[0]);
    ck(line(r, 'Via:'), `Via: ${M.INVITE_HEADERS.Via}`, 'the peer Via is echoed verbatim');
    ck(line(r, 'From:'), `From: ${M.INVITE_HEADERS.From}`, 'and so is its From, tag included');
    ck(line(r, 'To:'), `To: <sip:15551234567@sip.flynumber.com>;tag=${d.localTag}`, 'with our tag appended');
    ck(line(r, 'CSeq:'), 'CSeq: 7 INVITE'); ck(line(r, 'Call-ID:'), 'Call-ID: in-call-1');
    ck(d.reply.status, 180); ck(d.reply.key, 'z9hG4bKin1|INVITE'); ck(d.state, 'proceeding');
    ok(!r.includes('Content-Type'), 'a 180 carries no body'); ua.clearTimers(d);
  }],
  [49, 'rejecting an inbound call sends 486 and reports ended{busy} exactly once', async () => {
    const ua = M.mockUa();
    const d = new Dialog({ ua, direction: 'inbound', request: M.inboundInvite() });
    ck(await d.reject(486), true);
    ok(ua.transport.replies[0].text.startsWith('SIP/2.0 486 Busy Here'), ua.transport.replies[0].text);
    ck(ua.ended.length, 1); ck(ua.ended[0].reason, 'busy'); ck(d.state, 'terminated');
    ck(await d.reject(486), false, 'an ended dialog refuses to answer again'); ck(await d.answer(), false);
    ck(ua.ended.length, 1); ck(ua.transport.replies.length, 1); ua.clearTimers(d);
  }],
  [50, 'end() is idempotent: a BYE crossing a local hang-up reports one ended event', () => {
    const ua = M.mockUa();
    const d = new Dialog({ ua, direction: 'outbound', number: '+4520123456' }); d.end('normal', { status: 200 });
    d.end('failed', { status: 486 }); d.end('busy');
    ck(ua.ended.length, 1, 'exactly one ended, or the UI logs the same call twice');
    ck(ua.ended[0].reason, 'normal', 'the first reason is the one that counts'); ck(ua.ended[0].status, 200);
    ck(d.ended, true); ck(d.endReason, 'normal');
    ck(d.state, 'terminated', 'a terminated dialog must not keep reporting its old state');
    deep(ua.states(), ['terminated'], 'and the change is announced exactly once');
  }],
  [51, 'the end reason and detail reach the UI, and a duration only exists once answered', () => {
    const ua = M.mockUa();
    const d = new Dialog({ ua, direction: 'inbound', request: M.inboundInvite() });
    d.end('normal', { status: 200, detail: 'BYE from the far end' });
    ck(ua.ended[0].reason, 'normal'); ck(ua.ended[0].detail, 'BYE from the far end');
    ck(d.durationSec, 0, 'a call that was never answered has no duration');
    d.answeredAt = Date.now() - 65000; ck(d.durationSec, 65);
  }],
  [52, 'answering an inbound call sends SDP, and a retransmitted ACK is cheap to absorb', async () => {
    const ua = M.mockUa();
    const d = new Dialog({ ua, direction: 'inbound', request: M.inboundInvite() }); ck(await d.answer(), true);
    const reply = ua.transport.replies[0].text;
    ok(reply.startsWith('SIP/2.0 200 OK'), reply.split(M.CRLF)[0]);
    ck(line(reply, 'Content-Type:'), 'Content-Type: application/sdp', 'an answer without SDP is a call with no audio');
    ok(reply.includes('m=audio 16384 RTP/AVP 0 8 101'), reply.slice(-200));
    ck(line(reply, 'To:'), `To: <sip:15551234567@sip.flynumber.com>;tag=${d.localTag}`);
    ck(d.reply.status, 200); ck(d.reply.key, 'z9hG4bKin1|INVITE'); ck(d.state, 'confirmed');
    ck(ua.confirmed.length, 1); ck(d.localSdp.port, 16384);
    d.noteAck(); ck(d.ackSeen, true); ck(ua.acksNoted, 1);
    d.noteAck(); ck(ua.acksNoted, 2, 'a retransmitted ACK must not be an error'); ua.clearTimers(d);
  }],
  [53, 'the native bridge is detected, and its absence is reported honestly', async () => {
    delete globalThis.window;                       // a browser tab: no preload, no daemon
    const native = await import('../../src/nativeSip.js');
    ck(native.nativeAvailable(), false, 'a browser tab has no daemon behind it');
    const h = M.nativeHarness();
    ck(native.nativeAvailable(), true); ck(typeof h.stub.command, 'function'); ck(typeof h.stub.onEvent, 'function');
    h.drop(); ck(native.nativeAvailable(), false, 'and it goes away when the bridge does');
  }],
  [54, 'isNativeSession separates the native descriptor from the browser one', async () => {
    const { native, drop } = await M.withNative();
    const is = native.isNativeSession;
    ck(is({ engine: 'native' }), true); ck(is({ transport: 'udp' }), true); ck(is({ wsUrlSource: 'native_daemon' }), true);
    ck(is({ mode: 'webrtc', wsUrl: 'wss://sip.telnyx.com' }), false, 'the browser descriptor must never be claimed');
    ck(is(null), false); ck(is(undefined), false); ck(is({}), false); drop();
  }],
  [55, 'the engine reports the same contract as the browser one, minus recording', async () => {
    const { native, engine, st, drop } = await M.withNative(() => ({ ok: true }));
    for (const fn of ['start', 'dispose', 'dial', 'answer', 'decline', 'hangUp', 'toggleMute', 'sendDtmf', 'send', 'onEvent']) {
      ck(typeof engine[fn], 'function', `the browser engine exposes ${fn}(), so this one must too`);
    }
    ck(engine.state, 'idle'); ck(engine.live, null); ck(engine.incoming, null); ck(engine.recording.supported, false, 'no MediaStream, no MediaRecorder');
    ok(/native daemon/.test(engine.recording.reason), engine.recording.reason);
    deep(engine.descriptor, { engine: 'native', carrier: 'flynumber', domain: 'sip.flynumber.com', port: 5060 });
    ck(native.nativeStandbyLabel({ provider: 'flynumber', domain: 'sip.flynumber.com' }), 'Native softphone (flynumber · sip.flynumber.com)');
    ck(native.nativeStandbyLabel({ carrierName: 'FlyNumber' }), 'Native softphone (FlyNumber)');
    ck(native.nativeStandbyLabel(null), 'Native softphone');
    ck(st.state, undefined, 'nothing is rendered until something happens'); engine.dispose(); drop();
  }],
  [56, 'dial("") is refused locally and never reaches the daemon', async () => {
    const { engine, st, sent, drop } = await M.withNative(() => ({ ok: true }));
    const r = await engine.dial('   '); ck(r.ok, false); ck(r.reason, 'no-number');
    ck(sent.length, 0, 'an empty dial must not put an INVITE on the wire'); ck(st.state, undefined);
    engine.dispose(); drop();
  }],
  [57, 'hangUp() with no call says no-call and clears the UI instead of throwing', async () => {
    const { engine, st, sent, drop } = await M.withNative(() => ({ ok: true }));
    const r = await engine.hangUp(); ck(r.ok, false); ck(r.reason, 'no-call'); ck(sent.length, 0);
    ck(st.target, ''); ck(st.level, 0); ck(st.direction, null); ck(st.incoming, null); engine.dispose(); drop();
  }],
  [58, 'a dial, a mute and a DTMF digit round-trip through the bridge with the right payload', async () => {
    const { engine, st, sent, drop } = await M.withNative((a) => (a === 'dial' ? { ok: true, callId: 'call-1' } : { ok: true }));
    const r = await engine.dial('+4520123456'); ck(r.ok, true); ck(r.callId, 'call-1');
    deep(sent[0], ['dial', { number: '+4520123456', callId: null }]);
    ck(st.target, '+4520123456'); ck(st.state, 'dialing'); ck(st.error, '');
    ck(await engine.toggleMute(), true); deep(sent[1], ['mute', { enabled: true }]); ck(st.muted, true);
    ck(await engine.toggleMute(), false); ck(st.muted, false);
    ck(await engine.sendDtmf('#'), true); deep(sent[3], ['dtmf', { digit: '#' }]); engine.dispose(); drop();
  }],
  [59, 'start() registers over UDP with the carrier domain, never a wss:// URL', async () => {
    const { engine, st, sent, drop } = await M.withNative(() => ({ ok: true }));
    ck((await engine.start()).ok, true);
    deep(sent[0], ['register', { domain: 'sip.flynumber.com', port: 5060, user: '15551234567', callerId: '+15551234567', transport: 'udp' }]);
    deep(st.standby, { state: 'registering', reason: '' });
    ok(!JSON.stringify(sent[0]).includes('wss'), 'the daemon speaks UDP SIP; a WebSocket URL is the browser engine');
    engine.dispose(); drop();
    const refused = await M.withNative(() => ({ ok: false, error: '403 Forbidden' })); await refused.engine.start();
    refused.engine.dispose(); refused.drop();
    deep(refused.st.standby, { state: 'unavailable', reason: '403 Forbidden' }, 'a refusal is shown verbatim');
  }],
  [60, 'daemon events drive the renderer state machine, and reasons are normalized', async () => {
    const { engine, st, fired, drop } = await M.withNative(() => ({ ok: true }));
    const ev = (e) => engine.onEvent(e); ev({ event: 'registered', audio: { input: 'MacBook Pro Microphone' } });
    deep(st.standby, { state: 'ready', reason: '' }); ck(st.mic, 'MacBook Pro Microphone'); ck(st.state, 'standby');
    ev({ event: 'incoming', callId: 'c-9', callerPhone: '20123456' }); await M.tick();
    ck(st.state, 'incoming', 'an inbound call must ring even if nothing else works');
    ck(st.incoming.callerNumber, '+4520123456', 'E.164, so the CRM lookup matches');
    ck(st.incoming.native, true); ck(st.incoming.engine, 'native'); deep(fired[0], ['incoming', 'c-9']);
    ev({ event: 'mute', enabled: true }); ck(st.muted, true);
    ev({ event: 'audio_level', level: 0.42 }); ck(st.level, 0.42);
    ev({ event: 'audio_level', level: 7 }); ck(st.level, 1, 'clamped before it reaches a width style');
    ev({ event: 'connected', callId: 'c-9' });
    ck(st.state, 'active'); ck(st.direction, 'inbound'); ck(engine.live.callId, 'c-9'); deep(fired[1], ['active', 'inbound']);
    ev({ event: 'ended', reason: 'normal' });
    ck(st.state, 'ended'); ck(engine.live, null); ck(st.level, 0); deep(fired[2], ['ended', 'inbound']);
    ev(null); ev({});                       // junk from the daemon must not throw in the renderer
    engine.dispose(); engine.dispose(); drop();
    const e2 = await M.withNative(() => ({ ok: true }));   // a ring that is never answered
    e2.engine.onEvent({ event: 'incoming', callId: 'c-10', callerPhone: '+4520999999' }); await M.tick();
    e2.engine.onEvent({ event: 'ended', reason: 'rejected' });
    deep(e2.fired[1], ['incomingEnded', 'declined'], 'a rejected ring is "declined", not "missed"');
    ck(e2.st.state, 'idle', 'and the phone goes back to idle, not standby');
    e2.engine.dispose(); ck(e2.st.level, 0, 'dispose always clears the meter'); e2.drop();
  }],
];

module.exports = { checks, line };

// Direct run: `node test/unit/telephony-chaos-part2.test.js` proves this half on its own.
if (require.main === module) {
  M.runChecks(checks, 'part 2').then((r) => process.exit(r.failed ? 1 : 0));
}
