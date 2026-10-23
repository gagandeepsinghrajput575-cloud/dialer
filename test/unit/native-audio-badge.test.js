// The daemon's `ready` event may precede React subscribing; the badge must still report silent audio.
'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..');
const SESSION = { engine: 'native', provider: 'flynumber', domain: 'sip.flynumber.com', port: 5060, username: 'alice', callerId: '+4532331610', transport: 'udp' };
const NO_AUDIO = ['coreaudio: this is linux, not darwin'];

async function engineFor(status, readyAfterRegister = false) {
  const state = { standby: null, state: '' };
  let listener = null;
  const bridge = {
    status: async () => status,
    onEvent(fn) { listener = fn; return () => { listener = null; }; },
    async command(action) {
      if (action === 'register') {
        listener?.({ event: 'registered' });
        if (readyAfterRegister) listener?.({ event: 'ready', audio: { name: 'null' }, audioErrors: NO_AUDIO });
      }
      return { ok: true };
    },
  };
  globalThis.window = { pulseNativeSip: bridge };
  const mod = await import(pathToFileURL(path.join(REPO, 'src', 'nativeSip.js')).href);
  const engine = mod.createNativeEngine({
    session: SESSION,
    setState: (value) => { state.state = value; },
    setStandby: (value) => { state.standby = value; },
    setLevel: () => {}, setMuted: () => {}, setError: () => {}, setTarget: () => {},
    setDirection: () => {}, setIncomingCall: () => {}, setStandbyNote: () => {}, setMicLabel: () => {},
    callbacksRef: { current: {} },
  });
  return { engine, state };
}

async function main() {
  const { register } = require('node:module');
  register(pathToFileURL(path.join(REPO, 'test', 'helpers', 'esm-resolver.mjs')).href, pathToFileURL(__filename).href);

  // The ready event is lost before subscription. Main's retained status must recover the audio error.
  {
    const h = await engineFor({ running: true, audio: 'null', audioErrors: NO_AUDIO });
    try {
      await h.engine.start();
      assert.strictEqual(h.state.standby.state, 'unavailable');
      assert.match(h.state.standby.reason, /no audio device/i);
      assert.match(h.state.standby.reason, /portaudio/i);
      console.log('  ✓ a missed ready event is recovered from supervisor status; silent audio is not marked ready');
    } finally { h.engine.dispose(); delete globalThis.window; }
  }

  // If ready does arrive late, it must update a badge that already received `registered`.
  {
    const h = await engineFor({ running: true, audio: '', audioErrors: [] }, true);
    try {
      await h.engine.start();
      assert.strictEqual(h.state.standby.state, 'unavailable');
      assert.match(h.state.standby.reason, /no audio device/i);
      console.log('  ✓ a late ready event updates an already-registered badge');
    } finally { h.engine.dispose(); delete globalThis.window; }
  }

  // A real backend remains ready; "fix" cannot be hard-coded to unavailable.
  {
    const h = await engineFor({ running: true, audio: 'coreaudio', audioErrors: [] });
    try {
      await h.engine.start();
      assert.strictEqual(h.state.standby.state, 'ready');
      assert.strictEqual(h.state.standby.reason, '');
      console.log('  ✓ a reported CoreAudio backend remains ready');
    } finally { h.engine.dispose(); delete globalThis.window; }
  }
}

main().then(() => process.exit(0), (e) => {
  console.error(`  ✗ ${e.message}`);
  process.exit(1);
});
