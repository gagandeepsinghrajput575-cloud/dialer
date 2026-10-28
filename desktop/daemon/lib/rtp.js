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

function createSession({
  payloadType = 0,
  ssrc = crypto.randomBytes(4).readUInt32BE(0),
  seq = null,
  timestamp = null,
} = {}) {
  // The payload type is mutable: `applyRemoteSdp` sets it from the answer (a European trunk answers
  // PCMA), and a closure copy here meant every packet went out labelled with the type the session
  // was created with — A-law samples tagged PCMU, which the far end decodes as garbage. Sequence and
  // timestamp stay in their own locals because only `packet()` advances them.
  let pts = payloadType & 0x7f;
  let ssrcValue = ssrc >>> 0;
  // Both counters are private and mutable; the getters below expose them for tests and logs.
  // A DTMF burst shares one timestamp but still consumes sequence numbers, which is why the
  // two are advanced separately rather than derived from one another.
  //
  // The RFC leaves the starting values free, and random ones are the right default (RFC 3550
  // §5.1: a predictable initial sequence number lets an attacker pre-spoof packets). They are
  // seedable so a wrap-around at 65535 -> 0 and the 160-samples-per-frame advance can be pinned
  // by a test instead of being sampled once in every 65 thousand runs.
  let seqCounter = (seq === null || seq === undefined ? crypto.randomBytes(2).readUInt16BE(0) : Number(seq) || 0) & 0xffff;
  let stamp = (timestamp === null || timestamp === undefined ? crypto.randomBytes(4).readUInt32BE(0) : Number(timestamp) || 0) >>> 0;
  return {
    get ssrc() { return ssrcValue; },
    get payloadType() { return pts; },
    set payloadType(value) { pts = Number(value) & 0x7f; },
    get seq() { return seqCounter; },
    get timestamp() { return stamp; },
    nextSeq() { const value = seqCounter; seqCounter = (seqCounter + 1) & 0xffff; return value; },
    advance(_from, samples) { stamp = (stamp + samples) >>> 0; },
    /**
     * @param {Buffer} payload G.711 bytes
     * @param {boolean} marker first packet of a talk spurt
     */
    packet(payload, marker = false) {
      const buf = Buffer.allocUnsafe(HEADER_LEN + payload.length);
      buf[0] = 0x80;                                  // V=2, P=0, X=0, CC=0
      buf[1] = (marker ? 0x80 : 0) | (pts & 0x7f);    // read live: the answer may change it
      buf.writeUInt16BE(seqCounter & 0xffff, 2);
      buf.writeUInt32BE(stamp >>> 0, 4);
      buf.writeUInt32BE(ssrcValue >>> 0, 8);
      payload.copy(buf, HEADER_LEN);
      seqCounter = (seqCounter + 1) & 0xffff;
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

const DTMF_FREQUENCIES = {
  1: [697, 1209], 2: [697, 1336], 3: [697, 1477],
  4: [770, 1209], 5: [770, 1336], 6: [770, 1477],
  7: [852, 1209], 8: [852, 1336], 9: [852, 1477],
  '*': [941, 1209], 0: [941, 1336], '#': [941, 1477],
  A: [697, 1633], B: [770, 1633], C: [852, 1633], D: [941, 1633],
};

/**
 * Generate standard dual-tone multi-frequency PCM audio (mono, 8 kHz, 16-bit).
 * Used to stream in-band touch tones alongside out-of-band RFC 2833 packets
 * so IVR menus, PBXs, and carrier gateways reliably recognize every key press.
 */
function generateDtmfPcm(digit, durationMs = 160) {
  const code = String(digit).toUpperCase();
  const freqs = DTMF_FREQUENCIES[code];
  if (!freqs) return null;
  const numSamples = Math.round((durationMs / 1000) * 8000); // 8 kHz
  const pcm = new Int16Array(numSamples);
  const [f1, f2] = freqs;
  for (let i = 0; i < numSamples; i++) {
    const t = i / 8000;
    const s = 0.45 * Math.sin(2 * Math.PI * f1 * t) + 0.45 * Math.sin(2 * Math.PI * f2 * t);
    pcm[i] = Math.round(s * 16384);
  }
  return pcm;
}

/**
 * The three/four packets an RFC 2833 digit needs: same timestamp, growing duration, and the
 * last one flagged E-bit and repeated so a single loss does not eat the tone.
 * @param {object} o { session, digit, durationMs, volume, payloadType }
 * @returns {Buffer[]}
 */
function dtmfPackets({ session, digit, durationMs = 160, volume = 10, payloadType = PT_DTMF }) {
  const code = DTMF_CODES[String(digit).toUpperCase()];
  if (code === undefined || !session) return [];
  const pt = payloadType || PT_DTMF;
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
  for (const dur of steps) out.push(rawPacket(session, pt, stamp, body(dur, false), false));
  // The end packet three times: RFC 2833 §2.5.1.4 requires retransmission until the receiver
  // acknowledges by timestamp, and UDP gives us nothing else to rely on.
  for (let i = 0; i < 3; i++) out.push(rawPacket(session, pt, stamp, body(total, true), false));
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

/**
 * Transmit consecutive silent G.711 RTP packets for NAT latching (RFC 3550).
 * 160 bytes of 0xD5 (PCMA) or 0xFF (PCMU) per 20ms frame.
 * Each packet increments sequenceNumber by +1 and timestamp by +160.
 */
function createSilentNatPackets(session, count = 3, payloadType = session?.payloadType ?? 0) {
  if (!session) return [];
  const pt = payloadType !== undefined ? payloadType : (session.payloadType || 0);
  const silentByte = pt === 8 ? 0xd5 : 0xff; // 8=PCMA (0xD5), 0=PCMU (0xFF)
  const payload = Buffer.alloc(SAMPLES_PER_PACKET, silentByte);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(session.packet(payload, i === 0));
  }
  return out;
}

/**
 * Bounded RTP sequence reorder buffer (4 to 8 packets window).
 * Correctly accounts for uint16 wrap-around (65535 -> 0), duplicate suppression,
 * immediate pass-through for in-order arrivals, gap holding, and capacity/timeout flushes.
 */
class ReorderBuffer {
  constructor({ capacity = 8, onPacket, maxHoldMs = 60 } = {}) {
    this.capacity = capacity;
    this.onPacket = typeof onPacket === 'function' ? onPacket : () => {};
    this.maxHoldMs = maxHoldMs;
    this.queue = [];
    this.lastSeq = null;
    this.flushTimer = null;
  }

  static seqDiff(a, b) {
    let diff = (a - b) & 0xffff;
    if (diff > 0x8000) diff -= 0x10000;
    return diff;
  }

  push(packet) {
    if (!packet || packet.seq === undefined) return;
    const seq = packet.seq & 0xffff;

    if (this.lastSeq === null) {
      this.lastSeq = seq;
      this.onPacket(packet);
      return;
    }

    const diff = ReorderBuffer.seqDiff(seq, this.lastSeq);
    // Duplicate or old packet that already passed
    if (diff <= 0) return;

    if (diff === 1) {
      // In-order immediate pass-through
      this.lastSeq = seq;
      this.onPacket(packet);
      this.drainContiguous();
      return;
    }

    // Gap detected (e.g. lastSeq 100, received 102): hold for missing 101
    if (this.queue.some((p) => p.seq === seq)) return; // duplicate in buffer

    this.queue.push(packet);
    this.queue.sort((a, b) => ReorderBuffer.seqDiff(a.seq, b.seq));

    if (this.queue.length > this.capacity) {
      this.flushOldest();
    } else if (!this.flushTimer && this.maxHoldMs > 0) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushOldest();
      }, this.maxHoldMs);
    }
  }

  drainContiguous() {
    while (this.queue.length > 0) {
      const next = this.queue[0];
      const diff = ReorderBuffer.seqDiff(next.seq, this.lastSeq);
      if (diff === 1) {
        this.queue.shift();
        this.lastSeq = next.seq;
        this.onPacket(next);
      } else if (diff <= 0) {
        this.queue.shift();
      } else {
        break;
      }
    }
    if (this.queue.length === 0 && this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  flushOldest() {
    if (this.queue.length === 0) return;
    const oldest = this.queue.shift();
    this.lastSeq = oldest.seq;
    this.onPacket(oldest);
    this.drainContiguous();
  }

  clear() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.queue = [];
    this.lastSeq = null;
  }
}

module.exports = {
  createSession, parse, isRtcp, dtmfPackets, rawPacket,
  generateDtmfPcm, DTMF_FREQUENCIES,
  createSilentNatPackets, ReorderBuffer,
  HEADER_LEN, SAMPLES_PER_PACKET, PT_DTMF, DTMF_CODES,
};
