// In-browser WebRTC softphone engine.
//
// This module owns everything that happens between "the agent pressed C" and "there is audio
// in their headphones": the microphone, the peer connection, the audio sink, mute, touch-tones
// and the session state machine. Dialer.jsx only renders what this reports.
//
// Three hard constraints shaped the design:
//
//   1. **The agent's call time is the only honest timer.** The previous behaviour put the
//      dialer into an 'active' call the instant the server answered, so a session that never
//      connected still logged a classified conversation. Here 'active' is reached only when
//      audio actually flows (or, in test mode, when the simulation says so), and a failed
//      start reports 'error' so the caller can throw the phantom dial away.
//
//   2. **Media APIs are absent in more places than you expect** — jsdom, headless browsers,
//      an insecure origin (getUserMedia is HTTPS/localhost only), a denied permission. None
//      of those may throw an unhandled exception; each degrades into a readable error state.
//
//   3. **A call can arrive, not just leave.** While the tab is open in WebRTC mode the engine
//      sits in 'standby' on one persistent registration, so the number rings in the browser.
//      The ring is synthesised (no assets, nothing to fetch), it is owned by exactly one tab
//      (navigator.locks — two tabs must never fight over the speakers), and it is torn down on
//      every single way out of 'incoming': answered, declined, cancelled by the caller, the
//      mode switched, the tab closed.
//
// The state machine, in full:
//
//   idle ──▶ standby ──▶ incoming ──▶ active ──▶ ended ──▶ standby
//                 │           └──▶ (declined / missed) ──▶ standby
//                 └──▶ registering ──▶ dialing ──▶ ringing ──▶ active   (outbound)
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { formatCallerNumber, holdCrossTabLock } from './utils.js';
import { createRinger } from './utils/ringer.js';

export const WEBRTC_STATES = ['idle', 'standby', 'registering', 'dialing', 'ringing', 'incoming', 'active', 'ended', 'error'];

// The lock every tab competes for before it makes a sound. Named here, next to the engine that
// takes it, so the dial lock and the audio lock cannot drift apart.
export const INBOUND_AUDIO_LOCK = 'pulse-inbound-audio';

// The tones a keypad produces. Frequencies are the standard DTMF pairs.
export const DTMF_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
const DTMF_TONES = {
  1: [697, 1209], 2: [697, 1336], 3: [697, 1477],
  4: [770, 1209], 5: [770, 1336], 6: [770, 1477],
  7: [852, 1209], 8: [852, 1336], 9: [852, 1477],
  '*': [941, 1209], 0: [941, 1336], '#': [941, 1477],
};

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
 * @param {object}  opts
 * @param {boolean} opts.enabled    - true only when telephony_mode === 'webrtc'
 * @param {boolean} [opts.dryRun]   - test mode: simulate, never touch the network
 * @param {string}  [opts.countryCode] - default country code, for caller-ID display/matching
 * @param {string}  [opts.micDevice]   - preferred input device id
 * @param {function} opts.onActive     - called once when audio is genuinely flowing
 * @param {function} opts.onEnded      - called once when the session is finished
 * @param {function} [opts.onIncoming] - called when the phone rings in the tab
 * @param {function} [opts.onIncomingEnded] - called when a ring ends unanswered
 */
export default function useWebRtc({
  enabled = false, dryRun = false, countryCode = '', micDevice = '',
  onActive, onEnded, onIncoming, onIncomingEnded, onRecordingReady,
} = {}) {
  const [state, setState] = useState('idle');
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);        // 0..1, drives the waveform
  const [error, setError] = useState('');
  const [target, setTarget] = useState('');     // the number being called
  const [dtmfLog, setDtmfLog] = useState([]);   // tones sent, newest last
  const [micLabel, setMicLabel] = useState('');
  const [incomingCall, setIncomingCall] = useState(null);   // { callerNumber, prospect, invitation, answer, decline, ... }
  const [standby, setStandby] = useState({ state: 'off', reason: '' });
  const [direction, setDirection] = useState(null);         // 'outbound' | 'inbound' while a call is live
  const [standbyNote, setStandbyNote] = useState('');       // cross-tab message: "call in progress elsewhere"

  // Everything that must be released on hang-up lives in refs: React state is asynchronous,
  // and a hang-up has to stop audio *now*, not on the next render.
  const streamRef = useRef(null);
  const pcRef = useRef(null);
  const audioRef = useRef(null);
  const ctxRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(0);
  const simRef = useRef(0);
  const tonesRef = useRef([]);
  const recorderRef = useRef(null);
  const recordingCallIdRef = useRef(null);
  const callbacksRef = useRef({ onActive, onEnded, onIncoming, onIncomingEnded, onRecordingReady });
  const stateRef = useRef('idle');
  const mutedRef = useRef(false);
  const enabledRef = useRef(enabled);
  const ringerRef = useRef(null);
  const incomingRef = useRef(null);      // the ringing call, readable synchronously (key handlers)
  const inboundActiveRef = useRef(false);
  const answeredInboundRef = useRef(null);   // the live inbound session, for hang-up/teardown
  const lockRef = useRef(null);          // the held cross-tab audio lock, released on call end
  const sipRef = useRef(null);           // the outbound session handle, so hang-up sends BYE
  const unmountedRef = useRef(false);
  // The INVITE payload needs answer/decline before those callbacks exist in source order, and
  // an object handed to React must keep working across renders.
  const answerInboundRef = useRef(null);
  const declineInboundRef = useRef(null);
  const glareMutexRef = useRef(false); // glare window: outbound invite in-flight vs inbound INVITE

  callbacksRef.current = { onActive, onEnded, onIncoming, onIncomingEnded, onRecordingReady };
  enabledRef.current = enabled;

  const setStateSafe = useCallback((next) => {
    stateRef.current = next;
    setState(next);
  }, []);

  // The ringer is created once and reused; every path that ends a call goes through stop().
  if (!ringerRef.current && typeof window !== 'undefined') ringerRef.current = createRinger();

  const stopRinger = useCallback(() => {
    try { ringerRef.current?.stop(); } catch { /* a silent ringer is not an error */ }
  }, []);

  const releaseInboundLock = useCallback(() => {
    const lock = lockRef.current;
    lockRef.current = null;
    if (lock) lock.release?.().catch?.(() => {});
  }, []);

  const startRecording = useCallback((callId) => {
    if (dryRun || typeof window === 'undefined' || typeof window.MediaRecorder !== 'function') return;
    const Ctx = audioContextCtor();
    if (!Ctx) return;
    try {
      const ctx = new Ctx();
      const dest = ctx.createMediaStreamDestination();
      if (streamRef.current && streamRef.current.getAudioTracks().length) {
        try {
          const micSource = ctx.createMediaStreamSource(streamRef.current);
          micSource.connect(dest);
        } catch { /* ignore */ }
      }
      const remoteStream = audioRef.current?.srcObject;
      if (remoteStream && remoteStream.getAudioTracks().length) {
        try {
          const remoteSource = ctx.createMediaStreamSource(remoteStream);
          remoteSource.connect(dest);
        } catch { /* ignore */ }
      }
      const mime = typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg');
      const recorder = new MediaRecorder(dest.stream, { mimeType: mime });
      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      const startedAt = Date.now();
      recorder.start(1000);
      recordingCallIdRef.current = callId || null;
      recorderRef.current = {
        recorder,
        ctx,
        chunks,
        mimeType: mime,
        startedAt,
        callId,
        stop: () => {
          try {
            if (recorder.state !== 'inactive') recorder.stop();
          } catch { /* already stopped */ }
        },
      };
    } catch {
      recorderRef.current = null;
    }
  }, [dryRun]);

  const stopRecording = useCallback(() => {
    const session = recorderRef.current;
    if (!session) return;
    recorderRef.current = null;
    try {
      session.recorder.onstop = () => {
        try {
          const durationSec = Math.max(0, Math.round((Date.now() - session.startedAt) / 1000));
          const blob = new Blob(session.chunks, { type: session.mimeType });
          if (blob.size > 0) {
            callbacksRef.current.onRecordingReady?.({ blob, durationSec, callId: session.callId || recordingCallIdRef.current });
          }
        } catch { /* ignore assembly errors */ }
        try { session.ctx.close(); } catch { /* ignore */ }
      };
      session.stop();
    } catch {
      try { session.ctx.close(); } catch { /* ignore */ }
    }
  }, []);

  // ---- teardown. Idempotent, and never throws. ----
  const releaseMedia = useCallback(() => {
    stopRecording();
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    if (simRef.current) { clearInterval(simRef.current); simRef.current = 0; }

    // The ringer is audio too: answering, hanging up, switching modes or unmounting mid-ring
    // must all silence it, and 'stop' is the only thing allowed to touch those nodes.
    stopRinger();
    releaseInboundLock();

    // 1) Detach senders before closing PC — releases OS mic indicator immediately.
    //    Closing a PC that still references tracks leaves orange dot on macOS for 0.5–30s.
    try {
      const pc = pcRef.current;
      if (pc) {
        pc.ontrack = null;
        pc.oniceconnectionstatechange = null;
        try {
          for (const sender of (pc.getSenders?.() || [])) {
            try {
              if (sender.track) {
                try { sender.replaceTrack(null); } catch {}
                try { pc.removeTrack(sender); } catch {}
              }
            } catch {}
          }
        } catch {}
        pc.close();
      }
    } catch { /* already closed */ }
    pcRef.current = null;

    // 2) Now stop tracks — PC no longer references them
    try {
      if (streamRef.current) for (const t of streamRef.current.getTracks()) {
        try { t.enabled = false; } catch {}
        try { t.stop(); } catch {}
      }
    } catch { /* nothing to stop */ }
    streamRef.current = null;

    try { if (audioRef.current) audioRef.current.srcObject = null; } catch { /* ignore */ }
    try { if (ctxRef.current && ctxRef.current.state !== 'closed') ctxRef.current.close(); } catch { /* ignore */ }
    ctxRef.current = null;
    analyserRef.current = null;
    for (const entry of tonesRef.current) {
      try {
        if (entry?.osc) { try { entry.osc.stop(); entry.osc.disconnect(); } catch {} }
        else if (entry?.oscs) { for (const o of entry.oscs) try { o.stop(); o.disconnect(); } catch {} }
        if (entry?.gain) try { entry.gain.disconnect(); } catch {}
        if (entry?.ctx && entry.ctx.state !== 'closed') try { entry.ctx.close(); } catch {}
        else if (entry?.stop) try { entry.stop(); } catch {}
      } catch {}
    }
    tonesRef.current = [];
    setLevel(0);
    setMuted(false);
    mutedRef.current = false;
  }, [releaseInboundLock, stopRecording, stopRinger]);

  // Release the microphone if the component unmounts mid-call.
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      releaseMedia();
      // The tab is going away: leaving the registration open would have the provider ringing
      // a browser that is no longer there.
      import('./webrtcSignalling.js').then((m) => m.disposeStandbySession()).catch(() => {});
    };
  }, [releaseMedia]);

  // ---- live microphone level, so the waveform shows the real room ----
  const startLevelMeter = useCallback((node) => {
    const Ctx = audioContextCtor();
    if (!Ctx) return;
    try {
      const ctx = new Ctx();
      ctxRef.current = ctx;
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(node);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      analyserRef.current = analyser;
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
        setLevel(peak);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      // An AudioContext failure must not stop the call — the meter is cosmetic.
      analyserRef.current = null;
    }
  }, []);

  // Test-mode level: a believable random walk so the waveform moves like a voice.
  const startSimulatedLevel = useCallback(() => {
    let v = 0.25;
    simRef.current = setInterval(() => {
      v = Math.max(0.06, Math.min(0.85, v + (Math.random() - 0.45) * 0.22));
      setLevel(v);
    }, 110);
  }, []);

  // Ringback / DTMF tones. Purely local: nothing is transmitted anywhere.
  // Hardened: track AudioContext alongside oscillators so releaseMedia can close it (G-5).
  const playTone = useCallback((freqs, ms) => {
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
      tonesRef.current.push(entry);
      setTimeout(() => {
        try { entry.stop(); } catch {}
        tonesRef.current = tonesRef.current.filter((e) => e !== entry);
      }, ms);
    } catch {
      // Ensure partial context is closed on failure
      try { for (const o of oscs) try { o.stop(); } catch {} } catch {}
      try { if (ctx && ctx.state !== 'closed') ctx.close(); } catch {}
    }
  }, []);

  // ---- opening the microphone. One implementation for both directions. ----
  const openMicrophone = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: micDevice ? { deviceId: { ideal: micDevice } } : true,
    });
    streamRef.current = stream;
    try { setMicLabel(stream.getAudioTracks()[0]?.label || ''); } catch { /* label is optional */ }
    startLevelMeter(stream);
    return stream;
  }, [micDevice, startLevelMeter]);

  // ---- inbound ---------------------------------------------------------------------------
  const finishActiveCall = useCallback((dir) => {
    // Declared before hangUp uses it: closes the media and reports the end exactly once.
    if (dir === 'inbound') { inboundActiveRef.current = false; answeredInboundRef.current = null; }
    try { sipRef.current?.stop?.(); } catch { /* already gone */ }
    sipRef.current = null;
    releaseMedia();
    setStateSafe('ended');
    setDirection(null);
    callbacksRef.current.onEnded?.(dir);
    setTimeout(() => {
      if (stateRef.current === 'ended') setStateSafe(enabledRef.current ? 'standby' : 'idle');
    }, 400);
  }, [releaseMedia, setStateSafe]);


  // The ring ended before anybody picked up: the caller hung up (SIP CANCEL), the agent said
  // no, or another tab owns the call. The ringer stops first — always first.
  const endIncoming = useCallback((reason = 'canceled') => {
    const entry = incomingRef.current;
    if (!entry) return;
    stopRinger();
    incomingRef.current = null;
    setIncomingCall(null);
    releaseInboundLock();
    setDirection(null);
    setStateSafe(enabledRef.current ? 'standby' : 'idle');
    callbacksRef.current.onIncomingEnded?.({ ...entry, reason });
  }, [releaseInboundLock, setStateSafe, stopRinger]);

  const handleIncoming = useCallback(async ({ invitation, callerNumber, accept, reject, terminate, onStateChange, simulated = false }) => {
    // A second INVITE while the first is still ringing is the provider retrying, not a second
    // caller. Answering two sessions would put two people in the agent's ears.
    if (incomingRef.current) {
      try { reject?.({ statusCode: 486 }); } catch { /* already gone */ }
      return { ok: false, reason: 'already-ringing' };
    }
    // Glare window: outbound dial just started (invite in-flight). Defer inbound politely.
    if (glareMutexRef.current) {
      try { reject?.({ statusCode: 486 }); } catch { /* already gone */ }
      return { ok: false, reason: 'glare-outbound-pending' };
    }

    // One ringer per machine. The tab that holds the audio lock takes the call; the others
    // step aside and say so, instead of both of them competing for the speakers.
    const lock = await holdCrossTabLock(INBOUND_AUDIO_LOCK);
    if (unmountedRef.current) { await lock.release(); return { ok: false, reason: 'unmounted' }; }
    if (!lock.held) {
      setStandbyNote('Call in progress on another tab');
      try { reject?.({ statusCode: 486 }); } catch { /* already gone */ }
      return { ok: false, reason: 'another-tab' };
    }
    lockRef.current = lock;
    setStandbyNote('');

    const shown = formatCallerNumber(callerNumber, countryCode) || String(callerNumber || '').trim();
    const entry = {
      callerNumber: shown || 'Unknown',
      rawNumber: String(callerNumber || '').trim(),
      startedAt: new Date().toISOString(),
      invitation: invitation || null,
      simulated,
      answered: false,
      prospect: null,
      matched: false,
      provisional: false,
      callId: null,
      // The CRM half (prospect, call id) is filled in by the softphone provider as soon as the
      // server answers; the media half lives here from the first ring.
      //
      // It mutates in place on purpose. The SIP state-change handler closes over this exact
      // object to tell "my ring ended" from "some other ring ended"; replacing the object with
      // a copy would break that comparison, and a far-end CANCEL would leave the phone ringing
      // forever. React gets a fresh object for its own equality check.
      attachCrm: (patch) => {
        const current = incomingRef.current;
        if (!current) return;
        Object.assign(current, patch);
        setIncomingCall({ ...current });
      },
      answer: () => answerInboundRef.current?.(),
      decline: () => declineInboundRef.current?.(),
      terminate: () => { try { terminate?.(); } catch { /* already gone */ } },
    };
    entry.onStateChange = onStateChange;
    entry.accept = accept;
    entry.reject = reject;
    // Declining emits the local 'terminated' transition before the caller ever hears the 603.
    // Without this, the teardown would report 'canceled' and the agent would be told the
    // caller gave up when in fact they hung up on the caller.
    entry.endReason = null;

    incomingRef.current = entry;
    setIncomingCall(entry);
    setDirection(null);
    setStateSafe('incoming');
    setError('');
    // Ring immediately — before any network round trip, because the agent has four seconds to
    // decide and the CRM lookup must never be the thing that delays the sound.
    try { ringerRef.current?.start(); } catch { /* a browser with no Web Audio still gets the call */ }

    // The far end hanging up before Answer is a normal outcome, not an error: CANCEL / 487.
    try {
      onStateChange?.((s) => {
        if (s === 'terminated') {
          if (incomingRef.current === entry) endIncoming(entry.endReason || 'canceled');
          else if (inboundActiveRef.current) { stopRinger(); finishActiveCall('inbound'); }
        } else if (s === 'established' && !entry.answered) {
          entry.answered = true;
          inboundActiveRef.current = true;
        }
      });
    } catch { /* no state machine: accept/reject below still drive the call */ }

    callbacksRef.current.onIncoming?.(entry);
    return { ok: true, entry };
  }, [countryCode, endIncoming, setStateSafe, stopRinger]);

  // Answering for real: the microphone must be live *before* the session is accepted, or the
  // first seconds of the call are one-way silence.
  const answerInbound = useCallback(async () => {
    const entry = incomingRef.current;
    if (!entry) return { ok: false, reason: 'no-incoming' };
    // CANCEL may have arrived while we were acquiring lock/mic — if already terminated, abort
    if (entry.invitation && String(entry.invitation.state || '').toLowerCase() === 'terminated') {
      if (incomingRef.current === entry) endIncoming('canceled');
      return { ok: false, reason: 'caller-hung-up' };
    }
    stopRinger();
    setStandbyNote('');

    if (!entry.simulated && !mediaSupported()) {
      const reason = mediaUnavailableReason();
      setError(reason);
      try { entry.reject?.({ statusCode: 486 }); } catch { /* ignore */ }
      endIncoming('missed');
      return { ok: false, reason };
    }

    try {
      if (entry.simulated) {
        startSimulatedLevel();
      } else {
        await openMicrophone();
      }
    } catch (e) {
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      const reason = denied
        ? 'Microphone permission was refused — the call was declined.'
        : `Could not open the microphone: ${e?.message || e}`;
      setError(reason);
      // Answering without a microphone is a silent, dead call. Refuse it instead.
      try { entry.reject?.({ statusCode: 486 }); } catch { /* ignore */ }
      endIncoming('missed');
      return { ok: false, reason, denied: !!denied };
    }

    try {
      // Re-check after mic open: CANCEL may have arrived during getUserMedia (80–200 ms window)
      if (entry.invitation && String(entry.invitation.state || '').toLowerCase() === 'terminated') {
        releaseMedia();
        endIncoming('canceled');
        return { ok: false, reason: 'canceled' };
      }

      // Bind remote audio stream handler BEFORE SDP offer/answer negotiation runs so the instant
      // WebRTC receives the remote RTP audio track during setRemoteDescription, audio output plays.
      const attachRemoteTrack = (track) => {
        if (!audioRef.current || !track) return;
        audioRef.current.muted = false;
        audioRef.current.srcObject = new MediaStream([track]);
        const playResult = audioRef.current.play?.();
        if (playResult && typeof playResult.catch === 'function') {
          playResult.catch((err) => {
            console.warn('Inbound WebRTC audio play() deferred or blocked:', err);
          });
        }
      };

      const bindPeerConnection = (pc) => {
        if (!pc) return;
        pcRef.current = pc;
        const onTrackEvent = (event) => {
          const track = event?.track || event?.streams?.[0]?.getAudioTracks?.()?.[0];
          if (track && (!track.kind || track.kind === 'audio')) attachRemoteTrack(track);
        };
        if (typeof pc.addEventListener === 'function') {
          pc.addEventListener('track', onTrackEvent);
        } else {
          const prev = pc.ontrack;
          pc.ontrack = (event) => {
            if (typeof prev === 'function') prev.call(pc, event);
            onTrackEvent(event);
          };
        }
      };

      await entry.accept?.(streamRef.current, {
        onTrack: (track) => attachRemoteTrack(track),
        onPeerConnection: (pc) => bindPeerConnection(pc),
      });

      // Fallback safety: if the remote track had already landed on the handler's stream/receivers
      // before playback settled, guarantee audioRef.current is bound and playing.
      const sdh = entry.invitation?.sessionDescriptionHandler;
      const pc = sdh?.peerConnection;
      if (pc && pcRef.current !== pc) bindPeerConnection(pc);
      if (audioRef.current && !audioRef.current.srcObject) {
        const existingTrack = sdh?.remoteMediaStream?.getAudioTracks?.()?.[0]
          || (pc?.getReceivers ? pc.getReceivers().find((r) => r.track?.kind === 'audio')?.track : null);
        if (existingTrack) attachRemoteTrack(existingTrack);
      }
    } catch (e) {
      // 487 Canceled crossing 200 OK: not an error, just caller gave up
      if (/487|Canceled|canceled|terminated/i.test(String(e?.message || e))) {
        releaseMedia(); endIncoming('canceled');
        return { ok: false, reason: 'canceled' };
      }
      releaseMedia();
      const reason = `The incoming call could not be answered — ${e?.message || e}`;
      setError(reason);
      endIncoming('missed');
      return { ok: false, reason };
    }

    // The ring is over. Clearing the ref is what lets the *next* call in: while it is set, the
    // engine answers every fresh INVITE with 486 "busy" and the tab is deaf for the rest of the
    // session. The session handle moves to sipRef so hang-up still sends the BYE.
    const answered = { ...entry, answered: true };
    incomingRef.current = null;
    answeredInboundRef.current = answered;
    try { entry.onStateChange = null; } catch { /* a frozen entry is fine too */ }
    sipRef.current = { stop: () => { try { entry.terminate?.(); } catch { /* already gone */ } } };
    setIncomingCall(null);          // the call bar takes it from here
    inboundActiveRef.current = true;
    setDirection('inbound');
    setTarget(answered.callerNumber);
    setStateSafe('active');
    try {
      callbacksRef.current.onActive?.('inbound');
    } catch (cbErr) {
      console.error('Inbound onActive callback error:', cbErr);
    }
    if (answered.callId) startRecording(answered.callId);
    return { ok: true, entry: answered };
  }, [endIncoming, openMicrophone, releaseMedia, setStateSafe, startRecording, startSimulatedLevel, stopRinger]);

  const declineInbound = useCallback(async () => {
    const entry = incomingRef.current;
    if (!entry) return { ok: false, reason: 'no-incoming' };
    stopRinger();
    entry.endReason = 'declined';      // set before reject: the teardown reads it synchronously
    try { entry.reject?.({ statusCode: 603 }); } catch { /* ignore */ }
    if (incomingRef.current === entry) endIncoming('declined');
    return { ok: true };
  }, [endIncoming, stopRinger]);

  // The ring object can call these from the modal at any time, including between renders.
  answerInboundRef.current = answerInbound;
  declineInboundRef.current = declineInbound;

  // Test mode: ring the tab without a provider, so the whole inbound path (modal, matching,
  // ringer, answer, classification) can be exercised on a machine with no SIP gateway.
  const simulateIncomingCall = useCallback((number = '20123456') => {
    if (!enabled) return Promise.resolve({ ok: false, reason: 'not-webrtc' });
    if (!dryRun) return Promise.resolve({ ok: false, reason: 'live-mode' });
    const listeners = new Set();
    const emit = (s) => { for (const fn of listeners) { try { fn(s); } catch { /* ignore */ } } };
    const invitation = {
      simulated: true,
      remoteIdentity: { uri: { user: String(number) } },
      state: 'Initial',
      accept: async () => { emit('established'); },
      reject: () => { emit('terminated'); },
      terminate: () => { emit('terminated'); },
      bye: () => { emit('terminated'); },
    };
    return handleIncoming({
      invitation,
      callerNumber: String(number),
      simulated: true,
      onStateChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      accept: async () => { emit('established'); },
      reject: () => { emit('terminated'); },
      terminate: () => { emit('terminated'); },
    });
  }, [dryRun, enabled, handleIncoming]);

  // The provider's handler closes over settings that arrive after the first render (country
  // code, microphone). The UA must always call the *current* one, not the one it was built with.
  const incomingHandlerRef = useRef(null);
  incomingHandlerRef.current = handleIncoming;

  // Test mode: the caller gives up. A real far-end CANCEL arrives as a SIP state change, which
  // is the path this drives, so the modal teardown under test is the same one a live call uses.
  const simulateCallerHangup = useCallback(() => {
    const entry = incomingRef.current;
    if (!entry?.simulated) return { ok: false, reason: 'no-incoming' };
    try { entry.terminate?.(); } catch { /* the harness has already gone */ }
    // Belt to the state-change braces: if no listener was wired, end the ring directly.
    if (incomingRef.current === entry) endIncoming('canceled');
    return { ok: true };
  }, [endIncoming]);

  // ---- the persistent registration -------------------------------------------------------
  // A softphone that only registers when you dial cannot receive a call. While the tab is in
  // WebRTC mode and no call is in flight, one UserAgent stays registered and listening.
  useEffect(() => {
    if (!enabled || dryRun) {
      setStandby((s) => (s.state === 'off' ? s : { state: 'off', reason: '' }));
      return undefined;
    }
    let cancelled = false;
    setStandby({ state: 'registering', reason: '' });

    (async () => {
      let session;
      try {
        session = await api.webrtcSession();
      } catch (e) {
        if (!cancelled) setStandby({ state: 'unavailable', reason: e.message || 'The softphone session is unreachable.' });
        return;
      }
      if (cancelled) return;
      if (!session?.canRegister) {
        setStandby({
          state: 'unavailable',
          reason: session?.configured
            ? 'Turn on SIP credential handoff in Settings → Telephony to receive calls in the browser.'
            : `The in-browser softphone is not configured yet (missing: ${(session?.missing || []).join(', ') || 'credentials'}).`,
        });
        return;
      }
      try {
        const { initStandbySession } = await import('./webrtcSignalling.js');
        if (cancelled) return;
        await initStandbySession({
          session,
          onIncomingCall: (payload) => incomingHandlerRef.current?.(payload),
          onState: (s, detail) => {
            if (cancelled) return;
            if (s === 'ready') setStandby({ state: 'ready', reason: '' });
            else if (s === 'registering') setStandby({ state: 'registering', reason: '' });
            else if (s === 'retrying') setStandby({ state: 'ready', reason: detail || '' });
          },
        });
      } catch (e) {
        if (!cancelled) setStandby({ state: 'unavailable', reason: e?.message || String(e) });
      }
    })();

    return () => { cancelled = true; };
  }, [enabled, dryRun]);

  // Switching the mode, or leaving the tab idle for good, must not leave a registration open.
  useEffect(() => {
    if (enabled) return undefined;
    return () => {
      // No-op when the session is already gone.
      setStandby({ state: 'off', reason: '' });
    };
  }, [enabled]);

  const start = useCallback(async (phone, { dryRun: callDryRun = false, callId = null } = {}) => {
    if (!enabled) return { ok: false, reason: 'not-webrtc' };
    const origin = stateRef.current;
    // 'standby' is a resting state, not a call: an outbound dial from standby reuses the
    // registration that is already open instead of performing a second handshake.
    if (origin !== 'idle' && origin !== 'standby' && origin !== 'ended' && origin !== 'error') {
      return { ok: false, reason: 'busy' };
    }
    if (incomingRef.current) return { ok: false, reason: 'busy' };   // the phone is ringing
    // Glare window: mark outbound in-flight so concurrent inbound INVITE is deferred (G-1)
    glareMutexRef.current = true;
    setTimeout(() => { glareMutexRef.current = false; }, 1200);

    setError('');
    setDtmfLog([]);
    setTarget(phone);
    setDirection('outbound');
    setStateSafe('registering');
    recordingCallIdRef.current = callId || null;

    if (callDryRun) {
      // Test mode never touches the microphone. It plays a ringback, then pretends to connect.
      playTone([440, 480], 900);
      startSimulatedLevel();
      const dial = setTimeout(() => setStateSafe('dialing'), 120);
      const ring = setTimeout(() => setStateSafe('ringing'), 420);
      const live = setTimeout(() => {
        setStateSafe('active');
        callbacksRef.current.onActive?.('outbound');
      }, 1400);
      tonesRef.current.push({ stop: () => { clearTimeout(dial); clearTimeout(ring); clearTimeout(live); } });
      return { ok: true, simulated: true };
    }

    // ---- live path ----
    if (!mediaSupported()) {
      const reason = mediaUnavailableReason();
      setError(reason);
      setStateSafe('error');
      return { ok: false, reason };
    }

    let session = null;
    try {
      session = await api.webrtcSession();
    } catch (e) {
      setError(e.message || 'Could not reach the browser-softphone session endpoint.');
      setStateSafe('error');
      return { ok: false, reason: e.message };
    }
    if (!session?.canRegister) {
      const reason = session?.configured
        ? 'The browser softphone cannot register: turn on SIP credential handoff in Settings → Telephony.'
        : `The browser softphone is not configured yet (missing: ${(session?.missing || []).join(', ') || 'credentials'}).`;
      setError(reason);
      setStateSafe('error');
      return { ok: false, reason };
    }

    try {
      await openMicrophone();
    } catch (e) {
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      const reason = denied
        ? 'Microphone permission was refused — allow it for this site and press C again.'
        : `Could not open the microphone: ${e?.message || e}`;
      setError(reason);
      setStateSafe('error');
      return { ok: false, reason };
    }

    const attachOutboundRemoteTrack = (track) => {
      if (!audioRef.current || !track) return;
      audioRef.current.muted = false;
      audioRef.current.srcObject = new MediaStream([track]);
      const playResult = audioRef.current.play?.();
      if (playResult && typeof playResult.catch === 'function') {
        playResult.catch((err) => {
          console.warn('Outbound WebRTC audio play() deferred or blocked:', err);
        });
      }
    };

    const bindOutboundPeerConnection = (pc) => {
      if (!pc) return;
      pcRef.current = pc;
      const onTrackEvent = (event) => {
        const track = event?.track || event?.streams?.[0]?.getAudioTracks?.()?.[0];
        if (track && (!track.kind || track.kind === 'audio')) attachOutboundRemoteTrack(track);
      };
      if (typeof pc.addEventListener === 'function') {
        pc.addEventListener('track', onTrackEvent);
      } else {
        const prev = pc.ontrack;
        pc.ontrack = (event) => {
          if (typeof prev === 'function') prev.call(pc, event);
          onTrackEvent(event);
        };
      }
    };

    // Signalling binds the live RTCPeerConnection and attaches ontrack BEFORE SDP offer/answer
    // completes so early media (183 Session Progress) and 200 OK RTP streams never miss tracks.
    try {
      const { startSignalling } = await import('./webrtcSignalling.js');
      sipRef.current = await startSignalling({
        session,
        remoteNumber: phone,
        localStream: streamRef.current,
        onTrack: (track) => attachOutboundRemoteTrack(track),
        onPeerConnection: (pc) => bindOutboundPeerConnection(pc),
        onState: setStateSafe,
        onError: (msg) => { setError(msg); setStateSafe('error'); },
        onActive: () => {
          try {
            const sdh = sipRef.current?.inviter?.sessionDescriptionHandler;
            const sipPc = sdh?.peerConnection;
            if (sipPc && pcRef.current !== sipPc) bindOutboundPeerConnection(sipPc);
            if (audioRef.current && !audioRef.current.srcObject) {
              const existingTrack = sdh?.remoteMediaStream?.getAudioTracks?.()?.[0]
                || (sipPc?.getReceivers ? sipPc.getReceivers().find((r) => r.track?.kind === 'audio')?.track : null);
              if (existingTrack) attachOutboundRemoteTrack(existingTrack);
            }
          } catch {}
          try {
            callbacksRef.current.onActive?.('outbound');
          } catch (cbErr) {
            console.error('Outbound onActive callback error:', cbErr);
          }
          if (recordingCallIdRef.current && !recorderRef.current) {
            startRecording(recordingCallIdRef.current);
          }
        },
        onIncomingCall: (payload) => incomingHandlerRef.current?.(payload),
      });
      return { ok: true, simulated: false };
    } catch (e) {
      releaseMedia();
      const reason = e?.message || String(e);
      setError(reason);
      setStateSafe('error');
      return { ok: false, reason };
    }
  }, [enabled, handleIncoming, openMicrophone, playTone, releaseMedia, setStateSafe, startRecording, startSimulatedLevel]);

  const hangUp = useCallback(() => {
    const current = stateRef.current;
    if (current === 'idle' || current === 'standby') return;
    const wasInbound = inboundActiveRef.current;
    finishActiveCall(wasInbound ? 'inbound' : 'outbound');
  }, [finishActiveCall]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    try {
      const track = streamRef.current?.getAudioTracks?.()[0];
      // `enabled = false` keeps the track live but silent, which is what a phone mute does.
      if (track) track.enabled = !next;
    } catch { /* no track in test mode — the state still flips */ }
    setMuted(next);
    return next;
  }, []);

  const sendDtmf = useCallback((digit) => {
    if (!DTMF_KEYS.includes(String(digit))) return false;
    const key = String(digit);
    setDtmfLog((log) => [...log.slice(-11), key]);

    // A real session can carry the tone in-band if the browser exposes DTMF on the sender.
    try {
      const sender = pcRef.current?.getSenders?.().find((s) => s.track?.kind === 'audio');
      if (sender && sender.dtmf && typeof sender.dtmf.insertDTMF === 'function') {
        sender.dtmf.insertDTMF(key, 160);
        return true;
      }
    } catch { /* fall through to the audible tone */ }

    const pair = DTMF_TONES[key];
    if (pair) playTone(pair, 160);
    return true;
  }, [playTone]);

  const reset = useCallback(() => {
    releaseMedia();
    setStateSafe(enabledRef.current ? 'standby' : 'idle');
    setError('');
    setDtmfLog([]);
    setTarget('');
    setDirection(null);
  }, [releaseMedia, setStateSafe]);

  // Never leave audio running because the mode was switched mid-call.
  useEffect(() => {
    if (enabled) return;
    if (stateRef.current !== 'idle' || incomingRef.current) {
      // Switching out of WebRTC mode mid-ring has to silence the ringer too.
      stopRinger();
      if (incomingRef.current) endIncoming('canceled');
      reset();
    }
    import('./webrtcSignalling.js').then((m) => m.disposeStandbySession()).catch(() => {});
  }, [enabled, endIncoming, reset, stopRinger]);

  return useMemo(() => ({
    state, muted, level, error, target, dtmfLog, micLabel, standby, standbyNote, incomingCall, direction,
    active: state === 'active',
    ringing: state === 'incoming',
    busy: state !== 'idle' && state !== 'standby' && state !== 'ended' && state !== 'error',
    supported: mediaSupported(),
    audioRef,
    silenceRinger: stopRinger,
    start, hangUp, toggleMute, sendDtmf, reset,
    answerInbound, declineInbound, simulateIncomingCall, simulateCallerHangup,
    startRecording, stopRecording,
  }), [
    state, muted, level, error, target, dtmfLog, micLabel, standby, standbyNote, incomingCall, direction,
    stopRinger, start, hangUp, toggleMute, sendDtmf, reset, answerInbound, declineInbound, simulateIncomingCall, simulateCallerHangup,
    startRecording, stopRecording,
  ]);
}

// Enumerate the microphones/cameras the browser will admit to. Labels are blank until the
// agent has granted permission at least once, which is a browser rule, not a bug.
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
