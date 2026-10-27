// Unit test for Native SIP daemon call recorder.
// Verifies 8 kHz bidirectional linear PCM mixing, 16-bit clamping, RIFF/WAV header generation,
// and recording event dispatch across daemon, media, and nativeSip.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createWavHeader, CallRecorder, uploadOrSaveRecording, SAMPLE_RATE } = require('../../desktop/daemon/lib/recorder');
const mediaLayer = require('../../desktop/daemon/lib/media');
const { EventEmitter } = require('events');

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

async function run() {
  console.log('[unit:native-recording] native SIP call recorder & dual-channel WAV mixing');

  // 1. RIFF/WAV header verification
  const header = createWavHeader({ numSamples: 8000, sampleRate: 8000, numChannels: 1, bitsPerSample: 16 });
  assert.strictEqual(header.length, 44, 'WAV header is exactly 44 bytes');
  assert.strictEqual(header.toString('ascii', 0, 4), 'RIFF', 'RIFF identifier at offset 0');
  assert.strictEqual(header.toString('ascii', 8, 12), 'WAVE', 'WAVE identifier at offset 8');
  assert.strictEqual(header.toString('ascii', 12, 16), 'fmt ', 'fmt subchunk at offset 12');
  assert.strictEqual(header.readUInt16LE(20), 1, 'AudioFormat 1 is uncompressed PCM');
  assert.strictEqual(header.readUInt16LE(22), 1, 'NumChannels is 1 (mono)');
  assert.strictEqual(header.readUInt32LE(24), 8000, 'SampleRate is 8000 Hz');
  assert.strictEqual(header.readUInt16LE(34), 16, 'BitsPerSample is 16');
  assert.strictEqual(header.toString('ascii', 36, 40), 'data', 'data subchunk at offset 36');
  // 8000 samples * 2 bytes = 16000 data bytes. ChunkSize = 36 + 16000 = 16036
  assert.strictEqual(header.readUInt32LE(4), 16036, 'RIFF chunkSize calculation matches 36 + dataSize');
  assert.strictEqual(header.readUInt32LE(40), 16000, 'data subchunk size is 16000 bytes');
  ok('createWavHeader generates standard 44-byte RIFF/WAV header');

  // 2. CallRecorder: bidirectional mixing and 16-bit clamping
  const rec = new CallRecorder({ callId: 1, externalId: 101, sampleRate: 8000 });
  const micFrame = new Int16Array(160);
  const remFrame = new Int16Array(160);

  // Set known samples: 20000 + 20000 = 40000 which should clamp to 32767
  micFrame[0] = 20000;
  remFrame[0] = 20000;
  // Normal sample: 5000 + 3000 = 8000
  micFrame[1] = 5000;
  remFrame[1] = 3000;
  // Negative overflow: -25000 + -20000 = -45000 which should clamp to -32768
  micFrame[2] = -25000;
  remFrame[2] = -20000;

  rec.pushRemote(remFrame);
  rec.recordFrame(micFrame, false);

  const res = rec.finalize();
  assert.strictEqual(res.callId, 1, 'preserves callId');
  assert.strictEqual(res.externalId, 101, 'preserves externalId');
  assert.strictEqual(res.totalSamples, 160, '160 samples mixed');
  assert.strictEqual(res.wavBuffer.length, 44 + 320, '44 header + 320 byte data = 364 bytes');

  // Verify clamped samples in WAV output
  const dataOffset = 44;
  assert.strictEqual(res.wavBuffer.readInt16LE(dataOffset + 0), 32767, 'positive overflow clamped to 32767');
  assert.strictEqual(res.wavBuffer.readInt16LE(dataOffset + 2), 8000, 'normal sample mixed accurately to 8000');
  assert.strictEqual(res.wavBuffer.readInt16LE(dataOffset + 4), -32768, 'negative overflow clamped to -32768');
  ok('CallRecorder mixes mic + remote PCM with proper 16-bit linear clamping');

  // 3. CallRecorder: mute handling
  const recMute = new CallRecorder({ callId: 2, externalId: 102 });
  const micMute = new Int16Array(160);
  const remMute = new Int16Array(160);
  micMute[0] = 12000;
  remMute[0] = 4000;

  recMute.pushRemote(remMute);
  recMute.recordFrame(micMute, true); // muted!
  const resMute = recMute.finalize();
  assert.strictEqual(resMute.wavBuffer.readInt16LE(44), 4000, 'muted mic contributes 0; only remote is recorded');
  ok('CallRecorder suppresses microphone audio when call is muted');

  // 4. Local disk saving
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-rec-unit-'));
  process.env.DATA_DIR = tmpDir;
  fs.mkdirSync(path.join(tmpDir, 'recordings'), { recursive: true });

  const dummyWav = Buffer.concat([createWavHeader({ numSamples: 160 }), Buffer.alloc(320)]);
  const saveRes = await uploadOrSaveRecording({
    wavBuffer: dummyWav,
    durationSec: 1,
    callId: 3,
    externalId: 999,
  });
  assert.strictEqual(saveRes.savedLocal, true, 'saved to local disk');
  const savedFile = path.join(tmpDir, 'recordings', 'call-999.wav');
  assert.ok(fs.existsSync(savedFile), 'file exists on disk');
  assert.strictEqual(fs.statSync(savedFile).size, 364, 'file size on disk matches WAV size');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  ok('uploadOrSaveRecording saves valid WAV file to disk');

  // 5. Media layer recording emission
  const ua = new EventEmitter();
  ua.mediaSockets = [];
  ua.levels = { input: 0, output: 0, at: 0 };
  ua.pump = null;
  ua.log = () => {};
  mediaLayer.attach(ua);

  let recordedEvent = null;
  ua.on('recording', (ev) => { recordedEvent = ev; });

  const fakeDialog = {
    id: 55,
    externalId: 777,
    media: { close: () => {} },
  };
  fakeDialog.recorder = new CallRecorder({ callId: fakeDialog.id, externalId: fakeDialog.externalId });
  fakeDialog.recorder.pushRemote(new Int16Array(160));
  fakeDialog.recorder.recordFrame(new Int16Array(160), false);

  ua.releaseMedia(fakeDialog);
  assert.ok(recordedEvent, 'recording event emitted on releaseMedia');
  assert.strictEqual(recordedEvent.callId, 777, 'recording event has externalId as callId');
  assert.strictEqual(recordedEvent.dialogId, 55, 'recording event has dialogId');
  assert.strictEqual(recordedEvent.mimeType, 'audio/wav', 'mimeType is audio/wav');
  assert.ok(recordedEvent.sizeBytes > 44, 'sizeBytes includes WAV header + samples');
  ok('mediaLayer.releaseMedia finalizes recorder and emits recording event');

  console.log(`\n🎉 [unit:native-recording] all ${passed} checks passed`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
