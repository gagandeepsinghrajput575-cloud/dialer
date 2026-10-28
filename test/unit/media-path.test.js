// The media path itself: what leaves as our voice, what we accept as theirs, and who may re-point it.
//
// Three defects live here and all three are silent on a call:
//   1. our outbound payload type must follow the answer (PCMA on a European trunk, PCMU on a US one);
//   2. an inbound packet in a codec we support must not be dropped merely because its payload type
//      differs from the one the answer chose — that is a one-way call with `received` still climbing;
//   3. only a real RTP packet may re-point `media.target`, or an unsolicited datagram can redirect
//      the operator's voice to an arbitrary host.
const assert = require('assert');
const dgram = require('dgram');
const { EventEmitter } = require('events');

const { UserAgent } = require('../../desktop/daemon/lib/ua');
const sdpLib = require('../../desktop/daemon/lib/sdp');
const rtp = require('../../desktop/daemon/lib/rtp');
const g711 = require('../../desktop/daemon/lib/g711');

let passed = 0;
let failed = 0;
const ok = (m) => { passed++; console.log(`  \u2713 ${m}`); };
const bad = (m) => { failed++; console.log(`  \u2717 ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeTransport() {
  const t = new EventEmitter();
  t.host = '203.0.113.7'; t.port = 5060; t.localAddress = '0.0.0.0';
  t.send = async () => t;
  return t;
}

const ANSWER = [
  'v=0', 'o=carrier 1 1 IN IP4 127.0.0.1', 's=carrier', 'c=IN IP4 127.0.0.1', 't=0 0',
  'm=audio 40000 RTP/AVP 8 0 101',
  'a=rtpmap:8 PCMA/8000', 'a=rtpmap:0 PCMU/8000', 'a=rtpmap:101 telephone-event/8000',
  'a=fmtp:101 0-16', 'a=sendrecv', '',
].join('\r\n');

(async () => {
  console.log('\n=== VAL-MEDIA-015: outbound PT, inbound PT tolerance, media latching ===\n');

  const written = [];
  const audio = {
    name: 'stub', available: () => true, reason: '',
    describe: () => ({ name: 'stub' }),
    async open() {}, start() {}, stop() {},
    write(pcm) { written.push(pcm); return true; },
  };
  const ua = new UserAgent({ transport: fakeTransport(), audio, account: { domain: 'example.test', port: 5060, user: 'u', password: 'p' } });
  const media = await ua.openMediaSocket();
  const dialog = { id: 'd1', ua, media, remoteSdp: sdpLib.parse(ANSWER), state: 'confirmed', recorder: null, codec: null };
  ua.active = dialog;

  // 1. The answer chose PCMA (pt 8) — our encoder must follow it, not stay on PCMU.
  const applied = ua.applyRemoteSdp(dialog);
  check(applied === true, 'the answer is applied');
  check(media.codec === 8 && media.remotePt === 8 && media.session.payloadType === 8,
    'the chosen payload type follows the answer (PCMA = 8)');
  check(media.target.port === 40000, 'media is aimed at the answer address');

  const outgoing = media.session.packet(g711.encode(new Int16Array(160), media.codec));
  check((outgoing[1] & 0x7f) === 8, 'an outbound packet carries the negotiated payload type');
  check(outgoing.length === 12 + 160, 'an outbound packet is 12 + 160 bytes (G.711, 20 ms)');

  // 2. A supported codec under a different PT must still be decoded, not dropped.
  const sender = dgram.createSocket('udp4');
  await new Promise((r) => sender.bind(0, '127.0.0.1', r));
  const pt0 = rtp.createSession({ payloadType: 0 }).packet(Buffer.alloc(160, 0xff));
  sender.send(pt0, media.port, '127.0.0.1');
  await sleep(120);
  check(written.length > 0, 'inbound PCMU (pt 0) is decoded even though the answer chose pt 8');
  check(media.target.host === '127.0.0.1' && media.target.port === sender.address().port,
    'a real RTP packet still re-latches the target (symmetric RTP preserved)');

  // 3. A datagram that is not RTP must never re-point where the operator's voice goes.
  const targetBefore = { ...media.target };
  const stray = dgram.createSocket('udp4');
  await new Promise((r) => stray.bind(0, '127.0.0.1', r));
  stray.send(Buffer.from('this is not rtp'), media.port, '127.0.0.1');
  await sleep(120);
  check(media.target.host === targetBefore.host && media.target.port === targetBefore.port,
    'a non-RTP datagram does not hijack the media target');

  // 4. A payload type we cannot decode is ignored rather than decoded into noise.
  const before = written.length;
  const unsupported = rtp.createSession({ payloadType: 99 }).packet(Buffer.alloc(160, 0x11));
  sender.send(unsupported, media.port, '127.0.0.1');
  await sleep(120);
  check(written.length === before, 'an undecodable payload type is ignored');

  sender.close(); stray.close(); media.close();
  assert.strictEqual(failed, 0, `${failed} media-path check(s) failed`);
  console.log(`\n${failed ? '\u{1F4A5}' : '\u{1F389}'} ${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
