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
      addon.start(unit, (frame) => { try { onInput?.(frame); } catch { /* never stop the pump */ } });
    },
    write(int16) {
      if (!unit) return false;
      try { addon.write(unit, int16); return true; } catch { return false; }
    },
    stop() { if (unit) { try { addon.stop(unit); } catch { /* already stopped */ } } },
    close() { this.stop(); if (unit) { try { addon.close(unit); } catch { /* already closed */ } unit = null; } },
    devices() {
      if (!this.available()) return { inputs: [], outputs: [] };
      try { return addon.devices(); } catch { return { inputs: [], outputs: [] }; }
    },
  };
}

module.exports = { create, ADDON_CANDIDATES, BUILD_HINT };
