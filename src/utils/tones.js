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
 * Build the local tone player.
 *
 * @param {{current: Array}} sink - a ref-like object holding the live tones, so the caller can
 *   stop every one of them at once on hang-up (`releaseMedia`). Each entry gets a `stop()`.
 * @returns {(freqs: number[], ms: number) => void}
 */
export function createTonePlayer(sink) {
  return (freqs, ms) => {
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
      sink.current.push(entry);
      setTimeout(() => {
        try { entry.stop(); } catch {}
        sink.current = sink.current.filter((e) => e !== entry);
      }, ms);
    } catch {
      // Ensure partial context is closed on failure
      try { for (const o of oscs) try { o.stop(); } catch {} } catch {}
      try { if (ctx && ctx.state !== 'closed') ctx.close(); } catch {}
    }
  };
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
