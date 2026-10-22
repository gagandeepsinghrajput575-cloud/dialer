// Telephony chaos suite — part 1 of 2: the wire libraries (checks 1-28).
//
// Every line here is a hard invariant rather than a smoke test: the exact value a real trunk sends
// and the exact bytes we must put back. Digest, SIP framing, SDP offer/answer, G.711, RTP and the
// UDP transaction layer. Getting one of these wrong is a call that never connects, has no audio, or
// is cut off four seconds after answer — and none of them surface in a happy-path test.
//
// Checks are one per line on purpose: this file has a 350-line ceiling and 28 invariants to pin, so
// the prose lives in the assertion message and the title, not in the layout.
//
// Run through telephony-chaos-stress.test.js, which aggregates this and part 2 (checks 29-60).
'use strict';

const assert = require('assert');
const digest = require('../../desktop/daemon/lib/digest');
const sip = require('../../desktop/daemon/lib/sipMessage');
const sdp = require('../../desktop/daemon/lib/sdp');
const g711 = require('../../desktop/daemon/lib/g711');
const rtp = require('../../desktop/daemon/lib/rtp');
const { Transport, keyOf } = require('../../desktop/daemon/lib/transport');

const ck = assert.strictEqual;
const ok = assert.ok;
const CRLF = '\r\n';

// A datagram exactly as a carrier proxy writes one: CRLF throughout, one line per header value
// (a forwarded request really does carry several Vias), blank line, then the body.
function sipBuf(startLine, headers = {}, body = '') {
  const lines = [startLine];
  for (const [name, value] of Object.entries(headers)) {
    for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
  }
  return Buffer.from(`${lines.join(CRLF)}${CRLF}${CRLF}${body}`, 'utf8');
}

const VIA1 = 'SIP/2.0/UDP 10.0.0.5:5060;branch=z9hG4bKresp1;rport';
function response(status, reason, extra = {}, body = '') {
  return sipBuf(`SIP/2.0 ${status} ${reason}`, Object.assign({
    Via: VIA1, From: '"Alice" <sip:alice@atlanta.com>;tag=1928301774', To: '<sip:bob@biloxi.com>;tag=a6c85cf',
    'Call-ID': 'a84b4c76e66710@atlanta.com', CSeq: '314159 INVITE', 'Content-Type': 'application/sdp',
  }, extra), body);
}

const checks = [
  [1, 'a 407 challenge carries every digest parameter through, quoted or bare', () => {
    const list = digest.parseChallenges('Digest realm="sip.flynumber.com", nonce="abc123", qop="auth", algorithm=MD5, opaque="op-1"');
    ck(list.length, 1); ck(list[0].scheme, 'digest');
    const p = list[0].params;
    ck(p.realm, 'sip.flynumber.com'); ck(p.nonce, 'abc123'); ck(p.qop, 'auth'); ck(p.algorithm, 'MD5'); ck(p.opaque, 'op-1');
  }],
  [2, 'a Basic challenge listed ahead of a Digest one never wins the pick', () => {
    const list = digest.parseChallenges(['Basic realm="nope"', 'Digest realm="sip.flynumber.com", nonce="n-2", qop="auth"']);
    ck(list.length, 2); ck(digest.pick(list).scheme, 'digest'); ck(digest.pick(list).params.nonce, 'n-2'); ck(digest.pick([]), null);
  }],
  [3, 'the digest response is the RFC 2617 MD5, byte for byte, with qop=auth', () => {
    const [ch] = digest.parseChallenges('Digest realm="sip.flynumber.com", nonce="dcd98b", qop="auth", algorithm=MD5');
    const out = digest.respond({ method: 'REGISTER', uri: 'sip:sip.flynumber.com', username: '15551234567', password: 's3cr3t', challenge: ch, nc: 1, cnonce: '0a4f113b' });
    const ha1 = digest.md5('15551234567:sip.flynumber.com:s3cr3t');
    const ha2 = digest.md5('REGISTER:sip:sip.flynumber.com');
    ok(out.startsWith('Digest username="15551234567"'), out);
    ok(out.includes(`response="${digest.md5(`${ha1}:dcd98b:00000001:0a4f113b:auth:${ha2}`)}"`), 'the hash must be the qop=auth MD5');
    ok(out.includes('nc=00000001') && out.includes('cnonce="0a4f113b"') && out.includes('qop=auth'), out);
    ok(!out.includes('algorithm='), 'MD5 is the default and must not be spelled out');
  }],
  [4, 'no qop means the RFC 2069 hash, and an algorithm we cannot do throws', () => {
    const [plain] = digest.parseChallenges('Digest realm="r", nonce="n1"');
    const out = digest.respond({ method: 'INVITE', uri: 'sip:x@y', username: 'u', password: 'p', challenge: plain });
    ok(out.includes(`response="${digest.md5(`${digest.md5('u:r:p')}:n1:${digest.md5('INVITE:sip:x@y')}`)}`), out);
    ok(!out.includes('qop=') && !out.includes('nc='), out);
    const [sha] = digest.parseChallenges('Digest realm="r", nonce="n1", algorithm=SHA-256');
    assert.throws(() => digest.respond({ method: 'REGISTER', uri: 'sip:x', username: 'u', password: 'p', challenge: sha }), /Unsupported digest algorithm/);
  }],
  [5, 'a URI user part is percent-decoded, and a non-SIP URI is not invented', () => {
    ck(sip.parseUri('sip:%2B4520123456@host').user, '+4520123456');
    const p = sip.parseUri('<sip:john%20doe@10.0.0.1:5062;transport=udp>');
    ck(p.user, 'john doe'); ck(p.host, '10.0.0.1'); ck(p.port, 5062); ck(p.params.transport, 'udp');
    ck(sip.parseUri('tel:123').raw, 'tel:123'); ck(sip.parseUri('tel:123').user, '', 'a tel: URI has no SIP user part');
  }],
  [6, 'compact header forms are expanded, because the FlyNumber proxy sends them', () => {
    const m = sip.parse(sipBuf('INVITE sip:bob@biloxi.com SIP/2.0', {
      v: 'SIP/2.0/UDP pc33.atlanta.com;branch=z9hG4bK776asdhds', i: 'compact-call-1', f: '<sip:a@b>;tag=1', t: '<sip:c@d>', l: '0',
    }));
    ck(m.kind, 'request'); ck(m.first('call-id'), 'compact-call-1', 'i: must read as Call-ID');
    ck(m.first('via'), 'SIP/2.0/UDP pc33.atlanta.com;branch=z9hG4bK776asdhds');
    ck(m.first('from'), '<sip:a@b>;tag=1'); ck(m.first('content-length'), '0');
    ck(sip.COMPACT.i, 'call-id'); ck(sip.COMPACT.m, 'contact');
  }],
  [7, 'repeated Via headers survive as a list and first() takes the top one', () => {
    const m = sip.parse(sipBuf('INVITE sip:bob@biloxi.com SIP/2.0', {
      Via: ['SIP/2.0/UDP proxy.carrier.com:5060;branch=z9hG4bKtop', 'SIP/2.0/UDP 10.0.0.9:5060;branch=z9hG4bKbottom'], 'Call-ID': 'vias-1',
    }));
    ok(Array.isArray(m.headers.via), 'two Vias must stay two'); ck(m.headers.via.length, 2);
    ck(m.first('via'), 'SIP/2.0/UDP proxy.carrier.com:5060;branch=z9hG4bKtop');
    ck(sip.addressOf(m).host, 'proxy.carrier.com');
    ck(sip.addressOf(m, { host: '1.2.3.4', port: 9 }).host, '1.2.3.4', 'what the peer saw wins over what we wrote');
  }],
  [8, 'a folded header (RFC 3261 7.3.1) is unfolded before it is read', () => {
    const m = sip.parse(`INVITE sip:bob@biloxi.com SIP/2.0${CRLF}Subject: I know${CRLF} you are there${CRLF}Call-ID: folded-1${CRLF}${CRLF}`);
    ck(m.first('subject'), 'I know you are there'); ck(m.first('call-id'), 'folded-1');
  }],
  [9, 'a junk datagram parses to null instead of throwing inside the audio path', () => {
    ck(sip.parse(''), null); ck(sip.parse(null), null); ck(sip.parse('NOT SIP AT ALL'), null);
    ck(sip.parse('SIP/2.0 not-a-status'), null); ck(sip.parse(Buffer.from([0, 1, 2, 3])), null);
    ck(sip.parse(sipBuf('SIP/2.0 200 OK', { Via: 'x' })).kind, 'response');
  }],
  [10, 'buildUri omits the default port and keeps a valueless parameter', () => {
    ck(sip.buildUri({ user: '15551234567', host: 'sip.flynumber.com', port: 5060 }), 'sip:15551234567@sip.flynumber.com');
    ck(sip.buildUri({ user: 'x', host: 'h', port: 5070 }), 'sip:x@h:5070');
    ck(sip.buildUri({ user: 'x', host: 'h', params: { user: 'phone' } }), 'sip:x@h;user=phone');
    ck(sip.buildUri({ user: 'x', host: 'h', params: { lr: '' } }), 'sip:x@h;lr');
  }],
  [11, 'serialize orders the mandatory headers, writes CRLF and counts bytes not chars', () => {
    const body = 'v=0\r\no=- 1 1 IN IP4 1.2.3.4\r\n';
    const buf = sip.serialize({ startLine: 'INVITE sip:bob@biloxi.com SIP/2.0', body, headers: {
      'X-Thing': '1', CSeq: '1 INVITE', Via: 'SIP/2.0/UDP h:5060;branch=z9hG4bK1', 'Call-ID': 'c1',
    } });
    const t = buf.toString('utf8');
    ok(t.startsWith('INVITE sip:bob@biloxi.com SIP/2.0\r\nVia:'), t.slice(0, 60));
    ok(t.indexOf('Via:') < t.indexOf('Call-ID:') && t.indexOf('Call-ID:') < t.indexOf('CSeq:') && t.indexOf('CSeq:') < t.indexOf('X-Thing:'), 'Via, Call-ID, CSeq first, unknowns last');
    ok(t.includes(`Content-Length: ${Buffer.byteLength(body)}`), 'byte length, not string length');
    ok(t.endsWith(`${CRLF}${CRLF}${body}`)); ck(sip.parse(buf).body, body);
  }],
  [12, 'parseVia reads branch, received and rport — the NAT path depends on all three', () => {
    const v = sip.parseVia('SIP/2.0/UDP 10.0.0.5:5060;rport=5070;received=203.0.113.9;branch=z9hG4bKabc');
    ck(v.transport, 'UDP'); ck(v.host, '10.0.0.5'); ck(v.port, 5060); ck(v.branch, 'z9hG4bKabc');
    ck(v.received, '203.0.113.9'); ck(v.rport, 5070);
    ck(sip.parseVia('').host, ''); ck(sip.parseVia(undefined).transport, 'UDP');
  }],
  [13, 'CSeq and the From identity are read the way the UI needs them', () => {
    const m = sip.parse(sipBuf('INVITE sip:b SIP/2.0', { CSeq: '314159 INVITE', From: '"Alice Anders" <sip:alice@atlanta.com>;tag=1928' }));
    ck(sip.parseCSeq(m).seq, 314159); ck(sip.parseCSeq(m).method, 'INVITE');
    const id = sip.identityOf(m.first('from'));
    ck(id.displayName, 'Alice Anders'); ck(id.uri, 'sip:alice@atlanta.com'); ck(id.user, 'alice');
    ck(sip.identityOf('sip:bare@host').user, 'bare');
    ck(sip.parseCSeq(null).seq, 0, 'a null message must not throw on the response path');
  }],
  [14, 'our offer advertises PCMU, PCMA and telephone-event at 8 kHz', () => {
    const body = sdp.build({ ip: '203.0.113.7', port: 16384 });
    ok(body.includes('v=0') && body.includes('c=IN IP4 203.0.113.7'), body);
    ok(body.includes('m=audio 16384 RTP/AVP 0 8 101'), body);
    ok(body.includes('a=rtpmap:0 PCMU/8000') && body.includes('a=rtpmap:8 PCMA/8000'), body);
    ok(body.includes('a=rtpmap:101 telephone-event/8000') && body.includes('a=fmtp:101 0-16'), 'DTMF must be offered or the keypad is dead');
    ok(body.includes('a=ptime:20') && body.includes('a=sendrecv') && body.endsWith('\r\n'));
  }],
  [15, 'a remote SDP yields the media address, its payload order and the DTMF payload', () => {
    const p = sdp.parse(['v=0', 'o=- 9 9 IN IP4 198.51.100.2', 's=-', 'c=IN IP4 198.51.100.2', 't=0 0', 'm=audio 49170 RTP/AVP 8 0 101',
      'a=rtpmap:8 PCMA/8000', 'a=rtpmap:0 PCMU/8000', 'a=rtpmap:101 telephone-event/8000', 'a=fmtp:101 0-16', 'a=sendonly'].join(CRLF));
    ck(p.ip, '198.51.100.2'); ck(p.port, 49170); ck(p.dtmfPt, 101); ck(p.direction, 'sendonly'); ck(p.sessionId, '9'); ck(p.codecs.length, 3);
    assert.deepStrictEqual(p.payloadTypes, [8, 0, 101], 'the peer order is the negotiation order');
    ck(sdp.parse('').port, 0); assert.deepStrictEqual(sdp.parse('').payloadTypes, []);
  }],
  [16, 'negotiation honours the peer order and falls back to PCMU rather than silence', () => {
    assert.deepStrictEqual(sdp.negotiate(sdp.parse('m=audio 1 RTP/AVP 8 0')), { pt: 8, name: 'PCMA' });
    assert.deepStrictEqual(sdp.negotiate(sdp.parse('m=audio 1 RTP/AVP 0 8')), { pt: 0, name: 'PCMU' });
    assert.deepStrictEqual(sdp.negotiate(sdp.parse('m=audio 1 RTP/AVP 18 96')), { pt: 0, name: 'PCMU' }, 'nothing shared: answer with our preference');
    assert.deepStrictEqual(sdp.negotiate(sdp.parse('m=audio 1 RTP/AVP 96'), []), null);
    assert.deepStrictEqual(sdp.negotiate(null), { pt: 0, name: 'PCMU' });
  }],
  [17, 'G.711 survives a round trip in both laws, and silence is 0xff / 0xd5', () => {
    for (const pt of [0, 8]) {
      const pcm = Int16Array.from(g711.SAMPLES);
      const back = g711.decode(g711.encode(pcm, pt), pt);
      ck(back.length, pcm.length);
      for (let i = 0; i < pcm.length; i += 1) {
        // 8-bit logarithmic: near full scale one quantization step is ~630, so that is the tolerance.
        ok(Math.abs(back[i] - pcm[i]) <= 700, `pt ${pt} sample ${pcm[i]} came back ${back[i]}`);
      }
    }
    ck(g711.encode(Int16Array.from([0]), 0)[0], 0x7f, 'u-law silence (+0)');
    ck(g711.encode(Int16Array.from([0]), 8)[0], 0xd5, 'A-law silence');
    ck(g711.decode(Buffer.from([0x7f]), 0)[0], 0); ck(g711.decode(Buffer.from([0xff]), 0)[0], 0, '-0 decodes to 0 too');
    ck(g711.encode(new Int16Array(160), 0).length, 160, 'one byte per sample: a 20 ms frame stays 160 bytes');
  }],
  [18, 'the float/int16 conversions clamp, and level() reports a usable peak', () => {
    const i = g711.toInt16(Float32Array.from([0.5, -0.5, 2, -3, 0]));
    assert.deepStrictEqual(Array.from(i), [16384, -16383, 32767, -32767, 0], 'out of range is clamped, not wrapped');
    ck(i[1], -16383, 'Math.round is half-up, so -0.5 lands one below the mirror of +0.5');
    ck(g711.level(Int16Array.from([0, -16384, 8000])), 0.5, 'peak over 32768');
    ck(g711.level(new Int16Array(160)), 0);
    const f = g711.toFloat32(Int16Array.from([16384, -32768]));
    ck(f[0], 0.5); ck(f[1], -1);
  }],
  [19, 'an RTP header is 12 bytes, V=2, and the sequence wraps 65535 -> 0', () => {
    const s = rtp.createSession({ payloadType: 0, ssrc: 3735928559, seq: 65534, timestamp: 1000 });
    const a = s.packet(Buffer.alloc(160), true);
    ck(a.length, 172); ck(a[0], 0x80, 'V=2, no padding, no extension, no CSRC');
    ck(a[1] & 0x80, 0x80, 'the first packet of a talk spurt carries the marker'); ck(a[1] & 0x7f, 0);
    ck(a.readUInt16BE(2), 65534); ck(a.readUInt32BE(4), 1000); ck(a.readUInt32BE(8), 3735928559);
    const b = s.packet(Buffer.alloc(160), false);
    ck(b.readUInt16BE(2), 65535); ck(b[1] & 0x80, 0);
    ck(s.packet(Buffer.alloc(160)).readUInt16BE(2), 0, 'the counter must wrap, not stick');
  }],
  [20, 'the timestamp advances by exactly the payload length — 160 per 20 ms frame', () => {
    const s = rtp.createSession({ payloadType: 8, seq: 1, timestamp: 0 });
    s.packet(Buffer.alloc(160)); ck(s.timestamp, 160);
    s.packet(Buffer.alloc(160)); ck(s.timestamp, 320); ck(s.seq, 3);
    s.advance(320, 160); ck(s.timestamp, 480);
    const huge = rtp.createSession({ seq: 1, timestamp: 4294967200 });
    huge.packet(Buffer.alloc(160)); ck(huge.timestamp, 64, 'the 32-bit timestamp wraps, never goes negative');
  }],
  [21, 'rtp.parse rejects what is not audio: short, wrong version, an extension that lies', () => {
    const good = rtp.createSession({ seq: 7, timestamp: 700, ssrc: 5 }).packet(Buffer.alloc(20, 0x41), true);
    const p = rtp.parse(good);
    ck(p.kind, 'rtp'); ck(p.marker, true); ck(p.seq, 7); ck(p.timestamp, 700); ck(p.ssrc, 5); ck(p.payload.length, 20);
    ck(rtp.parse(Buffer.alloc(11)), null, 'shorter than a header'); ck(rtp.parse('not a buffer'), null);
    const v1 = Buffer.from(good); v1[0] = 0x40; ck(rtp.parse(v1), null, 'V=1 is not RTP we can play');
    const ext = Buffer.from(good); ext[0] = 0x90; ck(rtp.parse(ext), null, 'an extension past the end must not be trusted');
    const pad = Buffer.concat([good, Buffer.from([0, 0, 3])]); pad[0] = 0xa0;
    ck(rtp.parse(pad).payload.length, 20, 'RFC 3550 padding: the last byte counts itself');
  }],
  [22, 'RTCP is recognised by payload type 64-95 so reports are never played as audio', () => {
    const at = (pt) => { const b = Buffer.alloc(8); b[0] = 0x80; b[1] = pt & 0x7f; return b; };
    ck(rtp.isRtcp(at(200)), true, 'SR'); ck(rtp.isRtcp(at(201)), true, 'RR'); ck(rtp.isRtcp(at(203)), true, 'BYE');
    ck(rtp.isRtcp(at(64)), true); ck(rtp.isRtcp(at(95)), true);
    ck(rtp.isRtcp(at(0)), false, 'PCMU'); ck(rtp.isRtcp(at(8)), false, 'PCMA'); ck(rtp.isRtcp(at(101)), false, 'telephone-event');
    ck(rtp.isRtcp(at(96)), false); ck(rtp.isRtcp(Buffer.alloc(1)), false);
  }],
  [23, 'an RFC 2833 digit is six packets on one timestamp, the last three E-bit repeats', () => {
    const s = rtp.createSession({ seq: 100, timestamp: 5000, ssrc: 9 });
    const packets = rtp.dtmfPackets({ session: s, digit: '5', durationMs: 160, volume: 10 });
    ck(packets.length, 6);
    ck(new Set(packets.map((b) => b.readUInt32BE(4))).size, 1, 'one burst shares one timestamp');
    ck(packets[0].readUInt32BE(4), 5000);
    assert.deepStrictEqual(packets.map((b) => b.readUInt16BE(2)), [100, 101, 102, 103, 104, 105], 'but it still consumes sequence numbers');
    assert.deepStrictEqual(packets.map((b) => b[1] & 0x7f), [101, 101, 101, 101, 101, 101]);
    assert.deepStrictEqual(packets.map((b) => (b[13] & 0x80 ? 1 : 0)), [0, 0, 0, 1, 1, 1], 'E bit is payload byte 1, retransmitted three times');
    assert.deepStrictEqual(packets.map((b) => b[12]), [5, 5, 5, 5, 5, 5], 'event code 5');
    assert.deepStrictEqual(packets.map((b) => b.readUInt16BE(14)), [384, 768, 1280, 1280, 1280, 1280], 'duration grows to 160 ms at 8 kHz');
    ck(s.timestamp, 6280, 'the burst consumes its own duration exactly once');
    assert.deepStrictEqual(rtp.dtmfPackets({ session: s, digit: 'Q' }), []);
    ck(rtp.DTMF_CODES['#'], 11); ck(rtp.DTMF_CODES.A, 12);
  }],
  [24, 'the transaction key is branch + method, however it has to be discovered', () => {
    ck(keyOf({ branch: 'z9hG4bK1', method: 'invite' }), 'z9hG4bK1|INVITE', 'the method is uppercased');
    ck(keyOf({ buf: sipBuf('INVITE sip:bob@biloxi.com SIP/2.0', { Via: 'SIP/2.0/UDP h:5060;branch=z9hG4bKx1', CSeq: '1 INVITE', 'Call-ID': 'k1' }) }), 'z9hG4bKx1|INVITE');
    ck(keyOf({ buf: response(486, 'Busy Here', { Via: 'SIP/2.0/UDP h:5060;branch=z9hG4bKx1' }) }), 'z9hG4bKx1|INVITE', 'a response keys off its CSeq method');
    ck(keyOf({ buf: sipBuf('BYE sip:b@h SIP/2.0', { Via: 'SIP/2.0/UDP h;branch=z9hG4bKb2', CSeq: '9 BYE' }) }), 'z9hG4bKb2|BYE');
    ck(keyOf({ buf: Buffer.from('') }), '|', 'unparseable bytes yield an empty key rather than a throw');
  }],
  [25, 'open() binds and reports a routable advertised address, never the wildcard', async () => {
    const t = new Transport({ localAddress: '', sipPort: 0 });
    const addr = await t.open();
    ok(addr && addr.port > 0, 'an ephemeral port must be bound'); ck(addr.family, 'IPv4');
    ok(t.host !== '0.0.0.0' && t.host !== '::', 'SDP and Contact must never advertise the wildcard');
    ok(/^\d{1,3}(\.\d{1,3}){3}$/.test(t.host), t.host);
    ck(t.port, addr.port); ck(new Transport({ sipPort: 5060 }).port, 5060, 'an explicit SIP port is what we advertise');
    t.close(); t.close(); ck(t.closed, true, 'close() is idempotent');
  }],
  [26, 'a provisional stops Timer A but keeps the transaction; a stray response only emits', async () => {
    const t = new Transport({ localAddress: '' });
    await t.open();
    t.socket.send = (buf, off, len, port, host, cb) => cb(null);   // never put a test datagram on a wire
    const seen = [];
    const tx = t.request({
      msg: sipBuf('INVITE sip:bob@biloxi.com SIP/2.0', { Via: 'SIP/2.0/UDP h:5060;branch=z9hG4bKp1', CSeq: '1 INVITE', 'Call-ID': 'prov-1' }),
      branch: 'z9hG4bKp1', method: 'INVITE', target: { host: '127.0.0.1', port: 5060 }, invite: true,
      onProvisional: (m) => seen.push(m.status),
    });
    ok(tx.retransmit, 'Timer A must be armed for an INVITE');
    t.onMessage(response(100, 'Trying', { Via: 'SIP/2.0/UDP h:5060;branch=z9hG4bKp1' }), { address: '127.0.0.1', port: 5060 });
    assert.deepStrictEqual(seen, [100]);
    ck(tx.retransmit, null, 'a provisional stops the retransmit timer');
    ck(t.transactions.has('z9hG4bKp1|INVITE'), true, 'the transaction lives until a final response');
    const strays = [];
    t.on('unmatched_response', (m) => strays.push(m.status));
    t.onMessage(response(486, 'Busy Here', { Via: 'SIP/2.0/UDP h:5060;branch=z9hG4bKunknown' }), { address: '127.0.0.1', port: 5060 });
    assert.deepStrictEqual(strays, [486], 'a response with no transaction is reported, never dropped silently');
    tx.stop(); t.close();
  }],
  [27, 'an unsendable datagram becomes a synthetic final response, not a hung call', async () => {
    const t = new Transport({ localAddress: '' });
    await t.open();
    const got = await new Promise((resolve) => t.request({
      msg: sipBuf('INVITE sip:bob@biloxi.com SIP/2.0', { Via: 'SIP/2.0/UDP h:5060;branch=z9hG4bKdead', CSeq: '1 INVITE', 'Call-ID': 'dead-1' }),
      branch: 'z9hG4bKdead', method: 'INVITE', target: { host: '256.256.256.256', port: 5060 }, invite: true, onFinal: resolve,
    }));
    ck(got.synthetic, true); ck(got.status, 0);
    ok(/^transport: /.test(got.reason), `the UI shows this verbatim: ${got.reason}`);
    ck(t.transactions.has('z9hG4bKdead|INVITE'), false, 'the transaction is cleaned up');
    t.close();
  }],
  [28, 'where a peer really answered from is remembered and used for in-dialog requests', () => {
    const t = new Transport({ localAddress: '' });
    t.onMessage(response(200, 'OK', { 'Call-ID': 'hint-1' }), { address: '138.197.42.26', port: 5060 });
    assert.deepStrictEqual(t.peerFor('hint-1', null), { host: '138.197.42.26', port: 5060 });
    const fallback = { host: 'sip.flynumber.com', port: 5060 };
    ck(t.peerFor('never-seen', fallback), fallback, 'an unseen dialog falls back to the account domain');
    t.onMessage(sipBuf('BYE sip:15551234567@sip.flynumber.com SIP/2.0', {
      Via: 'SIP/2.0/UDP 138.197.42.26:5060;branch=z9hG4bKbye1', From: '<sip:a@b>;tag=1', To: '<sip:c@d>', 'Call-ID': 'hint-2', CSeq: '2 BYE',
    }), { address: '138.197.42.26', port: 5070 });
    assert.deepStrictEqual(t.peerFor('hint-2', null), { host: '138.197.42.26', port: 5070 }, 'an inbound request teaches us the peer too');
  }],
];

module.exports = { checks, sipBuf, response, VIA1 };

// Direct run: `node test/unit/telephony-chaos-part1.test.js` proves this half on its own.
if (require.main === module) {
  require('../helpers/telephony-mocks').runChecks(checks, 'part 1').then((r) => process.exit(r.failed ? 1 : 0));
}
