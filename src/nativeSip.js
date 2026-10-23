// Native SIP adapter: maps daemon IPC/events to useWebRtc's state contract. Recording is unsupported.
import { audioIssueMessage, formatCallerNumber, holdCrossTabLock } from './utils/plain.js';
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

// Match ring end reasons to the renderer's declined/canceled/missed labels.
const RING_END = {
  rejected: 'declined', busy: 'missed', canceled: 'canceled',
  normal: 'canceled', 'no-answer': 'missed', error: 'canceled',
};

/** Create the bridge-backed engine using the hook's shared state setters and callbacks. */
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
  let registrationPromise = null;

  const tone = createTonePlayer({ get current() { return tones; }, set current(v) { tones = v; } });
  const go = (next) => { if (!disposed) { state = next; setState(next); } };
  let audioIssue = '';
  let registered = false;
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

  // Ring entry shares the browser engine's CRM shape; keep its identity stable through CANCEL.
  const beginRing = async (payload) => {
    if (entry) return { ok: false, reason: 'already-ringing' };
    lock = await holdCrossTabLock(lockKey);
    if (disposed) { releaseLock(); return { ok: false, reason: 'disposed' }; }
    if (!lock.held) {
      // Refuse when another tab owns the audio lock.
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
      invitation: null, simulated: false, native: true, answered: false,
      prospect: null, matched: false, provisional: false,
      callId: payload.callId ?? null,       // CRM row id may replace this after matching
      dialogId: payload.callId ?? null,     // SIP daemon id must remain stable for commands
      engine: 'native',
      attachCrm: (patch) => {
        if (!entry) return;
        Object.assign(entry, patch);
        setIncomingCall({ ...entry });
      },
      answer: () => answer(),
      decline: () => decline(),
      terminate: () => { send('hangup', { callId: entry?.dialogId }).catch(() => {}); },
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
    const ringing = entry;
    if (!ringing) return { ok: false, reason: 'no-incoming' };
    const dialogId = ringing.dialogId;
    const res = await send('answer', { callId: dialogId });
    if (!res?.ok) { setError(res?.error || 'The daemon could not answer that call.'); return res; }
    stopRinger();
    // Either event/reply order must avoid resurrecting a canceled ring or reporting twice.
    if (live && String(live.callId) === String(dialogId)) return res;
    if (entry !== ringing) return { ok: false, reason: 'ring-ended' };
    ringing.answered = true;
    live = { callId: dialogId, direction: 'inbound' };
    entry = null;
    setIncomingCall(null);
    setDirection('inbound');
    go('active');
    cb().onActive?.('inbound');
    return res;
  }

  async function decline() {
    const ringing = entry;
    if (!ringing) return { ok: false, reason: 'no-incoming' };
    let res;
    try { res = await send('reject', { callId: ringing.dialogId, code: 603 }); }
    catch (e) { res = { ok: false, error: e?.message || 'The decline did not reach the daemon.' }; }
    if (res?.ok === false) {
      if (entry === ringing) setError(res.error || 'The daemon could not decline that call.');
      return res;
    }
    if (entry !== ringing) return res; // the caller may have canceled while the command was in flight
    ringing.endReason = 'declined';
    endRing('rejected');
    return res;
  }

  async function hangUp() {
    const callId = live?.callId ?? entry?.dialogId ?? null;
    if (entry && !live) {
      const res = await decline();
      return res?.ok === false ? res : { ok: true };
    }
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
    const res = await send('mute', { enabled: next }).catch((e) => ({ ok: false, error: e?.message }));
    if (res?.ok === false) { setError(res?.error || 'The daemon could not change the mute.'); return mutedNow; }
    mutedNow = next; setMuted(next);
    return next;
  }
  let mutedNow = false;

  async function sendDtmf(digit) {
    const key = String(digit);
    const res = await send('dtmf', { digit: key });
    if (res?.ok === false) return false;
    const pair = DTMF_TONES[key];
    if (pair) tone(pair, 160);
    return true;
  }

  const onEvent = (msg) => {
    if (disposed || !msg || !msg.event) return;
    switch (msg.event) {
      case 'registered':
        registered = true;
        badge(audioIssue ? 'unavailable' : 'ready', audioIssue);
        setError('');
        setMicLabel(msg.audio?.input || session.username || 'Native softphone');
        go(state === 'idle' ? 'standby' : state);
        break;
      case 'registering':
        badge('registering');
        break;
      case 'unregistered':
        registered = false;
        badge('off', 'The daemon unregistered from the carrier.');
        break;
      case 'registration_failed':
        registered = false;
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
        const callId = msg.callId ?? entry?.dialogId ?? live?.callId ?? null;
        const alreadyLive = live && String(live.callId) === String(callId);
        const direction = alreadyLive ? live.direction : entry ? 'inbound' : 'outbound';
        if (!alreadyLive) {
          live = { callId, direction };
          if (entry) entry.answered = true;
          entry = null;
          setIncomingCall(null);
          setDirection(direction);
          go('active');
          cb().onActive?.(direction);
        }
        break;
      }
      case 'mute':
        mutedNow = !!msg.enabled;
        setMuted(mutedNow);
        break;
      case 'audio_level':   // the daemon sends {input, output}; `level` is the browser engine's shape
        setLevel(Math.max(0, Math.min(1, typeof msg.level === 'number' ? msg.level : Math.max(msg.input || 0, msg.output || 0))));
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
      case 'ready':
        audioIssue = audioIssueMessage(msg);
        if (registered) badge(audioIssue ? 'unavailable' : 'ready', audioIssue);
        break; // no sound card still registers
      case 'media_timeout': case 'error':
        if (msg.reason || msg.scope === 'media' || (!live && !entry)) setError(msg.reason || msg.message || 'The native softphone reported an error.');
        break;
      case 'shutdown':
        registered = false;
        badge('unavailable', `The SIP daemon stopped (${msg.reason || 'unknown reason'}).`);
        if (live || entry) { const d = live?.direction || 'inbound'; teardown(); go('error'); cb().onEnded?.(d); }
        break;
      default: break; // 'log', 'state', 'dtmf': useful in the log, nothing to render
    }
  };

  const off = b?.onEvent?.(onEvent);

  /** Register once; the standby effect and a fast outbound dial may race each other. */
  async function start() {
    if (!b) { badge('unavailable', 'This browser has no native SIP bridge.'); return { ok: false }; }
    if (registrationPromise) return registrationPromise;
    registrationPromise = (async () => {
      try {
        // Recover the `ready` probe if React subscribed after the daemon emitted it.
        const status = await b.status?.();
        if (status?.audio) audioIssue = audioIssueMessage({ audio: { name: status.audio }, audioErrors: status.audioErrors });
        badge('registering');
        go('standby');
        const res = await send('register', {
          domain: session.domain, port: session.port, user: session.username,
          callerId: session.callerId, transport: session.transport || 'udp',
        });
        if (res?.ok === false) {
          badge('unavailable', res.error || 'The daemon could not register.');
          registrationPromise = null;
        }
        return res;
      } catch (e) {
        registrationPromise = null;
        throw e;
      }
    })();
    return registrationPromise;
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
