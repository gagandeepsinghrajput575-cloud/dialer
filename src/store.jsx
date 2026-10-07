import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';

const Ctx = createContext(null);
export const useStore = () => useContext(Ctx);

export function StoreProvider({ children }) {
  const [prospects, setProspects] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [stats, setStats] = useState(null);
  const [settings, setSettings] = useState(null);
  const [view, setViewState] = useState(() => (location.hash.replace('#', '') || 'dashboard'));
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
  const startTimer = useCallback((id, type) => {
    toastTimers.current.set(id, setTimeout(() => dismiss(id), type === 'error' ? 6000 : 3200));
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
  const toast = useCallback((msg, type = 'ok') => {
    setToasts((t) => {
      const last = t[t.length - 1];
      // Merging a repeat must be pure: the previous version mutated the existing object and
      // reassigned its `id`, which is the React key — that remounted the node mid-animation
      // and, under StrictMode (where updaters run twice), double-counted the repeat.
      if (last && last.msg === msg && last.type === type) {
        const merged = t.slice(0, -1).concat({ ...last, repeats: (last.repeats || 1) + 1 });
        restartTimer(last.id, type);
        return merged;
      }
      const id = ++toastId.current;
      startTimer(id, type);
      const next = [...t, { id, msg, type, repeats: 1 }];
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
    const onHash = () => setViewState(location.hash.replace('#', '') || 'dashboard');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // optimistic local patch + server save
  const updateProspect = useCallback(async (id, patch) => {
    setProspects((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    try {
      const saved = await api.updateProspect(id, patch);
      setProspects((list) => list.map((p) => (p.id === id ? { ...p, ...saved } : p)));
      refreshStats();
      return saved;
    } catch (e) { toast(e.message, 'error'); refreshProspects(); return null; }
  }, [refreshProspects, refreshStats, toast]);

  const patchLocal = useCallback((id, patch) => setProspects((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p))), []);

  const openInDialer = useCallback((id) => { setActiveId(id); setDrawerId(null); setView('dialer'); }, [setView]);

  const deleteProspect = useCallback(async (id) => {
    try {
      await api.deleteProspect(id);
      setActiveId((cur) => (cur === id ? null : cur));
      setDrawerId((cur) => (cur === id ? null : cur));
      await Promise.all([refreshProspects(), refreshStats()]);
      toast('Prospect deleted');
    } catch (e) {
      toast(e.message, 'error');
    }
  }, [refreshProspects, refreshStats, toast]);

  const value = useMemo(() => ({
    prospects, loaded, stats, settings, view, setView, activeId, setActiveId, drawerId, setDrawerId,
    toast, toasts, refreshProspects, refreshStats, refreshSettings, updateProspect, patchLocal, openInDialer, deleteProspect,
  }), [prospects, loaded, stats, settings, view, setView, activeId, drawerId, toast, toasts, refreshProspects, refreshStats, refreshSettings, updateProspect, patchLocal, openInDialer, deleteProspect]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
