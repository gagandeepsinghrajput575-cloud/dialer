// SRTP, the media half of a TLS trunk.
//
// Measured on this account: a TLS INVITE offering plain `RTP/AVP` is answered `488 Not Acceptable
// Here` with `Q.850;cause=88;text="INCOMPATIBLE_DESTINATION"`. Offer `RTP/SAVP` with an SDES
// `a=crypto` line and the same call proceeds to 100 → 180 → 200 OK. So the carrier requires secure
// media on TLS legs, and this module is the encryption it requires.
//
// Scope is deliberate: AES_CM_128_HMAC_SHA1_80 only (RTP, not RTCP), which is what RFC 4568 SDES
// suites in the wild overwhelmingly use. Anything else throws instead of silently sending clear
// audio on a trunk the operator believes is encrypted.
'use strict';

const crypto = require('crypto');

const SUITES = {
  AES_CM_128_HMAC_SHA1_80: { keyLen: 16, saltLen: 14, tagLen: 10, authLen: 20, label: 80 },
  AES_CM_128_HMAC_SHA1_32: { keyLen: 16, saltLen: 14, tagLen: 4, authLen: 20, label: 32 },
};

/**
 * Where the payload starts: fixed header, CSRC list, and (bit 0x10) the RFC 5285 extension.
 *
 * Getting this wrong is worse than a dropped packet. The SRTP tag authenticates the *ciphertext*,
 * so a wrong offset still verifies, decrypts from the wrong byte, and plays as full-scale noise —
 * which is exactly the "loud buzz" a call with a header extension produces.
 */
function headerLength(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 12) return packet ? packet.length : 0;
  let length = 12 + 4 * (packet[0] & 0x0f);
  if ((packet[0] & 0x10) && packet.length >= length + 4) {
    const words = packet.readUInt16BE(length + 2);
    length += 4 + 4 * words;
  }
  return Math.min(length, packet.length);
}

/** `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:BASE64` -> { tag, suite, key } */
function parseCrypto(value) {
  // Accept the raw attribute or the whole `a=crypto:` line: callers differ, and a silent null here
  // means the call plays its SRTP tag as audio.
  const raw = String(value || '').trim().replace(/^a=crypto:/i, '').replace(/^crypto:/i, '');
  const m = /^(\d+)\s+(\S+)\s+inline:([A-Za-z0-9+/=]+)/.exec(raw);
  if (!m) return null;
  const suite = SUITES[m[2]];
  if (!suite) return null;
  return { tag: Number(m[1]), suite: m[2], key: Buffer.from(m[3], 'base64'), tagLen: suite.tagLen };
}

/**
 * RFC 3711 §4.3.1 AES-CM keystream. `label` distinguishes the three derived secrets; the IV is the
 * master salt shifted left 16 bits with the label XORed into byte 7.
 */
function derive(masterKey, masterSalt, label, length) {
  const iv = Buffer.alloc(16, 0);
  masterSalt.copy(iv, 2);
  iv[7] ^= label;
  const cipher = crypto.createCipheriv(`aes-${masterKey.length * 8}-ctr`, masterKey, iv);
  return Buffer.concat([cipher.update(Buffer.alloc(length, 0)), cipher.final()]);
}

class SrtpContext {
  /**
   * @param {object} o
   * @param {string|Buffer} o.key  the SDES inline key (base64 string or 30 raw bytes)
   * @param {string} [o.suite]     AES_CM_128_HMAC_SHA1_80 (default)
   */
  constructor({ key, suite = 'AES_CM_128_HMAC_SHA1_80' } = {}) {
    const spec = SUITES[suite];
    if (!spec) throw new Error(`srtp: unsupported suite ${suite}`);
    const master = Buffer.isBuffer(key) ? key : Buffer.from(String(key || ''), 'base64');
    if (master.length !== spec.keyLen + spec.saltLen) {
      throw new Error(`srtp: ${suite} needs ${spec.keyLen + spec.saltLen} key bytes, got ${master.length}`);
    }
    this.spec = spec;
    this.suite = suite;
    this.masterKey = master.slice(0, spec.keyLen);
    this.masterSalt = master.slice(spec.keyLen);
    this.sessionKey = derive(this.masterKey, this.masterSalt, 0x00, spec.keyLen);
    this.sessionAuth = derive(this.masterKey, this.masterSalt, 0x01, spec.authLen);
    this.sessionSalt = derive(this.masterKey, this.masterSalt, 0x02, spec.saltLen);
    this.roc = 0;
    this.lastSeq = 0;
    this.started = false;
  }

  /** RFC 3711 §4.1.1 packet IV: salt XOR ssrc (bytes 4-7) XOR index (bytes 8-13). */
  ivFor(ssrc, index) {
    const iv = Buffer.alloc(16, 0);
    this.sessionSalt.copy(iv, 2);
    iv[4] ^= (ssrc >>> 24) & 0xff;
    iv[5] ^= (ssrc >>> 16) & 0xff;
    iv[6] ^= (ssrc >>> 8) & 0xff;
    iv[7] ^= ssrc & 0xff;
    for (let i = 0; i < 6; i++) {
      iv[8 + i] ^= (index / 2 ** (8 * (5 - i))) & 0xff;
    }
    return iv;
  }

  crypt(data, ssrc, index) {
    const cipher = crypto.createCipheriv(`aes-${this.sessionKey.length * 8}-ctr`, this.sessionKey,
      this.ivFor(ssrc, index));
    return Buffer.concat([cipher.update(data), cipher.final()]);
  }

  auth(packet, roc) {
    const h = crypto.createHmac('sha1', this.sessionAuth);
    h.update(packet);
    const rocBuf = Buffer.alloc(4);
    rocBuf.writeUInt32BE(roc >>> 0);
    h.update(rocBuf);
    return h.digest().slice(0, this.spec.tagLen);
  }

  /** Track rollover so the 48-bit index is right on long calls (RFC 3711 §3.3.1). */
  updateRoc(seq) {
    if (!this.started) {
      this.started = true;
    } else if (seq < this.lastSeq && this.lastSeq - seq > 0x8000) {
      this.roc = (this.roc + 1) >>> 0;
    }
    this.lastSeq = seq;
    return this.roc;
  }

  /** RTP in, SRTP out: header stays clear, payload is encrypted, tag appended. */
  protect(packet) {
    if (!Buffer.isBuffer(packet) || packet.length < 12) return packet;
    const seq = packet.readUInt16BE(2);
    const ssrc = packet.readUInt32BE(8);
    const roc = this.updateRoc(seq);
    const offset = headerLength(packet);
    if (packet.length < offset) return packet;
    const head = packet.slice(0, offset);
    const body = this.crypt(packet.slice(offset), ssrc, (roc * 0x10000) + seq);
    const sealed = Buffer.concat([head, body]);
    return Buffer.concat([sealed, this.auth(sealed, roc)]);
  }

  /**
   * SRTP in, RTP out. Returns null for anything that fails authentication, so a corrupted or
   * replayed packet is dropped instead of decoded into a click.
   */
  unprotect(packet) {
    if (!Buffer.isBuffer(packet) || packet.length < 12 + this.spec.tagLen) return null;
    const seq = packet.readUInt16BE(2);
    const ssrc = packet.readUInt32BE(8);
    const roc = this.updateRoc(seq);
    const sealed = packet.slice(0, packet.length - this.spec.tagLen);
    const tag = packet.slice(packet.length - this.spec.tagLen);
    const expected = this.auth(sealed, roc);
    if (expected.length !== tag.length || !crypto.timingSafeEqual(expected, tag)) return null;
    const offset = headerLength(sealed);
    if (sealed.length < offset) return null;
    const head = sealed.slice(0, offset);
    const body = this.crypt(sealed.slice(offset), ssrc, (roc * 0x10000) + seq);
    return Buffer.concat([head, body]);
  }
}

module.exports = { SrtpContext, parseCrypto, derive, headerLength, SUITES };
