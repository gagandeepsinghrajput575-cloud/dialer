// PortAudio backend — the fallback when the CoreAudio addon was not built.
//
// `cd desktop/daemon && npm i portaudio` gives a working microphone and speaker on macOS,
// Linux and Windows without compiling anything Pulse ships. It is optional: nothing in the
// daemon requires it, and its absence is reported, not fatal.
'use strict';

const { RATE, FRAME_SAMPLES } = require('./index.js');

let pa = null;
let loadError = '';
try { pa = require('portaudio'); } catch (e) { loadError = String(e?.message || e); }

function create() {
  let stream = null;
  let reader = null;

  return {
    name: 'portaudio',
    available: () => !!pa,
    reason: pa ? '' : `portaudio: not installed (${loadError.split('\n')[0]})`,
    describe: () => ({ name: 'portaudio', ready: !!stream, rate: RATE, frameSamples: FRAME_SAMPLES }),
    async open() {
      if (!pa) throw new Error(this.reason);
      stream = new pa.Speaker({
        channels: 1, sampleRate: RATE, audioFormat: pa.SampleFormatSignedInt16,
        // A short device latency keeps the operator's own voice from feeling distant.
        deviceId: pa.defaultOutputDevice, highwaterMark: FRAME_SAMPLES * 4,
      });
      reader = new pa.MicrophoneReader({
        channels: 1, sampleRate: RATE, audioFormat: pa.SampleFormatSignedInt16,
        deviceId: pa.defaultInputDevice, highwaterMark: FRAME_SAMPLES * 4,
      });
      stream.start();
      reader.start();
      return this.describe();
    },
    // Pull exactly one 20 ms frame per call: the media pump is the clock, not PortAudio.
    start(onInput) {
      const read = () => {
        if (!reader) return;
        try {
          const frame = reader.read(FRAME_SAMPLES, 3);
          if (frame) onInput?.(new Int16Array(frame.buffer, frame.byteOffset, FRAME_SAMPLES));
        } catch { /* an overrun drops one frame; it must not kill the call */ }
      };
      this._timer = setInterval(read, 20);
    },
    write(int16) {
      if (!stream) return false;
      try { stream.write(Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength)); return true; } catch { return false; }
    },
    stop() {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      try { reader?.stop(); } catch { /* already stopped */ }
      try { stream?.stop(); } catch { /* already stopped */ }
    },
    close() {
      this.stop();
      try { reader?.close(); } catch { /* already closed */ }
      try { stream?.close(); } catch { /* already closed */ }
      reader = null; stream = null;
    },
    devices() {
      if (!pa) return { inputs: [], outputs: [] };
      try {
        return {
          inputs: pa.allDevices.filter((d) => d.supportedInputChannels > 0)
            .map((d) => ({ id: String(d.id), label: d.name })),
          outputs: pa.allDevices.filter((d) => d.supportedOutputChannels > 0)
            .map((d) => ({ id: String(d.id), label: d.name })),
        };
      } catch { return { inputs: [], outputs: [] }; }
    },
  };
}

module.exports = { create };
