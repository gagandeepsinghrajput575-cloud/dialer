// The microphone chain: gain → low cut → presence lift → lookahead limiter.
//
// Every stage exists for a measured reason (docs/AUDIO-REVIEW-2026-10-28.md):
//
//   1. **Gain.** The trunk received the operator ~10 dB too quiet; at +8 dB a deliberately relaxed
//      voice still measured -21.2 dBFS against the far end's -15.4, so the operator was pushing to be
//      heard. GAIN is 3.0x (+9.5 dB), which is as far as the limiter can be driven without artefacts.
//
//   2. **Low cut + presence lift.** "CrystalSound Microphone" reports `Transport: Virtual`, i.e. a
//      driver voices the signal, and its voicing is dark. Measured against the far end *in the same
//      recording* (so codec and recorder cancel out): +5.3 dB at 120-200 Hz, then -11.5 / -8.7 /
//      -18.9 / -20.7 dB at 1.6-2.2 k / 2.2-2.8 k / 2.8-3.2 k / 3.2-3.6 k. Too much body, too little
//      definition — heard as "muffled / blurry". The driver cannot be replaced (its noise cancellation
//      is wanted), so the compensation happens here: a 180 Hz high-pass and a broad +8 dB lift at
//      2.65 kHz. This cannot invent what the driver removed; it rebalances what it left.
//
//   3. **Lookahead limiter.** A per-sample tanh used to protect the ceiling, and at 3.0x it was driven
//      past its knee on every stressed syllable. A curve applied sample-by-sample *is* the artefact:
//      flattening the top of a waveform turns it into a near-square edge, which measures as
//      sample-to-sample jumps over 20000 units (77 of them across wire-516.wav) and sounds like a
//      spark or tick at the start of words. No curve shape fixes that, because the problem is the
//      sudden gain change. This limiter derives the gain from an envelope with 5 ms of lookahead and
//      ramps it down *before* the transient arrives, so the waveform keeps its shape and only its
//      envelope is compressed.
'use strict';

const GAIN = 3.0;            // +9.5 dB
const KNEE = 0.72;           // the ceiling curve starts bending here (fraction of full scale)
const CEIL = 0.98;           // asymptote of the curve, and the hard clamp behind it
const TARGET_CEIL = 0.95;    // where the limiter aims: margin wide enough that the clamp behind it never fires

const SAMPLE_RATE = 8000;
const LOW_CUT_HZ = 180;      // below this is the mud the caller hears as "basement"
const PRESENCE_HZ = 2000;    // high shelf: lifts everything above, which is what a driver rolling off by 3.4 kHz needs
const PRESENCE_DB = 9;
const PRESENCE_Q = 0.707;    // shelf slope 1 (unused for the shelf, kept for the option of a peak)
const RELEASE_MS = 120;
const LOOKAHEAD_MS = 5;
const ATTACK_MS = 1;         // a fifth of the lookahead: fast enough to be in place, slow enough not to click

/** Soft-knee curve with an explicit ceiling: identity below the knee, an asymptote at `ceiling`. */
function shapeAt(x, ceiling = CEIL, knee = KNEE) {
  const magnitude = x < 0 ? -x : x;
  if (magnitude <= knee) return x;
  const over = (magnitude - knee) / (1 - knee);
  const limited = knee + (ceiling - knee) * Math.tanh(over);
  return x < 0 ? -limited : limited;
}

/** The curve at the module ceiling. */
const shape = (x) => shapeAt(x);

/** One-pole coefficient for a time constant in milliseconds. */
const pole = (ms, fs) => 1 - Math.exp(-1 / ((ms * fs) / 1000));

/**
 * RBJ biquad, transposed direct form II.
 *
 * The state (`z1`, `z2`) deliberately lives across frames: resetting it every 20 ms would put a step
 * at every frame boundary, which is a tick fifty times a second.
 */
class Biquad {
  constructor(type, fs, f0, q, gainDb = 0) {
    const w0 = (2 * Math.PI * f0) / fs;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    let b0;
    let b1;
    let b2;
    let a0;
    let a1;
    let a2;
    if (type === 'highpass') {
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
    } else if (type === 'peaking') {
      const A = Math.pow(10, gainDb / 40);
      b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
    } else if (type === 'highshelf') {
      // RBJ high shelf, slope S = 1. Unlike a peaking filter this keeps lifting everything above f0,
      // which is what a driver that rolls off towards 3.4 kHz actually needs.
      const A = Math.pow(10, gainDb / 40);
      const shelf = Math.sin(w0) * Math.SQRT1_2;
      b0 = A * ((A + 1) + (A - 1) * cos + 2 * Math.sqrt(A) * shelf);
      b1 = -2 * A * ((A - 1) + (A + 1) * cos);
      b2 = A * ((A + 1) + (A - 1) * cos - 2 * Math.sqrt(A) * shelf);
      a0 = (A + 1) - (A - 1) * cos + 2 * Math.sqrt(A) * shelf;
      a1 = 2 * ((A - 1) - (A + 1) * cos);
      a2 = (A + 1) - (A - 1) * cos - 2 * Math.sqrt(A) * shelf;
    } else {
      throw new Error(`Unknown filter type "${type}"`);
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
    this.z1 = 0;
    this.z2 = 0;
  }

  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  reset() { this.z1 = 0; this.z2 = 0; }
}


/**
 * Envelope-following limiter with lookahead.
 *
 * The gain comes from the *lowest* gain needed anywhere in the lookahead window, and is ramped
 * linearly to it over exactly that window — so by the time a transient emerges from the delay line the
 * gain is already where it needs to be. Nothing steps, so nothing ticks.
 */
class Limiter {
  constructor({ fs = SAMPLE_RATE, ceiling = TARGET_CEIL, clampTo = CEIL, knee = KNEE, releaseMs = RELEASE_MS, lookaheadMs = LOOKAHEAD_MS } = {}) {
    this.ceiling = ceiling;
    this.clampTo = clampTo;
    this.knee = knee;
    this.window = Math.max(1, Math.round((lookaheadMs * fs) / 1000));
    this.release = pole(releaseMs, fs);
    this.attack = pole(ATTACK_MS, fs);
    this.delay = new Float64Array(this.window);
    this.pos = 0;
    this.gain = 1;
    this.min = [];          // sliding-window minimum of the per-sample target gains
    this.index = 0;
    this.clamped = 0;       // safety-net hits; a healthy chain keeps this at zero
  }

  reset() {
    this.delay.fill(0);
    this.pos = 0;
    this.gain = 1;
    this.min.length = 0;
    this.index = 0;
    this.clamped = 0;
  }

  /** The gain a single sample would need on its own. */
  target(magnitude) {
    return magnitude > this.knee ? shapeAt(magnitude, this.ceiling, this.knee) / magnitude : 1;
  }

  run(x) {
    const i = this.index++;
    const wanted = this.target(Math.abs(x));

    // Sliding minimum: the lowest gain anything in the window is going to need. The window spans the
    // sample being output (index i - window, which is what `delay` is about to yield) through the
    // newest sample, so the gain applied now is safe for the audio leaving the delay line. Expiring at
    // `<` rather than `<=` matters: dropping i - window lets the output sample's own peak escape the
    // minimum, which is exactly how an overshoot (and a hard clamp) gets through.
    while (this.min.length && this.min[this.min.length - 1].v >= wanted) this.min.pop();
    this.min.push({ i, v: wanted });
    while (this.min.length && this.min[0].i < i - this.window) this.min.shift();
    const needed = this.min[0].v;

    // Attack and release are first-order smoothers, not steps: a step in gain is the tick this whole
    // class exists to avoid. The attack time constant is deliberately a fifth of the lookahead, so the
    // gain is ~99% of the way to its target by the time the transient leaves the delay line.
    if (needed < this.gain) this.gain += (needed - this.gain) * this.attack;
    else this.gain += (1 - this.gain) * this.release;

    const delayed = this.delay[this.pos];
    this.delay[this.pos] = x;
    this.pos = (this.pos + 1) % this.window;

    let y = delayed * this.gain;
    if (y > this.clampTo) { y = this.clampTo; this.clamped += 1; }
    else if (y < -this.clampTo) { y = -this.clampTo; this.clamped += 1; }
    return y;
  }
}

/**
 * Build the live microphone chain. One instance per user agent: filter and limiter state must survive
 * across 20 ms frames, and must be reset between calls.
 */
function createMicChain(opts = {}) {
  const fs = opts.sampleRate || SAMPLE_RATE;
  const gain = opts.gain != null ? opts.gain : GAIN;
  const lowCut = new Biquad('highpass', fs, opts.lowCutHz || LOW_CUT_HZ, 0.707);
  const presence = new Biquad(
    'highshelf', fs, opts.presenceHz || PRESENCE_HZ, opts.presenceQ || PRESENCE_Q,
    opts.presenceDb != null ? opts.presenceDb : PRESENCE_DB,
  );
  const limiter = new Limiter({ fs, ceiling: opts.ceiling != null ? opts.ceiling : TARGET_CEIL });

  return {
    gain,
    limiter,
    /** One frame of Int16 in, one frame of Int16 out. State carries between calls. */
    process(pcm) {
      const out = new Int16Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) {
        let v = (pcm[i] / 32768) * gain;
        v = lowCut.run(v);
        v = presence.run(v);
        v = limiter.run(v);
        const s = Math.round(v * 32768);
        out[i] = s > 32767 ? 32767 : (s < -32768 ? -32768 : s);
      }
      return out;
    },
    reset() {
      lowCut.reset();
      presence.reset();
      limiter.reset();
    },
    describe() {
      return {
        gain,
        lowCutHz: opts.lowCutHz || LOW_CUT_HZ,
        presenceHz: opts.presenceHz || PRESENCE_HZ,
        presenceDb: opts.presenceDb != null ? opts.presenceDb : PRESENCE_DB,
        lookaheadMs: LOOKAHEAD_MS,
        ceiling: limiter.ceiling,
        clamped: limiter.clamped,
      };
    },
  };
}

module.exports = {
  createMicChain, shape, Limiter, Biquad,
  GAIN, KNEE, CEIL, LOW_CUT_HZ, PRESENCE_HZ, PRESENCE_DB,
};

