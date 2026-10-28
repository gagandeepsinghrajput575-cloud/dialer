// The microphone chain: gain, low cut, presence shelf, lookahead limiter.
//
// Two complaints drive these checks, both measured on real calls (docs/AUDIO-REVIEW-2026-10-28.md):
//   * a spark/tick at the start of words, from a per-sample tanh flattening every stressed syllable;
//   * "muffled / blurry", because this driver's voicing is 10-20 dB down above 1.6 kHz versus the far
//     end in the same recording.
// A check that only asserts "the output is quieter than full scale" would pass on the old code, so the
// ones that matter are the *shape* of the gain envelope and the EQ response.
const assert = require('assert');

const M = require('../../desktop/daemon/lib/mic-gain');

let passed = 0;
let failed = 0;
const ok = (m) => { passed++; console.log(`  \u2713 ${m}`); };
const bad = (m) => { failed++; console.log(`  \u2717 ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

const FS = 8000;
const sine = (hz, amp, n, from = 0) => {
  const pcm = new Int16Array(n);
  for (let i = from; i < n; i++) pcm[i] = Math.round(amp * Math.sin((2 * Math.PI * hz * (i - from)) / FS));
  return pcm;
};
const rms = (pcm, from = 0) => {
  let sum = 0;
  for (let i = from; i < pcm.length; i++) { const v = pcm[i] / 32768; sum += v * v; }
  return Math.sqrt(sum / Math.max(1, pcm.length - from));
};
const dbfs = (x) => 20 * Math.log10(x);
const peakOf = (pcm) => pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const maxJump = (pcm) => {
  let worst = 0;
  for (let i = 1; i < pcm.length; i++) worst = Math.max(worst, Math.abs(pcm[i] - pcm[i - 1]));
  return worst;
};
/** Steady-state gain of the chain at one frequency, with the fixed boost removed. */
const eqGainDb = (hz, opts) => {
  const chain = M.createMicChain(opts);
  const input = sine(hz, 800, FS);
  const output = chain.process(input);
  return dbfs(rms(output, FS / 2) / rms(input, FS / 2)) - dbfs(M.GAIN);
};

console.log('\n=== VAL-MEDIA-017: microphone chain (gain, EQ, lookahead limiter) ===\n');

// 1. The fixed boost is what it says it is, in the region where nothing else is happening.
{
  check(M.GAIN === 3.0, 'the boost is +9.5 dB (3.0x)');
  const total = eqGainDb(1000) + dbfs(M.GAIN);
  console.log(`  chain gain at 1 kHz: ${total.toFixed(2)} dB total`);
  check(total > dbfs(M.GAIN) - 1.5 && total < dbfs(M.GAIN) + 1.5, 'a mid-band tone is boosted by 3.0x, within 1.5 dB');
}

// 2. Silence in, silence out: an IIR rings for a few milliseconds after a tone, but it must die away to
//    nothing audible and must never sustain. The driver gates between phrases, so this is the gap the
//    caller hears between words.
{
  const chain = M.createMicChain();
  chain.process(sine(300, 8000, 160));         // give the filters real state first
  chain.process(new Int16Array(160));          // 20 ms: the lookahead line flushes the last tone samples
  const settled = chain.process(new Int16Array(160));
  const later = chain.process(new Int16Array(160));
  const tail = Math.max(peakOf(settled), peakOf(later));
  console.log(`  silence 40 ms after a tone: peak ${tail} of 32768 (${dbfs(tail / 32768).toFixed(0)} dBFS)`);
  check(tail <= 8, 'the chain decays to silence within 40 ms, at least 70 dB down');
  check(peakOf(later) <= peakOf(settled), 'and that tail keeps decaying rather than sustaining');
}

// 3. The ceiling holds, and the safety clamp is never what holds it.
{
  const chain = M.createMicChain();
  const hot = chain.process(sine(1000, 32767, FS));
  const peak = peakOf(hot);
  console.log(`  full-scale 1 kHz: peak ${dbfs(peak / 32768).toFixed(2)} dBFS, clamps ${chain.limiter.clamped}`);
  check(peak <= Math.round(M.CEIL * 32768), 'a full-scale tone stays under the hard ceiling');
  check(peak > Math.round(0.9 * 32768), 'and is still loud — the limiter compresses, it does not mute');
  check(chain.limiter.clamped === 0, 'the gain envelope alone keeps it there: the safety clamp never fires');
}

// 4. The tick. A word starting after silence used to flatten into a near-square edge: the per-sample
//    tanh at 3.0x produced jumps over 20000 units on a tone that cannot even produce them.
{
  const onset = sine(300, 32767, 1600, 800);             // silence, then a full-scale 300 Hz word
  const chain = M.createMicChain();
  const smooth = chain.process(onset);
  const smoothJump = maxJump(smooth);
  let oldJump = 0;
  for (let i = 801; i < onset.length; i++) {
    const a = Math.round(M.shape((onset[i - 1] / 32768) * M.GAIN) * 32768);
    const b = Math.round(M.shape((onset[i] / 32768) * M.GAIN) * 32768);
    oldJump = Math.max(oldJump, Math.abs(b - a));
  }
  console.log(`  onset: new max jump ${smoothJump} vs per-sample tanh ${oldJump}`);
  check(smoothJump < 12000, 'the new chain keeps the waveform smooth at a word onset');
  check(oldJump > 20000, 'the old per-sample curve does not — the control proves the check bites');
  check(chain.limiter.clamped === 0, 'and no clamp fires at the onset either');

  // A step in gain is a click however the curve is shaped, so measure the envelope itself.
  const probe = M.createMicChain();
  let prev = 1;
  let worstStep = 0;
  const run = probe.limiter.run.bind(probe.limiter);
  probe.limiter.run = (v) => {
    const y = run(v);
    worstStep = Math.max(worstStep, Math.abs(probe.limiter.gain - prev));
    prev = probe.limiter.gain;
    return y;
  };
  probe.process(onset);
  console.log(`  worst single-sample gain change: ${worstStep.toFixed(4)} (${(20 * Math.log10(1 + worstStep)).toFixed(3)} dB)`);
  check(worstStep < 0.08, 'the gain envelope never steps (no click source)');
}

// 5. The low end is cut: this is the "basement" the caller hears, and it measured 5.3 dB hot.
{
  const eq100 = eqGainDb(100);
  const eq180 = eqGainDb(180);
  const eq500 = eqGainDb(500);
  console.log(`  low cut: 100 Hz ${eq100.toFixed(1)} dB, 180 Hz ${eq180.toFixed(1)} dB, 500 Hz ${eq500.toFixed(1)} dB`);
  check(eq100 <= -8, '100 Hz is at least 8 dB down');
  check(eq180 <= -2 && eq180 >= -5, 'the 180 Hz corner sits at about -3 dB');
  check(Math.abs(eq500) < 1.5, 'and 500 Hz is left alone');
}

// 6. The presence lift covers the band the driver loses (2.2-3.2 kHz) and keeps rising to the top,
//    because the driver's rolloff does.
{
  const p22 = eqGainDb(2200);
  const p265 = eqGainDb(2650);
  const p32 = eqGainDb(3200);
  const p34 = eqGainDb(3400);
  console.log(`  presence: 2.2k ${p22.toFixed(1)} dB, 2.65k ${p265.toFixed(1)}, 3.2k ${p32.toFixed(1)}, 3.4k ${p34.toFixed(1)}`);
  check(p22 >= 4, '2.2 kHz gets at least +4 dB');
  check(p265 >= 7, '2.65 kHz gets at least +7 dB');
  check(p32 >= 7, '3.2 kHz gets at least +7 dB — where the deficit is worst, so the lift cannot fall away');
  check(p34 >= p22, 'and the shelf keeps rising to the top of the band rather than peaking and falling');
  check(eqGainDb(1000) < 2, 'without dragging the mid-band up with it');
}

// 7. Release: after a loud passage the chain opens back up, or the next quiet sentence is buried.
{
  const chain = M.createMicChain();
  chain.process(sine(500, 32767, 800));                   // 100 ms loud, fully limited
  const quietIn = sine(500, 900, 2400);                   // 300 ms quiet
  const quietOut = chain.process(quietIn);
  const measured = dbfs(rms(quietOut, 1600)) - dbfs(rms(quietIn, 1600));
  console.log(`  quiet tone 200 ms after the loud one: ${measured.toFixed(2)} dB of gain (want ${dbfs(M.GAIN).toFixed(1)})`);
  check(measured > dbfs(M.GAIN) - 2.5, 'the gain recovers to within 2.5 dB of unity within 200 ms');
}

// 8. State must carry across 20 ms frames: per-frame instances would put a step at every boundary.
{
  const whole = sine(400, 12000, 3200);
  const once = M.createMicChain().process(whole);
  const chain = M.createMicChain();
  const chunked = new Int16Array(whole.length);
  for (let i = 0; i < whole.length; i += 160) chunked.set(chain.process(whole.subarray(i, i + 160)), i);
  let same = true;
  for (let i = 0; i < once.length; i++) if (once[i] !== chunked[i]) { same = false; break; }
  check(same, 'framing does not change the output (filters and envelope persist between frames)');
  check(chunked instanceof Int16Array && chunked.length === whole.length, 'frame length and type are preserved');
  check(!chunked.includes(32767) && !chunked.includes(-32768), 'no sample sits on the rail');
}

// 9. Reset for a new call.
{
  const chain = M.createMicChain();
  chain.process(sine(500, 32767, 1600));
  chain.reset();
  const fresh = M.createMicChain().process(sine(500, 800, 800));
  const afterReset = chain.process(sine(500, 800, 800));
  let same = true;
  for (let i = 0; i < fresh.length; i++) if (fresh[i] !== afterReset[i]) { same = false; break; }
  check(same, 'a reset chain behaves exactly like a new one (no carried-over attenuation)');
}

// 10. The chain describes itself, for the status output and for the docs.
{
  const d = M.createMicChain().describe();
  check(d.gain === M.GAIN && d.lowCutHz === M.LOW_CUT_HZ && d.presenceHz === M.PRESENCE_HZ && d.presenceDb === M.PRESENCE_DB,
    'describe() reports the gain and EQ it is actually using');
  check(d.lookaheadMs > 0 && d.ceiling < 1, 'and the limiter settings that keep the ceiling');
}

assert.strictEqual(failed, 0, `${failed} mic chain check(s) failed`);
console.log(`\n${failed ? '\u{1F4A5}' : '\u{1F389}'} ${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);

