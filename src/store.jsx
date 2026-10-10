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
  // The full prospect list is only needed by the table/kanban pages. The dialer
  // pages its queue from the server, so we must not download everything for it.
  const loadedRef = useRef(false);
  const inflightRef = useRef(null);

  const setView = useCallback((v) => { setViewState(v); history.replaceState(null, '', '#' + v); }, []);

  /**
   * Views no longer all read from one big array: the dialer holds a page of the
   * queue and the drawer holds a single record. These subscriptions let either
   * of them hear about a save or a delete without the store knowing they exist.
   */
  const listeners = useRef({ saved: new Set(), deleted: new Set() });
  const subscribe = useCallback((kind, fn) => {
    listeners.current[kind].add(fn);
    return () => { listeners.current[kind].delete(fn); };
  }, []);
  const onProspectSaved = useCallback((fn) => subscribe('saved', fn), [subscribe]);
  const onProspectDeleted = useCallback((fn) => subscribe('deleted', fn), [subscribe]);
  const emit = useCallback((kind, payload) => {
    for (const fn of [...listeners.current[kind]]) {
      try { fn(payload); } catch { /* one broken listener must not fail the save */ }
    }
  }, []);

  const toast = useCallback((msg, type = 'ok') => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), type === 'error' ? 6000 : 3200);
  }, []);

  /**
   * Re-read the full list, but only if some page has already asked for it.
   * Pass force=true when a screen genuinely needs the whole list right now.
   */
  const refreshProspects = useCallback(async (force = false) => {
    if (!force && !loadedRef.current) return;
    try {
      setProspects(await api.prospects());
      loadedRef.current = true;
      setLoaded(true);
    } catch (e) { toast(e.message, 'error'); }
  }, [toast]);

  /** Load the full list once, on demand, de-duplicating concurrent callers. */
  const ensureProspects = useCallback(() => {
    if (loadedRef.current) return Promise.resolve();
    if (inflightRef.current) return inflightRef.current;
    inflightRef.current = (async () => {
      try {
        setProspects(await api.prospects());
        loadedRef.current = true;
        setLoaded(true);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        inflightRef.current = null;
      }
    })();
    return inflightRef.current;
  }, [toast]);

  const refreshStats = useCallback(async () => { try { setStats(await api.stats()); } catch { /* ignore */ } }, []);
  const refreshSettings = useCallback(async () => { try { setSettings(await api.settings()); } catch { /* ignore */ } }, []);

  useEffect(() => { refreshStats(); refreshSettings(); }, [refreshStats, refreshSettings]);

  // optimistic local patch + server save
  const updateProspect = useCallback(async (id, patch) => {
    setProspects((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    try {
      const saved = await api.updateProspect(id, patch);
      setProspects((list) => list.map((p) => (p.id === id ? { ...p, ...saved } : p)));
      emit('saved', saved);
      refreshStats();
      return saved;
    } catch (e) { toast(e.message, 'error'); refreshProspects(); return null; }
  }, [refreshProspects, refreshStats, toast, emit]);

  const patchLocal = useCallback((id, patch) => setProspects((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p))), []);

  const openInDialer = useCallback((id) => { setActiveId(id); setDrawerId(null); setView('dialer'); }, [setView]);

  const deleteProspect = useCallback(async (id) => {
    try {
      await api.deleteProspect(id);
      setActiveId((cur) => (cur === id ? null : cur));
      setDrawerId((cur) => (cur === id ? null : cur));
      emit('deleted', id);
      await Promise.all([refreshProspects(), refreshStats()]);
      toast('Prospect deleted');
    } catch (e) {
      toast(e.message, 'error');
    }
  }, [refreshProspects, refreshStats, toast, emit]);

  const value = useMemo(() => ({
    prospects, loaded, stats, settings, view, setView, activeId, setActiveId, drawerId, setDrawerId,
    toast, toasts, refreshProspects, ensureProspects, refreshStats, refreshSettings, updateProspect, patchLocal, openInDialer, deleteProspect,
    onProspectSaved, onProspectDeleted,
  }), [prospects, loaded, stats, settings, view, setView, activeId, drawerId, toast, toasts, refreshProspects, ensureProspects, refreshStats, refreshSettings, updateProspect, patchLocal, openInDialer, deleteProspect, onProspectSaved, onProspectDeleted]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
