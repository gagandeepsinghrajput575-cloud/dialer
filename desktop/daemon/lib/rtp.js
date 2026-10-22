// RTP (RFC 3550) and RFC 2833 telephone-event, for one 8 kHz G.711 stream.
//
// The header is twelve bytes and the whole job is: keep the sequence numbers contiguous, the
// timestamps advancing by exactly the packet duration, and the marker bit set on the first
// packet after silence. Anything else and the far end hears clicks or a robot.
'use strict';

const crypto = require('crypto');

const HEADER_LEN = 12;
const SAMPLES_PER_PACKET = 160;   // 20 ms at 8 kHz
const PT_DTMF = 101;

function createSession({ payloadType = 0, ssrc = crypto.randomBytes(4).readUInt32BE(0) } = {}) {
  // Both counters are private and mutable; the getters below expose them for tests and logs.
  // A DTMF burst shares one timestamp but still consumes sequence numbers, which is why the
  // two are advanced separately rather than derived from one another.
  let seq = crypto.randomBytes(2).readUInt16BE(0);
  let stamp = crypto.randomBytes(4).readUInt32BE(0);
  return {
    ssrc,
    payloadType,
    get seq() { return seq; },
    get timestamp() { return stamp; },
    nextSeq() { const value = seq; seq = (seq + 1) & 0xffff; return value; },
    advance(_from, samples) { stamp = (stamp + samples) >>> 0; },
    /**
     * @param {Buffer} payload G.711 bytes
     * @param {boolean} marker first packet of a talk spurt
     */
    packet(payload, marker = false) {
      const buf = Buffer.allocUnsafe(HEADER_LEN + payload.length);
      buf[0] = 0x80;                                  // V=2, P=0, X=0, CC=0
      buf[1] = (marker ? 0x80 : 0) | (payloadType & 0x7f);
      buf.writeUInt16BE(seq & 0xffff, 2);
      buf.writeUInt32BE(stamp >>> 0, 4);
      buf.writeUInt32BE(ssrc >>> 0, 8);
      payload.copy(buf, HEADER_LEN);
      seq = (seq + 1) & 0xffff;
      stamp = (stamp + payload.length) >>> 0;
      return buf;
    },
  };
}

/**
 * Parse a received datagram. Returns null for anything that is not RTP we can use — a stray
 * STUN binding or an RTCP report must not be treated as audio.
 */
function parse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_LEN) return null;
  const version = (buf[0] & 0xc0) >> 6;
  if (version !== 2) return null;
  const padding = !!(buf[0] & 0x20);
  const extension = !!(buf[0] & 0x10);
  const cc = buf[0] & 0x0f;
  const marker = !!(buf[1] & 0x80);
  const payloadType = buf[1] & 0x7f;
  let offset = HEADER_LEN + cc * 4;
  if (extension) {
    if (buf.length < offset + 4) return null;
    offset += 4 + buf.readUInt16BE(offset + 2) * 4;
  }
  if (offset > buf.length) return null;
  let end = buf.length;
  if (padding && end > offset) {
    const padLen = buf[end - 1];
    if (padLen > 0 && padLen <= end - offset) end -= padLen;
  }
  if (end < offset) return null;
  return {
    kind: 'rtp',
    marker,
    payloadType,
    seq: buf.readUInt16BE(2),
    timestamp: buf.readUInt32BE(4),
    ssrc: buf.readUInt32BE(8),
    payload: buf.subarray(offset, end),
  };
}

// RTCP packets share the port pair (RTP on even, RTCP on odd). They are not audio; recognising
// them is enough to drop them without logging noise.
function isRtcp(buf, rtpPort) {
  if (buf.length < 2) return false;
  const pt = buf[1] & 0x7f;
  return pt >= 64 && pt <= 95;
}

const DTMF_CODES = {
  0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
  '*': 10, '#': 11, A: 12, B: 13, C: 14, D: 15,
};

/**
 * The three/four packets an RFC 2833 digit needs: same timestamp, growing duration, and the
 * last one flagged E-bit and repeated so a single loss does not eat the tone.
 * @param {object} o { session, digit, durationMs, volume }
 * @returns {Buffer[]}
 */
function dtmfPackets({ session, digit, durationMs = 160, volume = 10 }) {
  const code = DTMF_CODES[String(digit).toUpperCase()];
  if (code === undefined || !session) return [];
  const stamp = session.timestamp;
  const total = Math.max(80, Math.round(durationMs / 10) * 80); // duration is in 8 kHz units
  const body = (dur, end) => {
    // event(8) | E R volume(6) | duration(16)
    const b = Buffer.allocUnsafe(4);
    const vol = Math.max(0, Math.min(63, volume));
    b[0] = code;
    b[1] = (end ? 0x80 : 0) | (vol & 0x3f);
    b.writeUInt16BE(Math.min(0xffff, dur), 2);
    return b;
  };
  const out = [];
  const steps = [Math.round(total * 0.3), Math.round(total * 0.6), total];
  for (const dur of steps) out.push(rawPacket(session, PT_DTMF, stamp, body(dur, false), false));
  // The end packet three times: RFC 2833 §2.5.1.4 requires retransmission until the receiver
  // acknowledges by timestamp, and UDP gives us nothing else to rely on.
  for (let i = 0; i < 3; i++) out.push(rawPacket(session, PT_DTMF, stamp, body(total, true), false));
  session.advance(stamp, total);
  return out;
}

// DTMF must not disturb the audio sequence/timestamp accounting, so it writes its own header.
function rawPacket(session, pt, timestamp, payload, marker) {
  const buf = Buffer.allocUnsafe(HEADER_LEN + payload.length);
  buf[0] = 0x80;
  buf[1] = (marker ? 0x80 : 0) | (pt & 0x7f);
  buf.writeUInt16BE(session.nextSeq() & 0xffff, 2);
  buf.writeUInt32BE(timestamp >>> 0, 4);
  buf.writeUInt32BE(session.ssrc >>> 0, 8);
  payload.copy(buf, HEADER_LEN);
  return buf;
}

module.exports = {
  createSession, parse, isRtcp, dtmfPackets, rawPacket,
  HEADER_LEN, SAMPLES_PER_PACKET, PT_DTMF, DTMF_CODES,
};
