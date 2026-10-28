// Microphone boost, for a trunk that was receiving the operator ~10 dB too quiet.
//
// Measured on a real call (docs/AUDIO-REVIEW-2026-10-28.md): active speech at -27.5 dBFS RMS with a
// -8.8 dBFS peak, against the far end's -17.7 dBFS — the caller hears a distant voice. The
// CrystalSound driver hands CoreAudio a low-amplitude signal and nothing downstream added gain.
//
// +6 dB (2x) puts active speech near -21 dBFS, which is standard telephone level, and leaves the
// peak around -2.8 dBFS. The soft limiter exists for the calls that are louder than this one was:
// above the knee it compresses toward a ceiling with tanh, so a shout can never wrap or rail. It is
// stateless on purpose — no attack/release to pump, no lookahead to add latency.
'use strict';

const GAIN = 2.0;        // +6 dB
const KNEE = 0.72;       // soft limiting starts here (fraction of full scale)
const CEIL = 0.98;       // and can never exceed this

/** Soft-knee limiter on a normalised sample. Identity below the knee. */
function shape(x) {
  const magnitude = x < 0 ? -x : x;
  if (magnitude <= KNEE) return x;
  const over = (magnitude - KNEE) / (1 - KNEE);
  const limited = KNEE + (CEIL - KNEE) * Math.tanh(over);
  return x < 0 ? -limited : limited;
}

/**
 * Apply gain + soft limiting to one Int16 frame.
 *
 * @param {Int16Array|number[]} pcm
 * @param {{gain?: number}} [opts]
 * @returns {Int16Array} a new frame; the input is left untouched
 */
function boostPcm(pcm, { gain = GAIN } = {}) {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const scaled = shape((pcm[i] / 32768) * gain) * 32768;
    // Round, then clamp for the -32768 edge: Math.round(-0.98 * 32768) is inside range already,
    // this is only a guard against a future gain change.
    const v = Math.round(scaled);
    out[i] = v > 32767 ? 32767 : (v < -32768 ? -32768 : v);
  }
  return out;
}

module.exports = { boostPcm, shape, GAIN, KNEE, CEIL };
