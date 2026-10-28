// What we actually put on the wire.
//
// A call to an IVR or a voicemail can never tell the operator how they sounded, and the existing
// call recording mixes local mic with remote audio, so the far end contaminates it. This tap keeps
// only the G.711 payloads we transmit, decoded back to PCM, so the resulting WAV is exactly what
// the carrier received — the file you would have heard if you were the other party.
//
// Frames are buffered in memory and written once when the call ends: the pump runs every 20 ms and
// must never block on disk.
'use strict';

const fs = require('fs');
const path = require('path');
const g711 = require('./g711');

const RATE = 8000;
const MAX_SAMPLES = RATE * 60 * 30;      // 30 minutes: a hard cap so a stuck call cannot fill the disk

class WireTap {
  constructor({ dir, callId }) {
    this.dir = dir;
    this.callId = callId;
    this.chunks = [];                    // { payload, pt } so each is decoded the way it was encoded
    this.samples = 0;
    this.closed = false;
  }

  /**
   * @param {Buffer} payload G.711 bytes, one byte per 8 kHz sample.
   * @param {number} pt payload type it was encoded with (0 = PCMU, 8 = PCMA).
   */
  write(payload, pt = 0) {
    if (this.closed || !Buffer.isBuffer(payload) || !payload.length) return;
    if (this.samples >= MAX_SAMPLES) return;
    this.chunks.push({ payload: Buffer.from(payload), pt });
    this.samples += payload.length;
  }

  /** @returns {{path:string, bytes:number, seconds:number}|null} */
  finish() {
    if (this.closed) return null;
    this.closed = true;
    if (!this.samples) return null;
    // Decode with the codec's own table. A second µ-law implementation here would be a second
    // source of truth for "what the far end heard" — and the two would drift apart silently.
    const pcm = Buffer.allocUnsafe(this.samples * 2);
    let offset = 0;
    for (const chunk of this.chunks) {
      const samples = g711.decode(chunk.payload, chunk.pt);
      for (let i = 0; i < samples.length; i++) {
        pcm.writeInt16LE(samples[i], offset);
        offset += 2;
      }
    }
    const wav = Buffer.allocUnsafe(44 + pcm.length);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(36 + pcm.length, 4);
    wav.write('WAVE', 8);
    wav.write('fmt ', 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);            // PCM
    wav.writeUInt16LE(1, 22);            // mono
    wav.writeUInt32LE(RATE, 24);
    wav.writeUInt32LE(RATE * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(pcm.length, 40);
    pcm.copy(wav, 44);

    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, `wire-${this.callId}.wav`);
      fs.writeFileSync(file, wav);
      return { path: file, bytes: wav.length, seconds: this.samples / RATE };
    } catch {
      return null;
    }
  }
}

module.exports = { WireTap, MAX_SAMPLES, RATE };

