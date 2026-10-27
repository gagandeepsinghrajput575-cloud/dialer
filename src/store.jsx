import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { samePhone } from './utils.js';

const Ctx = createContext(null);
export const useStore = () => useContext(Ctx);

export function StoreProvider({ children }) {
  const [prospects, setProspects] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [stats, setStats] = useState(null);
  const [settings, setSettings] = useState(null);
  const [view, setViewState] = useState(() => (location.hash.replace('#', '') || 'dialer'));
  const [activeId, setActiveId] = useState(null); // prospect in dialer
  const [drawerId, setDrawerId] = useState(null); // prospect in side drawer
  const [toasts, setToasts] = useState([]);
  const toastId = useRef(0);
  const toastTimers = useRef(new Map());

  const dismiss = useCallback((id) => {
    const timer = toastTimers.current.get(id);
    if (timer) clearTimeout(timer);
    toastTimers.current.delete(id);            // pruned, so the map cannot grow unboundedly
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);
  const startTimer = useCallback((id, type, ms) => {
    const life = ms || (type === 'error' ? 6000 : 3200);
    toastTimers.current.set(id, setTimeout(() => dismiss(id), life));
  }, [dismiss]);
  const restartTimer = useCallback((id, type) => {
    const existing = toastTimers.current.get(id);
    if (existing) clearTimeout(existing);
    startTimer(id, type);
  }, [startTimer]);

  const setView = useCallback((v) => { setViewState(v); history.replaceState(null, '', '#' + v); }, []);

  // Toasts are capped so a burst (a mashed shortcut, a failing import) can never pile up
  // hundreds of animated nodes, and an identical message shown twice in a row is merged.
  const MAX_TOASTS = 4;
  // `action` is an optional { label, onClick } rendered inside the toast — "Captured in Local
  // Outbox · View" is the case it was added for. A toast with an action is never merged, so a
  // stale handler cannot be attached to a fresh message.
  const toast = useCallback((msg, type = 'ok', action = null) => {
    setToasts((t) => {
      const last = t[t.length - 1];
      // Merging a repeat must be pure: the previous version mutated the existing object and
      // reassigned its `id`, which is the React key — that remounted the node mid-animation
      // and, under StrictMode (where updaters run twice), double-counted the repeat.
      if (last && last.msg === msg && last.type === type && !action && !last.action) {
        const merged = t.slice(0, -1).concat({ ...last, repeats: (last.repeats || 1) + 1 });
        restartTimer(last.id, type);
        return merged;
      }
      const id = ++toastId.current;
      // An actionable toast needs to outlive a glance, or the button vanishes before it can
      // be pressed.
      startTimer(id, type, action ? 9000 : undefined);
      const next = [...t, { id, msg, type, repeats: 1, ...(action ? { action } : {}) }];
      return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
    });
  }, []);

  // Never leave a dismissal timer behind when the provider unmounts.
  useEffect(() => {
    const timers = toastTimers.current;
    return () => { for (const t of timers.values()) clearTimeout(t); timers.clear(); };
  }, []);

  const refreshSeq = useRef(0);
  const refreshProspects = useCallback(async () => {
    // Overlapping refreshes are routine (a call finishing while an import lands). Without a
    // sequence guard the slower, older response could win and revert a row you just edited.
    const seq = ++refreshSeq.current;
    try {
      const next = await api.prospects();
      if (seq === refreshSeq.current) setProspects(next);
    } catch (e) {
      if (seq === refreshSeq.current) toast(e.message, 'error');
    }
    if (seq === refreshSeq.current) setLoaded(true);
  }, [toast]);
  const refreshStats = useCallback(async () => { try { setStats(await api.stats()); } catch { /* ignore */ } }, []);
  const refreshSettings = useCallback(async () => { try { setSettings(await api.settings()); } catch { /* ignore */ } }, []);

  useEffect(() => { refreshProspects(); refreshStats(); refreshSettings(); }, [refreshProspects, refreshStats, refreshSettings]);

  // Follow the URL: the browser back/forward buttons now move between pages, and a shared
  // link opens the page it points at. Unknown hashes fall back to Dashboard in App.jsx.
  useEffect(() => {
    const onHash = () => setViewState(location.hash.replace('#', '') || 'dialer');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const listenersRef = useRef({ saved: new Set(), deleted: new Set() });
  const onProspectSaved = useCallback((fn) => {
    listenersRef.current.saved.add(fn);
    return () => listenersRef.current.saved.delete(fn);
  }, []);
  const onProspectDeleted = useCallback((fn) => {
    listenersRef.current.deleted.add(fn);
    return () => listenersRef.current.deleted.delete(fn);
  }, []);

  // optimistic local patch + server save
  const updateProspect = useCallback(async (id, patch) => {
    setProspects((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    try {
      const saved = await api.updateProspect(id, patch);
      setProspects((list) => list.map((p) => (p.id === id ? { ...p, ...saved } : p)));
      refreshStats();
      for (const fn of listenersRef.current.saved) { try { fn(saved); } catch {} }
      return saved;
    } catch (e) { toast(e.message, 'error'); refreshProspects(); return null; }
  }, [refreshProspects, refreshStats, toast]);

  const patchLocal = useCallback((id, patch) => setProspects((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p))), []);

  // ---- bulk actions from the prospects table ----
  // Both optimistically patch what they can and then reconcile with the server's answer: the
  // response reports what actually changed, so the UI never claims more than it did.
  const bulkStageProspects = useCallback(async (ids, stage) => {
    const list = [...ids];
    if (!list.length) return null;
    setProspects((rows) => rows.map((p) => (list.includes(p.id) ? { ...p, stage } : p)));
    try {
      const r = await api.bulkStage(list, stage);
      await Promise.all([refreshProspects(), refreshStats()]);
      if (r && r.updated !== r.requested) toast(`${r.updated} of ${r.requested} prospects moved`, 'error');
      else toast(`${r?.updated ?? list.length} prospects moved`);
      return r;
    } catch (e) {
      toast(e.message, 'error');
      refreshProspects();               // put the optimistic patch back the way it was
      return null;
    }
  }, [refreshProspects, refreshStats, toast]);

  const bulkMarkDnc = useCallback(async (ids, dnc) => {
    const list = [...ids];
    if (!list.length) return null;
    setProspects((rows) => rows.map((p) => (list.includes(p.id) ? { ...p, dnc: dnc ? 1 : 0 } : p)));
    try {
      // One request per prospect, deliberately: DNC is a per-row PATCH with its own validation,
      // and a bulk endpoint that bypassed it could put a prospect in a state the UI cannot show.
      await Promise.all(list.map((id) => api.updateProspect(id, { dnc })));
      await Promise.all([refreshProspects(), refreshStats()]);
      toast(dnc ? `${list.length} marked Do Not Call` : `${list.length} cleared for calling`);
      return { updated: list.length };
    } catch (e) {
      toast(e.message, 'error');
      refreshProspects();
      return null;
    }
  }, [refreshProspects, refreshStats, toast]);

  const bulkDeleteProspects = useCallback(async (ids) => {
    const list = [...ids];
    if (!list.length) return null;
    try {
      const r = await api.bulkDelete(list);
      // The drawer and the dialer may be showing something that no longer exists.
      setDrawerId((cur) => (list.includes(cur) ? null : cur));
      setActiveId((cur) => (list.includes(cur) ? null : cur));
      await Promise.all([refreshProspects(), refreshStats()]);
      for (const fn of listenersRef.current.deleted) { for (const id of list) { try { fn(id); } catch { /* a listener must not break the delete */ } } }
      toast(`${r?.deleted ?? list.length} prospects deleted${r?.calls ? ` with ${r.calls} call records` : ''}`);
      return r;
    } catch (e) {
      toast(e.message, 'error');
      return null;
    }
  }, [refreshProspects, refreshStats, toast]);

  const openInDialer = useCallback((id) => { setActiveId(id); setDrawerId(null); setView('dialer'); }, [setView]);

  // ---- inbound calls -------------------------------------------------------------------
  // The ringing call lives here because it is not owned by a page: the modal is mounted at the
  // root so a callback rings on Settings just as loudly as on the dialer, and the dialer reads
  // the same object to know that this call did not start with a C keypress.
  const [inbound, setInbound] = useState(null);
  const [inboundEnded, setInboundEnded] = useState(null);   // answered call that has hung up: { callId, prospect }
  const inboundRef = useRef(null);
  inboundRef.current = inbound;

  // Local, instant match for the ringing caller. The server does the authoritative lookup (and
  // provisions an unknown caller); this is what puts a name on screen without waiting for a
  // round trip while the phone is still ringing.
  const findProspectByPhone = useCallback(
    (phone) => (phone ? prospects.find((p) => samePhone(p.phone, phone)) || null : null),
    [prospects],
  );

  // The local outbox is reachable from three places (Settings, the composer's "captured"
  // toast, and the composer itself), so its open state lives here and the modal is rendered
  // once at the root rather than re-mounted per page.
  const [outboxOpen, setOutboxOpen] = useState(false);
  const [outboxFocusId, setOutboxFocusId] = useState(null);   // message to select on open
  const openOutbox = useCallback((focusId = null) => { setOutboxFocusId(focusId); setOutboxOpen(true); }, []);
  const closeOutbox = useCallback(() => { setOutboxOpen(false); setOutboxFocusId(null); }, []);

  const deleteProspect = useCallback(async (id) => {
    try {
      await api.deleteProspect(id);
      setActiveId((cur) => (cur === id ? null : cur));
      setDrawerId((cur) => (cur === id ? null : cur));
      await Promise.all([refreshProspects(), refreshStats()]);
      for (const fn of listenersRef.current.deleted) { try { fn(id); } catch {} }
      toast('Prospect deleted');
    } catch (e) {
      toast(e.message, 'error');
    }
  }, [refreshProspects, refreshStats, toast]);

  // ---- persistent active call state across navigation ----------------
  // When a call is placed or answered, the session lives in store so navigating
  // to Recordings, Recents, or Settings never wipes or loses the in-call cockpit.
  const [activeCall, setActiveCallState] = useState(null);
  const activeCallRef = useRef(null);
  activeCallRef.current = activeCall;

  const setActiveCall = useCallback((call) => {
    setActiveCallState(call);
  }, []);

  const clearActiveCall = useCallback(() => {
    setActiveCallState(null);
  }, []);

  const value = useMemo(() => ({
    prospects, loaded, stats, settings, view, setView, activeId, setActiveId, drawerId, setDrawerId,
    toast, toasts, refreshProspects, refreshStats, refreshSettings, updateProspect, patchLocal, openInDialer, deleteProspect,
    bulkStageProspects, bulkMarkDnc, bulkDeleteProspects,
    onProspectSaved, onProspectDeleted,
    outboxOpen, outboxFocusId, openOutbox, closeOutbox, dismissToast: dismiss,
    inbound, setInbound, inboundRef, inboundEnded, setInboundEnded, findProspectByPhone,
    activeCall, setActiveCall, clearActiveCall, activeCallRef,
  }), [prospects, loaded, stats, settings, view, setView, activeId, drawerId, toast, toasts, refreshProspects, refreshStats, refreshSettings, updateProspect, patchLocal, openInDialer, deleteProspect, bulkStageProspects, bulkMarkDnc, bulkDeleteProspects, onProspectSaved, onProspectDeleted, outboxOpen, outboxFocusId, openOutbox, closeOutbox, dismiss, inbound, inboundEnded, findProspectByPhone, activeCall, setActiveCall, clearActiveCall]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
