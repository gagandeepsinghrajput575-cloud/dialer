// Native call recorder: mixes incoming and outgoing 8 kHz linear PCM and encodes standard WAV.
'use strict';

const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 8000;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;

/** Standard 44-byte RIFF/WAVE header for 16-bit mono 8 kHz PCM. */
function createWavHeader({ numSamples, sampleRate = SAMPLE_RATE, numChannels = NUM_CHANNELS, bitsPerSample = BITS_PER_SAMPLE }) {
  const bytesPerSample = bitsPerSample / 8;
  const byteRate = sampleRate * numChannels * bytesPerSample;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numSamples * numChannels * bytesPerSample;
  const buffer = Buffer.alloc(44);

  // RIFF Chunk Descriptor
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4); // ChunkSize
  buffer.write('WAVE', 8);

  // "fmt " sub-chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);             // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20);              // AudioFormat (1 = PCM)
  buffer.writeUInt16LE(numChannels, 22);    // NumChannels
  buffer.writeUInt32LE(sampleRate, 24);     // SampleRate
  buffer.writeUInt32LE(byteRate, 28);       // ByteRate
  buffer.writeUInt16LE(blockAlign, 32);     // BlockAlign
  buffer.writeUInt16LE(bitsPerSample, 34);  // BitsPerSample

  // "data" sub-chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);       // Subchunk2Size

  return buffer;
}

class CallRecorder {
  constructor({ callId, externalId = null, sampleRate = SAMPLE_RATE }) {
    this.callId = callId;
    this.externalId = externalId;
    this.sampleRate = sampleRate;
    this.remoteQueue = [];
    this.chunks = [];
    this.totalSamples = 0;
    this.startedAt = Date.now();
    this.lastFrameAt = this.startedAt;
  }

  setExternalId(id) {
    if (id !== undefined && id !== null) this.externalId = id;
  }

  /** Queue a remote 160-sample frame from G.711 RTP. */
  pushRemote(pcm) {
    if (!pcm || !pcm.length) return;
    const samples = pcm instanceof Int16Array ? pcm : new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
    // Guard against boundless queue growth if mic pump is stalled
    if (this.remoteQueue.length > 50) {
      this.remoteQueue.shift();
    }
    this.remoteQueue.push(samples);

    // If no mic frame pump has ticked in > 500 ms (e.g. silent / headless backend),
    // record the remote stream directly so audio is never lost.
    if (Date.now() - this.lastFrameAt > 500 && this.remoteQueue.length > 0) {
      const rem = this.remoteQueue.shift();
      const buf = Buffer.alloc(rem.length * 2);
      for (let i = 0; i < rem.length; i++) {
        buf.writeInt16LE(rem[i], i * 2);
      }
      this.chunks.push(buf);
      this.totalSamples += rem.length;
    }
  }

  /** Mix and record a 160-sample frame from local microphone clock (20 ms). */
  recordFrame(micPcm, isMuted = false) {
    this.lastFrameAt = Date.now();
    const mic = (isMuted || !micPcm) ? null : (
      micPcm instanceof Int16Array
        ? micPcm
        : (Buffer.isBuffer(micPcm)
          ? new Int16Array(micPcm.buffer, micPcm.byteOffset, Math.floor(micPcm.byteLength / 2))
          : micPcm)
    );
    const count = (mic && mic.length) || 160;
    const remoteChunk = this.remoteQueue.length > 0 ? this.remoteQueue.shift() : null;

    const outBuf = Buffer.alloc(count * 2);
    for (let i = 0; i < count; i++) {
      const micSample = mic && i < mic.length ? mic[i] : 0;
      const remSample = remoteChunk && i < remoteChunk.length ? remoteChunk[i] : 0;
      // Standard 16-bit linear PCM mixing with clamping to prevent wrap-around
      let sum = micSample + remSample;
      if (sum > 32767) sum = 32767;
      else if (sum < -32768) sum = -32768;
      outBuf.writeInt16LE(sum, i * 2);
    }
    this.chunks.push(outBuf);
    this.totalSamples += count;
  }

  /** Assemble final WAV buffer and metadata. */
  finalize() {
    // Flush any remaining remote audio packets
    while (this.remoteQueue.length > 0) {
      const rem = this.remoteQueue.shift();
      const buf = Buffer.alloc(rem.length * 2);
      for (let i = 0; i < rem.length; i++) {
        buf.writeInt16LE(rem[i], i * 2);
      }
      this.chunks.push(buf);
      this.totalSamples += rem.length;
    }

    const dataBuffer = Buffer.concat(this.chunks);
    const header = createWavHeader({ numSamples: this.totalSamples, sampleRate: this.sampleRate });
    const wavBuffer = Buffer.concat([header, dataBuffer]);
    const durationSec = Math.max(0, Math.round(this.totalSamples / this.sampleRate));

    return {
      callId: this.callId,
      externalId: this.externalId,
      durationSec,
      totalSamples: this.totalSamples,
      wavBuffer,
      sizeBytes: wavBuffer.length,
    };
  }
}

/** Upload WAV to API and save to local data/recordings directory. */
async function uploadOrSaveRecording({ wavBuffer, durationSec, callId, externalId, apiBase, log = () => {} }) {
  const targetId = externalId || callId;
  const numId = Number(targetId);
  let savedLocal = false;
  let uploaded = false;

  // 1. Direct local filesystem storage
  try {
    const rootDir = path.resolve(__dirname, '..', '..', '..');
    const defaultDir = path.join(rootDir, 'data', 'recordings');
    const dir = process.env.DATA_DIR ? path.join(path.resolve(process.env.DATA_DIR), 'recordings') : defaultDir;
    if (fs.existsSync(dir) && targetId) {
      const targetPath = path.join(dir, `call-${targetId}.wav`);
      fs.writeFileSync(targetPath, wavBuffer);
      savedLocal = true;
      log('media', `saved recording to local disk: ${targetPath}`);
    }
  } catch (err) {
    log('media', `local recording save failed: ${err.message}`);
  }

  // 2. Upload to server API endpoint (which writes to recordings table and ensures ledger presence)
  if (apiBase && Number.isInteger(numId) && numId > 0 && wavBuffer.length > 44) {
    try {
      const sessionUrl = `${apiBase.replace(/\/+$/, '')}/api/session`;
      const sessionRes = await fetch(sessionUrl, { signal: AbortSignal.timeout(4000) });
      const sessionData = await sessionRes.json();
      const token = sessionData?.token;

      const uploadUrl = `${apiBase.replace(/\/+$/, '')}/api/recordings/${numId}`;
      const form = new FormData();
      const blob = new Blob([wavBuffer], { type: 'audio/wav' });
      form.append('audio', blob, `call-${numId}.wav`);
      form.append('duration_sec', String(durationSec));

      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: token ? { 'x-pulse-token': token } : {},
        body: form,
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      if (data?.ok) {
        uploaded = true;
        log('media', `uploaded call recording to ${uploadUrl} (call ${numId}, ${durationSec}s)`);
      } else {
        log('media', `recording upload rejected by server: ${data?.error || res.status}`);
      }
    } catch (err) {
      log('media', `recording upload request error: ${err.message}`);
    }
  }

  return { savedLocal, uploaded };
}

module.exports = {
  createWavHeader,
  CallRecorder,
  uploadOrSaveRecording,
  SAMPLE_RATE,
};
