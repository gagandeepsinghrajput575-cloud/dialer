// The silent backend: a call with no sound card attached.
//
// It exists so that (a) CI can exercise registration, INVITE, RTP and DTMF end to end on a
// machine with no audio hardware, and (b) a mis-built addon degrades to "you cannot hear
// anything yet" rather than "the daemon will not start". Input is silence, output is counted
// and dropped.
'use strict';

const { RATE, FRAME_SAMPLES } = require('./index.js');

function create() {
  let timer = null;
  let frames = 0;
  let opened = false;
  const state = { name: 'null', rate: RATE, frameSamples: FRAME_SAMPLES };

  return {
    name: 'null',
    available: () => true,
    reason: '',
    describe: () => ({ ...state, opened, frames }),
    async open() { opened = true; return state; },
    // Emits silence on the real 20 ms cadence, so pacing bugs show up in tests too.
    start(onInput) {
      if (timer) return;
      let next = Date.now();
      const silence = new Int16Array(FRAME_SAMPLES);
      timer = setInterval(() => {
        frames++;
        next += 20;
        const drift = next - Date.now();
        if (drift < -200) next = Date.now();
        try { onInput?.(silence); } catch { /* a throwing consumer must not stop the pump */ }
      }, 20);
    },
    write() { return true; },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    close() { this.stop(); opened = false; },
    devices: () => ({ inputs: [{ id: 'null', label: 'No audio device' }], outputs: [{ id: 'null', label: 'No audio device' }] }),
  };
}

module.exports = { create };
