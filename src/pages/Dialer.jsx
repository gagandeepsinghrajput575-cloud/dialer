import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  PhoneOff, Voicemail, Ban, ShieldHalf, PhoneMissed, MessagesSquare,
  CalendarCheck, OctagonX, Circle, Phone, PhoneCall, Search,
  ChevronLeft, ChevronRight, Check, SkipForward, Upload, Sparkles,
  Loader2, Keyboard, Mail, Building2, NotebookPen, Plus, X,
  Headphones, RotateCw, FlaskConical, Wifi
} from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store.jsx';
import ProspectCard from '../components/ProspectCard.jsx';
import QueueList from '../components/QueueList.jsx';
import Notes, { CallHistory, useDetail } from '../components/Notes.jsx';
import { Avatar, Editable, Empty, Switch } from '../components/ui.jsx';
import useServerQueue from '../useServerQueue.js';
import { QUEUE_TABS, QUEUE_LIMIT, firstFreshId, pickNextId, queueTab, stepIndex, tabForProspect } from '../queue.js';
import { OUTCOMES, STAGES, ccLabel, dispatchDialUri, fmtDur, softphoneLabel, stageMeta, useTimer, withCrossTabLock } from '../utils.js';

const ICONS = { PhoneOff, Voicemail, Ban, ShieldHalf, PhoneMissed, MessagesSquare, CalendarCheck, OctagonX };
const TABS = [
  { id: 'new', label: 'To call', test: (p) => p.stage === 'new' },
  { id: 'follow', label: 'Follow-ups', test: (p) => ['contacted', 'interested', 'followup'].includes(p.stage) },
  { id: 'all', label: 'All', test: () => true },
];

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
          <label>Phone<input value={f.phone} onChange={set('phone')} placeholder="+45 20 12 34 56" /></label>
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
  const { prospects, loaded, activeId, setActiveId, refreshProspects, refreshStats, toast, patchLocal, setView, settings, updateProspect } = useStore();
  const [tab, setTab] = useState('new');
  const [q, setQ] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | dialing | active
  const [callId, setCallId] = useState(null);
  const [dial, setDial] = useState(null); // { uri, full, protocol, mode, phone } handed to the softphone
  const [launched, setLaunched] = useState(false); // OS accepted the dial URI
  const [done, setDone] = useState(() => new Set());
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
  // Clears the draft in the ref *and* the state, so the Notes auto-save-on-unmount guard
  // cannot fire with text that has already been written to the prospect.
  const clearQuickNote = useCallback((restore = '') => {
    quickNoteRef.current = restore;
    setQuickNote(restore);
  }, []);
  const activeItemRef = useRef(null);

  // Synchronous guards. React state updates are asynchronous, so a second keypress landing in
  // the same tick would otherwise sail past every `phase !== 'idle'` check and dial twice
  // (or log the same call twice). Refs are updated immediately, so they close that window.
  const phaseRef = useRef('idle');
  const classifyRef = useRef(null);
  const dialLockRef = useRef(false);
  const logLockRef = useRef(false);
  const setPhaseSafe = useCallback((next) => { phaseRef.current = next; setPhase(next); }, []);
  const setClassifySafe = useCallback((next) => { classifyRef.current = next; setClassifyModal(next); }, []);
  const timersRef = useRef(new Set());
  // setTimeout that is always cleaned up, so nothing fires after the dialer unmounts.
  const later = useCallback((fn, ms) => {
    const id = setTimeout(() => { timersRef.current.delete(id); fn(); }, ms);
    timersRef.current.add(id);
    return id;
  }, []);
  useEffect(() => {
    const pending = timersRef.current;
    return () => { for (const id of pending) clearTimeout(id); pending.clear(); };
  }, []);

  // Server-backed queue: filtering, ranking, and paging live on the server
  const queue = useServerQueue({ tab, q, limit: QUEUE_LIMIT });
  const { items, total, counts, hasMore, loading, loadingMore, error } = queue;

  // Selected prospect outside loaded page -> fetch on demand so center stage stays populated
  const [pinned, setPinned] = useState(null);
  const pinnedRef = useRef(null);
  pinnedRef.current = pinned;
  const pinTriedRef = useRef(new Set());

  useEffect(() => {
    if (!activeId) {
      if (pinnedRef.current) setPinned(null);
      return undefined;
    }
    if (items.some((p) => p.id === activeId)) {
      if (pinnedRef.current?.id === activeId) setPinned(null);
      pinTriedRef.current.delete(activeId);
      return undefined;
    }
    if (pinnedRef.current?.id === activeId) return undefined;
    if (pinTriedRef.current.has(activeId)) return undefined;

    let cancelled = false;
    pinTriedRef.current.add(activeId);
    api.prospect(activeId)
      .then((p) => { if (!cancelled && p) setPinned(p); })
      .catch(() => {
        pinTriedRef.current.delete(activeId);
      });
    return () => { cancelled = true; };
  }, [activeId, items]);

  // Always resolve active prospect from active queue or pinned prospect
  const active = useMemo(() => {
    if (activeId) {
      const match = items.find((p) => p.id === activeId);
      if (match) return match;
      if (pinned && pinned.id === activeId) return pinned;
    }
    return items[0] || null;
  }, [items, activeId, pinned]);

  const { detail, reload } = useDetail(active?.id);
  const idx = active ? items.findIndex((p) => p.id === active.id) : -1;

  // Auto-scroll the active queue item into view smoothly
  useEffect(() => {
    if (activeItemRef.current) {
      activeItemRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [active?.id]);

  // Synchronize tab when activeId changes externally (e.g. Prospects table 'Call')
  useEffect(() => {
    if (!activeId) return;
    const target = items.find((p) => p.id === activeId) || pinned;
    if (!target) return;
    const curTab = TABS.find((x) => x.id === tab);
    if (curTab && !curTab.test(target)) {
      if (target.stage === 'new') setTab('new');
      else if (['contacted', 'interested', 'followup'].includes(target.stage)) setTab('follow');
      else setTab('all');
    }
  }, [activeId, items, pinned, tab]);

  // When switching tabs explicitly, pick the top item of the new queue
  const handleTabChange = useCallback((newTabId) => {
    if (phaseRef.current !== 'idle' || classifyRef.current) return toast('Finish or classify this call first.', 'error');
    setTab(newTabId);
    setActiveId(null);
  }, [toast]);

  // Candidate calculation for the next prospect in queue
  const getNextProspectId = useCallback((currentQueue, currentProspectId) => {
    const list = Array.isArray(currentQueue) ? currentQueue : (items || []);
    if (!currentProspectId || !list.length) return null;
    const currentIdx = list.findIndex((p) => p.id === currentProspectId);
    if (currentIdx === -1) return list[0]?.id || null;
    for (let step = 1; step < list.length; step++) {
      const candidate = list[(currentIdx + step) % list.length];
      if (candidate && candidate.id !== currentProspectId && !done.has(candidate.id)) {
        return candidate.id;
      }
    }
    if (list.length > 1) {
      return list[(currentIdx + 1) % list.length]?.id || null;
    }
    return null;
  }, [items, done]);

  const go = useCallback((dir) => {
    if (phaseRef.current !== 'idle' || classifyRef.current) return toast('Finish or classify this call first.', 'error');
    if (!items.length) return;
    const nextIdx = stepIndex(items.length, idx, dir);
    if (nextIdx >= 0 && items[nextIdx]) {
      setActiveId(items[nextIdx].id);
    }
  }, [items, idx, setActiveId, toast]);

  // Hand the dial URI (sip:/tel:) straight to the desktop softphone and go 'active' immediately —
  // no second leg to wait for, so the timer and the shortcut keys are live the moment you press C.
  const startCall = useCallback(async () => {
    // One dial at a time, per tick and per request: mash C as hard as you like.
    if (dialLockRef.current) return;
    if (!active || phaseRef.current !== 'idle' || classifyRef.current) return;
    if (active.dnc) return toast('This prospect is marked Do Not Call.', 'error');
    if (!active.phone) return toast('No phone number for this prospect.', 'error');
    // Danish 70/90 ranges cost real money. Ask first, because the call is logged and the
    // softphone is handed the number the moment this function continues.
    const nk = active.number_kind;
    if (nk && nk.expensive && !confirm(`${nk.label}\n${active.phone}\n\n${nk.note}\n\nDial anyway?`)) return;
    dialLockRef.current = true;
    setPhaseSafe('dialing');
    setLaunched(false);
    try {
      // Hold a cross-tab mutex around the server call only. Two open tabs used to be able to
      // dial the same prospect and log two calls; now the second tab is refused instead.
      const guarded = await withCrossTabLock(`pulse-dial-${active.id}`, () => api.call(active.id));
      if (guarded.blocked) {
        setPhaseSafe('idle');
        return toast('Another tab is already dialing this prospect.', 'error');
      }
      const r = guarded.value;
      setCallId(r.callId);
      setDial({ uri: r.dialUri, full: r.dialUriFull, protocol: r.protocol, mode: r.telephonyMode, phone: r.phone });
      patchLocal(active.id, { call_count: active.call_count + 1, last_called_at: new Date().toISOString() });
      const softphone = softphoneLabel(r.telephonyMode);
      if (r.dryRun) {
        toast(`Test mode: ${r.dialUri} simulated in-browser`);
      } else {
        const ok = r.telephonyMode === 'softphone' ? dispatchDialUri(r.dialUri) : false;
        setLaunched(ok);
        if (ok) toast(`${softphone} is dialing ${r.phone}…`);
        else toast(r.warning || `Launch ${r.dialUri} in ${softphone} to connect`, 'error');
      }
      setPhaseSafe('active');
      refreshStats();
    } catch (e) {
      setPhaseSafe('idle');
      setDial(null);
      toast(e.message, 'error');
      refreshStats();
    } finally {
      dialLockRef.current = false;
    }
  }, [active, setPhaseSafe, toast, patchLocal, refreshStats]);

  // Re-dispatch the same URI when the OS prompt was dismissed or the softphone was closed.
  const relaunchSoftphone = useCallback(() => {
    if (!dial?.uri) return;
    const softphone = softphoneLabel(dial.mode);
    if (phaseRef.current === 'idle') return;
    // Test mode must never hand a dial URI to the OS — not even on a re-launch.
    if (settings?.dry_run === '1') {
      return toast(`Test mode is on: ${dial.uri} stays simulated, nothing is dialed.`);
    }
    const ok = dispatchDialUri(dial.uri);
    setLaunched(ok);
    toast(ok ? `Re-launching ${dial.uri} in ${softphone}` : `Could not launch ${softphone} — open it and dial ${dial.phone} manually`, ok ? 'ok' : 'error');
  }, [dial, settings, toast]);

  // When clicking hang up button, open the classification modal
  const hangUp = useCallback(() => {
    if (phaseRef.current !== 'active' || !callId || !active) return;
    const dur = secRef.current;
    setPhaseSafe('idle');
    setLaunched(false);
    setTargetStage(active.stage || 'contacted');
    setCustomNote(quickNoteRef.current.trim());
    setClassifySafe({
      callId,
      duration: dur,
      prospect: active,
    });
  }, [callId, active, setPhaseSafe, setClassifySafe]);

  // Discard an active or hung-up call without polluting stats or history
  const handleDiscardCall = useCallback(async () => {
    const idToDiscard = classifyRef.current ? classifyRef.current.callId : callId;
    if (idToDiscard) {
      try {
        await api.discardCall(idToDiscard);
      } catch {
        /* ignore */
      }
    }
    setPhaseSafe('idle');
    setCallId(null);
    setClassifySafe(null);
    setDial(null);
    setLaunched(false);
    setQuickNote('');
    toast('Call discarded');
    await Promise.all([queue.refresh(), refreshProspects(), refreshStats()]);
  }, [callId, queue, setPhaseSafe, setClassifySafe, toast, refreshProspects, refreshStats]);

  const commitClassification = useCallback(async (outcomeId, chosenStage, noteText) => {
    const modal = classifyRef.current || classifyModal;
    if (!modal || logLockRef.current) return; // one classification per call, however fast you press
    logLockRef.current = true;
    const o = OUTCOMES.find((x) => x.id === outcomeId) || OUTCOMES[0];
    const pid = modal.prospect.id;
    const nextId = getNextProspectId(items, pid);

    try {
      await api.logCall(modal.callId, { outcome: outcomeId, duration_sec: modal.duration });
      if (chosenStage && chosenStage !== modal.prospect.stage) {
        await updateProspect(pid, { stage: chosenStage });
      }
      const noteToSave = (noteText || '').trim();
      if (noteToSave) {
        await api.addNote(pid, noteToSave);
      }
      setFlash({ label: o.label, color: o.color, id: Date.now() });
      later(() => setFlash(null), 1400);
      setDone((d) => new Set(d).add(pid));
      setQuickNote('');
      setClassifySafe(null);
      setCallId(null);
      setDial(null);
      setLaunched(false);
      await Promise.all([queue.refresh(), refreshProspects(), refreshStats(), reload()]);
      if (autoNext && outcomeId !== 'meeting_booked' && nextId) {
        later(() => setActiveId(nextId), 750);
      }
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      logLockRef.current = false;
    }
  }, [classifyModal, items, getNextProspectId, updateProspect, autoNext, setActiveId, setClassifySafe, later, queue, refreshProspects, refreshStats, reload, toast]);

  // Direct outcome logging (from 1-8 keys or outcome buttons during active call)
  const logOutcome = useCallback(async (outcome) => {
    if (classifyRef.current || classifyModal) {
      commitClassification(outcome, targetStage, customNote);
      return;
    }
    if (logLockRef.current) return; // a mashed outcome key logs the call once, saves the note once
    if (phaseRef.current !== 'active' || !callId || !active) return;
    logLockRef.current = true;
    const o = OUTCOMES.find((x) => x.id === outcome);
    const finished = active.id;
    const nextId = getNextProspectId(items, finished);
    const noteToSave = quickNoteRef.current.trim();
    // Hand the note over before any await: from here on the draft is empty, so nothing can
    // save it a second time while this request is in flight.
    if (noteToSave) clearQuickNote();
    try {
      await api.logCall(callId, { outcome, duration_sec: secRef.current });
      if (noteToSave) {
        await api.addNote(finished, noteToSave);
      }
      setFlash({ label: o.label, color: o.color, id: Date.now() });
      later(() => setFlash(null), 1300);
      setDone((d) => new Set(d).add(finished));
      setPhaseSafe('idle');
      setCallId(null);
      setDial(null);
      setLaunched(false);
      clearQuickNote();
      await Promise.all([queue.refresh(), refreshProspects(), refreshStats(), reload()]);
      if (autoNext && outcome !== 'meeting_booked' && nextId) {
        later(() => setActiveId(nextId), 750);
      }
    } catch (e) {
      clearQuickNote(noteToSave); // give the note back so the agent does not lose it
      toast(e.message, 'error');
    } finally {
      logLockRef.current = false;
    }
  }, [classifyModal, commitClassification, targetStage, customNote, callId, active, items, getNextProspectId, autoNext, setActiveId, setPhaseSafe, clearQuickNote, later, queue, refreshProspects, refreshStats, reload, toast]);

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
    try {
      const p = await api.addProspect(newProspectData);
      await Promise.all([refreshProspects(), refreshStats()]);
      toast('Prospect added to queue');
      if (p && p.id) setActiveId(p.id);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  // Comprehensive keyboard shortcut routing
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }
      // Deliberately checks e.target (where the keystroke happened) and NOT
      // document.activeElement: focus legitimately stays in the live-notes box between calls,
      // and C / 1-8 must keep working while it does.
      // OS key repeat (holding a key down) must not stack up calls or classifications.
      if (e.repeat) return;
      // Single-character shortcuts work regardless of Shift/CapsLock; named keys stay verbatim.
      const k = typeof e.key === 'string' && e.key.length === 1 ? e.key.toLowerCase() : e.key;

      // Modal keyboard handling
      if (classifyRef.current || classifyModal) {
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
      if (k === 'c') {
        e.preventDefault();
        if (phaseRef.current === 'idle') startCall();
        else if (phaseRef.current === 'active') hangUp();
      } else if (k === 'h' && phaseRef.current === 'active') {
        e.preventDefault();
        hangUp();
      } else if (k === 'ArrowRight') {
        go(1);
      } else if (k === 'ArrowLeft') {
        go(-1);
      } else if (k === 'n') {
        e.preventDefault();
        document.getElementById('top-quick-note')?.focus();
      } else if (k === 'r' && phaseRef.current === 'active') {
        e.preventDefault();
        relaunchSoftphone();
      } else if (/^[1-8]$/.test(k) && phaseRef.current === 'active') {
        logOutcome(OUTCOMES[Number(k) - 1].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, classifyModal, startCall, hangUp, go, logOutcome, relaunchSoftphone, handleDiscardCall, commitClassification, targetStage, customNote]);

  if (loaded && prospects.length === 0) {
    return (
      <Empty icon={<PhoneCall size={34} />} title="No prospects to dial yet" sub="Upload your list and every prospect's details will appear here while you call.">
        <div className="row gap">
          <button className="btn primary" onClick={() => setView('import')}><Upload size={16} /> Import a list</button>
          <button className="btn" onClick={async () => { await api.demo(); await refreshProspects(); }}><Sparkles size={16} /> Load demo data</button>
        </div>
      </Empty>
    );
  }

  const calling = phase !== 'idle';
  const dry = settings?.dry_run === '1';
  const softphone = softphoneLabel(settings?.telephony_mode);
  const cc = ccLabel(settings?.default_country_code);
  const proto = settings?.softphone_protocol === 'tel' ? 'tel' : 'sip';
  const inflightText = dry
    ? `Simulating ${dial?.uri || `${proto}:${active?.phone || ''}`}`
    : launched || phase === 'dialing'
      ? `Dialing via ${softphone} (${cc})…`
      : `Waiting on ${softphone} (${cc})`;

  return (
    <div className="dialer">
      {/* QUEUE SIDEBAR */}
      <section className="glass queue">
        <div className="seg">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => handleTabChange(t.id)}>
              {tab === t.id && <motion.span layoutId="segpill" className="seg-pill" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
              <span>{t.label}</span>
              {counts?.[t.id] ? <em className="seg-count">{counts[t.id]}</em> : null}
            </button>
          ))}
        </div>
        <div className="search">
          <Search size={15} />
          <input placeholder="Search queue…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="queue-meta">
          <span>{total || items.length} in queue</span>
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
                        <Phone size={14} /> <Editable className="banner-phone-edit" value={active.phone} placeholder="+45 20 12 34 56" onSave={(v) => updateProspect(active.id, { phone: v })} />
                      </span>
                    ) : (
                      <span className="banner-phone-chip missing">
                        <Phone size={14} /> <Editable className="banner-phone-edit" value="" placeholder="Click to add phone (+45 20 12 34 56)" onSave={(v) => updateProspect(active.id, { phone: v })} />
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
              <AnimatePresence>
                {calling && (
                  <motion.div
                    className={`inflight ${dry ? 'dry' : launched ? 'live' : 'wait'}`}
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.22, ease: 'easeOut' }}
                  >
                    <span className="inflight-dot" />
                    {dry ? <FlaskConical size={14} /> : launched ? <Headphones size={14} /> : <Wifi size={14} />}
                    <span className="inflight-txt">{inflightText}</span>
                    {dial?.uri && <code className="inflight-uri">{dial.uri}</code>}
                    {!dry && phase === 'active' && (
                      <button className="btn xs" onClick={relaunchSoftphone} title="Re-launch the softphone (R)">
                        <RotateCw size={12} /> Re-launch
                      </button>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
              <div className="callbar-top">
                <div>
                  <div className="eyebrow">
                    {phase === 'idle' ? 'Ready to dial' : phase === 'dialing' ? `Dispatching to ${softphone}…` : 'Call in progress'}
                  </div>
                  <div className="callnum">
                    {active.phone || 'No number (add phone above)'}
                    {active.number_kind && (
                      <span
                        className={`num-kind ${active.number_kind.expensive ? 'expensive' : 'info'}`}
                        title={active.number_kind.note}
                      >
                        {active.number_kind.label}
                      </span>
                    )}
                  </div>
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
                <div className="row gap justify-between call-actions">
                  <div className="row gap">
                    <button className="btn danger sm" onClick={hangUp} title={dry ? 'Hang up and classify (H)' : `End the call in ${softphone}, then classify here (H)`}><PhoneOff size={14} /> Hang Up & Classify</button>
                    <button className="link-btn" onClick={handleDiscardCall}><SkipForward size={13} /> Discard without logging</button>
                  </div>
                  {!dry && dial?.uri && (
                    <a
                      className="link-btn softphone-link"
                      href={launched ? dial.full || dial.uri : dial.uri}
                      title={`Launch ${dial.uri} in ${softphone}`}
                    >
                      <Headphones size={13} />
                      {launched ? `Re-open ${dial.full || dial.uri}` : `${softphone} didn't open? Launch ${dial.uri}`}
                    </a>
                  )}
                </div>
              )}
              {dry && phase === 'idle' && (
                <div className="hint-dry">
                  <FlaskConical size={13} /> Test mode is on. Calls are simulated in the browser — nothing is dialed.
                  Switch to Live mode in Settings once {softphone} is registered with VOIP.SO.
                </div>
              )}
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
              <div className="kbd-hint"><Keyboard size={13} /> <kbd>C</kbd> call/hang up · <kbd>1-8</kbd> classify · <kbd>H</kbd> hang up &amp; classify · <kbd>R</kbd> re-launch softphone · <kbd>←</kbd><kbd>→</kbd> navigate · <kbd>N</kbd> notes</div>
            </div>
          </>
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
                draftRef={quickNoteRef}
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
