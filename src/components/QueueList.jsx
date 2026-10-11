import React, { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Check, ChevronDown, Loader2, RefreshCw } from 'lucide-react';
import { Avatar } from './ui.jsx';
import { stageMeta } from '../utils.js';

const asSet = (done) => (done instanceof Set ? done : new Set(done || []));

/** Shimmer rows shown while page 1 is in flight. */
export function QueueSkeleton({ rows = 6 }) {
  return (
    <div className="queue-skeleton" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="q-skel" key={i} style={{ opacity: 1 - i * 0.12 }}>
          <span className="q-skel-avatar" />
          <span className="q-skel-lines"><i /><i /></span>
        </div>
      ))}
    </div>
  );
}

/**
 * The dialer's queue column.
 * Accessible with IntersectionObserver sentinel and accessible Load more button.
 */
export default function QueueList({
  items = [],
  activeId = null,
  done,
  locked = false,
  total = 0,
  hasMore = false,
  loading = false,
  loadingMore = false,
  error = null,
  onSelect = () => {},
  onLoadMore = () => {},
  onRetry = () => {},
  activeItemRef = null,
}) {
  const doneIds = asSet(done);
  const sentinelRef = useRef(null);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;
  const canLoadRef = useRef(false);
  canLoadRef.current = hasMore && !loadingMore && !loading;

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && canLoadRef.current) loadMoreRef.current?.();
      },
      { root: el.closest('.queue-list') || null, rootMargin: '240px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const showingFirstPage = loading && items.length === 0;

  return (
    <div className="queue-list" aria-label="Dial queue" aria-busy={loading || loadingMore || undefined}>
      {showingFirstPage ? <QueueSkeleton /> : null}

      {!showingFirstPage && items.map((p) => {
        const on = activeId === p.id;
        const isDone = doneIds.has(p.id);
        const cls = ['q-item', on && 'on', isDone && 'done'].filter(Boolean).join(' ');
        return (
          <button
            type="button"
            key={p.id}
            ref={on ? activeItemRef : null}
            disabled={locked && !on}
            aria-current={on ? 'true' : undefined}
            className={cls}
            title={on ? 'Currently selected' : 'Select to dial'}
            onClick={() => !locked && onSelect(p.id)}
          >
            {on && <motion.span layoutId="qpill" className="q-pill" transition={{ type: 'spring', stiffness: 400, damping: 36 }} />}
            <Avatar name={p.name || p.company} size={34} seed={p.id + p.name} />
            <div className="q-txt">
              <b>{p.name || '(no name)'}</b>
              <span>{p.company || p.phone}</span>
            </div>
            {/* A lead with no number cannot be dialled, so say so on the row rather than
                letting the agent discover it by pressing C. */}
            {!p.phone && <span className="q-nonum" title="No phone number yet — add one to dial this lead">no number</span>}
            {isDone ? <Check size={16} className="q-check" /> : <i className="dot" style={{ background: stageMeta(p.stage).color }} />}
          </button>
        );
      })}

      {error && !showingFirstPage ? (
        <div className="queue-error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn xs" onClick={onRetry}><RefreshCw size={12} /> Retry</button>
        </div>
      ) : null}

      {!loading && !error && items.length === 0 ? (
        <div className="muted small center pad">Nobody here. Try another tab or add one above.</div>
      ) : null}

      {hasMore ? (
        <button type="button" className="btn sm load-more" onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? <Loader2 size={14} className="spin" /> : <ChevronDown size={14} />}
          {loadingMore ? 'Loading…' : 'Load more'}
          {total ? <em className="load-more-count">{items.length}/{total}</em> : null}
        </button>
      ) : null}

      {!hasMore && !loading && items.length > 0 ? (
        <div className="queue-end muted small center">
          {total && items.length < total ? `Showing ${items.length} of ${total}` : 'End of queue'}
        </div>
      ) : null}

      <div className="queue-sentinel" ref={sentinelRef} aria-hidden="true" />
    </div>
  );
}
