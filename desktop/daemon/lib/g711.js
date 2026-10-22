// G.711 — the only codec a PSTN trunk is guaranteed to speak.
//
// 8 kHz, 8 bits, 20 ms packets => 160 samples in, 160 bytes out. Both companding laws are
// here because a carrier picks one and the answer must match its offer: PCMU (µ-law, North
// America / most SIP trunks) and PCMA (A-law, Europe). The tables are the ITU-T G.711
// reference algorithm, not an approximation, so a call to FlyNumber sounds like a call.
'use strict';

const BIAS = 0x84;
const CLIP = 32635;
const SEG_END = [0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff];

function segmentOf(pcm) {
  for (let i = 0; i < 8; i++) if (pcm <= SEG_END[i]) return i;
  return 8;
}

// ---- µ-law -----------------------------------------------------------------------------
function ulawEncodeSample(pcm16) {
  let pcm = pcm16 < -32768 ? -32768 : pcm16 > 32767 ? 32767 : pcm16;
  let mask = 0x7f;
  if (pcm < 0) { pcm = -pcm; mask = 0xff; }
  if (pcm > CLIP) pcm = CLIP;
  pcm += BIAS;
  const seg = segmentOf(pcm);
  if (seg >= 8) return 0x7f ^ mask;
  const uval = (seg << 4) | ((pcm >> (seg + 3)) & 0x0f);
  return (uval ^ mask) & 0xff;
}

function ulawDecodeSample(u8) {
  const u = ~u8 & 0xff;
  const seg = (u & 0x70) >> 4;
  // Rebuild the biased magnitude, undo the bias, then restore the sign from bit 7.
  const value = ((((u & 0x0f) << 3) + BIAS) << seg) - BIAS;
  return (u & 0x80) ? value : -value;
}

// ---- A-law -----------------------------------------------------------------------------
function alawEncodeSample(pcm16) {
  let pcm = pcm16 < -32768 ? -32768 : pcm16 > 32767 ? 32767 : pcm16;
  let mask = 0xd5;
  if (pcm < 0) { pcm = -pcm - 1; mask = 0x55; }
  const seg = segmentOf(pcm);
  if (seg >= 8) return 0x7f ^ mask;
  const aval = seg < 1 ? (pcm >> 4) & 0x0f : ((pcm >> (seg + 3)) & 0x0f) | (seg << 4);
  return (aval ^ mask) & 0xff;
}

function alawDecodeSample(a8) {
  const a = a8 ^ 0x55;
  const seg = (a & 0x70) >> 4;
  const value = seg < 1 ? ((a & 0x0f) << 4) + 8 : (((a & 0x0f) << 4) + 0x108) << (seg - 1);
  return (a & 0x80) ? value : -value;
}

// ---- frame helpers ---------------------------------------------------------------------
// Int16 (mono, 8 kHz) -> G.711 bytes. Accepts an Int16Array or a plain number array.
function encode(pcm, pt) {
  const out = Buffer.allocUnsafe(pcm.length);
  const alaw = pt === 8;
  for (let i = 0; i < pcm.length; i++) {
    out[i] = alaw ? alawEncodeSample(pcm[i] | 0) : ulawEncodeSample(pcm[i] | 0);
  }
  return out;
}

// G.711 bytes -> Int16Array.
function decode(payload, pt) {
  const out = new Int16Array(payload.length);
  const alaw = pt === 8;
  for (let i = 0; i < payload.length; i++) {
    out[i] = alaw ? alawDecodeSample(payload[i]) : ulawDecodeSample(payload[i]);
  }
  return out;
}

// Float32 in [-1,1] (what an audio device hands us) -> Int16.
function toInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let v = float32[i];
    v = v < -1 ? -1 : v > 1 ? 1 : v;
    out[i] = Math.round(v * 32767);
  }
  return out;
}

// Int16 -> Float32 in [-1,1] (what an audio device plays).
function toFloat32(int16) {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 32768;
  return out;
}

// 0..1 peak of a frame, so the UI waveform can show the operator's real voice level.
function level(int16) {
  let peak = 0;
  for (let i = 0; i < int16.length; i++) {
    const v = int16[i] < 0 ? -int16[i] : int16[i];
    if (v > peak) peak = v;
  }
  return peak / 32768;
}

// A round trip must be within a quantization step of the input, or the tables are wrong.
const SAMPLES = [0, 1, -1, 127, -128, 1000, -1000, 8000, -8000, 32635, -32635, 32767, -32768];

module.exports = {
  encode, decode, toInt16, toFloat32, level,
  ulawEncodeSample, ulawDecodeSample, alawEncodeSample, alawDecodeSample, SAMPLES,
};
