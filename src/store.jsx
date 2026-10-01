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

  const setView = useCallback((v) => { setViewState(v); history.replaceState(null, '', '#' + v); }, []);

  const toast = useCallback((msg, type = 'ok') => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), type === 'error' ? 6000 : 3200);
  }, []);

  const refreshProspects = useCallback(async () => {
    try { setProspects(await api.prospects()); } catch (e) { toast(e.message, 'error'); }
    setLoaded(true);
  }, [toast]);
  const refreshStats = useCallback(async () => { try { setStats(await api.stats()); } catch { /* ignore */ } }, []);
  const refreshSettings = useCallback(async () => { try { setSettings(await api.settings()); } catch { /* ignore */ } }, []);

  useEffect(() => { refreshProspects(); refreshStats(); refreshSettings(); }, [refreshProspects, refreshStats, refreshSettings]);

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
