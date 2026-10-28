// Microphone boost, for a trunk that was receiving the operator ~10 dB too quiet.
//
// Measured on a real call (docs/AUDIO-REVIEW-2026-10-28.md): active speech at -27.5 dBFS RMS with a
// -8.8 dBFS peak, against the far end's -17.7 dBFS — the caller hears a distant voice. The
// CrystalSound driver hands CoreAudio a low-amplitude signal and nothing downstream added gain.
//
// +9.5 dB (3.0x) is the current setting, and it is a retreat from 3.5x on measured evidence rather
// than a preference. At 3.5x a live call (wire-502.wav) drove stressed syllables ~6 dB past the knee,
// and this sample-wise tanh turns their peaks into near-square edges: 13 sample-to-sample jumps over
// 20000 units around 18.18 s, audible as a spark/crackle on emphasis. At 3.0x the same syllables
// overdrive the knee by ~1 dB instead, the level stays at -16.3 dBFS active against the far end's
// -15.4, and the spark count halves — it does NOT disappear, and no gain setting removes it, because
// the operator's loudest syllables already arrive near -7 dBFS and any useful gain saturates the
// curve. The real fix is an envelope-following limiter (attack/release) instead of a per-sample clip;
// this constant simply keeps the artefact below the point where it is noticed.
'use strict';

const GAIN = 3.0;        // +9.5 dB
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
