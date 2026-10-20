// The sound of the phone ringing, synthesised in the tab, plus browser audio-unlock helpers.
//
// Zero assets and zero network: a browser that can play a 425 Hz sine can ring, which means
// an incoming call makes a noise even on a machine where the sample pack was never shipped.
// The tone is the Danish standard (425 Hz, 1s on / 4s off), the same cadence the handset on
// the desk uses.
//
// Modern Chromium/WebKit autoplay policies start AudioContext in 'suspended' and block
// <audio>.play() on remote WebRTC tracks unless primed inside a user gesture ('pointerdown'
// or 'keydown'). installGlobalAudioUnlock() + unlockAudio() prime a shared Web Audio context
// and the persistent root <audio> element synchronously within user gesture call stacks.

export const DANISH_RING = { frequency: 425, onMs: 1000, offMs: 4000, volume: 0.18 };
export const DANISH_RINGBACK = { frequency: 425, onMs: 1000, offMs: 4000, volume: 0.06 };

let sharedUnlockCtx = null;

function getAudioContextCtor() {
  if (typeof window === 'undefined') return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

/**
 * Synchronously prime/unlock Web Audio and an optional HTMLAudioElement within a user gesture
 * call stack ('pointerdown' / 'keydown' / Answer click) before any async await boundary.
 *
 * @param {HTMLMediaElement|null} [audioEl]
 * @returns {AudioContext|null}
 */
export function unlockAudio(audioEl = null) {
  let ctx = sharedUnlockCtx;
  try {
    if (!ctx || ctx.state === 'closed') {
      const Ctor = getAudioContextCtor();
      if (Ctor) {
        ctx = new Ctor();
        sharedUnlockCtx = ctx;
      }
    }
    if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      ctx.resume()?.catch?.(() => {});
    }
    // Play a zero-length silent buffer when supported so WebKit/Safari marks Web Audio unlocked.
    if (ctx && typeof ctx.createBuffer === 'function' && typeof ctx.createBufferSource === 'function') {
      const silent = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = silent;
      src.connect(ctx.destination);
      src.start(0);
    }
  } catch { /* non-browser or restricted environment */ }

  try {
    if (audioEl) {
      audioEl.muted = false;
      if (audioEl.srcObject && audioEl.paused && typeof audioEl.play === 'function') {
        audioEl.play()?.catch?.(() => {});
      }
    }
  } catch { /* element playback may not be ready yet */ }

  return ctx;
}

/**
 * Attach passive global user-gesture listeners ('pointerdown' & 'keydown') on window so audio
 * output is unlocked before the first inbound SIP INVITE ever arrives.
 *
 * @param {() => HTMLMediaElement|null} [getAudioEl]
 * @returns {() => void} cleanup function
 */
export function installGlobalAudioUnlock(getAudioEl = () => null) {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {};
  }
  const onGesture = () => {
    unlockAudio(typeof getAudioEl === 'function' ? getAudioEl() : null);
  };
  window.addEventListener('pointerdown', onGesture, { capture: true, passive: true });
  window.addEventListener('keydown', onGesture, { capture: true });
  return () => {
    window.removeEventListener('pointerdown', onGesture, { capture: true });
    window.removeEventListener('keydown', onGesture, { capture: true });
  };
}

/**
 * @param {object} [overrides]
 * @param {Function|null} [overrides.audioContext] AudioContext constructor or instance (injected in tests)
 * @returns {{ start: () => boolean, stop: () => void, ringing: () => boolean }}
 */
export function createRinger(overrides = {}) {
  const cfg = { ...DANISH_RING, ...overrides };
  let ctx = null;
  let osc = null;
  let gain = null;
  let timer = null;
  let live = false;

  function stop() {
    live = false;
    if (timer !== null) { clearTimeout(timer); timer = null; }

    // Detach first, then tear down: a pulse that fires between the two would touch freed nodes.
    const c = ctx; const g = gain; const o = osc;
    ctx = null; gain = null; osc = null;

    try {
      if (g && c) {
        if (typeof g.gain.cancelScheduledValues === 'function') g.gain.cancelScheduledValues(c.currentTime);
        g.gain.setValueAtTime(0, c.currentTime);   // silence is scheduled before anything is unplugged
        g.disconnect();
      }
    } catch { /* the graph may already be gone */ }
    try { if (o) { o.stop(); o.disconnect(); } } catch { /* already stopped */ }
    try { if (c && c.state !== 'closed') c.close(); } catch { /* already closed */ }
  }

  function pulse() {
    if (!live || !ctx || !gain) return;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const now = ctx.currentTime;
    try {
      if (typeof gain.gain.cancelScheduledValues === 'function') gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(cfg.volume, now);
      gain.gain.setValueAtTime(0, now + cfg.onMs / 1000);
    } catch { stop(); return; }
    timer = setTimeout(pulse, cfg.onMs + cfg.offMs);
  }

  function start() {
    stop();   // ringing twice is a restart, never two tones on top of each other
    const CtorOrInstance = cfg.audioContext !== undefined
      ? cfg.audioContext
      : getAudioContextCtor();
    if (!CtorOrInstance) return false;
    try {
      ctx = typeof CtorOrInstance === 'function' ? new CtorOrInstance() : CtorOrInstance;
      const wasSuspended = ctx.state === 'suspended';

      gain = ctx.createGain();
      gain.gain.setValueAtTime(0, ctx.currentTime);   // silent until the first pulse
      gain.connect(ctx.destination);

      osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(cfg.frequency, ctx.currentTime);
      osc.connect(gain);
      osc.start();

      live = true;
      pulse();

      if (wasSuspended && typeof ctx.resume === 'function') {
        const activeCtx = ctx;
        try {
          const resumed = activeCtx.resume();
          if (resumed && typeof resumed.then === 'function') {
            resumed.then(() => {
              // Re-anchor the audible pulse immediately once the hardware audio clock unfreezes.
              if (live && ctx === activeCtx) pulse();
            }).catch(() => {});
          }
        } catch { /* autoplay policy until user interacts */ }
      }
      return true;
    } catch {
      stop();
      return false;
    }
  }

  return { start, stop, ringing: () => live };
}

/**
 * Danish outbound ringback synthesiser (425 Hz, 1s on / 4s off, quiet 0.06 volume) played
 * locally when a live SIP INVITE receives `180 Ringing` without early-media SDP, and stopped
 * immediately upon `183 Session Progress` (with SDP) or `200 OK`.
 */
export function createRingback(overrides = {}) {
  return createRinger({ ...DANISH_RINGBACK, ...overrides });
}
