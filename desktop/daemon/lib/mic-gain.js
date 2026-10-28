// Microphone boost, for a trunk that was receiving the operator ~10 dB too quiet.
//
// Measured on a real call (docs/AUDIO-REVIEW-2026-10-28.md): active speech at -27.5 dBFS RMS with a
// -8.8 dBFS peak, against the far end's -17.7 dBFS — the caller hears a distant voice. The
// CrystalSound driver hands CoreAudio a low-amplitude signal and nothing downstream added gain.
//
// +11 dB (3.5x) is the third step, and the first that assumes the operator speaks at zero effort:
// +6 dB still required projection, +8 dB left a relaxed sentence at -21.2 dBFS against the far end's
// -15.4 (docs/AUDIO-REVIEW-2026-10-28.md, second pass). At 3.5x that sentence lands near -18.4 dBFS
// and its loudest syllable near -0.8 dBFS — the first point where the limiter does real work on an
// ordinary voice. The soft knee is what makes that safe rather than a trade: the curve is an
// asymptote at 0.98, so no input can rail, and the -8.8 dBFS peak measured on the louder pass
// becomes 1.27 full scale and comes out at -0.26 dBFS compressed instead of clipping. The limiter is
// stateless on purpose: no attack/release to pump, no lookahead to add latency.
//
// It does not change the timbre: gain is a flat multiplier, so the presence deficit measured above
// 1.6 kHz (see docs/AUDIO-REVIEW-2026-10-28.md) is untouched. This closes the level gap, not the tone.
'use strict';

const GAIN = 3.5;        // +11 dB
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
