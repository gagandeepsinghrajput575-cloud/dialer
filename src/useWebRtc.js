// In-browser WebRTC softphone engine.
//
// This module owns everything that happens between "the agent pressed C" and "there is audio
// in their headphones": the microphone, the peer connection, the audio sink, mute, touch-tones
// and the session state machine. Dialer.jsx only renders what this reports.
//
// Two hard constraints shaped the design:
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';

export const WEBRTC_STATES = ['idle', 'registering', 'dialing', 'ringing', 'active', 'ended', 'error'];

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
 * @param {boolean} opts.enabled   - true only when telephony_mode === 'webrtc'
 * @param {function} opts.onActive - called once when audio is genuinely flowing
 * @param {function} opts.onEnded  - called once when the session is finished
 */
export default function useWebRtc({ enabled = false, onActive, onEnded } = {}) {
  const [state, setState] = useState('idle');
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);        // 0..1, drives the waveform
  const [error, setError] = useState('');
  const [target, setTarget] = useState('');     // the number being called
  const [dtmfLog, setDtmfLog] = useState([]);   // tones sent, newest last
  const [micLabel, setMicLabel] = useState('');

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
  const callbacksRef = useRef({ onActive, onEnded });
  const stateRef = useRef('idle');
  const mutedRef = useRef(false);

  callbacksRef.current = { onActive, onEnded };

  const setStateSafe = useCallback((next) => {
    stateRef.current = next;
    setState(next);
  }, []);

  // ---- teardown. Idempotent, and never throws. ----
  const releaseMedia = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    if (simRef.current) { clearInterval(simRef.current); simRef.current = 0; }

    try {
      if (pcRef.current) {
        pcRef.current.ontrack = null;
        pcRef.current.oniceconnectionstatechange = null;
        pcRef.current.close();
      }
    } catch { /* already closed */ }
    pcRef.current = null;

    // Releasing the tracks is what turns the browser's recording indicator off. A leaked
    // stream leaves the mic hot after the call, which is the worst possible bug here.
    try {
      if (streamRef.current) for (const t of streamRef.current.getTracks()) t.stop();
    } catch { /* nothing to stop */ }
    streamRef.current = null;

    try { if (audioRef.current) audioRef.current.srcObject = null; } catch { /* ignore */ }
    try { if (ctxRef.current && ctxRef.current.state !== 'closed') ctxRef.current.close(); } catch { /* ignore */ }
    ctxRef.current = null;
    analyserRef.current = null;
    for (const t of tonesRef.current) { try { t.stop(); } catch { /* ignore */ } }
    tonesRef.current = [];
    setLevel(0);
    setMuted(false);
    mutedRef.current = false;
  }, []);

  // Release the microphone if the component unmounts mid-call.
  useEffect(() => () => releaseMedia(), [releaseMedia]);

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
  const playTone = useCallback((freqs, ms) => {
    const Ctx = audioContextCtor();
    if (!Ctx) return;
    try {
      const ctx = audioContextCtor() ? new Ctx() : null;
      if (!ctx) return;
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
      const gain = ctx.createGain();
      gain.gain.value = 0.06;                     // quiet: it is a cue, not a ringtone
      gain.connect(ctx.destination);
      const oscs = freqs.map((f) => {
        const o = ctx.createOscillator();
        o.frequency.value = f;
        o.connect(gain);
        o.start();
        return o;
      });
      tonesRef.current.push(...oscs);
      setTimeout(() => {
        for (const o of oscs) { try { o.stop(); } catch { /* already stopped */ } }
        try { ctx.close(); } catch { /* ignore */ }
        tonesRef.current = tonesRef.current.filter((o) => !oscs.includes(o));
      }, ms);
    } catch { /* audio cues are best-effort */ }
  }, []);

  const start = useCallback(async (phone, { dryRun = false } = {}) => {
    if (!enabled) return { ok: false, reason: 'not-webrtc' };
    if (stateRef.current !== 'idle' && stateRef.current !== 'ended' && stateRef.current !== 'error') {
      return { ok: false, reason: 'busy' };
    }

    setError('');
    setDtmfLog([]);
    setTarget(phone);
    setStateSafe('registering');

    if (dryRun) {
      // Test mode never touches the microphone. It plays a ringback, then pretends to connect.
      playTone([440, 480], 900);
      startSimulatedLevel();
      const dial = setTimeout(() => setStateSafe('dialing'), 120);
      const ring = setTimeout(() => setStateSafe('ringing'), 420);
      const live = setTimeout(() => {
        setStateSafe('active');
        callbacksRef.current.onActive?.();
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

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: session.micDevice ? { deviceId: { ideal: session.micDevice } } : true,
      });
    } catch (e) {
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      const reason = denied
        ? 'Microphone permission was refused — allow it for this site and press C again.'
        : `Could not open the microphone: ${e?.message || e}`;
      setError(reason);
      setStateSafe('error');
      return { ok: false, reason };
    }

    streamRef.current = stream;
    try { setMicLabel(stream.getAudioTracks()[0]?.label || ''); } catch { /* label is optional */ }
    startLevelMeter(stream);

    // A peer connection is created and the microphone attached even before signalling
    // succeeds, so the session is ready the moment an offer comes back — and so the same
    // object can carry an inbound leg if the provider rings us.
    try {
      const PC = typeof window !== 'undefined' ? window.RTCPeerConnection : null;
      if (PC) {
        const pc = new PC({ iceServers: [{ urls: 'stun:stun.voip.so:3478' }] });
        for (const track of stream.getTracks()) pc.addTrack(track, stream);
        pc.ontrack = (ev) => {
          const [remote] = ev.streams || [];
          if (audioRef.current && remote) {
            audioRef.current.srcObject = remote;
            audioRef.current.play?.().catch(() => {});
          }
        };
        pc.oniceconnectionstatechange = () => {
          const s = pc.iceConnectionState;
          if (s === 'connected' || s === 'completed') {
            if (stateRef.current !== 'active') { setStateSafe('active'); callbacksRef.current.onActive?.(); }
          } else if (s === 'failed' || s === 'disconnected') {
            setError('The audio connection dropped.');
            setStateSafe('error');
          }
        };
        pcRef.current = pc;
      }
    } catch { /* the media element still plays the local stream back */ }

    // Signalling is the one piece that needs the provider's SIP-over-WebSocket gateway. It is
    // deliberately isolated behind this boundary: swap the adapter and the engine is unchanged.
    try {
      const { startSignalling } = await import('./webrtcSignalling.js');
      await startSignalling({
        session,
        remoteNumber: phone,
        pc: pcRef.current,
        localStream: streamRef.current,
        onState: setStateSafe,
        onError: (msg) => { setError(msg); setStateSafe('error'); },
        onActive: () => callbacksRef.current.onActive?.(),
      });
      return { ok: true, simulated: false };
    } catch (e) {
      const reason = e?.message || String(e);
      setError(reason);
      setStateSafe('error');
      return { ok: false, reason };
    }
  }, [enabled, playTone, startLevelMeter, startSimulatedLevel, setStateSafe]);

  const hangUp = useCallback(() => {
    if (stateRef.current === 'idle') return;
    releaseMedia();
    setStateSafe('ended');
    callbacksRef.current.onEnded?.();
    // 'ended' is a reportable moment, not a resting state — settle back to idle so the next
    // dial is a clean start.
    setTimeout(() => { if (stateRef.current === 'ended') setStateSafe('idle'); }, 400);
  }, [releaseMedia, setStateSafe]);

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
    setStateSafe('idle');
    setError('');
    setDtmfLog([]);
    setTarget('');
  }, [releaseMedia, setStateSafe]);

  // Never leave audio running because the mode was switched mid-call.
  useEffect(() => {
    if (!enabled && stateRef.current !== 'idle') reset();
  }, [enabled, reset]);

  return useMemo(() => ({
    state, muted, level, error, target, dtmfLog, micLabel,
    active: state === 'active',
    busy: state !== 'idle' && state !== 'ended' && state !== 'error',
    supported: mediaSupported(),
    audioRef,
    start, hangUp, toggleMute, sendDtmf, reset,
  }), [state, muted, level, error, target, dtmfLog, micLabel, start, hangUp, toggleMute, sendDtmf, reset]);
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
