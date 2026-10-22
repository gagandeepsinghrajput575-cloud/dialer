// Audio backend resolution.
//
// One interface, three implementations, chosen at start-up:
//   coreaudio — the native macOS addon (desktop/native/pulse_audio), built by
//               desktop/scripts/build-daemon.sh. This is what the operator hears.
//   portaudio — `npm i portaudio` in desktop/daemon, for a Mac/Linux box where the addon
//               was not built but PortAudio was.
//   null      — no sound card. Signalling, registration and RTP still run, which is how the
//               SIP state machine is verified in CI on a machine with no audio at all.
//
// A missing backend must never stop the daemon: it starts, reports `audio.backend = "null"`,
// and the UI can say "no audio device" instead of the app silently doing nothing.
'use strict';

const BACKENDS = ['coreaudio', 'portaudio', 'null'];
const RATE = 8000;
const FRAME_MS = 20;
const FRAME_SAMPLES = (RATE * FRAME_MS) / 1000;   // 160

function tryRequire(name) {
  try { return require(name); } catch { return null; }
}

function load(preferred = 'auto') {
  const wanted = String(preferred || 'auto').toLowerCase();
  const order = wanted === 'auto' ? BACKENDS : [wanted, 'null'];
  const errors = [];
  for (const name of order) {
    try {
      if (name === 'null') return { name, backend: require('./null.js').create(), errors };
      if (name === 'coreaudio') {
        const mod = tryRequire('./coreaudio.js');
        if (!mod) { errors.push('coreaudio: module missing'); continue; }
        const backend = mod.create();
        if (!backend.available()) { errors.push(backend.reason || 'coreaudio: addon not built'); continue; }
        return { name, backend, errors };
      }
      if (name === 'portaudio') {
        const mod = tryRequire('./portaudio.js');
        if (!mod) { errors.push('portaudio: module missing'); continue; }
        const backend = mod.create();
        if (!backend.available()) { errors.push(backend.reason || 'portaudio: not installed'); continue; }
        return { name, backend, errors };
      }
    } catch (e) {
      errors.push(`${name}: ${e?.message || e}`);
    }
  }
  return { name: 'null', backend: require('./null.js').create(), errors };
}

module.exports = { load, BACKENDS, RATE, FRAME_MS, FRAME_SAMPLES };
