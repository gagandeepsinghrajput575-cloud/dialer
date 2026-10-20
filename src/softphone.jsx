// The softphone provider: one engine, one ringing phone, for the whole app.
//
// The engine (useWebRtc) owns the media. The store owns the CRM data. This component is the
// only thing that talks to both, which is why it exists rather than the modal calling the API
// directly: "who is calling?" needs the prospect record *and* the SIP session, and answering
// needs to move the cockpit onto the right person before the agent has finished saying hello.
//
// It also owns the test-mode trigger, so the whole inbound path can be exercised without a
// provider: press `i` on any page in test mode and the phone rings exactly as it would.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { api } from './api';
import { useStore } from './store.jsx';
import useWebRtc from './useWebRtc.js';
import { isDesktop, onDesktopCommand, openInSoftphone, pushDesktopState } from './desktop/bridge.mjs';
import { useNativeInbound } from './desktop/nativeInbound.mjs';

const Ctx = createContext(null);
export const useSoftphone = () => useContext(Ctx);

export function SoftphoneProvider({ children }) {
  const {
    settings, toast, setActiveId, setView, setInbound, inboundRef, setInboundEnded,
    findProspectByPhone, refreshProspects, refreshStats, prospects,
  } = useStore();

  const enabled = settings?.telephony_mode === 'webrtc';
  const dryRun = settings?.dry_run === '1';
  const countryCode = settings?.default_country_code || '';

  // The dialer registers here. It is a ref, not state: the engine calls these on the media
  // thread's timeline and must never wait for a re-render to open the classification modal.
  const handlersRef = useRef({ onActive: null, onEnded: null, onRecordingReady: null });
  const setCallHandlers = useCallback((handlers) => { handlersRef.current = handlers || { onActive: null, onEnded: null, onRecordingReady: null }; }, []);

  // ---- a call is ringing ---------------------------------------------------------------
  const onIncoming = useCallback(async (entry) => {
    // 1. Instant, local answer: a name from the list we already have, so the modal is never
    //    blank while the network catches up.
    const callerPhone = entry.rawNumber || entry.callerNumber || 'Unknown';
    const local = findProspectByPhone(callerPhone);
    setInbound({
      ...entry, callerNumber: entry.callerNumber || 'Unknown', prospect: local, matched: !!local, provisional: false, loading: !local, resolution: 'local',
    });

    // 2. The authoritative one: matches against the whole database (not just the loaded page),
    //    provisions a placeholder lead for a stranger, and opens the ledger row.
    try {
      const res = await api.inboundCall({ callerPhone });
      entry.attachCrm?.({ prospect: res.prospect, matched: res.matched, provisional: res.provisional, callId: res.callId });
      entry.callId = res.callId;
      // A stranger's placeholder lead only exists server-side: pull it into the list so the
      // cockpit can show the person the agent is about to say hello to.
      if (res.provisional) refreshProspects();
      setInbound((cur) => (cur && cur.startedAt === entry.startedAt
        ? { ...cur, prospect: res.prospect, matched: res.matched, provisional: res.provisional, callId: res.callId, loading: false, resolution: res.matched ? 'database' : 'provisional' }
        : cur));
      refreshStats();
    } catch (e) {
      setInbound((cur) => (cur && cur.startedAt === entry.startedAt ? { ...cur, loading: false, logError: e.message } : cur));
    }
  }, [findProspectByPhone, refreshProspects, refreshStats, setInbound]);

  // ---- a ring ended unanswered ---------------------------------------------------------
  // The engine reports one object: the ring, plus why it stopped. Reading it as a second
  // positional argument is how a decline used to be logged as a miss with no toast at all.
  const onIncomingEnded = useCallback(async (ended) => {
    const rec = inboundRef.current;
    const callId = rec?.callId || ended?.callId;
    const reason = ended?.reason || 'canceled';
    setInbound(null);

    // An answered call ends through onEnded: its ledger row is the agent's call to classify,
    // and it must never be marked missed on the way out.
    if (ended?.answered) return;

    if (reason === 'declined') toast(`Declined call from ${ended.callerNumber || 'caller'}`);
    else if (reason === 'canceled') toast(`Missed call from ${ended.callerNumber || 'caller'}`, 'error');
    // 'another-tab' / 'missed' are handled by the tab that owns the call; a passive tab stays quiet.

    if (!callId) return;
    try {
      const res = await api.missCall(callId, { reason: reason === 'declined' ? 'declined' : 'missed', duration_sec: 0 });
      // A stranger's placeholder lead is swept with the ring (data minimisation): if it was,
      // the list on screen has to change, or the agent keeps seeing a lead that no longer exists.
      if (res?.cleanedUp) await refreshProspects();
      await refreshStats();
    } catch { /* the ring is over either way; a missing ledger row must not shout at the agent */ }
  }, [inboundRef, refreshProspects, refreshStats, setInbound, toast]);

  // ---- a call became real --------------------------------------------------------------
  const onActive = useCallback((direction) => {
    if (direction === 'inbound') {
      const rec = inboundRef.current;
      setInbound(rec ? { ...rec, answered: true } : null);
      if (rec?.callId) {
        api.patchCall(rec.callId, { status: 'connected', outcome: 'conversation' }).catch(() => { });
        refreshStats();
      }
      // A callback about a customer the agent is already talking to: the cockpit has to be
      // showing that person, on the dialer, before the first sentence.
      if (rec?.prospect?.id) {
        setActiveId(rec.prospect.id);
        setView('dialer');
      }
    }
    handlersRef.current.onActive?.(direction);
  }, [inboundRef, refreshStats, setActiveId, setInbound, setView]);

  const onEnded = useCallback((direction) => {
    if (direction === 'inbound') {
      const rec = inboundRef.current;
      // Hand the finished call to the dialer, which owns the 1-8 disposition modal. The call
      // row already exists server-side, so classification is the same PATCH an outbound call
      // uses — same copilot, same follow-up prompt, same stats.
      setInboundEnded(rec ? { callId: rec.callId, prospect: rec.prospect } : null);
      setInbound(null);
      refreshStats();
    }
    handlersRef.current.onEnded?.(direction);
  }, [inboundRef, refreshStats, setInbound, setInboundEnded]);

  const onRecordingReady = useCallback(async ({ blob, durationSec, callId }) => {
    if (callId && blob && blob.size > 0) {
      try {
        await api.uploadRecording(callId, blob, durationSec);
      } catch (e) {
        console.warn('Background recording upload non-fatal failure:', e);
      }
    }
    handlersRef.current.onRecordingReady?.({ blob, durationSec, callId });
  }, []);

  const engine = useWebRtc({
    enabled,
    dryRun,
    countryCode,
    micDevice: settings?.webrtc_mic_device || '',
    onActive,
    onEnded,
    onIncoming,
    onIncomingEnded,
    onRecordingReady,
  });

  const { simulateIncomingCall, simulateCallerHangup, incomingCall } = engine;
  const incomingRef = useRef(null);
  incomingRef.current = incomingCall;

  // ---- native engine ---------------------------------------------------------------------
  // The Linphone daemon inside the shell owns the ring and the audio. Its events feed the same
  // inbound machinery the browser engine uses, and the ledger row it already opened is adopted
  // (never re-created), so a native call is one row, one modal and one disposition.
  const native = useNativeInbound({
    enabled: isDesktop(),
    onRinging: useCallback((event) => {
      const local = findProspectByPhone(event.callerPhone);
      setInbound({
        callerNumber: event.callerPhone || 'Unknown', callerName: event.callerName || '',
        prospect: local, matched: !!local, provisional: false, loading: !local,
        resolution: 'local', callId: null, startedAt: new Date().toISOString(), native: true,
      });
    }, [findProspectByPhone, setInbound]),
    onLedger: useCallback((event) => {
      setInbound((cur) => (cur && cur.native
        ? { ...cur, callId: event.callId || cur.callId, prospect: event.prospect || cur.prospect, loading: false, matched: !!event.matched, provisional: !!event.provisional }
        : cur));
    }, [setInbound]),
    onAnswered: useCallback(() => onActive('inbound'), [onActive]),
    onEnded: useCallback((event) => {
      if (event.answered || event.durationSec > 0) { onEnded('inbound'); return; }
      const rec = inboundRef.current;
      setInbound(null);
      if (rec && rec.callerNumber) toast(`Missed call from ${rec.callerNumber}`, 'error');
      refreshStats();
    }, [inboundRef, onEnded, refreshStats, setInbound, toast]),
  });

  // The modal and the menu both call these; whichever engine owns the ring gets the answer.
  const nativeRinging = !!native.incomingCall;
  const ringingCall = engine.incomingCall || native.incomingCall;
  const answerInbound = nativeRinging ? native.answer : engine.answerInbound;
  const declineInbound = nativeRinging ? native.decline : engine.declineInbound;

  // ---- native shell ----------------------------------------------------------------------
  // The macOS menu bar and pulse:// deep links dial through exactly this path: one direct-dial
  // ledger row, then the same engine `start` the dialer page uses. No second call pipeline.
  const startDesktopDial = useCallback(async (phone) => {
    const clean = String(phone || '').trim();
    if (!clean) return { ok: false, reason: 'no-number' };
    // Fail-safe: when this shell cannot start in-app audio (engine off, WSS blocked, no mic),
    // hand the number to Linphone immediately instead of dead-ending the menu action.
    const handoff = () => {
      if (!isDesktop() || !openInSoftphone(clean)) return false;
      toast('Opening Linphone for this call');
      return true;
    };
    if (!enabled) {
      if (handoff()) return { ok: true, handoff: true };
      toast('Turn on the in-app softphone to dial from the menu', 'error');
      return { ok: false, reason: 'not-webrtc' };
    }
    try {
      const call = await api.directDial({ phone: clean, name: '' });
      const result = await engine.start(call.phone || clean, { callId: call.callId });
      if (result && result.ok) setView('dialer');
      else if (!['busy', 'already-ringing', 'glare-outbound-pending'].includes(result && result.reason) && handoff()) {
        return { ok: true, handoff: true };
      }
      return result;
    } catch (e) {
      toast(e.message || 'Could not start that call', 'error');
      return { ok: false, reason: e.message };
    }
  }, [enabled, engine, setView, toast]);

  // The menu bar is outside React: it must never act on a stale render's callbacks.
  const answerRef = useRef(null);
  const declineRef = useRef(null);
  const hangupRef = useRef(null);
  answerRef.current = answerInbound;
  declineRef.current = declineInbound;
  hangupRef.current = engine.hangUp;

  useEffect(() => {
    if (!isDesktop()) return undefined;
    return onDesktopCommand((command) => {
      if (!command) return;
      if (command.action === 'dial') startDesktopDial(command.phone);
      else if (command.action === 'answer') answerRef.current?.();
      else if (command.action === 'decline') declineRef.current?.();
      else if (command.action === 'hangup') hangupRef.current?.();
      else if (command.action === 'dtmf') engine.sendDtmf && engine.sendDtmf(command.digit);
    });
  }, [engine, startDesktopDial]);


  // The dock badge and the native notification are driven by the engine's own state, so they
  // can never claim a ringing phone the modal is not showing.
  useEffect(() => {
    if (!isDesktop()) return;
    if (incomingRef.current || native.incomingCall) {
      const ring = incomingRef.current || native.incomingCall;
      pushDesktopState({ type: 'incoming', callerPhone: ring.callerNumber || '' });
    } else if (engine.state === 'active') pushDesktopState({ type: 'active' });
    else pushDesktopState({ type: 'idle' });
  }, [incomingCall, engine.state, native.incomingCall]);

  // ---- test-mode trigger ---------------------------------------------------------------
  // Press `i` anywhere in test mode: the phone rings, the modal appears, Enter answers and
  // Escape declines — the same code path a real INVITE takes, minus the gateway. Live mode
  // ignores the key entirely; a shortcut that could fake a customer calling would be a lie.
  useEffect(() => {
    if (!enabled || !dryRun) return undefined;
    const onKey = (e) => {
      if (e.key !== 'i' && e.key !== 'I') return;
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (typing) return;
      // Shift+I: the caller gives up before you reach the phone.
      if (e.shiftKey) { simulateCallerHangup(); return; }
      if (incomingRef.current) return;                       // already ringing
      // A modal owns the keyboard; the ring must not hijack it.
      if (typeof document !== 'undefined' && document.querySelector('.classify-modal, .dtmf-pad, .email-modal, .outbox-modal, .drawer')) return;
      e.preventDefault();
      const testNumber = prospects.find((p) => p.phone)?.phone || '20123456';
      simulateIncomingCall(testNumber);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dryRun, enabled, prospects, simulateCallerHangup, simulateIncomingCall]);

  const value = useMemo(() => ({
    ...engine,
    enabled, dryRun,
    standbyLabel: dryRun
      ? 'Standby · Test mode (calls simulated)'
      : engine.standby.state === 'ready' ? 'Standby · Ready for calls'
        : engine.standby.state === 'registering' ? 'Standby · Registering…'
          : engine.standby.state === 'unavailable' ? 'Standby unavailable'
            : 'Standby · Off',
    setCallHandlers,
    simulateIncomingCall,
    simulateCallerHangup,
    incomingCall: ringingCall,
    answerInbound,
    declineInbound,
    nativeEngine: nativeRinging,
  }), [engine, enabled, dryRun, setCallHandlers, simulateCallerHangup, simulateIncomingCall, ringingCall, answerInbound, declineInbound, nativeRinging]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
