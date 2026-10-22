// Headless SIP daemon — end-to-end verification against a mock carrier.
//
// The daemon is spawned for real (child process, JSON lines over stdio) and talked to by a UDP
// SIP/RTP peer that behaves like a trunk: it challenges with digest auth, answers INVITEs, rings
// the daemon, sends audio and hangs up. Nothing inside the daemon is stubbed, so a regression in
// registration, SDP negotiation, RTP pacing or teardown fails here rather than in production.
//
//   node test/unit/sip-daemon.test.js
'use strict';

const assert = require('assert');
const g711 = require('../../desktop/daemon/lib/g711');
const sdpLib = require('../../desktop/daemon/lib/sdp');
const digest = require('../../desktop/daemon/lib/digest');
const sipMessage = require('../../desktop/daemon/lib/sipMessage');
const rtpLib = require('../../desktop/daemon/lib/rtp');

const { boot, bootRegistered, teardown, dial, toneFrames } = require('../helpers/daemon-harness');

let passed = 0;
const ok = (msg) => { passed++; console.log(`  \u2713 ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (v) => JSON.stringify(v);

console.log('[unit:sip-daemon] headless SIP daemon against a mock carrier');

// ---- pure-library checks ---------------------------------------------------------------
// No process and no socket: a broken table or parser is named precisely instead of showing up
// as a mysterious call failure three layers away.
function libraryChecks() {
  for (const pt of [0, 8]) {
    const name = pt === 0 ? 'PCMU' : 'PCMA';
    const input = new Int16Array(160);
    for (let i = 0; i < input.length; i++) input[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 8000) * 16000);
    const back = g711.decode(g711.encode(input, pt), pt);
    let maxErr = 0;
    for (let i = 0; i < input.length; i++) maxErr = Math.max(maxErr, Math.abs(input[i] - back[i]));
    // 8-bit companded audio has a large step at the top of the range; a real bug is far worse.
    assert.ok(maxErr < 1200, `${name} round trip within a quantization step (max error ${maxErr})`);
    assert.ok(g711.decode(g711.encode(new Int16Array(160), pt), pt).every((v) => Math.abs(v) < 40), `${name} keeps silence silent`);
    ok(`${name} encode/decode round trips within ${maxErr} LSB`);
  }
  assert.strictEqual(g711.encode(g711.toInt16(new Float32Array(4).fill(1)), 0).length, 4, 'float32 -> int16 -> G.711 preserves length');
  assert.ok(g711.level(new Int16Array([0, 16384, -16384])) > 0.4 && g711.level(new Int16Array(160)) === 0, 'the level meter reads peak and silence');

  const parsed = sdpLib.parse(sdpLib.build({ ip: '10.0.0.5', port: 20000 }));
  assert.strictEqual(parsed.ip, '10.0.0.5');
  assert.strictEqual(parsed.port, 20000);
  assert.deepStrictEqual(parsed.payloadTypes, [0, 8, 101], 'our offer lists PCMU, PCMA and telephone-event');
  assert.strictEqual(parsed.dtmfPt, 101);
  assert.strictEqual(sdpLib.negotiate({ payloadTypes: [8, 101] }).pt, 8, 'the peer\u2019s first supported codec wins');
  assert.strictEqual(sdpLib.negotiate({ payloadTypes: [9, 10] }).pt, 0, 'an unsupported offer falls back to our preference');
  assert.match(sdpLib.build({ ip: '10.0.0.5', port: 0 }), /m=audio 0 RTP\/AVP 0/, 'a held call offers port 0');
  ok('SDP builds, parses and negotiates PCMU/PCMA with telephone-event');

  // Digest: the reference vector from RFC 2617 §3.5.
  const challenge = digest.pick(digest.parseChallenges('Digest realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", qop="auth", opaque="5ccc069c403ebaf9f0171e9517f40e41"'));
  const header = digest.respond({ method: 'GET', uri: '/dir/index.html', username: 'Mufasa', password: 'Circle Of Life', challenge, nc: 1, cnonce: '0a4f113b' });
  assert.match(header, /response="6629fae49393a05397450978507c4ef1"/, 'the RFC 2617 example hashes correctly');
  assert.match(header, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/, 'opaque is echoed back');
  ok('digest auth reproduces the RFC 2617 reference response');

  const raw = [
    'INVITE sip:bob@biloxi.com SIP/2.0', 'v: SIP/2.0/UDP pc33.atlanta.com;branch=z9hG4bK776asdhds',
    'f: "Alice" <sip:alice@atlanta.com>;tag=1928301774', 't: Bob <sip:bob@biloxi.com>',
    'i: a84b4c76e66710@pc33.atlanta.com', 'CSeq: 314159 INVITE', 'l: 11', '', 'hello world',
  ].join('\r\n');
  const msg = sipMessage.parse(raw);
  assert.strictEqual(msg.method, 'INVITE');
  assert.strictEqual(msg.first('call-id'), 'a84b4c76e66710@pc33.atlanta.com', 'compact "i" is read as Call-ID');
  assert.strictEqual(msg.body, 'hello world', 'the body survives the compact Content-Length');
  assert.strictEqual(sipMessage.parseVia(msg.first('via')).branch, 'z9hG4bK776asdhds');
  assert.deepStrictEqual(sipMessage.identityOf(msg.first('from')), { displayName: 'Alice', uri: 'sip:alice@atlanta.com', user: 'alice' });
  assert.strictEqual(sipMessage.parseUri('sip:%2B4520123456@host;user=phone').user, '+4520123456', 'an escaped + in the user part is decoded');
  const res = sipMessage.parse('SIP/2.0 486 Busy Here\r\nv: x\r\n\r\n');
  assert.deepStrictEqual([res.status, res.reason], [486, 'Busy Here']);
  ok('SIP parsing handles compact forms, quoted display names, escaped users and responses');

  const session = rtpLib.createSession({ payloadType: 0, ssrc: 42 });
  const first = session.packet(Buffer.alloc(160, 7), true);
  const second = session.packet(Buffer.alloc(160, 8));
  assert.strictEqual(first[0], 0x80, 'RTP version 2');
  assert.strictEqual(first[1] & 0x80, 0x80, 'the first packet carries the marker bit');
  assert.strictEqual(second[1] & 0x80, 0, 'and the next one does not');
  assert.strictEqual(second.readUInt16BE(2), (first.readUInt16BE(2) + 1) & 0xffff);
  assert.strictEqual(second.readUInt32BE(4) - first.readUInt32BE(4), 160);
  assert.strictEqual(rtpLib.parse(second).ssrc, 42);
  assert.strictEqual(rtpLib.parse(Buffer.from([0x90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null, 'a non-v2 datagram is not treated as audio');
  assert.strictEqual(rtpLib.isRtcp(Buffer.from([0x80, 200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), true, 'RTCP is recognised and dropped');
  ok('RTP headers, marker bit, sequence and timestamp arithmetic are correct');
}

// ---- daemon checks ---------------------------------------------------------------------
async function run() {
  // 1 ---------------------------------------------------------- registration + digest auth
  {
    const t = await bootRegistered();
    const registers = t.carrier.method('REGISTER');
    assert.ok(registers.length >= 2, 'REGISTER is sent unauthenticated first, then answered');
    assert.strictEqual(t.carrier.responses(401).length, 1, 'the carrier challenged with 401');
    assert.strictEqual(t.carrier.authFailures, 0, 'the digest response verified against the carrier\u2019s own recomputation');
    const authed = registers.find((m) => m.headers.authorization);
    assert.match(authed.headers.authorization, /qop=auth.*nc=00000001/, 'qop=auth with a nonce count');
    assert.match(authed.startLine, /^REGISTER sip:127\.0\.0\.1 SIP\/2\.0$/, 'the REGISTER request-URI is the realm, not a user address');
    const registered = t.events.find((e) => e.event === 'registered');
    assert.strictEqual(registered.account, 'alice@127.0.0.1', 'the account is reported as user@domain');
    const status = await t.command('status');
    assert.strictEqual(status.registration.state, 'registered');
    assert.strictEqual(status.registration.refreshScheduled, true, 'a refresh is scheduled before the registration lapses');
    assert.strictEqual(status.audio.name, 'null', 'the silent backend is reported honestly, not hidden');
    ok(`registration completes through a 401 digest challenge (${registers.length} REGISTERs, expires=${registered.expires})`);
    await teardown(t);
  }

  // 2 ------------------------------------------------- wrong password is reported, not hung
  {
    const t = await boot({ password: 'correct-horse', daemonPassword: 'wrong' });
    const failed = await t.waitFor((e) => e.event === 'registration_failed', 5000, 'registration_failed');
    assert.match(failed.reason, /403/, 'the SIP reason reaches the controller verbatim');
    assert.ok(failed.retryInMs >= 5000, 'a failure schedules a capped backoff instead of a hot retry loop');
    assert.strictEqual(t.carrier.registrations, 0, 'a bad password never registers');
    ok(`a rejected registration reports "${failed.reason}" and backs off ${failed.retryInMs}ms`);
    await teardown(t);
  }

  // 3 ----------------------------------------------------- outbound call, audio both ways
  {
    const t = await bootRegistered();
    const { callId } = await dial(t);
    const invite = t.carrier.lastMessage('INVITE');
    assert.match(invite.startLine, /^INVITE sip:\+4520123456@127\.0\.0\.1;user=phone SIP\/2\.0$/, 'the request-URI carries the E.164 number');
    assert.match(invite.headers.from, /"\+4532331610"/, 'the verified DID is the From display name');
    assert.strictEqual(invite.headers['content-type'], 'application/sdp');
    assert.ok(t.carrier.ackSeen, 'the 200 OK was acknowledged');

    await sleep(400);                                   // ~20 frames of 20 ms audio
    const audio = t.audioPackets();
    assert.ok(audio.length >= 8, `RTP flowed to the carrier (${audio.length} packets)`);
    assert.strictEqual(audio[0].payload.length, 160, 'each packet is one 20 ms frame of 8 kHz G.711');
    const seqs = audio.map((p) => p.seq);
    const stamps = audio.map((p) => p.timestamp);
    assert.ok(seqs.every((s, i) => i === 0 || s === ((seqs[i - 1] + 1) & 0xffff)), 'sequence numbers are contiguous');
    assert.ok(stamps.every((s, i) => i === 0 || s === stamps[i - 1] + 160), 'timestamps advance by exactly one frame');
    for (const frame of toneFrames()) await t.carrier.sendRtp(g711.encode(frame, 0));
    await sleep(150);
    const status = await t.command('status');
    assert.deepStrictEqual([status.call.state, status.call.number, status.call.codec], ['confirmed', '+4520123456', 'PCMU']);
    ok(`outbound call connects, ACKs and streams PCMU both ways (callId ${callId}, ${audio.length} packets out)`);
    await teardown(t);
  }

  // 4 ------------------------------------------------------------------- mute and DTMF
  {
    const t = await bootRegistered();
    await dial(t);
    await sleep(200);
    const muteReply = await t.command('mute', { enabled: true });
    assert.strictEqual(muteReply.muted, true, 'the daemon confirms the mute');
    const atMute = t.countRtp();
    await sleep(300);
    assert.strictEqual(t.countRtp() - atMute, 0, 'a muted call sends no audio packets at all');
    assert.strictEqual(t.events.find((e) => e.event === 'mute').enabled, true, 'the controller is told the mute landed');
    await t.command('mute', { enabled: false });
    await sleep(200);
    assert.ok(t.countRtp() - atMute > 0, 'unmuting resumes the stream');

    const before = t.dtmfPackets().length;
    const sent = await t.command('dtmf', { digit: '5' });
    assert.strictEqual(sent.ok, true, `DTMF accepted (${j(sent)})`);
    await sleep(150);
    const tones = t.dtmfPackets().slice(before);
    assert.ok(tones.length >= 4, `RFC 2833 packets were sent for the digit (${tones.length})`);
    assert.ok(tones.every((p) => p.payload[0] === 5), 'the event code is 5');
    assert.ok(tones.filter((p) => p.payload[1] & 0x80).length >= 3, 'the end-of-event packet is retransmitted, as RFC 2833 requires');
    ok('mute stops the send path and DTMF emits RFC 2833 tones with a retransmitted end packet');
    await teardown(t);
  }

  // 5 ---------------------------------------------------------- hang-up in both directions
  {
    const t = await bootRegistered();
    const { callId } = await dial(t);
    const bye = await t.command('hangup', { callId });
    assert.strictEqual(bye.ok, true, `hangup accepted (${j(bye)})`);
    const ended = await t.waitFor((e) => e.event === 'ended' && e.callId === callId, 3000, 'ended');
    assert.strictEqual(ended.reason, 'normal', 'a local hang-up on a live call is "normal"');
    assert.ok(ended.durationSec >= 0, 'the talk time is reported so the CRM can log it');
    assert.ok(t.carrier.byeSeen, 'a BYE reached the carrier');
    const status = await t.command('status');
    assert.strictEqual(status.call, null, 'no call is live after hang-up');
    assert.strictEqual(status.dialogs, 0, 'the dialog is gone, not leaked');
    ok('local hang-up sends BYE, reports ended{normal} and leaks no dialog');
    await teardown(t);
  }

  {
    const t = await bootRegistered();
    const { callId } = await dial(t);
    // The customer hangs up: a BYE from the carrier must produce exactly one event.
    const d = t.carrier.dialog;
    const bye = [
      `BYE ${d.requestUri} SIP/2.0`, `Via: SIP/2.0/UDP 127.0.0.1:${t.carrier.sipPort};branch=z9hG4bKremote1`,
      `From: <sip:+4520123456@127.0.0.1>;tag=${d.toTag}`, `To: <sip:alice@127.0.0.1>;tag=${d.fromTag}`,
      `Call-ID: ${d.callId}`, 'CSeq: 2 BYE', 'Content-Length: 0', '', '',
    ].join('\r\n');
    t.carrier.sip.send(Buffer.from(bye), t.carrier.peer.port, t.carrier.peer.address);
    const ended = await t.waitFor((e) => e.event === 'ended' && e.callId === callId, 3000, 'ended after remote BYE');
    assert.strictEqual(ended.reason, 'normal', 'a remote hang-up is a normal end, not an error');
    await sleep(250);
    assert.strictEqual(t.events.filter((e) => e.event === 'ended').length, 1, 'exactly one ended event per call leg');
    ok('a remote BYE ends the call once, with reason "normal"');
    await teardown(t);
  }

  // 6 --------------------------------------------------------------------- a busy carrier
  {
    const t = await bootRegistered({ behaviour: 'busy' });
    const res = await t.command('dial', { number: '+4520123456' });
    assert.strictEqual(res.ok, true, `the dial is accepted; the carrier refuses it (${j(res)})`);
    const ended = await t.waitFor((e) => e.event === 'ended', 3000, 'ended');
    assert.strictEqual(ended.reason, 'busy', '486 Busy Here is reported as busy, not as a generic failure');
    assert.strictEqual(ended.status, 486);
    assert.strictEqual(t.carrier.method('ACK').length, 1, 'the non-2xx answer is ACKed');
    ok('a 486 from the carrier becomes ended{busy, status:486} and is ACKed');
    await teardown(t);
  }

  // 7 ------------------------------------------------------------------------ inbound call
  {
    const t = await bootRegistered();
    await t.carrier.callIn({ from: '+4520998877' });
    const incoming = await t.waitFor((e) => e.event === 'incoming', 4000, 'incoming');
    assert.deepStrictEqual([incoming.callerPhone, incoming.callerName], ['+4520998877', 'Customer'], 'the caller\u2019s number and name are passed through');
    await t.waitFor((e) => e.event === 'ringing', 3000, 'ringing');
    // After the `ringing` event, not before: the 180 goes out on the socket while the event is
    // still travelling up stdout, and asserting on the wire first made this check flaky under
    // load (a full suite running in parallel) without anything being wrong with the daemon.
    assert.ok(t.carrier.responses(180).length >= 1, 'the daemon rings back with 180 Ringing');

    const answered = await t.command('answer', { callId: incoming.callId });
    assert.strictEqual(answered.ok, true, `answer accepted (${j(answered)})`);
    const connected = await t.waitFor((e) => e.event === 'connected' && e.direction === 'inbound', 4000, 'connected');
    assert.strictEqual(connected.callId, incoming.callId);
    assert.ok(t.carrier.inboundAnswered, 'the carrier saw a 200 OK to its INVITE');
    const answer = t.carrier.responses(200).find((m) => /m=audio/.test(m.body));
    assert.match(answer.body, /a=rtpmap:0 PCMU\/8000/, 'G.711 \u00b5-law is offered');
    assert.match(answer.body, /telephone-event\/8000/, 'RFC 2833 DTMF is offered');

    await sleep(250);
    assert.ok(t.audioPackets().length >= 4, `audio flows on an answered inbound call (${t.audioPackets().length} packets)`);
    await t.carrier.byeInbound();
    const ended = await t.waitFor((e) => e.event === 'ended', 3000, 'ended');
    assert.strictEqual(ended.direction, 'inbound');
    ok('an inbound INVITE rings, answers with SDP, streams audio and ends on the caller\u2019s BYE');
    await teardown(t);
  }

  // 8 ------------------------------------------------------- declining and a second caller
  {
    const t = await bootRegistered();
    await t.carrier.callIn();
    const incoming = await t.waitFor((e) => e.event === 'incoming', 4000, 'incoming');
    const rejected = await t.command('reject', { callId: incoming.callId, code: 603 });
    assert.strictEqual(rejected.ok, true, `reject accepted (${j(rejected)})`);
    assert.strictEqual(t.carrier.responses(603).length, 1, 'a 603 Decline was sent');
    const ended = await t.waitFor((e) => e.event === 'ended', 3000, 'ended');
    assert.strictEqual(ended.reason, 'rejected', 'declining is reported as rejected, not missed');
    ok('rejecting an inbound call sends 603 and reports ended{rejected}');
    await teardown(t);
  }

  {
    const t = await bootRegistered();
    await dial(t);
    const before = t.carrier.responses(486).length;
    await t.carrier.callIn({ from: '+4520111111' });
    await sleep(400);
    assert.ok(t.carrier.responses(486).length > before, 'a second caller while a call is live gets 486 Busy Here');
    assert.strictEqual(t.events.filter((e) => e.event === 'incoming').length, 0, 'the busy caller never rings the operator');
    ok('one audio device means one call: a second INVITE is refused with 486 and never rings');
    await teardown(t);
  }

  // 9 ----------------------------------------------------------------- protocol discipline
  {
    const t = await bootRegistered();
    t.child.stdin.write('this is not json\n');
    t.child.stdin.write(`${j({ id: 'x1', action: 'launch-missiles' })}\n`);
    t.child.stdin.write(`${j({ id: 'x2' })}\n`);
    const bad = await t.waitFor((e) => e.id === undefined && /Malformed JSON/.test(e.error || ''), 2000, 'malformed-line error');
    assert.strictEqual(bad.ok, false);
    assert.match((await t.waitFor((e) => e.id === 'x1', 2000, 'unknown action')).error, /Unknown action "launch-missiles"/);
    assert.match((await t.waitFor((e) => e.id === 'x2', 2000, 'missing action')).error, /needs an "action"/);
    assert.strictEqual((await t.command('hangup', {})).ok, false, 'hanging up with no call is an error, not a silent success');
    assert.strictEqual((await t.command('dtmf', { digit: '1' })).ok, false, 'DTMF with no live call is refused');
    assert.ok(Array.isArray((await t.command('devices')).inputs), 'the device list is always an array');
    assert.ok((await t.command('status')).transport.port > 0, 'the bound SIP port is reported');
    ok('malformed input, unknown actions and commands with no call all answer with a reason');
    await teardown(t);
  }

  // 10 ------------------------------------------------------------------ shutdown is clean
  {
    const t = await bootRegistered();
    await dial(t);
    t.child.stdin.write(`${j({ action: 'shutdown' })}\n`);
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 4000);
      t.child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
    assert.notStrictEqual(exited, 'timeout', 'the daemon exits on shutdown');
    assert.ok(t.events.some((e) => e.event === 'shutdown'), 'a shutdown event is emitted before exiting');
    ok(`shutdown during a live call tears down and exits (${exited})`);
    t.carrier.close();
  }
}

(async () => {
  try {
    libraryChecks();
    await run();
  } catch (e) {
    console.error(`\n  \u2717 ${e.message}`);
    if (process.env.SIP_TEST_DEBUG) console.error(e.stack);
    console.error(`\n\u274C [unit:sip-daemon] failed after ${passed} checks`);
    process.exit(1);
  }
  console.log(`\n\u{1F389} [unit:sip-daemon] all ${passed} checks passed`);
  process.exit(0);
})();
