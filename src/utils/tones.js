// Local audio cues: the tones a softphone makes that are never transmitted anywhere.
//
// Two kinds live here. The keypad's DTMF pairs (standard frequencies, played locally so the
// agent hears the press even when the far end gets the digit over RFC 2833) and the ringback /
// busy cadences. Extracted from useWebRtc.js so the native SIP engine — which owns no
// microphone and no peer connection, because the desktop daemon owns CoreAudio — can still give
// the agent the same audible feedback without dragging the browser engine along.
//
// Every function here treats a missing Web Audio API as a normal condition, not an error: jsdom,
// headless browsers and denied permissions all reach this code, and a cue that cannot play must
// never be the reason a call fails.

/** The keys a keypad produces, in the order they are laid out. */
export const DTMF_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

/** Standard DTMF tone pairs (low group, high group) in Hz. */
export const DTMF_TONES = {
  1: [697, 1209], 2: [697, 1336], 3: [697, 1477],
  4: [770, 1209], 5: [770, 1336], 6: [770, 1477],
  7: [852, 1209], 8: [852, 1336], 9: [852, 1477],
  '*': [941, 1209], 0: [941, 1336], '#': [941, 1477],
};

/** US ringback (440 + 480 Hz) and busy (480 + 620 Hz) — played locally, never sent. */
export const RINGBACK_TONE = [440, 480];
export const BUSY_TONE = [480, 620];

// ---- capability probes. Every one of these can legitimately be missing. ----
export function mediaSupported() {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function';
}

export function audioContextCtor() {
  if (typeof window === 'undefined') return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

// A short, honest sentence for why live audio is unavailable, used instead of a stack trace.
export function mediaUnavailableReason() {
  if (typeof navigator === 'undefined') return 'This environment has no browser media APIs.';
  if (!navigator.mediaDevices) return 'The browser did not expose microphone access (it requires localhost or HTTPS).';
  if (typeof navigator.mediaDevices.getUserMedia !== 'function') return 'getUserMedia is not available in this browser.';
  return '';
}

/**
 * Soothing call cues — gentle harmonic bells replacing anxiety-inducing repetitive telephony beepers.
 *
 * - 'dial': 1 single calming bell (E5 + harmonic) that rings once and fades to peaceful silence.
 * - 'pickup': an uplifting ascending 2-bell chime (C5 -> G5) to signal they answered.
 * - 'hangup': a gentle descending 2-bell chime (E5 -> B4) to signal call closure without harsh busy-beeps.
 */
let lastChime = { type: '', at: 0 };

export function playSoothingChime(type = 'dial', sink = null) {
  const nowMs = Date.now();
  if (lastChime.type === type && nowMs - lastChime.at < 350) return;
  lastChime = { type, at: nowMs };

  const Ctx = audioContextCtor();
  if (!Ctx) return;
  let ctx = null;
  const activeNodes = [];

  try {
    ctx = new Ctx();
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      try { ctx.resume()?.catch?.(() => {}); } catch {}
    }

    const now = ctx.currentTime || 0;

    const ringBell = (freq, startTime, duration = 1.3, peakGain = 0.07) => {
      const harmonicFreqs = [freq, freq * 2.0];
      const harmonicGains = [peakGain, peakGain * 0.32];

      harmonicFreqs.forEach((f, idx) => {
        try {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          if (osc.frequency && typeof osc.frequency.setValueAtTime === 'function') {
            osc.frequency.setValueAtTime(f, startTime);
          } else if (osc.frequency) {
            osc.frequency.value = f;
          }

          const gMax = harmonicGains[idx];
          if (gain.gain && typeof gain.gain.setValueAtTime === 'function') {
            gain.gain.setValueAtTime(0.0001, startTime);
            if (typeof gain.gain.exponentialRampToValueAtTime === 'function') {
              gain.gain.exponentialRampToValueAtTime(gMax, startTime + 0.02);
              gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
            } else if (typeof gain.gain.linearRampToValueAtTime === 'function') {
              gain.gain.linearRampToValueAtTime(gMax, startTime + 0.02);
              gain.gain.linearRampToValueAtTime(0, startTime + duration);
            } else {
              gain.gain.setValueAtTime(gMax, startTime);
              gain.gain.setValueAtTime(0, startTime + duration);
            }
          }

          osc.connect(gain);
          gain.connect(ctx.destination);

          if (typeof osc.start === 'function') osc.start(startTime);
          if (typeof osc.stop === 'function') osc.stop(startTime + duration);
          activeNodes.push(osc, gain);
        } catch {}
      });
    };

    let totalDuration = 1.4;
    if (type === 'dial') {
      // 1 single soothing warm bell (E5)
      ringBell(659.25, now, 1.4, 0.07);
      totalDuration = 1.5;
    } else if (type === 'pickup') {
      // Uplifting ascending chime: C5 (523.25 Hz) -> G5 (783.99 Hz)
      ringBell(523.25, now, 0.55, 0.06);
      ringBell(783.99, now + 0.12, 0.9, 0.08);
      totalDuration = 1.2;
    } else if (type === 'hangup') {
      // Gentle descending closure chime: E5 (659.25 Hz) -> B4 (493.88 Hz)
      ringBell(659.25, now, 0.45, 0.05);
      ringBell(493.88, now + 0.12, 0.7, 0.06);
      totalDuration = 1.0;
    }

    const entry = {
      ctx,
      stop: () => {
        for (const n of activeNodes) {
          try { if (typeof n.stop === 'function') n.stop(); n.disconnect?.(); } catch {}
        }
        try { if (ctx && ctx.state !== 'closed' && typeof ctx.close === 'function') ctx.close(); } catch {}
      },
    };

    if (sink && Array.isArray(sink.current)) sink.current.push(entry);

    setTimeout(() => {
      try { entry.stop(); } catch {}
      if (sink && Array.isArray(sink.current)) {
        sink.current = sink.current.filter((e) => e !== entry);
      }
    }, Math.round(totalDuration * 1000) + 150);
  } catch {
    try { if (ctx && ctx.state !== 'closed' && typeof ctx.close === 'function') ctx.close(); } catch {}
  }
}

/**
 * Build the local tone player.
 *
 * @param {{current: Array}} sink - a ref-like object holding the live tones, so the caller can
 *   stop every one of them at once on hang-up (`releaseMedia`). Each entry gets a `stop()`.
 * @returns {(freqs: number[], ms: number) => void}
 */
export function createTonePlayer(sink) {
  const tone = (freqs, ms) => {
    // Intercept repetitive US ringback [440, 480] and play the single soothing bell instead!
    if (Array.isArray(freqs) && freqs.length === 2 && freqs[0] === 440 && freqs[1] === 480) {
      playSoothingChime('dial', sink);
      return;
    }
    // Intercept harsh busy signal [480, 620] and play the gentle hangup chime instead!
    if (Array.isArray(freqs) && freqs.length === 2 && freqs[0] === 480 && freqs[1] === 620) {
      playSoothingChime('hangup', sink);
      return;
    }

    const Ctx = audioContextCtor();
    if (!Ctx) return;
    let ctx, gain, oscs = [];
    try {
      ctx = new Ctx();
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
      gain = ctx.createGain();
      gain.gain.value = 0.06;                     // quiet: it is a cue, not a ringtone
      gain.connect(ctx.destination);
      oscs = freqs.map((f) => {
        const o = ctx.createOscillator();
        o.frequency.value = f;
        o.connect(gain);
        o.start();
        return o;
      });
      const entry = { ctx, gain, oscs, osc: oscs[0], stop: () => {
        for (const o of oscs) try { o.stop(); o.disconnect(); } catch {}
        try { gain.disconnect(); } catch {}
        try { if (ctx.state !== 'closed') ctx.close(); } catch {}
      }};
      if (sink && Array.isArray(sink.current)) sink.current.push(entry);
      setTimeout(() => {
        try { entry.stop(); } catch {}
        if (sink && Array.isArray(sink.current)) {
          sink.current = sink.current.filter((e) => e !== entry);
        }
      }, ms);
    } catch {
      // Ensure partial context is closed on failure
      try { for (const o of oscs) try { o.stop(); } catch {} } catch {}
      try { if (ctx && ctx.state !== 'closed') ctx.close(); } catch {}
    }
  };

  tone.chime = (type) => playSoothingChime(type, sink);
  return tone;
}

/**
 * Enumerate the microphones/speakers the browser will admit to. Labels are blank until the
 * agent has granted permission at least once, which is a browser rule, not a bug.
 */
export async function listAudioDevices() {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return { supported: false, inputs: [], outputs: [], needsPermission: false };
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput').map((d) => ({ id: d.deviceId, label: d.label || 'Microphone' }));
    const outputs = devices.filter((d) => d.kind === 'audiooutput').map((d) => ({ id: d.deviceId, label: d.label || 'Speaker' }));
    return { supported: true, inputs, outputs, needsPermission: inputs.length > 0 && !inputs.some((d) => d.label && d.label !== 'Microphone') };
  } catch (e) {
    return { supported: false, inputs: [], outputs: [], needsPermission: false, error: String(e?.message || e) };
  }
}
