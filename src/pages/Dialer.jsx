import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  PhoneOff, Voicemail, Ban, ShieldHalf, PhoneMissed, MessagesSquare,
  CalendarCheck, OctagonX, Circle, Phone, PhoneCall, Search,
  ChevronLeft, ChevronRight, Check, SkipForward, Upload, Sparkles,
  Loader2, Keyboard, Mail, Building2, NotebookPen, Plus, X
} from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store.jsx';
import ProspectCard from '../components/ProspectCard.jsx';
import QueueList from '../components/QueueList.jsx';
import Notes, { CallHistory, useDetail } from '../components/Notes.jsx';
import { Avatar, Editable, Empty, Switch } from '../components/ui.jsx';
import useServerQueue from '../useServerQueue.js';
import { QUEUE_TABS, QUEUE_LIMIT, firstFreshId, pickNextId, queueTab, stepIndex, tabForProspect } from '../queue.js';
import { OUTCOMES, STAGES, fmtDur, useTimer } from '../utils.js';

const ICONS = { PhoneOff, Voicemail, Ban, ShieldHalf, PhoneMissed, MessagesSquare, CalendarCheck, OctagonX };

function Waveform({ active }) {
  return (
    <div className={`wave ${active ? 'on' : ''}`}>
      {Array.from({ length: 24 }).map((_, i) => (
        <motion.i
          key={i}
          animate={active ? { scaleY: [0.25, 1, 0.35, 0.8, 0.25] } : { scaleY: 0.2 }}
          transition={active ? { duration: 1.1 + (i % 5) * 0.15, repeat: Infinity, delay: i * 0.04, ease: 'easeInOut' } : { duration: 0.3 }}
        />
      ))}
    </div>
  );
}

function QuickAddModal({ onClose, onAdded }) {
  const [f, setF] = useState({ name: '', phone: '', email: '', company: '', title: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((prev) => ({ ...prev, [k]: e.target.value }));

  const save = async () => {
    if (!f.phone.trim() && !f.name.trim()) return;
    setBusy(true);
    try {
      await onAdded(f);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div className="modal glass" initial={{ opacity: 0, scale: 0.94, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }}>
        <div className="modal-head">
          <h3>Add prospect to queue</h3>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="form">
          <label>Name<input autoFocus value={f.name} onChange={set('name')} placeholder="Full name" /></label>
          <label>Phone<input value={f.phone} onChange={set('phone')} placeholder="+91 98100 12345" /></label>
          <label>Email<input value={f.email} onChange={set('email')} placeholder="name@company.com" /></label>
          <div className="two">
            <label>Company<input value={f.company} onChange={set('company')} /></label>
            <label>Title<input value={f.title} onChange={set('title')} /></label>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy || (!f.name.trim() && !f.phone.trim())}>
            {busy ? <Loader2 size={15} className="spin" /> : null} Add to queue
          </button>
        </div>
      </motion.div>
    </>
  );
}

export default function Dialer() {
  const {
    activeId, setActiveId, refreshStats, toast, setView, settings, updateProspect, patchLocal, stats,
    onProspectSaved, onProspectDeleted,
  } = useStore();
  const [tab, setTab] = useState('new');
  const [q, setQ] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | dialing | active
  const [callId, setCallId] = useState(null);
  const [autoNext, setAutoNext] = useState(true);
  const [flash, setFlash] = useState(null);
  const [noteFocus, setNoteFocus] = useState(0);
  const [quickNote, setQuickNote] = useState('');
  const [classifyModal, setClassifyModal] = useState(null); // { callId, duration, prospect }
  const [targetStage, setTargetStage] = useState('');
  const [customNote, setCustomNote] = useState('');
  const [showAdd, setShowAdd] = useState(false);

  const sec = useTimer(phase === 'active');
  const secRef = useRef(0);
  secRef.current = sec;
  const quickNoteRef = useRef('');
  quickNoteRef.current = quickNote;
  const activeItemRef = useRef(null);

  // Prospects dialed this session: dimmed in the list and skipped by auto-next.
  // A ref is the source of truth so callbacks never read a stale Set.
  const doneRef = useRef(new Set());
  const [done, setDone] = useState(() => doneRef.current);
  const markDone = useCallback((id) => {
    if (id == null || doneRef.current.has(id)) return;
    doneRef.current.add(id);
    setDone(new Set(doneRef.current));
  }, []);

  // The queue itself now lives on the server: tab, search, DNC filtering,
  // ordering and paging are all done by GET /api/queue.
  const queue = useServerQueue({ tab, q, limit: QUEUE_LIMIT });
  const { items, total, counts, hasMore, loading, loadingMore, error } = queue;

  // A selected prospect can sit outside the loaded page (opened from the
  // Prospects table, or just added). Fetch that one record on demand so the
  // centre stage never blanks out or silently shows somebody else.
  const [pinned, setPinned] = useState(null);
  const [pinState, setPinState] = useState('idle'); // idle | loading | ready | missing
  const pinnedRef = useRef(null);
  pinnedRef.current = pinned;
  const pinTriedRef = useRef(new Set());

  useEffect(() => {
    if (!activeId) {
      if (pinnedRef.current) setPinned(null);
      setPinState('idle');
      return undefined;
    }
    if (items.some((p) => p.id === activeId)) {
      if (pinnedRef.current?.id === activeId) setPinned(null);
      pinTriedRef.current.delete(activeId);
      setPinState('idle');
      return undefined;
    }
    if (pinnedRef.current?.id === activeId) { setPinState('ready'); return undefined; }
    if (pinTriedRef.current.has(activeId)) { setPinState('missing'); return undefined; }

    let cancelled = false;
    pinTriedRef.current.add(activeId);
    setPinState('loading');
    api.prospect(activeId)
      .then((p) => { if (!cancelled && p) { setPinned(p); setPinState('ready'); } })
      .catch((e) => {
        if (cancelled) return;
        if (e?.status === 404) {
          setPinned(null);
          setPinState('missing');
        } else {
          // Transient failure: allow a retry and keep the dialer usable.
          pinTriedRef.current.delete(activeId);
          setPinned(null);
          setPinState('error');
        }
      });
    return () => { cancelled = true; };
  }, [activeId, items]);

  // The selected prospect was deleted elsewhere — release the selection so the
  // top of the queue takes over instead of showing a blank stage.
  useEffect(() => {
    if (pinState !== 'missing' || !activeId) return;
    setPinState('idle');
    setActiveId(null);
    toast('That prospect is no longer available.', 'error');
  }, [pinState, activeId, setActiveId, toast]);

  const active = useMemo(() => {
    if (activeId) {
      const match = items.find((p) => p.id === activeId);
      if (match) return match;
      if (pinned && pinned.id === activeId) return pinned;
      // Could not pin it (network): fall back rather than blanking the stage.
      if (pinState === 'error') return items[0] || null;
      return null; // still resolving — never fall back to a different person
    }
    return items[0] || null;
  }, [items, activeId, pinned, pinState]);

  const { detail, reload } = useDetail(active?.id);

  // Auto-scroll the active queue item into view smoothly
  useEffect(() => {
    if (activeItemRef.current) {
      activeItemRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [active?.id]);

  // Edits and deletes can come from anywhere (drawer, prospects table), and the
  // dialer no longer holds the full list to see them happen — so keep the loaded
  // window in step through the store's save/delete notifications.
  useEffect(() => onProspectSaved((p) => { if (p?.id != null) queue.patchItem(p.id, p); }), [onProspectSaved, queue]);
  useEffect(() => onProspectDeleted((id) => queue.removeItem(id)), [onProspectDeleted, queue]);

  // Synchronize tab when activeId changes externally (e.g. Prospects table 'Call')
  useEffect(() => {
    if (!activeId) return;
    // Never chase a prospect we have just finished: logging an outcome moves it
    // to another tab, and following it there would yank the whole queue away
    // from the list the user is working through (and break auto-next).
    if (doneRef.current.has(activeId)) return;
    const target = items.find((p) => p.id === activeId) || (pinned?.id === activeId ? pinned : null);
    if (!target) return;
    const curTab = queueTab(tab);
    if (curTab && !curTab.test(target)) {
      const next = tabForProspect(target);
      if (next && next !== tab) setTab(next);
    }
  }, [activeId, items, pinned, tab]);

  // Switching tabs reloads page 1; clearing activeId lets its top row take over.
  const handleTabChange = useCallback((newTabId) => {
    if (newTabId === tab) return;
    if (phase !== 'idle' || classifyModal) return toast('Finish or classify this call first.', 'error');
    setTab(newTabId);
    setActiveId(null);
    setPinned(null);
    setPinState('idle');
  }, [tab, phase, classifyModal, setActiveId, toast]);

  /**
   * Next prospect to show, skipping anything already dialed. When the walk runs
   * off the end of the loaded window it fetches the next page and continues, so
   * auto-next works across page boundaries. Falls back to wrapping around, and
   * finally to the top row, so the dialer can never get stuck.
   */
  const advance = useCallback(async (fromId, fromIndex = -1) => {
    let list = queue.getItems();
    if (!list.length) return null;
    const idx = fromId == null ? -1 : list.findIndex((p) => p.id === fromId);

    // Logging an outcome usually moves that prospect to another tab, so after a
    // refresh it is gone from the window and its old index is meaningless.
    // Resume from the row that slid into its place rather than jumping back to
    // the top of the queue — `fromIndex` is the position captured beforehand.
    if (idx === -1 && fromIndex >= 0) {
      for (let i = Math.min(fromIndex, list.length - 1); i < list.length; i++) {
        if (!doneRef.current.has(list[i].id)) return list[i].id;
      }
    }

    let pick = pickNextId(list, fromId, doneRef.current);
    if (!pick.id && pick.hitEnd && queue.getState().hasMore) {
      const added = await queue.loadMore();
      if (added) {
        list = queue.getItems();
        pick = pickNextId(list, fromId, doneRef.current);
      }
    }
    return pick.id ?? firstFreshId(list, doneRef.current) ?? list[0]?.id ?? null;
  }, [queue]);

  const go = useCallback((dir) => {
    if (phase !== 'idle' || classifyModal) return toast('Finish or classify this call first.', 'error');
    const list = queue.getItems();
    if (!list.length) return;
    if (dir > 0) {
      advance(active?.id ?? null).then((id) => { if (id != null) setActiveId(id); });
      return undefined;
    }
    // Backwards never skips dialed prospects: it is an explicit "go back".
    const i = list.findIndex((p) => p.id === active?.id);
    const at = stepIndex(list.length, i, -1);
    if (at >= 0) setActiveId(list[at].id);
    return undefined;
  }, [phase, classifyModal, queue, active, advance, setActiveId, toast]);

  const startCall = useCallback(async () => {
    if (!active || phase !== 'idle' || classifyModal) return;
    if (active.dnc) return toast('This prospect is marked Do Not Call.', 'error');
    if (!active.phone) return toast('No phone number for this prospect.', 'error');
    setPhase('dialing');
    try {
      const r = await api.call(active.id);
      setCallId(r.callId);
      setPhase('active');
      patchLocal(active.id, { call_count: active.call_count + 1, last_called_at: new Date().toISOString() });
      queue.patchItem(active.id, { call_count: (active.call_count || 0) + 1, last_called_at: new Date().toISOString() });
      toast(r.dryRun ? 'Test mode: call simulated' : 'Calling… answer your phone/SIP to connect');
    } catch (e) {
      setPhase('idle');
      toast(e.message, 'error');
      refreshStats();
    }
  }, [active, phase, classifyModal, toast, patchLocal, refreshStats]);

  // When clicking hang up button, open the classification modal
  const hangUp = useCallback(() => {
    if (phase !== 'active' || !callId || !active) return;
    const dur = secRef.current;
    setPhase('idle');
    setTargetStage(active.stage || 'contacted');
    setCustomNote(quickNoteRef.current.trim());
    setClassifyModal({
      callId,
      duration: dur,
      prospect: active,
    });
  }, [phase, callId, active]);

  // Discard an active or hung-up call without polluting stats or history
  const handleDiscardCall = useCallback(async () => {
    const idToDiscard = classifyModal ? classifyModal.callId : callId;
    if (idToDiscard) {
      try {
        await api.discardCall(idToDiscard);
      } catch {
        /* ignore */
      }
    }
    setPhase('idle');
    setCallId(null);
    setClassifyModal(null);
    setQuickNote('');
    toast('Call discarded');
    await Promise.all([queue.refresh(), refreshStats()]);
  }, [classifyModal, callId, toast, queue, refreshStats]);

  const commitClassification = useCallback(async (outcomeId, chosenStage, noteText) => {
    if (!classifyModal) return;
    const o = OUTCOMES.find((x) => x.id === outcomeId) || OUTCOMES[0];
    const pid = classifyModal.prospect.id;
    const nextStage = chosenStage || classifyModal.prospect.stage;
    markDone(pid);
    // Plan the next target *before* refreshing: logging an outcome can move this
    // prospect out of the current tab, and that must not change where we go next.
    const listBefore = queue.getItems();
    const planned = pickNextId(listBefore, pid, doneRef.current);
    const plannedIndex = listBefore.findIndex((p) => p.id === pid);

    try {
      await api.logCall(classifyModal.callId, { outcome: outcomeId, duration_sec: classifyModal.duration });
      if (chosenStage && chosenStage !== classifyModal.prospect.stage) {
        await updateProspect(pid, { stage: chosenStage });
      }
      const noteToSave = (noteText || '').trim();
      if (noteToSave) {
        await api.addNote(pid, noteToSave);
      }
      setFlash({ label: o.label, color: o.color, id: Date.now() });
      setTimeout(() => setFlash(null), 1400);
      setQuickNote('');
      setClassifyModal(null);
      setCallId(null);
      // optimistic, then reconciled by the refresh below
      queue.patchItem(pid, { last_outcome: outcomeId, stage: nextStage });
      await Promise.all([queue.refresh(), refreshStats(), reload()]);
      if (autoNext && outcomeId !== 'meeting_booked') {
        let target = planned.id;
        if (target == null || !queue.getItems().some((p) => p.id === target)) target = await advance(pid, plannedIndex);
        if (target != null) setTimeout(() => setActiveId(target), 750);
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }, [classifyModal, queue, markDone, advance, updateProspect, autoNext, setActiveId, refreshStats, reload, toast]);

  // Direct outcome logging (from 1-8 keys or outcome buttons during active call)
  const logOutcome = useCallback(async (outcome) => {
    if (classifyModal) {
      commitClassification(outcome, targetStage, customNote);
      return;
    }
    if (phase !== 'active' || !callId || !active) return;
    const o = OUTCOMES.find((x) => x.id === outcome);
    const finished = active.id;
    markDone(finished);
    const listBefore = queue.getItems();
    const planned = pickNextId(listBefore, finished, doneRef.current);
    const plannedIndex = listBefore.findIndex((p) => p.id === finished);
    const noteToSave = quickNoteRef.current.trim();
    try {
      await api.logCall(callId, { outcome, duration_sec: secRef.current });
      if (noteToSave) {
        await api.addNote(finished, noteToSave);
      }
      setFlash({ label: o.label, color: o.color, id: Date.now() });
      setTimeout(() => setFlash(null), 1300);
      setPhase('idle');
      setCallId(null);
      setQuickNote('');
      queue.patchItem(finished, { last_outcome: outcome });
      await Promise.all([queue.refresh(), refreshStats(), reload()]);
      if (autoNext && outcome !== 'meeting_booked') {
        let target = planned.id;
        if (target == null || !queue.getItems().some((p) => p.id === target)) target = await advance(finished, plannedIndex);
        if (target != null) setTimeout(() => setActiveId(target), 750);
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }, [classifyModal, commitClassification, targetStage, customNote, phase, callId, active, queue, markDone, advance, autoNext, setActiveId, refreshStats, reload, toast]);

  // Save quick live note directly to prospect record
  const saveQuickNoteNow = async () => {
    const t = quickNote.trim();
    if (!t || !active) return;
    try {
      await api.addNote(active.id, t);
      setQuickNote('');
      await reload?.();
      toast('Note saved to prospect');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  // Quick add from dialer queue
  const handleQuickAdd = async (newProspectData) => {
    const p = await api.addProspect(newProspectData);
    await Promise.all([queue.refresh(), refreshStats()]);
    toast('Prospect added to queue');
    if (p && p.id) {
      // A brand new row sorts last (highest id) so it can land past the loaded
      // page; the pin fetch resolves it while the queue window catches up.
      pinTriedRef.current.delete(p.id);
      setPinned(null);
      setActiveId(p.id);
    }
  };

  // Comprehensive keyboard shortcut routing
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }

      // Modal keyboard handling
      if (classifyModal) {
        if (e.key === 'Escape') {
          e.preventDefault();
          handleDiscardCall();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          commitClassification('conversation', targetStage, customNote);
        } else if (/^[1-8]$/.test(e.key)) {
          e.preventDefault();
          commitClassification(OUTCOMES[Number(e.key) - 1].id, targetStage, customNote);
        }
        return;
      }

      // Normal stage shortcuts
      if (e.key === 'c') {
        e.preventDefault();
        if (phase === 'idle') startCall();
        else if (phase === 'active') hangUp();
      } else if (e.key === 'h' && phase === 'active') {
        e.preventDefault();
        hangUp();
      } else if (e.key === 'ArrowRight') {
        go(1);
      } else if (e.key === 'ArrowLeft') {
        go(-1);
      } else if (e.key === 'n') {
        e.preventDefault();
        document.getElementById('top-quick-note')?.focus();
      } else if (/^[1-8]$/.test(e.key) && phase === 'active') {
        logOutcome(OUTCOMES[Number(e.key) - 1].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, classifyModal, startCall, hangUp, go, logOutcome, handleDiscardCall, commitClassification, targetStage, customNote]);

  if (stats && stats.total === 0) {
    return (
      <Empty icon={<PhoneCall size={34} />} title="No prospects to dial yet" sub="Upload your list and every prospect's details will appear here while you call.">
        <div className="row gap">
          <button className="btn primary" onClick={() => setView('import')}><Upload size={16} /> Import a list</button>
          <button className="btn" onClick={async () => { await api.demo(); await Promise.all([queue.refresh(), refreshStats()]); }}><Sparkles size={16} /> Load demo data</button>
        </div>
      </Empty>
    );
  }

  const calling = phase !== 'idle';
  const dry = settings?.dry_run === '1';
  // Page 1 in flight, or the selected prospect is being fetched from outside it.
  const resolving = (!!activeId && pinState === 'loading') || (loading && !items.length && !error);

  return (
    <div className="dialer">
      {/* QUEUE SIDEBAR */}
      <section className="glass queue">
        {/* A segmented filter, not a tab strip: there is no tabpanel to control,
            so use a group of toggle buttons rather than an invalid role="tablist". */}
        <div className="seg" role="group" aria-label="Queue filter">
          {QUEUE_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={tab === t.id}
              className={tab === t.id ? 'on' : ''}
              onClick={() => handleTabChange(t.id)}
              title={`${t.label}: ${counts[t.id] ?? 0}`}
            >
              {tab === t.id && <motion.span layoutId="segpill" className="seg-pill" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
              <span>{t.label}</span>
              {counts[t.id] ? <em className="seg-count">{counts[t.id]}</em> : null}
            </button>
          ))}
        </div>
        <div className="search">
          <Search size={15} />
          <input
            type="search"
            placeholder="Search queue…"
            aria-label="Search the dial queue"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="queue-meta">
          <span>{loading && !items.length ? 'Loading…' : `${total} in queue`}</span>
          <span>{done.size} dialed</span>
          <button className="btn xs primary" onClick={() => setShowAdd(true)} title="Add prospect directly to queue"><Plus size={12} /> Add</button>
        </div>
        <QueueList
          items={items}
          activeId={active?.id ?? null}
          done={done}
          locked={calling || !!classifyModal}
          total={total}
          hasMore={hasMore}
          loading={loading}
          loadingMore={loadingMore}
          error={error}
          onSelect={setActiveId}
          onLoadMore={queue.loadMore}
          onRetry={queue.retry}
          activeItemRef={activeItemRef}
        />
      </section>

      {/* CENTER STAGE */}
      <section className="stage">
        {active ? (
          <>
            {/* PROMINENT TOP HERO HEADER - NAME & EMAIL ALWAYS VISIBLE */}
            <div className="glass top-prospect-banner">
              <div className="banner-left">
                <Avatar name={active.name || active.company} size={64} seed={active.id + active.name} />
                <div className="banner-titles">
                  <div className="banner-name-row">
                    <h2 className="banner-name">{active.name || 'Unnamed Prospect'}</h2>
                    {active.title && <span className="banner-title-badge">{active.title}</span>}
                    {active.dnc && <span className="dnc-badge sm"><Ban size={12} /> DNC</span>}
                  </div>
                  <div className="banner-contacts">
                    {active.phone ? (
                      <span className="banner-phone-chip">
                        <Phone size={14} /> <Editable className="banner-phone-edit" value={active.phone} placeholder="+91…" onSave={(v) => updateProspect(active.id, { phone: v })} />
                      </span>
                    ) : (
                      <span className="banner-phone-chip missing">
                        <Phone size={14} /> <Editable className="banner-phone-edit" value="" placeholder="Click to add phone (+91…)" onSave={(v) => updateProspect(active.id, { phone: v })} />
                      </span>
                    )}
                    {active.email ? (
                      <a href={`mailto:${active.email}`} className="banner-email-chip" title="Click to email">
                        <Mail size={14} /> <span>{active.email}</span>
                      </a>
                    ) : (
                      <span className="banner-email-chip muted"><Mail size={14} /> <span>No email listed</span></span>
                    )}
                    {active.company && (
                      <span className="banner-company-chip">
                        <Building2 size={14} /> <span>{active.company}</span>
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* QUICK TOP NOTES BOX - ALWAYS AT THE TOP */}
              <div className="top-notes-box">
                <div className="top-notes-head">
                  <label htmlFor="top-quick-note"><NotebookPen size={14} /> <b>Live Notes</b> <small>(synced with lower notes)</small></label>
                  {quickNote.trim() && (
                    <button className="btn sm primary" onClick={saveQuickNoteNow}>Save now</button>
                  )}
                </div>
                <textarea
                  id="top-quick-note"
                  rows={2}
                  className="top-notes-input"
                  placeholder="Type notes as you talk… (Press N to focus)"
                  value={quickNote}
                  onChange={(e) => setQuickNote(e.target.value)}
                />
              </div>
            </div>

            {/* CALL BAR */}
            <div className={`glass callbar ${phase}`}>
              <div className="callbar-glow" />
              <div className="callbar-top">
                <div>
                  <div className="eyebrow">{phase === 'idle' ? 'Ready to dial' : phase === 'dialing' ? 'Connecting…' : 'Call in progress'}</div>
                  <div className="callnum">{active.phone || 'No number (add phone above)'}</div>
                  <div className="callwho">
                    <strong>{active.name}</strong>
                    {active.email ? ` · ${active.email}` : ''}
                    {active.company ? ` · ${active.company}` : ''}
                  </div>
                </div>
                <div className="callctl">
                  <div className="timer">{phase === 'active' ? fmtDur(sec) : '0:00'}</div>
                  <div className="row gap">
                    <button className="icon-btn" onClick={() => go(-1)} disabled={calling || !!classifyModal} title="Previous (←)"><ChevronLeft size={18} /></button>
                    <div className="call-wrap">
                      {phase === 'active' && <><span className="ring r1" /><span className="ring r2" /></>}
                      <motion.button
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.94 }}
                        className={`call-btn ${phase === 'active' ? 'hangup-active' : phase}`}
                        onClick={phase === 'active' ? hangUp : startCall}
                        disabled={(phase === 'dialing') || active.dnc || !active.phone}
                        title={phase === 'active' ? "Hang up & Classify (H or C)" : active.phone ? "Call (C)" : "Add phone number to dial"}
                      >
                        {phase === 'dialing' ? (
                          <Loader2 size={26} className="spin" />
                        ) : phase === 'active' ? (
                          <PhoneOff size={26} />
                        ) : (
                          <Phone size={26} />
                        )}
                      </motion.button>
                    </div>
                    <button className="icon-btn" onClick={() => go(1)} disabled={calling || !!classifyModal} title="Next (→)"><ChevronRight size={18} /></button>
                  </div>
                </div>
              </div>
              <Waveform active={phase === 'active'} />

              <div className="outcome-head">
                <span>{phase === 'active' ? 'Click Hangup (Red) or pick a result below to classify:' : 'Call results unlock when a call starts'}</span>
                <label className="auto-next"><span>Auto-next</span><Switch checked={autoNext} onChange={setAutoNext} /></label>
              </div>
              <div className={`outcomes ${phase === 'active' ? 'live' : ''}`}>
                {OUTCOMES.map((o) => {
                  const Icon = ICONS[o.icon] || Circle;
                  return (
                    <motion.button key={o.id} whileTap={{ scale: 0.94 }} disabled={phase !== 'active'} className="outcome" style={{ '--c': o.color }} onClick={() => logOutcome(o.id)}>
                      <Icon size={17} /><span>{o.label}</span><kbd>{o.key}</kbd>
                    </motion.button>
                  );
                })}
              </div>
              {phase === 'active' && (
                <div className="row gap justify-between" style={{ marginTop: '10px' }}>
                  <button className="btn danger sm" onClick={hangUp}><PhoneOff size={14} /> Hang Up & Classify</button>
                  <button className="link-btn" onClick={handleDiscardCall}><SkipForward size={13} /> Discard without logging</button>
                </div>
              )}
              {dry && phase === 'idle' && <div className="hint-dry">Test mode is on. Calls are simulated. Turn it off in Settings when ready to dial live.</div>}
              <AnimatePresence>
                {flash && (
                  <motion.div key={flash.id} className="flash" style={{ '--c': flash.color }} initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.1 }}>
                    <Check size={20} /> Logged: {flash.label}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* FULL DETAILS CARD */}
            <div className="glass card-wrap">
              <ProspectCard p={active} big />
              <div className="kbd-hint"><Keyboard size={13} /> <kbd>C</kbd> call/hangup · <kbd>1-8</kbd> classify · <kbd>←</kbd><kbd>→</kbd> navigate · <kbd>N</kbd> notes</div>
            </div>
          </>
        ) : resolving ? (
          <div className="glass pad-lg stage-loading" aria-live="polite">
            <Loader2 size={18} className="spin" /> <span>Loading prospect…</span>
          </div>
        ) : (
          <Empty icon={<Search size={30} />} title="Nobody matches" sub="Change the tab, clear the search, or add a prospect to start calling.">
            <button className="btn primary" onClick={() => setShowAdd(true)}><Plus size={16} /> Add a prospect</button>
          </Empty>
        )}
      </section>

      {/* RIGHT SIDEBAR */}
      <section className="side-right">
        {active && (
          <>
            <div className="glass pad-lg">
              <Notes
                key={active.id}
                pid={active.id}
                notes={detail?.notes || []}
                reload={reload}
                autoFocusKey={noteFocus}
                draftValue={quickNote}
                onDraftChange={setQuickNote}
              />
            </div>
            <div className="glass pad-lg"><CallHistory calls={detail?.calls || []} /></div>
          </>
        )}
      </section>

      {/* CLASSIFICATION MODAL ON HANG UP */}
      <AnimatePresence>
        {classifyModal && (
          <>
            <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={handleDiscardCall} />
            <motion.div className="modal classify-modal" initial={{ opacity: 0, scale: 0.95, y: -20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: -20 }}>
              <div className="modal-head">
                <div>
                  <div className="eyebrow" style={{ color: '#38bdf8' }}>Call Finished ({fmtDur(classifyModal.duration)})</div>
                  <h3 style={{ fontSize: '20px', fontWeight: 800 }}>How would you classify {classifyModal.prospect.name || 'this prospect'}?</h3>
                </div>
                <button className="icon-btn" onClick={handleDiscardCall} title="Discard call"><X size={16} /></button>
              </div>

              <div className="classify-content">
                <label className="classify-label">1. Choose Call Outcome</label>
                <div className="classify-outcomes-grid">
                  {OUTCOMES.map((o) => {
                    const Icon = ICONS[o.icon] || Circle;
                    return (
                      <button
                        key={o.id}
                        type="button"
                        className="outcome live"
                        style={{ '--c': o.color }}
                        onClick={() => commitClassification(o.id, targetStage, customNote)}
                      >
                        <Icon size={18} />
                        <span>{o.label}</span>
                        <kbd>{o.key}</kbd>
                      </button>
                    );
                  })}
                </div>

                <div className="classify-section" style={{ marginTop: '16px' }}>
                  <label className="classify-label">2. Move Pipeline Stage (optional)</label>
                  <div className="stage-picker">
                    {STAGES.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className={`stage-pill ${targetStage === s.id ? 'on' : ''}`}
                        style={{ '--c': s.color }}
                        onClick={() => setTargetStage(s.id)}
                      >
                        <i />{s.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="classify-section" style={{ marginTop: '16px' }}>
                  <label className="classify-label">3. Call Notes / Takeaway</label>
                  <textarea
                    rows={3}
                    className="classify-note-input"
                    placeholder="Enter any notes from the call (will be saved directly to prospect history)…"
                    value={customNote}
                    onChange={(e) => setCustomNote(e.target.value)}
                  />
                </div>
              </div>

              <div className="modal-foot">
                <button className="btn danger" onClick={handleDiscardCall} title="Delete this call record without logging">Discard call</button>
                <button
                  className="btn primary"
                  onClick={() => commitClassification('conversation', targetStage, customNote)}
                >
                  <Check size={16} /> Save & Finish
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* QUICK ADD MODAL */}
      <AnimatePresence>
        {showAdd && (
          <QuickAddModal
            onClose={() => setShowAdd(false)}
            onAdded={handleQuickAdd}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
