// The sound of the phone ringing, synthesised in the tab.
//
// Zero assets and zero network: a browser that can play a 425 Hz sine can ring, which means
// an incoming call makes a noise even on a machine where the sample pack was never shipped.
// The tone is the Danish standard (425 Hz, 1s on / 4s off), the same cadence the handset on
// the desk uses.
//
// The hard part is not the tone, it is the lifecycle. A ringer that is not torn down on
// *every* way out of 'incoming' — answered, declined, cancelled by the far end, the tab
// closing, the mode being switched — leaves an agent listening to a phone that will not stop
// ringing after they picked it up. So: stop() is idempotent, start() always stops first, and
// the nodes are clamped, stopped, disconnected and closed in that order.

export const DANISH_RING = { frequency: 425, onMs: 1000, offMs: 4000, volume: 0.18 };

/**
 * @param {object} [overrides]
 * @param {Function|null} [overrides.audioContext] AudioContext constructor (injected in tests)
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
    const now = ctx.currentTime;
    try {
      gain.gain.setValueAtTime(cfg.volume, now);
      gain.gain.setValueAtTime(0, now + cfg.onMs / 1000);
    } catch { stop(); return; }
    timer = setTimeout(pulse, cfg.onMs + cfg.offMs);
  }

  function start() {
    stop();   // ringing twice is a restart, never two tones on top of each other
    const Ctor = cfg.audioContext !== undefined
      ? cfg.audioContext
      : (typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext || null) : null);
    if (!Ctor) return false;
    try {
      ctx = new Ctor();
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        try { ctx.resume()?.catch?.(() => {}); } catch { /* autoplay policy, not our problem */ }
      }
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
      return true;
    } catch {
      stop();
      return false;
    }
  }

  return { start, stop, ringing: () => live };
}
