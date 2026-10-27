// macOS CoreAudio backend, backed by the native addon in desktop/native/pulse_audio.
//
// The addon owns two AudioUnit I/O units running at the device's own rate (usually 48 kHz);
// it resamples to/from the 8 kHz mono Int16 frames SIP needs, so this file only shuttles
// buffers. If the addon was never built the backend reports unavailable with the exact
// command that fixes it, and index.js falls through to `null`.
'use strict';

const path = require('path');
const fs = require('fs');

const ADDON_CANDIDATES = [
  path.join(__dirname, '..', '..', '..', 'native', 'build', 'Release', 'pulse_audio.node'),
  path.join(__dirname, '..', '..', '..', 'native', 'build', 'pulse_audio.node'),
  path.join(__dirname, '..', '..', 'build', 'pulse_audio.node'),
];

const BUILD_HINT = 'Run: bash desktop/scripts/build-daemon.sh   (builds the CoreAudio addon)';

function loadAddon() {
  for (const candidate of ADDON_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return require(candidate);
    } catch (e) {
      return { error: `${candidate}: ${e?.message || e}` };
    }
  }
  return null;
}

function create() {
  const addon = process.platform === 'darwin' ? loadAddon() : null;
  const reason = process.platform !== 'darwin'
    ? `coreaudio: this is ${process.platform}, not darwin`
    : addon?.error
      ? `coreaudio: ${addon.error}`
      : addon ? '' : `coreaudio: addon not built — ${BUILD_HINT}`;
  let unit = null;
  let warmupSamplesRemaining = 160;
  let jitterQueue = [];
  let isPrimed = false;
  let lastWriteTime = 0;
  const JITTER_PRE_ROLL = 2; // 2 frames (40 ms) jitter cushion to eliminate starvation buzz

  function sanitizeAndWarmup(frame) {
    if (!frame || !frame.length) return frame;
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i];
      if (Number.isNaN(v) || !Number.isFinite(v)) {
        frame[i] = 0;
      }
    }
    if (warmupSamplesRemaining > 0) {
      const count = Math.min(frame.length, warmupSamplesRemaining);
      for (let i = 0; i < count; i++) {
        frame[i] = 0;
      }
      warmupSamplesRemaining -= count;
    }
    return frame;
  }

  return {
    name: 'coreaudio',
    available: () => !!addon && !addon.error,
    reason,
    describe: () => ({
      name: 'coreaudio',
      ready: !!unit,
      rate: addon?.sampleRate || 8000,
      frameSamples: 160,
      inputDevice: addon?.inputDevice || '',
      outputDevice: addon?.outputDevice || '',
    }),
    async open({ inputDevice = '', outputDevice = '' } = {}) {
      if (!this.available()) throw new Error(reason);
      unit = addon.open({ sampleRate: 8000, channels: 1, inputDevice, outputDevice });
      return this.describe();
    },
    start(onInput) {
      if (!unit) throw new Error('coreaudio: open() first');
      warmupSamplesRemaining = 160; // 20 ms warmup at 8 kHz
      addon.start(unit, (rawFrame) => {
        try {
          const frame = rawFrame instanceof Int16Array
            ? rawFrame
            : (Buffer.isBuffer(rawFrame)
              ? new Int16Array(rawFrame.buffer, rawFrame.byteOffset, Math.floor(rawFrame.byteLength / 2))
              : rawFrame);
          sanitizeAndWarmup(frame);
          onInput?.(frame);
        } catch { /* never stop the pump */ }
      });
    },
    write(int16) {
      if (!unit) return false;
      try {
        const now = Date.now();
        // If no audio arrived for > 150 ms (silence/pause), re-prime on the next burst
        if (now - lastWriteTime > 150) {
          isPrimed = false;
          jitterQueue = [];
        }
        lastWriteTime = now;

        if (!isPrimed) {
          jitterQueue.push(int16);
          if (jitterQueue.length >= JITTER_PRE_ROLL) {
            isPrimed = true;
            for (const chunk of jitterQueue) {
              addon.write(unit, chunk);
            }
            jitterQueue = [];
          }
          return true;
        }

        const ok = addon.write(unit, int16);
        return ok !== false;
      } catch {
        return false;
      }
    },
    stop() {
      warmupSamplesRemaining = 160;
      isPrimed = false;
      jitterQueue = [];
      if (unit) { try { addon.stop(unit); } catch { /* already stopped */ } }
    },
    close() {
      this.stop();
      if (unit) { try { addon.close(unit); } catch { /* already closed */ } unit = null; }
    },
    devices() {
      if (!this.available()) return { inputs: [], outputs: [] };
      try { return addon.devices(); } catch { return { inputs: [], outputs: [] }; }
    },
  };
}

module.exports = { create, ADDON_CANDIDATES, BUILD_HINT };
