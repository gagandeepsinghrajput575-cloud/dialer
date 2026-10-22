// The native SIP engine: the desktop daemon's phone, rendered.
//
// `useWebRtc.js` owns the browser engine (sip.js, getUserMedia, a peer connection). This module
// owns the other one — the headless daemon under `desktop/daemon`, which speaks plain UDP SIP to
// the carrier and opens CoreAudio itself. It exists for the trunks that have no WebRTC gateway
// (FlyNumber is one), where a browser tab simply cannot register.
//
// The two engines report the *same* contract, on purpose: Dialer.jsx and softphone.jsx never
// learn which one is driving. That is what makes "no screen switching" true — the agent presses
// the same C, sees the same waveform, gets the same classification modal.
//
// What is genuinely different:
//   * no microphone here. The daemon owns the audio device, so `level` comes from its
//     `audio_level` events and `micLabel` from its device description;
//   * no call recording. MediaRecorder can only capture a MediaStream, and there is none —
//     `recording` reports that honestly instead of silently producing nothing;
//   * registration lives in a process that outlives the tab, so a reload keeps the phone
//     registered and an inbound call still rings.
import { formatCallerNumber, holdCrossTabLock } from './utils.js';
import { createRinger } from './utils/ringer.js';
import { createTonePlayer, DTMF_TONES, BUSY_TONE, RINGBACK_TONE } from './utils/tones.js';

/** The bridge `desktop/preload.js` exposes. Absent in a plain browser tab. */
const bridge = () => (typeof window !== 'undefined' ? window.pulseNativeSip || null : null);

/** Is this a desktop app with a native SIP daemon behind it? */
export function nativeAvailable() {
  const b = bridge();
  return !!b && typeof b.command === 'function' && typeof b.onEvent === 'function';
}

/** Is this descriptor the native engine's? (The browser one has no `transport`.) */
export const isNativeSession = (session) => !!session
  && (session.engine === 'native' || session.transport === 'udp' || session.wsUrlSource === 'native_daemon');

// One renderer reason per way a call can stop, matching what softphone.jsx already understands:
// 'declined' and 'canceled' have distinct toasts, everything else is a plain miss.
const RING_END = {
  rejected: 'declined', busy: 'missed', canceled: 'canceled',
  normal: 'canceled', 'no-answer': 'missed', error: 'canceled',
};

/**
 * Start the native engine.
 *
 * @param {object}   opts
 * @param {object}   opts.session    - the descriptor from GET /api/telephony/webrtc-session
 * @param {function} opts.setState   - the engine state machine ('standby' | 'dialing' | …)
 * @param {function} opts.setStandby - the registration badge ({ state, reason })
 * @param {function} opts.setLevel   - 0..1 voice level for the waveform
 * @param {function} opts.setMuted
 * @param {function} opts.setError
 * @param {function} opts.setTarget
 * @param {function} opts.setDirection - 'outbound' | 'inbound' while a call is live
 * @param {function} opts.setIncomingCall - the ringing entry, or null
 * @param {function} opts.setStandbyNote
 * @param {function} opts.setMicLabel
 * @param {object}   opts.callbacksRef - { current: { onActive, onEnded, onIncoming, onIncomingEnded } }
 * @param {string}   [opts.countryCode]
 * @param {string}   [opts.lockKey]    - the cross-tab audio lock the browser engine also takes
 */
export function createNativeEngine(opts) {
  const b = bridge();
  const {
    session, setState, setStandby, setLevel, setMuted, setError, setTarget, setDirection,
    setIncomingCall, setStandbyNote, setMicLabel, callbacksRef, countryCode = '',
    lockKey = 'pulse-inbound-audio',
  } = opts;

  const cb = () => callbacksRef.current || {};
  let state = 'idle';
  let disposed = false;
  let live = null;                 // the connected call: { callId, direction }
  let entry = null;                // the ringing call, same shape the browser engine builds
  let lock = null;
  let tones = [];
  let ringer = null;

  const tone = createTonePlayer({ get current() { return tones; }, set current(v) { tones = v; } });
  const go = (next) => { if (!disposed) { state = next; setState(next); } };
  const badge = (s, reason = '') => { if (!disposed) setStandby({ state: s, reason }); };
  const stopRinger = () => { try { ringer?.stop(); } catch { /* silence is never an error */ } };
  const stopTones = () => { for (const t of [...tones]) { try { t.stop(); } catch { /* gone */ } } tones = []; };
  const releaseLock = () => { const l = lock; lock = null; try { l?.release?.(); } catch { /* gone */ } };

  /** Everything a call owns, released exactly once, in the order that clears the mic light. */
  const teardown = () => {
    stopRinger();
    stopTones();
    releaseLock();
    live = null;
    entry = null;
    setIncomingCall(null);
    setDirection(null);
    setLevel(0);
    setTarget('');
  };

  // ---- the ringing entry -------------------------------------------------------------------
  // Same object shape the browser engine hands to softphone.jsx, so the CRM half (prospect
  // lookup, ledger row, `attachCrm`) works unchanged — and mutates in place for the same reason:
  // a far-end CANCEL has to find *this* ring still ringing.
  const beginRing = async (payload) => {
    if (entry) return { ok: false, reason: 'already-ringing' };
    lock = await holdCrossTabLock(lockKey);
    if (disposed) { releaseLock(); return { ok: false, reason: 'disposed' }; }
    if (!lock.held) {
      // Another tab (or another window of the desktop app) has the speakers: refuse politely so
      // the carrier stops ringing instead of two phones fighting over one call.
      setStandbyNote('Call in progress on another tab');
      send('reject', { callId: payload.callId, code: 486 }).catch(() => {});
      return { ok: false, reason: 'another-tab' };
    }
    setStandbyNote('');
    const raw = String(payload.callerPhone || payload.caller || '').trim();
    entry = {
      callerNumber: formatCallerNumber(raw, countryCode) || raw || 'Unknown',
      rawNumber: raw,
      startedAt: new Date().toISOString(),
      invitation: null,
      simulated: false,
      native: true,
      answered: false,
      prospect: null,
      matched: false,
      provisional: false,
      callId: payload.callId ?? null,
      engine: 'native',
      attachCrm: (patch) => {
        if (!entry) return;
        Object.assign(entry, patch);
        setIncomingCall({ ...entry });
      },
      answer: () => answer(),
      decline: () => decline(),
      terminate: () => { send('hangup', { callId: entry?.callId }).catch(() => {}); },
      endReason: null,
    };
    setIncomingCall(entry);
    go('incoming');
    setError('');
    try { ringer = ringer || createRinger(); ringer.start(); } catch { /* no Web Audio: still rings visually */ }
    cb().onIncoming?.(entry);
    return { ok: true, entry };
  };

  /** The ring stopped and nobody answered. Reports once, then goes back to standby. */
  const endRing = (reason = 'canceled') => {
    const ended = entry;
    if (!ended) return;
    teardown();
    go(disp() ? 'standby' : 'idle');
    cb().onIncomingEnded?.({ ...ended, reason: RING_END[reason] || reason });
  };

  const disp = () => disposed;

  // ---- commands ----------------------------------------------------------------------------
  const send = (action, payload = {}) => (b ? b.command(action, payload) : Promise.resolve({ ok: false, error: 'no bridge' }));

  async function answer() {
    if (!entry) return { ok: false, reason: 'no-incoming' };
    const callId = entry.callId;
    const res = await send('answer', { callId });
    if (!res?.ok) { setError(res?.error || 'The daemon could not answer that call.'); return res; }
    stopRinger();
    entry.answered = true;
    live = { callId, direction: 'inbound' };
    setDirection('inbound');
    go('active');
    cb().onActive?.('inbound');
    return res;
  }

  async function decline() {
    if (!entry) return { ok: false, reason: 'no-incoming' };
    const res = await send('reject', { callId: entry.callId, code: 603 });
    entry.endReason = 'declined';
    endRing('rejected');
    return res;
  }

  async function hangUp() {
    const callId = live?.callId ?? entry?.callId ?? null;
    if (entry && !live) { await decline(); return { ok: true }; }
    if (!callId) { teardown(); go(disp() ? 'standby' : 'idle'); return { ok: false, reason: 'no-call' }; }
    const res = await send('hangup', { callId });
    return res;
  }

  async function dial(number, { callId = null } = {}) {
    const target = String(number || '').trim();
    if (!target) return { ok: false, reason: 'no-number' };
    setTarget(target);
    setError('');
    go('dialing');
    const res = await send('dial', { number: target, callId });
    if (!res?.ok) {
      setError(res?.error || 'The daemon refused that dial.');
      go('error');
      return res;
    }
    return res;
  }

  async function toggleMute() {
    const next = !mutedNow;
    const res = await send('mute', { enabled: next });
    if (res?.ok !== false) { mutedNow = next; setMuted(next); }
    return next;
  }
  let mutedNow = false;

  async function sendDtmf(digit) {
    const key = String(digit);
    const res = await send('dtmf', { digit: key });
    // The daemon puts the digit on the wire as RFC 2833; the tone is for the agent's ears only.
    const pair = DTMF_TONES[key];
    if (pair) tone(pair, 160);
    return res?.ok !== false;
  }

  // ---- events from the daemon --------------------------------------------------------------
  const onEvent = (msg) => {
    if (disposed || !msg || !msg.event) return;
    switch (msg.event) {
      case 'registered':
        badge('ready');
        setError('');
        setMicLabel(msg.audio?.input || session.username || 'Native softphone');
        go(state === 'idle' ? 'standby' : state);
        break;
      case 'registering':
        badge('registering');
        break;
      case 'unregistered':
        badge('off', 'The daemon unregistered from the carrier.');
        break;
      case 'registration_failed':
        badge('unavailable', msg.reason || 'The carrier refused the SIP account.');
        break;
      case 'account':
        if (msg.account) setMicLabel(`${msg.carrier || 'Native'} · ${msg.account}`);
        break;
      case 'incoming':
        beginRing(msg);
        break;
      case 'ringing':
        if (live?.direction === 'outbound') tone(RINGBACK_TONE, 1600);
        if (state === 'dialing') go('ringing');
        break;
      case 'dialing':
        if (!live) go('dialing');
        break;
      case 'provisional':
        if (state === 'dialing') go('ringing');
        break;
      case 'connected': {
        stopRinger();
        stopTones();
        const direction = entry ? 'inbound' : 'outbound';
        live = { callId: msg.callId ?? entry?.callId ?? null, direction };
        if (entry) entry.answered = true;
        entry = null;
        setIncomingCall(null);
        setDirection(direction);
        go('active');
        cb().onActive?.(direction);
        break;
      }
      case 'mute':
        mutedNow = !!msg.enabled;
        setMuted(mutedNow);
        break;
      case 'audio_level':
        if (typeof msg.level === 'number') setLevel(Math.max(0, Math.min(1, msg.level)));
        break;
      case 'ended': {
        const direction = live?.direction || (entry ? 'inbound' : 'outbound');
        const wasLive = !!live;
        const reason = msg.reason || 'normal';
        if (entry && !wasLive) { entry.endReason = reason; endRing(reason); }
        else {
          teardown();
          go('ended');
          cb().onEnded?.(direction);
          setTimeout(() => { if (!disposed && state === 'ended') go('standby'); }, 400);
        }
        if (reason === 'busy' && !wasLive) tone(BUSY_TONE, 900);
        if (msg.detail && !wasLive) setError('');
        break;
      }
      case 'rejected_incoming':
        endRing(msg.reason || 'rejected');
        break;
      case 'error':
        if (!live && !entry) setError(msg.message || 'The native softphone reported an error.');
        break;
      case 'shutdown':
        badge('unavailable', `The SIP daemon stopped (${msg.reason || 'unknown reason'}).`);
        if (live || entry) { const d = live?.direction || 'inbound'; teardown(); go('error'); cb().onEnded?.(d); }
        break;
      default:
        break; // 'ready', 'log', 'state', 'dtmf': useful in the log, nothing to render
    }
  };

  const off = b?.onEvent?.(onEvent);

  /** Register (or re-register) and report the badge. Called whenever the tab becomes the phone. */
  async function start() {
    if (!b) { badge('unavailable', 'This browser has no native SIP bridge.'); return { ok: false }; }
    badge('registering');
    go('standby');
    const res = await send('register', {
      domain: session.domain, port: session.port, user: session.username,
      callerId: session.callerId, transport: session.transport || 'udp',
    });
    if (res?.ok === false) badge('unavailable', res.error || 'The daemon could not register.');
    return res;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try { off?.(); } catch { /* already detached */ }
    teardown();
    setLevel(0);
  }

  return {
    start, dispose, dial, answer, decline, hangUp, toggleMute, sendDtmf,
    send, onEvent,
    get state() { return state; },
    get live() { return live; },
    get incoming() { return entry; },
    // No MediaStream means no MediaRecorder: said out loud rather than discovered later.
    recording: { supported: false, reason: 'Call audio lives in the native daemon, so the browser cannot record it.' },
    descriptor: { engine: 'native', carrier: session.provider, domain: session.domain, port: session.port },
  };
}

/** The line the standby badge shows while the desktop daemon holds the phone. */
export function nativeStandbyLabel(session) {
  if (!session) return 'Native softphone';
  const where = session.domain ? ` · ${session.domain}` : '';
  return `Native softphone (${session.carrierName || session.provider || 'SIP'}${where})`;
}
