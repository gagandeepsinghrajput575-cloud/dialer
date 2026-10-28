// The +6 dB microphone boost, and the limiter that keeps a louder call from clipping.
//
// Evidence (docs/AUDIO-REVIEW-2026-10-28.md): active speech left the daemon at -27.5 dBFS RMS with a
// -8.8 dBFS peak, while the far end sat at -17.7 dBFS. The operator sounded distant; nothing in the
// path applied gain. These checks pin the two properties that matter: quiet speech gets 6 dB louder,
// and loud speech does not rail.
const assert = require('assert');

const { boostPcm, shape, GAIN, KNEE, CEIL } = require('../../desktop/daemon/lib/mic-gain');

let passed = 0;
let failed = 0;
const ok = (m) => { passed++; console.log(`  \u2713 ${m}`); };
const bad = (m) => { failed++; console.log(`  \u2717 ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

const frame = (amplitude, hz = 300) => {
  const pcm = new Int16Array(160);
  for (let i = 0; i < 160; i++) pcm[i] = Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / 8000));
  return pcm;
};
const peakOf = (pcm) => pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

console.log('\n=== VAL-MEDIA-017: microphone boost + soft limiter ===\n');

// 1. The headline: a quiet frame becomes 6 dB louder, sample for sample.
{
  check(GAIN === 2.0, 'the boost is +6 dB (2x)');
  const quiet = frame(8000);
  const boosted = boostPcm(quiet);
  let worst = 0;
  for (let i = 0; i < quiet.length; i++) {
    const expected = quiet[i] * 2;
    if (Math.abs(boosted[i] - expected) > 1) worst = Math.max(worst, Math.abs(boosted[i] - expected));
  }
  console.log(`  quiet frame: peak ${peakOf(quiet)} -> ${peakOf(boosted)}`);
  check(worst <= 1, 'below the knee the output is exactly 2x the input (within rounding)');
  check(peakOf(boosted) === 16000, 'peak doubles: 8000 -> 16000 (-6.2 dBFS)');
}

// 2. Silence stays exactly silent (CrystalSound gates between phrases; a boost must not invent noise).
{
  const silence = boostPcm(new Int16Array(160));
  check(silence.every((v) => v === 0), 'digital silence stays digital silence');
}

// 3. A shout cannot rail: full-scale input is limited, monotonic, and never hits 32767.
{
  const hot = frame(32767);
  const boosted = boostPcm(hot);
  const peak = peakOf(boosted);
  console.log(`  hot frame  : peak 32767 -> ${peak} (ceiling ${Math.round(CEIL * 32768)})`);
  check(peak <= Math.round(CEIL * 32768), 'a full-scale frame stays under the ceiling');
  check(peak > Math.round(KNEE * 32768), 'and is still loud — the limiter compresses, it does not mute');
  check(!boosted.includes(32767) && !boosted.includes(-32768), 'no sample sits on the rail (no wraparound)');

  let monotonic = true;
  for (let i = 1; i < hot.length; i++) {
    if (hot[i] > hot[i - 1] && boosted[i] < boosted[i - 1]) monotonic = false;
  }
  check(monotonic, 'louder input never produces quieter output (no fold-over)');
}

// 4. The knee is a knee: identity below it, compression above it, and continuous across it.
{
  const below = shape(KNEE - 0.01);
  check(Math.abs(below - (KNEE - 0.01)) < 1e-9, 'below the knee the limiter is the identity');
  const justAbove = shape(KNEE + 0.01);
  const justBelow = shape(KNEE - 0.01);
  check(justAbove > justBelow && justAbove - justBelow < 0.02, 'crossing the knee is continuous');
  check(shape(1.0) <= CEIL + 1e-9 && shape(1.0) > KNEE, 'a full-scale sample lands between knee and ceiling');
  check(Math.abs(shape(-0.9)) === Math.abs(shape(0.9)), 'the limiter is symmetric for negative samples');
}

// 5. Shape of the output is preserved for the input we do not touch.
{
  const odd = frame(12000, 220);
  const boosted = boostPcm(odd);
  check(boosted.length === odd.length && boosted instanceof Int16Array, 'frame length and type are preserved');
  check(boosted[0] === 0 && odd[0] === 0, 'a silent first sample stays silent');
}

assert.strictEqual(failed, 0, `${failed} mic-gain check(s) failed`);
console.log(`\n${failed ? '\u{1F4A5}' : '\u{1F389}'} ${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
