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
import { installGlobalAudioUnlock } from './utils/ringer.js';
import { uploadWithOutbox, drainPendingRecordings } from './utils/recordingsStorage.js';
import { FOLLOWER_STANDBY_LABEL } from './utils/tabLeadership.js';

const Ctx = createContext(null);
export const useSoftphone = () => useContext(Ctx);

export function SoftphoneProvider({ children }) {
  const {
    settings, toast, setActiveId, setView, setInbound, inboundRef, setInboundEnded,
    findProspectByPhone, refreshProspects, refreshStats, bumpLedger, prospects,
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
      bumpLedger();
      refreshStats();
    } catch (e) {
      setInbound((cur) => (cur && cur.startedAt === entry.startedAt ? { ...cur, loading: false, logError: e.message } : cur));
    }
  }, [bumpLedger, findProspectByPhone, refreshProspects, refreshStats, setInbound]);

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
      bumpLedger();
      await refreshStats();
    } catch { /* the ring is over either way; a missing ledger row must not shout at the agent */ }
  }, [bumpLedger, inboundRef, refreshProspects, refreshStats, setInbound, toast]);

  // ---- a call became real --------------------------------------------------------------
  const onActive = useCallback((direction) => {
    if (direction === 'inbound') {
      const rec = inboundRef.current;
      setInbound(rec ? { ...rec, answered: true } : null);
      if (rec?.callId) {
        api.patchCall(rec.callId, { status: 'connected' })
          .then(() => { bumpLedger(); refreshStats(); })
          .catch(() => { });
      }
      // A callback about a customer the agent is already talking to: the cockpit has to be
      // showing that person, on the dialer, before the first sentence.
      if (rec?.prospect?.id) {
        setActiveId(rec.prospect.id);
        setView('dialer');
      }
    }
    handlersRef.current.onActive?.(direction);
  }, [bumpLedger, inboundRef, refreshStats, setActiveId, setInbound, setView]);

  const onEnded = useCallback((direction, endMeta) => {
    if (direction === 'inbound') {
      const rec = inboundRef.current;
      // Hand the finished call to the dialer, which owns the 1-8 disposition modal. The call
      // row already exists server-side, so classification is the same PATCH an outbound call
      // uses — same copilot, same follow-up prompt, same stats.
      setInboundEnded(rec ? { callId: rec.callId, prospect: rec.prospect, endMeta } : null);
      setInbound(null);
      bumpLedger();
      refreshStats();
    } else {
      bumpLedger();
    }
    handlersRef.current.onEnded?.(direction, endMeta);
  }, [bumpLedger, inboundRef, refreshStats, setInbound, setInboundEnded]);

  const onRecordingReady = useCallback(async ({ blob, durationSec, callId }) => {
    if (callId && blob && blob.size > 0) {
      const outcome = await uploadWithOutbox({
        callId,
        blob,
        durationSec,
        uploadFn: (id, data, dur) => api.uploadRecording(id, data, dur),
      });
      if (outcome.ok) {
        bumpLedger();
      } else {
        console.warn('Recording buffered in IndexedDB outbox for automatic retry:', outcome.error);
      }
    }
    handlersRef.current.onRecordingReady?.({ blob, durationSec, callId });
  }, [bumpLedger]);

  // Challenge 5: Drain buffered IndexedDB recordings on app startup AND whenever network reconnects.
  useEffect(() => {
    const flush = () => {
      drainPendingRecordings({
        uploadFn: (id, blob, dur) => api.uploadRecording(id, blob, dur),
        onUploaded: () => bumpLedger(),
      }).catch(() => {});
    };
    flush();
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('online', flush);
      return () => window.removeEventListener('online', flush);
    }
    return undefined;
  }, [bumpLedger]);

  const onAudioDeviceEvent = useCallback((ev) => {
    if (!ev) return;
    if (ev.type === 'switched') {
      toast(ev.message || 'Audio device switched to default microphone');
    } else if (ev.type === 'failed') {
      toast(ev.message || 'Audio input device lost — reconnect microphone or hang up.', 'error');
    }
  }, [toast]);

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
    onAudioDeviceEvent,
  });

  const { simulateIncomingCall, simulateCallerHangup, incomingCall } = engine;
  const incomingRef = useRef(null);
  incomingRef.current = incomingCall;

  // Prime Web Audio + persistent root <audio> element on first user gesture anywhere in the app
  // so inbound SIP ring tones and WebRTC remote audio streams never fall victim to autoplay block.
  useEffect(() => installGlobalAudioUnlock(() => engine.audioRef?.current || null), [engine.audioRef]);

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
        : engine.standby.state === 'follower' ? FOLLOWER_STANDBY_LABEL
          : engine.standby.state === 'registering' ? 'Standby · Registering…'
            : engine.standby.state === 'unavailable' ? 'Standby unavailable'
              : 'Standby · Off',
    setCallHandlers,
    simulateIncomingCall,
    simulateCallerHangup,
  }), [engine, enabled, dryRun, setCallHandlers, simulateCallerHangup, simulateIncomingCall]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
