// The microphone boost, and the limiter that keeps a louder call from clipping.
//
// Evidence (docs/AUDIO-REVIEW-2026-10-28.md): active speech first left the daemon at -27.5 dBFS RMS,
// while the far end sat at -17.7; +8 dB then left a *relaxed* voice at -21.2 against the far end's
// -15.4. The operator sounded distant; nothing in the path applied gain. These checks pin the two
// properties that matter: quiet speech gets exactly 3.5x, and loud speech does not rail — including
// at 3.5x, where an ordinary voice now reaches the knee.
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

// 1. The headline: a quiet frame becomes 11 dB louder, sample for sample.
{
  check(GAIN === 3.5, 'the boost is +11 dB (3.5x)');
  // 6000 x 3.5 = 21000, still below the knee (0.72 x 32768 = 23593), so this is a pure gain check.
  const quiet = frame(6000);
  const boosted = boostPcm(quiet);
  let worst = 0;
  for (let i = 0; i < quiet.length; i++) {
    const expected = quiet[i] * 3.5;
    if (Math.abs(boosted[i] - expected) > 1) worst = Math.max(worst, Math.abs(boosted[i] - expected));
  }
  console.log(`  quiet frame: peak ${peakOf(quiet)} -> ${peakOf(boosted)}`);
  check(worst <= 1, 'below the knee the output is exactly 3.5x the input (within rounding)');
  check(peakOf(boosted) === 21000, 'peak scales: 6000 -> 21000 (-3.9 dBFS)');

  // 8000 x 3.5 = 28000 is now past the knee: the gain the operator asked for is only reachable
  // because the limiter absorbs the top. Pin it, so a future gain change cannot silently start
  // squashing ordinary speech without a test noticing.
  const ordinary = boostPcm(frame(8000));
  console.log(`  ordinary syllable: peak 8000 -> ${peakOf(ordinary)} (unlimited would be 28000)`);
  check(peakOf(ordinary) === 27397, 'at 3.5x an 8000 input enters the limiter and lands at 27397');
  check(peakOf(ordinary) < Math.round(CEIL * 32768), 'and still sits under the ceiling');
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

// 6. The measurement this gain was chosen against (docs/AUDIO-REVIEW-2026-10-28.md): a -8.8 dBFS peak.
//    At 3.5x that is 1.27 full scale — past the knee — so it must come out loud, compressed, unclipped.
{
  const measuredPeak = Math.round(0.363 * 32768);        // -8.8 dBFS
  const boosted = boostPcm(frame(measuredPeak));
  const peak = peakOf(boosted);
  const dbfs = 20 * Math.log10(peak / 32768);
  console.log(`  observed call peak: ${measuredPeak} -> ${peak} (${dbfs.toFixed(1)} dBFS)`);
  check(dbfs > -2 && dbfs < 0, 'the loudest syllable of that call lands just under 0 dBFS, compressed');
  check(!boosted.includes(32767) && !boosted.includes(-32768), 'and does not rail');
}

assert.strictEqual(failed, 0, `${failed} mic-gain check(s) failed`);
console.log(`\n${failed ? '\u{1F4A5}' : '\u{1F389}'} ${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
