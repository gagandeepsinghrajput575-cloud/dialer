import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { PhoneOff, Voicemail, Ban, ShieldHalf, PhoneMissed, MessagesSquare, CalendarCheck, OctagonX, Circle, Phone, PhoneCall, Search, ChevronLeft, ChevronRight, Check, SkipForward, Upload, Sparkles, Loader2, Keyboard } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store.jsx';
import ProspectCard from '../components/ProspectCard.jsx';
import Notes, { CallHistory, useDetail } from '../components/Notes.jsx';
import { Avatar, Empty, Switch } from '../components/ui.jsx';
import { OUTCOMES, fmtDur, stageMeta, useTimer } from '../utils.js';

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
        <motion.i key={i} animate={active ? { scaleY: [0.25, 1, 0.35, 0.8, 0.25] } : { scaleY: 0.2 }} transition={active ? { duration: 1.1 + (i % 5) * 0.15, repeat: Infinity, delay: i * 0.04, ease: 'easeInOut' } : { duration: 0.3 }} />
      ))}
    </div>
  );
}

export default function Dialer() {
  const { prospects, loaded, activeId, setActiveId, refreshProspects, refreshStats, toast, patchLocal, setView, settings } = useStore();
  const [tab, setTab] = useState('new');
  const [q, setQ] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | dialing | active
  const [callId, setCallId] = useState(null);
  const [done, setDone] = useState(() => new Set());
  const [autoNext, setAutoNext] = useState(true);
  const [flash, setFlash] = useState(null);
  const [noteFocus, setNoteFocus] = useState(0);
  const sec = useTimer(phase === 'active');
  const secRef = useRef(0);
  secRef.current = sec;

  const queue = useMemo(() => {
    const t = TABS.find((x) => x.id === tab);
    const needle = q.trim().toLowerCase();
    return prospects
      .filter((p) => !p.dnc && t.test(p))
      .filter((p) => !needle || `${p.name} ${p.company} ${p.phone} ${p.email}`.toLowerCase().includes(needle))
      .sort((a, b) => a.id - b.id);
  }, [prospects, tab, q]);

  const active = useMemo(() => prospects.find((p) => p.id === activeId) || queue[0] || null, [prospects, activeId, queue]);
  const { detail, reload } = useDetail(active?.id);
  const idx = active ? queue.findIndex((p) => p.id === active.id) : -1;

  const go = useCallback((dir) => {
    if (phase !== 'idle') return toast('Finish this call first (log a result).', 'error');
    if (!queue.length) return;
    // next prospect not yet worked this session (when moving forward)
    let i = idx;
    for (let step = 0; step < queue.length; step++) {
      i = (i + dir + queue.length) % queue.length;
      if (dir < 0 || !done.has(queue[i].id) || step === queue.length - 1) break;
    }
    setActiveId(queue[i].id);
  }, [phase, queue, idx, done, setActiveId, toast]);

  const startCall = useCallback(async () => {
    if (!active || phase !== 'idle') return;
    if (active.dnc) return toast('This prospect is marked Do Not Call.', 'error');
    if (!active.phone) return toast('No phone number for this prospect.', 'error');
    setPhase('dialing');
    try {
      const r = await api.call(active.id);
      setCallId(r.callId);
      setPhase('active');
      patchLocal(active.id, { call_count: active.call_count + 1, last_called_at: new Date().toISOString() });
      toast(r.dryRun ? 'Test mode: no real call was placed' : 'Calling… answer your softphone to connect');
    } catch (e) {
      setPhase('idle');
      toast(e.message, 'error');
      refreshStats();
    }
  }, [active, phase, toast, patchLocal, refreshStats]);

  const logOutcome = useCallback(async (outcome) => {
    if (phase !== 'active' || !callId || !active) return;
    const o = OUTCOMES.find((x) => x.id === outcome);
    const finished = active.id;
    try {
      await api.logCall(callId, { outcome, duration_sec: secRef.current });
      setFlash({ label: o.label, color: o.color, id: Date.now() });
      setTimeout(() => setFlash(null), 1300);
      setDone((d) => new Set(d).add(finished));
      setPhase('idle'); setCallId(null);
      await Promise.all([refreshProspects(), refreshStats(), reload()]);
      if (autoNext && outcome !== 'meeting_booked') setTimeout(() => go(1), 900);
    } catch (e) { toast(e.message, 'error'); }
  }, [phase, callId, active, autoNext, go, refreshProspects, refreshStats, reload, toast]);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'c') { e.preventDefault(); startCall(); }
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'n') { e.preventDefault(); setNoteFocus((x) => x + 1); }
      else if (/^[1-8]$/.test(e.key)) logOutcome(OUTCOMES[Number(e.key) - 1].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [startCall, go, logOutcome]);

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
      {/* queue */}
      <section className="glass queue">
        <div className="seg">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
              {tab === t.id && <motion.span layoutId="segpill" className="seg-pill" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        <div className="search"><Search size={15} /><input placeholder="Search queue…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="queue-meta"><span>{queue.length} in queue</span><span>{done.size} done this session</span></div>
        <div className="queue-list">
          {queue.map((p) => {
            const on = active?.id === p.id;
            return (
              <button key={p.id} disabled={calling && !on} className={`q-item ${on ? 'on' : ''} ${done.has(p.id) ? 'done' : ''}`} onClick={() => !calling && setActiveId(p.id)}>
                {on && <motion.span layoutId="qpill" className="q-pill" transition={{ type: 'spring', stiffness: 400, damping: 36 }} />}
                <Avatar name={p.name || p.company} size={34} seed={p.id + p.name} />
                <div className="q-txt"><b>{p.name || '(no name)'}</b><span>{p.company || p.phone}</span></div>
                {done.has(p.id) ? <Check size={16} className="q-check" /> : <i className="dot" style={{ background: stageMeta(p.stage).color }} />}
              </button>
            );
          })}
          {queue.length === 0 && <div className="muted small center pad">Nobody here. Try another tab.</div>}
        </div>
      </section>

      {/* center */}
      <section className="stage">
        {active ? (
          <>
            <div className={`glass callbar ${phase}`}>
              <div className="callbar-glow" />
              <div className="callbar-top">
                <div>
                  <div className="eyebrow">{phase === 'idle' ? 'Ready to dial' : phase === 'dialing' ? 'Connecting…' : 'Call in progress'}</div>
                  <div className="callnum">{active.phone || 'No number'}</div>
                  <div className="callwho">{active.name}{active.company ? ` · ${active.company}` : ''}</div>
                </div>
                <div className="callctl">
                  <div className="timer">{phase === 'active' ? fmtDur(sec) : '0:00'}</div>
                  <div className="row gap">
                    <button className="icon-btn" onClick={() => go(-1)} disabled={calling} title="Previous (←)"><ChevronLeft size={18} /></button>
                    <div className="call-wrap">
                      {phase === 'active' && <><span className="ring r1" /><span className="ring r2" /></>}
                      <motion.button whileHover={{ scale: calling ? 1 : 1.05 }} whileTap={{ scale: 0.94 }} className={`call-btn ${phase}`} onClick={startCall} disabled={calling || active.dnc || !active.phone} title="Call (C)">
                        {phase === 'dialing' ? <Loader2 size={26} className="spin" /> : phase === 'active' ? <PhoneCall size={26} /> : <Phone size={26} />}
                      </motion.button>
                    </div>
                    <button className="icon-btn" onClick={() => go(1)} disabled={calling} title="Next (→)"><ChevronRight size={18} /></button>
                  </div>
                </div>
              </div>
              <Waveform active={phase === 'active'} />

              <div className="outcome-head">
                <span>{phase === 'active' ? 'How did it go? Log the result' : 'Call results unlock when a call starts'}</span>
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
                <button className="link-btn" onClick={() => { setPhase('idle'); setCallId(null); }}><SkipForward size={13} /> Discard without logging</button>
              )}
              {dry && phase === 'idle' && <div className="hint-dry">Test mode is on. Calls are simulated, so turn it off in Settings when you're ready to dial for real.</div>}
              <AnimatePresence>
                {flash && (
                  <motion.div key={flash.id} className="flash" style={{ '--c': flash.color }} initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.1 }}>
                    <Check size={20} /> Logged: {flash.label}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="glass card-wrap">
              <ProspectCard p={active} big />
              <div className="kbd-hint"><Keyboard size={13} /> <kbd>C</kbd> call · <kbd>1-8</kbd> result · <kbd>←</kbd><kbd>→</kbd> navigate · <kbd>N</kbd> notes</div>
            </div>
          </>
        ) : (
          <Empty icon={<Search size={30} />} title="Nobody matches" sub="Change the tab or search to find prospects." />
        )}
      </section>

      {/* right */}
      <section className="side-right">
        {active && (
          <>
            <div className="glass pad-lg"><Notes key={active.id} pid={active.id} notes={detail?.notes || []} reload={reload} autoFocusKey={noteFocus} /></div>
            <div className="glass pad-lg"><CallHistory calls={detail?.calls || []} /></div>
          </>
        )}
      </section>
    </div>
  );
}
