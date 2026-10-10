import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { QUEUE_LIMIT, QUEUE_MAX_LIMIT, appendPage, clampLimit } from './queue.js';

const EMPTY_COUNTS = { new: 0, follow: 0, all: 0 };

/**
 * Server-backed, cursor-paginated dialer queue.
 *
 * Replaces the old "download every prospect, filter and sort in the browser"
 * approach: the server owns filtering (tab / search / DNC) and ordering, and
 * this hook only ever holds the pages the dialer has actually asked for.
 *
 * Design notes:
 *  - `itemsRef` mirrors state so callbacks (auto-next, refresh) can read the
 *    current window synchronously instead of capturing a stale closure.
 *  - Every request carries a monotonically increasing token; a response is
 *    discarded unless its token is still the newest. That kills the
 *    fast-typing race where an older search reply lands last and wins.
 *  - In-flight requests are aborted when the tab/search changes or on unmount.
 *  - `refresh()` re-reads the *whole loaded window* in one request, so logging
 *    a call doesn't collapse the list back to page 1 under the user's cursor.
 */
export default function useServerQueue({ tab = 'all', q = '', limit = QUEUE_LIMIT, debounceMs = 250 } = {}) {
  const pageSize = clampLimit(limit);
  const needle = String(q ?? '').trim();

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState(EMPTY_COUNTS);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const itemsRef = useRef([]);
  const cursorRef = useRef(null);
  const hasMoreRef = useRef(false);
  const busyRef = useRef(false);
  const tokenRef = useRef(0);
  const abortRef = useRef(null);

  const commitItems = useCallback((next) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const cancelInflight = useCallback(() => {
    if (abortRef.current) {
      try { abortRef.current.abort(); } catch { /* already settled */ }
      abortRef.current = null;
    }
  }, []);

  // Debounce the search box: one request after typing settles, not one per key.
  const [debounced, setDebounced] = useState(needle);
  useEffect(() => {
    if (needle === debounced) return undefined;
    if (debounceMs <= 0) { setDebounced(needle); return undefined; }
    const t = setTimeout(() => setDebounced(needle), debounceMs);
    return () => clearTimeout(t);
  }, [needle, debounced, debounceMs]);

  const applyMeta = useCallback((r) => {
    cursorRef.current = r.nextCursor || null;
    hasMoreRef.current = !!r.hasMore;
    setHasMore(!!r.hasMore);
    setTotal(Number(r.total) || 0);
    setCounts(r.counts || EMPTY_COUNTS);
  }, []);

  // Load page 1 whenever tab, search or page size changes.
  useEffect(() => {
    cancelInflight();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const token = ++tokenRef.current;
    let alive = true;

    busyRef.current = false;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    commitItems([]);
    cursorRef.current = null;
    hasMoreRef.current = false;
    setHasMore(false);
    setTotal(0);

    api.queue({ tab, q: debounced, limit: pageSize, signal: ctrl.signal })
      .then((r) => {
        if (!alive || token !== tokenRef.current || !r) return;
        commitItems(r.items || []);
        applyMeta(r);
      })
      .catch((e) => {
        if (!alive || token !== tokenRef.current || e?.name === 'AbortError') return;
        setError(e?.message || 'Could not load the queue');
      })
      .finally(() => {
        if (alive && token === tokenRef.current) {
          setLoading(false);
          if (abortRef.current === ctrl) abortRef.current = null;
        }
      });

    return () => { alive = false; cancelInflight(); };
  }, [tab, debounced, pageSize, reloadKey, cancelInflight, commitItems, applyMeta]);

  /** Append the next page. Resolves true when new rows were added. */
  const loadMore = useCallback(async () => {
    if (busyRef.current || !hasMoreRef.current || !cursorRef.current) return false;
    busyRef.current = true;
    setLoadingMore(true);
    const token = ++tokenRef.current;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const r = await api.queue({ tab, q: debounced, limit: pageSize, cursor: cursorRef.current, signal: ctrl.signal });
      if (token !== tokenRef.current || !r) return false; // superseded by a tab/search change
      commitItems(appendPage(itemsRef.current, r.items || []));
      applyMeta(r);
      return true;
    } catch (e) {
      if (token === tokenRef.current && e?.name !== 'AbortError') setError(e?.message || 'Could not load more');
      return false;
    } finally {
      busyRef.current = false;
      if (token === tokenRef.current) {
        setLoadingMore(false);
        if (abortRef.current === ctrl) abortRef.current = null;
      }
    }
  }, [tab, debounced, pageSize, commitItems, applyMeta]);

  /** Re-read the loaded window after a mutation, keeping its size. */
  const refresh = useCallback(async () => {
    const target = Math.max(pageSize, itemsRef.current.length || pageSize);
    cancelInflight();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const token = ++tokenRef.current;
    try {
      // One page is capped at QUEUE_MAX_LIMIT by the server, but the loaded
      // window can be deeper than that after several loadMore() calls. Asking
      // for `target` in a single request used to come back truncated, so a
      // refresh quietly dropped every row past the cap. Walk pages instead.
      const acc = [];
      let cursor = null;
      let last = null;
      for (let guard = 0; guard < 64 && acc.length < target; guard++) {
        const size = clampLimit(Math.min(target - acc.length, QUEUE_MAX_LIMIT));
        const r = await api.queue({ tab, q: debounced, limit: size, cursor, signal: ctrl.signal });
        if (token !== tokenRef.current || !r) return false; // superseded by a tab/search change
        last = r;
        const got = r.items || [];
        acc.push(...got);
        cursor = r.nextCursor || null;
        if (!r.hasMore || !cursor || !got.length) break;
      }
      if (!last) return false;
      commitItems(appendPage([], acc));
      applyMeta(last);
      setError(null);
      return true;
    } catch (e) {
      if (token === tokenRef.current && e?.name !== 'AbortError') setError(e?.message || 'Could not refresh the queue');
      return false;
    } finally {
      // Clearing `loading` here matters: refresh() aborts the page-1 request,
      // and that request's own finally is token-guarded, so without this the
      // hook stays wedged in the loading state and the skeleton never clears.
      if (token === tokenRef.current) {
        setLoading(false);
        if (abortRef.current === ctrl) abortRef.current = null;
      }
    }
  }, [tab, debounced, pageSize, cancelInflight, commitItems, applyMeta]);

  const retry = useCallback(() => { setError(null); setReloadKey((k) => k + 1); }, []);
  const patchItem = useCallback((id, patch) => {
    commitItems(itemsRef.current.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, [commitItems]);
  const removeItem = useCallback((id) => commitItems(itemsRef.current.filter((p) => p.id !== id)), [commitItems]);
  const getItems = useCallback(() => itemsRef.current, []);
  const getState = useCallback(
    () => ({ items: itemsRef.current, hasMore: hasMoreRef.current, nextCursor: cursorRef.current }),
    []
  );

  return useMemo(() => ({
    items, total, counts, hasMore, loading, loadingMore, error,
    loadMore, refresh, retry, patchItem, removeItem, getItems, getState,
  }), [items, total, counts, hasMore, loading, loadingMore, error, loadMore, refresh, retry, patchItem, removeItem, getItems, getState]);
}
