// What we transmit, captured as audio — the only way to hear yourself without a human on the line.
//
// The mixed call recording cannot answer "how did I sound to them": it contains the far end too, so
// an IVR, hold music or voicemail ruins it. The tap keeps just the G.711 payloads we send, and its
// WAV must decode back to exactly the samples the codec decoder produces, or it is measuring
// something other than what the carrier received.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { WireTap } = require('../../desktop/daemon/lib/wiretap');
const g711 = require('../../desktop/daemon/lib/g711');

let passed = 0;
let failed = 0;
const ok = (m) => { passed++; console.log(`  \u2713 ${m}`); };
const bad = (m) => { failed++; console.log(`  \u2717 ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

console.log('\n=== VAL-MEDIA-016: transmitted-audio tap ===\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-wiretap-'));

// 1. A real 20 ms frame: 160 G.711 bytes in, 320 bytes of PCM out.
{
  const pcm = new Int16Array(160);
  for (let i = 0; i < 160; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 8000));
  const payload = g711.encode(pcm, 0);           // PCMU

  const tap = new WireTap({ dir, callId: 'test-1' });
  for (let f = 0; f < 3; f++) tap.write(payload);
  const written = tap.finish();

  check(!!written && fs.existsSync(written.path), 'a call tap writes a WAV');
  check(written.seconds > 0.05 && written.seconds < 0.07, `three 20 ms frames = 60 ms (${written.seconds.toFixed(3)}s)`);

  const wav = fs.readFileSync(written.path);
  check(wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE', 'RIFF/WAVE header');
  check(wav.readUInt16LE(20) === 1 && wav.readUInt16LE(22) === 1, 'PCM, mono');
  check(wav.readUInt32LE(24) === 8000 && wav.readUInt16LE(34) === 16, '8 kHz, 16-bit');
  check(wav.readUInt32LE(40) === 3 * 160 * 2, 'the data chunk is 3 x 160 samples');
  check(wav.readUInt32LE(4) === wav.length - 8, 'the RIFF size matches the file');

  // Every sample must equal what our own decoder would play for the same bytes.
  const expected = g711.decode(Buffer.concat([payload, payload, payload]), 0);
  let mismatches = 0;
  for (let i = 0; i < expected.length; i++) {
    if (wav.readInt16LE(44 + i * 2) !== expected[i]) mismatches++;
  }
  check(mismatches === 0, `the tap WAV equals the codec decode sample-for-sample (${expected.length} samples)`);
}

// 2. Silence still decodes to zero, which is what the far end must hear in a pause.
{
  const silence = g711.decode(Buffer.from([0xff]), 0)[0];
  check(silence === 0, '0xFF decodes to digital silence');
}

// 3. A call with no transmitted audio produces no file, and finishing twice is harmless.
{
  const empty = new WireTap({ dir, callId: 'test-2' });
  check(empty.finish() === null, 'a call that transmitted nothing writes no file');
  const tap = new WireTap({ dir, callId: 'test-3' });
  tap.write(g711.encode(new Int16Array(160), 0));
  check(!!tap.finish(), 'a normal tap finalizes');
  check(tap.finish() === null && tap.write(Buffer.from([1])) === undefined, 'finalizing twice is a no-op');
}

fs.rmSync(dir, { recursive: true, force: true });
assert.strictEqual(failed, 0, `${failed} wiretap check(s) failed`);
console.log(`\n${failed ? '\u{1F4A5}' : '\u{1F389}'} ${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
