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
import Notes, { CallHistory, useDetail } from '../components/Notes.jsx';
import { Avatar, Editable, Empty, Switch } from '../components/ui.jsx';
import { OUTCOMES, STAGES, fmtDur, stageMeta, useTimer } from '../utils.js';

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
  const { prospects, loaded, activeId, setActiveId, refreshProspects, refreshStats, toast, patchLocal, setView, settings, updateProspect } = useStore();
  const [tab, setTab] = useState('new');
  const [q, setQ] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | dialing | active
  const [callId, setCallId] = useState(null);
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
  const activeItemRef = useRef(null);

  // Compute active queue for current tab & filter
  const queue = useMemo(() => {
    const t = TABS.find((x) => x.id === tab);
    const needle = q.trim().toLowerCase();
    return prospects
      .filter((p) => !p.dnc && (t ? t.test(p) : true))
      .filter((p) => !needle || `${p.name} ${p.company} ${p.phone} ${p.email}`.toLowerCase().includes(needle))
      .sort((a, b) => {
        const hasPhoneA = a.phone && a.phone.trim().length > 0 ? 1 : 0;
        const hasPhoneB = b.phone && b.phone.trim().length > 0 ? 1 : 0;
        if (hasPhoneA !== hasPhoneB) return hasPhoneB - hasPhoneA;
        return a.id - b.id;
      });
  }, [prospects, tab, q]);

  // Always resolve active prospect from the active queue
  const active = useMemo(() => {
    if (activeId) {
      const match = queue.find((p) => p.id === activeId);
      if (match) return match;
    }
    return queue[0] || null;
  }, [queue, activeId]);

  const { detail, reload } = useDetail(active?.id);
  const idx = active ? queue.findIndex((p) => p.id === active.id) : -1;

  // Auto-scroll the active queue item into view smoothly
  useEffect(() => {
    if (activeItemRef.current) {
      activeItemRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [active?.id]);

  // Synchronize tab when activeId changes externally (e.g. Prospects table 'Call')
  useEffect(() => {
    if (!activeId) return;
    const target = prospects.find((p) => p.id === activeId);
    if (!target) return;
    const curTab = TABS.find((x) => x.id === tab);
    if (curTab && !curTab.test(target)) {
      if (target.stage === 'new') setTab('new');
      else if (['contacted', 'interested', 'followup'].includes(target.stage)) setTab('follow');
      else setTab('all');
    }
  }, [activeId, prospects, tab]);

  // When switching tabs explicitly, pick the top item of the new queue
  const handleTabChange = useCallback((newTabId) => {
    if (phase !== 'idle' || classifyModal) return toast('Finish or classify this call first.', 'error');
    setTab(newTabId);
    const t = TABS.find((x) => x.id === newTabId);
    const needle = q.trim().toLowerCase();
    const nextQueue = prospects
      .filter((p) => !p.dnc && (t ? t.test(p) : true))
      .filter((p) => !needle || `${p.name} ${p.company} ${p.phone} ${p.email}`.toLowerCase().includes(needle));
    if (nextQueue.length > 0) {
      setActiveId(nextQueue[0].id);
    } else {
      setActiveId(null);
    }
  }, [phase, classifyModal, prospects, q, setActiveId, toast]);

  // Safe and deterministic candidate calculation for the next prospect in queue
  const getNextProspectId = useCallback((currentQueue, currentProspectId) => {
    if (!currentProspectId || !currentQueue.length) return null;
    const currentIdx = currentQueue.findIndex((p) => p.id === currentProspectId);
    if (currentIdx === -1) return currentQueue[0]?.id || null;
    for (let step = 1; step < currentQueue.length; step++) {
      const candidate = currentQueue[(currentIdx + step) % currentQueue.length];
      if (candidate && candidate.id !== currentProspectId && !done.has(candidate.id)) {
        return candidate.id;
      }
    }
    if (currentQueue.length > 1) {
      return currentQueue[(currentIdx + 1) % currentQueue.length]?.id || null;
    }
    return null;
  }, [done]);

  const go = useCallback((dir) => {
    if (phase !== 'idle' || classifyModal) return toast('Finish or classify this call first.', 'error');
    if (!queue.length) return;
    let i = idx;
    for (let step = 0; step < queue.length; step++) {
      i = (i + dir + queue.length) % queue.length;
      if (dir < 0 || !done.has(queue[i].id) || step === queue.length - 1) break;
    }
    setActiveId(queue[i].id);
  }, [phase, classifyModal, queue, idx, done, setActiveId, toast]);

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
    await Promise.all([refreshProspects(), refreshStats()]);
  }, [classifyModal, callId, toast, refreshProspects, refreshStats]);

  const commitClassification = useCallback(async (outcomeId, chosenStage, noteText) => {
    if (!classifyModal) return;
    const o = OUTCOMES.find((x) => x.id === outcomeId) || OUTCOMES[0];
    const pid = classifyModal.prospect.id;
    const nextId = getNextProspectId(queue, pid);

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
      setDone((d) => new Set(d).add(pid));
      setQuickNote('');
      setClassifyModal(null);
      setCallId(null);
      await Promise.all([refreshProspects(), refreshStats(), reload()]);
      if (autoNext && outcomeId !== 'meeting_booked' && nextId) {
        setTimeout(() => setActiveId(nextId), 750);
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }, [classifyModal, queue, getNextProspectId, updateProspect, autoNext, setActiveId, refreshProspects, refreshStats, reload, toast]);

  // Direct outcome logging (from 1-8 keys or outcome buttons during active call)
  const logOutcome = useCallback(async (outcome) => {
    if (classifyModal) {
      commitClassification(outcome, targetStage, customNote);
      return;
    }
    if (phase !== 'active' || !callId || !active) return;
    const o = OUTCOMES.find((x) => x.id === outcome);
    const finished = active.id;
    const nextId = getNextProspectId(queue, finished);
    const noteToSave = quickNoteRef.current.trim();
    try {
      await api.logCall(callId, { outcome, duration_sec: secRef.current });
      if (noteToSave) {
        await api.addNote(finished, noteToSave);
      }
      setFlash({ label: o.label, color: o.color, id: Date.now() });
      setTimeout(() => setFlash(null), 1300);
      setDone((d) => new Set(d).add(finished));
      setPhase('idle');
      setCallId(null);
      setQuickNote('');
      await Promise.all([refreshProspects(), refreshStats(), reload()]);
      if (autoNext && outcome !== 'meeting_booked' && nextId) {
        setTimeout(() => setActiveId(nextId), 750);
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }, [classifyModal, commitClassification, targetStage, customNote, phase, callId, active, queue, getNextProspectId, autoNext, setActiveId, refreshProspects, refreshStats, reload, toast]);

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
    await Promise.all([refreshProspects(), refreshStats()]);
    toast('Prospect added to queue');
    if (p && p.id) {
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

  return (
    <div className="dialer">
      {/* QUEUE SIDEBAR */}
      <section className="glass queue">
        <div className="seg">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => handleTabChange(t.id)}>
              {tab === t.id && <motion.span layoutId="segpill" className="seg-pill" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        <div className="search">
          <Search size={15} />
          <input placeholder="Search queue…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="queue-meta">
          <span>{queue.length} in queue</span>
          <span>{done.size} dialed</span>
          <button className="btn xs primary" onClick={() => setShowAdd(true)} title="Add prospect directly to queue"><Plus size={12} /> Add</button>
        </div>
        <div className="queue-list">
          {queue.map((p) => {
            const on = active?.id === p.id;
            return (
              <button
                key={p.id}
                ref={on ? activeItemRef : null}
                disabled={(calling || !!classifyModal) && !on}
                className={`q-item ${on ? 'on' : ''} ${done.has(p.id) ? 'done' : ''}`}
                onClick={() => !calling && !classifyModal && setActiveId(p.id)}
              >
                {on && <motion.span layoutId="qpill" className="q-pill" transition={{ type: 'spring', stiffness: 400, damping: 36 }} />}
                <Avatar name={p.name || p.company} size={34} seed={p.id + p.name} />
                <div className="q-txt">
                  <b>{p.name || '(no name)'}</b>
                  <span>{p.company || p.phone}</span>
                </div>
                {done.has(p.id) ? <Check size={16} className="q-check" /> : <i className="dot" style={{ background: stageMeta(p.stage).color }} />}
              </button>
            );
          })}
          {queue.length === 0 && <div className="muted small center pad">Nobody here. Try another tab or add one above.</div>}
        </div>
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
