// The sound of an outbound call, designed to lower the temperature rather than raise it.
//
// Cold calling is acoustically exhausting: a 425 Hz ringback tone looped into a headset for
// thirty seconds, twenty times an hour, is a stressor. So the engine never synthesises
// ringback. Instead it makes three small, local cues:
//
//   blip()      — a single 200 ms, 330 Hz sine at low gain when the INVITE leaves. It says
//                 "the call went out" and then gets out of the way.
//   ringing()   — a heartbeat while the far end rings: one 80 ms, 180 Hz pulse every 3 s, at
//                 a gain you have to listen for. Not a ringback — it is the quiet "still
//                 there" that stops dead air from reading as a crash.
//   connected() — an ascending 520 → 660 Hz two-tone when the prospect picks up. It is the
//                 heads-up to start talking, and it is deliberately short (~260 ms total).
//
// Everything here is local: oscillators are connected to the AudioContext destination, never
// to a MediaStreamAudioDestinationNode, so none of it can reach the microphone the customer
// hears. `stop()` closes the context, because a softphone that opens one per call eventually
// hits the browser's context limit.

export const DIAL_BLIP = Object.freeze({ at: 0, frequency: 330, ms: 200, gain: 0.05 });

export const CONNECT_CHIME = Object.freeze([
  { at: 0, frequency: 520, ms: 120, gain: 0.06 },
  { at: 0.12, frequency: 660, ms: 140, gain: 0.06 },
]);

// 180 Hz is below the band a headset renders harshly and low enough to feel like a pulse
// rather than a tone. 80 ms is a heartbeat; 3 s apart is slow enough to ignore.
export const RING_PULSE = Object.freeze({ at: 0, frequency: 180, ms: 80, gain: 0.03 });
export const RING_PULSE_EVERY_MS = 3000;

/**
 * @param {object} [opts]
 * @param {Function} [opts.AudioContext] constructor (injected in tests)
 * @returns {{ blip: () => boolean, connected: () => boolean, stop: () => void }}
 */
export function createChime({ AudioContext: Ctor } = {}) {
  const Ctx = Ctor || (typeof window !== 'undefined'
    ? (window.AudioContext || window.webkitAudioContext)
    : null);
  let ctx = null;
  let pulseTimer = null;

  // Idempotent on purpose: a carrier can send 180 and then 183, and a second tempo overlapping
  // the first would turn a calm heartbeat into a rattle.
  const stopPulse = () => { if (pulseTimer) clearInterval(pulseTimer); pulseTimer = null; };

  const ensure = () => {
    if (!Ctx) return null;
    if (!ctx) {
      try { ctx = new Ctx(); } catch { return null; }
    }
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      try { ctx.resume().catch?.(() => {}); } catch { /* blocked until a gesture */ }
    }
    return ctx;
  };

  function play(tones) {
    const c = ensure();
    if (!c?.createOscillator || !c.destination) return false;
    for (const tone of tones) {
      try {
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = 'sine';
        osc.frequency.value = tone.frequency;
        gain.gain.value = 0;                        // always fade in: a click is worse than silence
        osc.connect(gain);
        gain.connect(c.destination);                // local output only
        const start = (c.currentTime || 0) + (tone.at || 0);
        const end = start + tone.ms / 1000;
        if (typeof gain.gain.setValueAtTime === 'function') {
          gain.gain.setValueAtTime(0, start);
          if (gain.gain.linearRampToValueAtTime) {
            gain.gain.linearRampToValueAtTime(tone.gain, start + 0.015);
            gain.gain.setValueAtTime(tone.gain, Math.max(start + 0.016, end - 0.02));
            gain.gain.linearRampToValueAtTime(0, end);
          }
        }
        osc.start(start);
        osc.stop(end + 0.01);
      } catch { /* a blocked cue must never break a call */ }
    }
    return true;
  }

  // The heartbeat is driven from JS rather than pre-scheduled: a ring can last three seconds
  // or ninety, and clearing one interval is a cleaner stop than unwinding a queue of nodes.
  const ringing = () => {
    if (pulseTimer) return true;
    if (!ensure()) return false;
    play([RING_PULSE]);   // the first beat lands immediately, not 3 s from now
    pulseTimer = setInterval(() => play([RING_PULSE]), RING_PULSE_EVERY_MS);
    if (typeof pulseTimer?.unref === 'function') pulseTimer.unref();   // never hold a process open
    return true;
  };

  return {
    blip: () => play([DIAL_BLIP]),
    ringing,
    stopRinging: stopPulse,
    connected: () => play(CONNECT_CHIME),
    stop: () => {
      stopPulse();
      try { if (ctx && ctx.state !== 'closed') ctx.close(); } catch { /* already closed */ }
      ctx = null;
    },
  };
}
