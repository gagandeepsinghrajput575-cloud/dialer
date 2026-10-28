// The daemon's inbound SIP leg: the mirror of the outbound path, and the three places it was asymmetric.
//
//   1. `remoteTarget` was only ever set from a 200 OK's Contact (the outbound direction), so an
//      inbound BYE was addressed to *our own* URI — the carrier 404s or ignores it and the caller's
//      leg survives the hang-up.
//   2. The answer SDP was built before negotiation and always led with PCMU, while the encoder
//      followed the *offer's* order. A caller offering PCMA first got A-law bytes decoded as µ-law:
//      garbled voice, inbound only.
//   3. A re-INVITE arriving before the phone was answered got a 200 with no body, because only
//      answer() ever opened the media socket.
const assert = require('assert');
const { EventEmitter } = require('events');

const { UserAgent } = require('../../desktop/daemon/lib/ua');
const sdpLib = require('../../desktop/daemon/lib/sdp');
const { parse } = require('../../desktop/daemon/lib/sipMessage');

let passed = 0;
let failed = 0;
const ok = (m) => { passed++; console.log(`  \u2713 ${m}`); };
const bad = (m) => { failed++; console.log(`  \u2717 ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

const CALLER = '127.0.0.1';
const CALLER_PORT = 5062;

function fakeTransport() {
  const t = new EventEmitter();
  t.host = '192.0.2.10';
  t.port = 5060;
  t.localAddress = '0.0.0.0';
  t.sent = [];
  t.replies = [];
  t.send = async (buf, target) => { t.sent.push({ text: String(buf), target }); return target; };
  t.replyTo = async (request, msg) => { t.replies.push(String(msg)); return {}; };
  t.peerFor = (_callId, fallback) => fallback;
  t.noteAck = () => {};
  t.close = () => {};
  return t;
}

const audio = {
  name: 'stub', available: () => true, reason: '',
  describe: () => ({ name: 'stub' }),
  async open() {}, start() {}, stop() {}, write() { return true; },
};

function makeUa() {
  return new UserAgent({
    transport: fakeTransport(),
    audio,
    account: { domain: 'example.test', port: 5060, user: 'agent', password: 'x' },
  });
}

/** An inbound INVITE whose offer leads with PCMA (pt 8) — the case that used to break the encoder. */
function inboundInvite({ callId = 'inbound-1@example.test', cseq = 1, body } = {}) {
  const offer = body !== undefined ? body : sdpLib.build({ ip: CALLER, port: 40000, payloadTypes: [8, 0] });
  const head = [
    'INVITE sip:agent@example.test SIP/2.0',
    `Via: SIP/2.0/UDP ${CALLER}:${CALLER_PORT};branch=z9hG4bK${cseq};rport`,
    'Max-Forwards: 70',
    'From: "Caller" <sip:+4512345678@example.test>;tag=caller1',
    'To: <sip:agent@example.test>',
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} INVITE`,
    `Contact: <sip:+4512345678@${CALLER}:${CALLER_PORT}>`,
    'Content-Type: application/sdp',
    `Content-Length: ${offer.length}`,
    '', offer,
  ].join('\r\n');
  const msg = parse(Buffer.from(head));
  msg.remote = { host: CALLER, port: CALLER_PORT };
  return msg;
}

(async () => {
  console.log('\n=== VAL-INBOUND-018: inbound addressing, answer codec, early re-INVITE ===\n');

  // 1. Answer an inbound call whose offer leads with PCMA.
  const ua = makeUa();
  await ua.onRequest(inboundInvite(), { reply: () => {} });
  check(ua.dialogs.size === 1, 'the INVITE creates one dialog');
  check(/^SIP\/2\.0 180 Ringing/.test(ua.transport.replies[0] || ''), 'the caller gets 180 Ringing');

  const dialog = [...ua.dialogs.values()][0];
  await ua.answer(dialog.id);

  const ok200 = ua.transport.replies[1] || '';
  check(/^SIP\/2\.0 200 OK/.test(ok200), 'answering sends 200 OK');
  const mLine = /\r\nm=audio (\d+) ([^ \r]+) ([^\r]+)/.exec(ok200);
  console.log(`  answer m-line: ${mLine ? mLine[0].trim() : '(none)'}`);
  check(!!mLine, 'the answer carries an m=audio line');
  check(mLine && mLine[3].trim().split(/\s+/)[0] === '8',
    'the answer offers PCMA first — the codec we will encode');
  check(mLine && !mLine[3].trim().split(/\s+/).includes('0'),
    'and does not also advertise PCMU, which we are not sending');
  check(dialog.media.codec === 8 && dialog.media.session.payloadType === 8,
    'the encoder and the packet header follow the same payload type');

  // 2. Hanging up must address the caller's Contact, not our own URI.
  await dialog.bye();
  const bye = ua.transport.sent.map((s) => s.text).find((t) => t.startsWith('BYE ')) || '';
  console.log(`  ${bye.split('\r\n')[0]}`);
  check(bye.startsWith(`BYE sip:+4512345678@${CALLER}:${CALLER_PORT} SIP/2.0`),
    "the BYE's request-URI is the caller's Contact");
  check(!/BYE sip:agent@example\.test/.test(bye), 'and not our own address');

  dialog.end('normal');
  ua.close();

  // 3. A re-INVITE that arrives while the phone is still ringing gets a real answer.
  const ua2 = makeUa();
  const cid = 'inbound-2@example.test';
  await ua2.onRequest(inboundInvite({ callId: cid }), { reply: () => {} });
  const ringing = [...ua2.dialogs.values()][0];
  check(ringing.state === 'proceeding', 'the dialog is ringing, not answered');
  // In-dialog answers go through ctx.reply (the transport's own path), not transport.replyTo.
  const inDialog = [];
  await ua2.onRequest(inboundInvite({ callId: cid, cseq: 2 }), { reply: (b) => inDialog.push(String(b)) });
  const reAnswer = inDialog[inDialog.length - 1] || '';
  console.log(`  re-INVITE answer: ${(reAnswer.split('\r\n')[0] || '(none)')}`);
  check(/^SIP\/2\.0 200 OK/.test(reAnswer), 'a re-INVITE while ringing is answered 200 OK');
  check(/Content-Type: application\/sdp/i.test(reAnswer) && /\r\nm=audio /.test(reAnswer),
    'and that answer carries SDP instead of an empty body');
  check(ua2.dialogs.size === 1, 'it updates the existing dialog instead of creating a second one');

  ringing.end('normal');
  ua2.close();

  assert.strictEqual(failed, 0, `${failed} inbound check(s) failed`);
  console.log(`\n${failed ? '\u{1F4A5}' : '\u{1F389}'} ${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
