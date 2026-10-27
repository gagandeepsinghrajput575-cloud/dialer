import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  PhoneOff, Voicemail, Ban, ShieldHalf, PhoneMissed, MessagesSquare,
  CalendarCheck, OctagonX, Circle, Phone, PhoneCall, Search,
  ChevronLeft, ChevronRight, Check, SkipForward, Upload, Sparkles,
  Loader2, Keyboard, Mail, Building2, NotebookPen, Plus, X,
  Headphones, RotateCw, FlaskConical, Wifi, Send,
  Mic, MicOff, Radio, Grid3x3, Trophy, LayoutDashboard, Repeat, Trash2,
  ChevronDown, ExternalLink, ShieldX, MapPin, Volume2, Globe,
  History, Users, ArrowUpRight, ArrowDownLeft
} from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store.jsx';
import { DTMF_KEYS } from '../useWebRtc.js';
import { useSoftphone } from '../softphone.jsx';
import ProspectCard from '../components/ProspectCard.jsx';
import EmailComposer, { VerifyBadge } from '../components/EmailComposer.jsx';
import QueueList from '../components/QueueList.jsx';
import Notes, { CallHistory, useDetail } from '../components/Notes.jsx';
import { Avatar, Editable, Empty, Switch } from '../components/ui.jsx';
import useServerQueue from '../useServerQueue.js';
import { QUEUE_TABS, QUEUE_LIMIT, firstFreshId, pickNextId, queueProgress, queueTab, stepIndex, tabForProspect } from '../queue.js';
import { OUTCOMES, STAGES, ccLabel, dispatchDialUri, fmtDur, getProspectDisplayName, outcomeMeta, phoneIssue, softphoneLabel, stageMeta, useTimer, withCrossTabLock } from '../utils.js';
import { extraInsights, clip, isUrlValue } from '../registry.js';
import { getDanishPronunciation, speakPronunciation } from '../utils/phonetics.js';

const ICONS = { PhoneOff, Voicemail, Ban, ShieldHalf, PhoneMissed, MessagesSquare, CalendarCheck, OctagonX };

// A call that ended well is exactly the moment a follow-up email is worth sending, so the
// dialer offers it in one click instead of making the agent find the prospect again.
// Outcomes are call results; stages are pipeline moves — the agent can land in either.
const FOLLOWUP_OUTCOMES = new Set(['conversation', 'meeting_booked']);
const FOLLOWUP_STAGES = new Set(['interested', 'followup', 'meeting']);
const shouldOfferFollowUp = (outcomeId, stage) => FOLLOWUP_OUTCOMES.has(outcomeId) || FOLLOWUP_STAGES.has(stage);
const TABS = [
  { id: 'new', label: 'To call', test: (p) => p.stage === 'new' },
  { id: 'follow', label: 'Follow-ups', test: (p) => ['contacted', 'interested', 'followup'].includes(p.stage) },
  { id: 'all', label: 'All', test: () => true },
];

function Waveform({ active, level }) {
  // Fluid, living audio equalizer animation that continuously flows during active calls,
  // dynamically modulated when live voice input is detected so it never sits frozen or flat.
  const voiceBoost = typeof level === 'number' && level > 0.04 ? Math.min(1.35, 0.95 + level * 0.8) : 1;

  return (
    <div className={`wave ${active ? 'on' : ''}`}>
      {Array.from({ length: 24 }).map((_, i) => (
        <motion.i
          key={i}
          animate={active
            ? {
              scaleY: [
                0.22,
                Math.min(1, 1.0 * voiceBoost),
                0.34,
                Math.min(1, 0.82 * voiceBoost),
                0.22,
              ]
            }
            : { scaleY: 0.2 }
          }
          transition={active ? {
            duration: 1.1 + (i % 5) * 0.15,
            repeat: Infinity,
            delay: i * 0.04,
            ease: 'easeInOut',
          } : { duration: 0.3 }}
        />
      ))}
    </div>
  );
}

// A softphone keypad. Its only job is to send tones, but showing the last few pressed makes
// it obvious whether the IVR heard you — silence on a call is otherwise indistinguishable
// from a dead audio path.
function DtmfPad({ log, onKey, onClose, muted, onToggleMute }) {
  const [typedTone, setTypedTone] = useState('');
  const [feedback, setFeedback] = useState('');

  const handleSend = (seq) => {
    const raw = String(seq !== undefined ? seq : typedTone || '').trim();
    if (!raw) return;
    for (const d of raw) {
      if (DTMF_KEYS.includes(d)) {
        onKey(d);
      }
    }
    setFeedback(`Sent tone: ${raw}`);
    setTypedTone('');
    setTimeout(() => setFeedback(''), 2000);
  };

  const handleKeyClick = (d) => {
    onKey(d);
    setFeedback(`Sent tone: ${d}`);
    setTimeout(() => setFeedback(''), 2000);
  };

  return (
    <div role="dialog" aria-label="Touch tones">
      <div className="dtmf-head">
        <b><Grid3x3 size={15} /> In-Call Touch Tones (IVR)</b>
        <button className="icon-btn" onClick={onClose} title="Close (Esc)"><X size={16} /></button>
      </div>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
        <input
          type="text"
          className="incall-tone-input"
          placeholder="Digit(s) & Enter..."
          value={typedTone}
          onChange={(e) => setTypedTone(e.target.value.replace(/[^0-9*#A-Da-d]/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleSend();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
          style={{ flex: 1, height: '36px', fontSize: '15px' }}
          autoFocus
        />
        <button
          type="button"
          className="btn primary sm"
          onClick={() => handleSend()}
          style={{ height: '36px', padding: '0 14px', fontWeight: 600 }}
          title="Send tone to line (Enter)"
        >
          Enter ↵
        </button>
      </div>

      <div className="dtmf-grid">
        {DTMF_KEYS.map((d) => (
          <button key={d} className="dtmf-key" onClick={() => handleKeyClick(d)} title={`Send tone ${d} immediately`}>{d}</button>
        ))}
      </div>
      <div className="dtmf-foot">
        <span className="dtmf-log" title="Tones sent on this call">
          {feedback ? <b style={{ color: '#34d399' }}>{feedback}</b> : log.length ? log.join(' ') : 'No tones sent yet'}
        </span>
        <button className={`btn xs ${muted ? 'danger' : ''}`} onClick={onToggleMute}>
          {muted ? <MicOff size={12} /> : <Mic size={12} />} {muted ? 'Unmute (M)' : 'Mute (M)'}
        </button>
      </div>
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

const DIALPAD_KEYS = [
  { key: '1', sub: ' ' },
  { key: '2', sub: 'ABC' },
  { key: '3', sub: 'DEF' },
  { key: '4', sub: 'GHI' },
  { key: '5', sub: 'JKL' },
  { key: '6', sub: 'MNO' },
  { key: '7', sub: 'PQRS' },
  { key: '8', sub: 'TUV' },
  { key: '9', sub: 'WXYZ' },
  { key: '*', sub: ' ' },
  { key: '0', sub: '+' },
  { key: '#', sub: ' ' },
];

function ManualDialModal({ onClose, onDial }) {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  const cleanDigits = phone.replace(/\D/g, '');
  const canCall = cleanDigits.length >= 5;

  const handleKeyClick = (k) => {
    setPhone((prev) => prev + k);
    inputRef.current?.focus();
  };

  const handleClear = () => {
    setPhone('');
    inputRef.current?.focus();
  };

  const handleBackspace = () => {
    setPhone((prev) => prev.slice(0, -1));
    inputRef.current?.focus();
  };

  const handleCall = async () => {
    if (!canCall || busy) return;
    setBusy(true);
    try {
      await onDial({ phone: phone.trim(), name: name.trim() });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Enter' && canCall) {
        e.preventDefault();
        handleCall();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canCall, phone, name, onClose]);

  return (
    <>
      <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div
        className="modal glass manual-dial-modal"
        initial={{ opacity: 0, scale: 0.94, y: 15 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96 }}
        role="dialog"
        aria-modal="true"
        aria-label="Direct Manual Dialpad"
      >
        <div className="modal-head">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0, fontSize: 16 }}>
            <Grid3x3 size={18} style={{ color: '#818cf8' }} /> Dial Any Number
          </h3>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)"><X size={16} /></button>
        </div>

        <div className="manual-dial-display">
          <input
            ref={inputRef}
            autoFocus
            type="tel"
            className="manual-dial-input"
            placeholder="Enter phone number…"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          {phone ? (
            <button type="button" className="manual-dial-clear" onClick={handleClear} title="Clear">
              <X size={16} />
            </button>
          ) : null}
        </div>

        <div style={{ marginBottom: 12 }}>
          <input
            type="text"
            placeholder="Contact Name / Note (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              width: '100%',
              fontSize: 13,
              padding: '8px 12px',
              borderRadius: 10,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid var(--line)',
              color: 'var(--text)',
              outline: 'none',
            }}
          />
        </div>

        <div className="manual-dial-grid">
          {DIALPAD_KEYS.map((k) => (
            <button
              key={k.key}
              type="button"
              className="manual-dial-key"
              onClick={() => handleKeyClick(k.key)}
            >
              <span className="manual-dial-key-digit">{k.key}</span>
              <span className="manual-dial-key-sub">{k.sub}</span>
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          {phone ? (
            <button
              type="button"
              className="btn"
              onClick={handleBackspace}
              style={{ flex: 'none', padding: '0 16px' }}
              title="Backspace"
            >
              ⌫
            </button>
          ) : null}
          <button
            type="button"
            className="manual-dial-call-btn"
            onClick={handleCall}
            disabled={!canCall || busy}
          >
            {busy ? <Loader2 size={16} className="spin" /> : <PhoneCall size={16} />}
            <span>{canCall ? `Call ${phone}` : 'Enter number'}</span>
          </button>
        </div>
      </motion.div>
    </>
  );
}

function ExtraDetailsAccordion({ prospect, onUpdate }) {
  const [open, setOpen] = useState(false);
  const insights = useMemo(() => extraInsights(prospect?.extra), [prospect?.extra]);
  const panelId = `dialer-extra-${prospect?.id || 'curr'}`;

  // Keyboard shortcut X to toggle extra details
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key?.toLowerCase() === 'x' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  if (!prospect) return null;

  const totalCount = (insights?.count || 0) + (prospect.location ? 1 : 0) + (prospect.website ? 1 : 0) + (prospect.follow_up_at ? 1 : 0);

  return (
    <div className="registry registry-cockpit" aria-label="Extra prospect details and registry metadata">
      <button
        type="button"
        className="registry-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        title="Toggle extra lead details & registry metadata (Press X)"
      >
        <ChevronDown size={15} className={`registry-caret ${open ? 'open' : ''}`} aria-hidden />
        <span className="registry-label">
          <b>Extra Details &amp; Registry Info</b> <em>{totalCount}</em>
        </span>
        <span className="registry-pills">
          {insights?.cvr && <span className="pill pill-cvr" title="Danish company registration number (CVR)">CVR {insights.cvr}</span>}
          {prospect.location && (
            <span className="pill pill-quiet" title={`Location: ${prospect.location}`}>
              <MapPin size={11} /> {clip(prospect.location, 26)}
            </span>
          )}
          {prospect.website && (
            <span className="pill pill-quiet" title={`Website: ${prospect.website}`}>
              <Globe size={11} /> Web
            </span>
          )}
          {insights?.adProtected && (
            <span className="pill pill-protected" title={insights.protectionNote}>
              <ShieldX size={12} /> Ad-protected
            </span>
          )}
          {insights?.urlCount > 0 && <span className="pill pill-quiet">{insights.urlCount} link{insights.urlCount === 1 ? '' : 's'}</span>}
          <kbd className="chip-kbd" title="Shortcut to toggle extra details">X</kbd>
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panelId}
            className="registry-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            {/* Standard Secondary Fields */}
            <div className="registry-grid" style={{ marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              {prospect.location && (
                <div className="registry-item">
                  <label><MapPin size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Location</label>
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(prospect.location + (prospect.company ? ` ${prospect.company}` : ''))}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="registry-link"
                    title="Open address in Google Maps"
                  >
                    <span>{prospect.location}</span>
                    <ExternalLink size={11} aria-hidden />
                  </a>
                </div>
              )}
              {prospect.website && (
                <div className="registry-item">
                  <label><Globe size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Website</label>
                  <a
                    href={prospect.website.startsWith('http') ? prospect.website : `https://${prospect.website}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="registry-link"
                    title={prospect.website}
                  >
                    <span>{clip(prospect.website, 45)}</span>
                    <ExternalLink size={11} aria-hidden />
                  </a>
                </div>
              )}
              <div className="registry-item">
                <label><CalendarCheck size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Follow-up Date</label>
                <input
                  type="date"
                  className="input sm"
                  style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: 6, padding: '2px 8px', fontSize: 12 }}
                  value={prospect.follow_up_at || ''}
                  onChange={(e) => onUpdate?.({ follow_up_at: e.target.value })}
                />
              </div>
              <div className="registry-item">
                <label>Pipeline Stage</label>
                <select
                  value={prospect.stage || 'new'}
                  onChange={(e) => onUpdate?.({ stage: e.target.value })}
                  style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.15)', color: '#fff', borderRadius: 6, padding: '3px 8px', fontSize: 12 }}
                >
                  {STAGES.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Dynamic Registry / Sheet columns */}
            {insights?.entries && insights.entries.length > 0 && (
              <div className="registry-grid">
                {insights.entries.map((e) => (
                  <div key={e.key} className="registry-item">
                    <label>{e.key}</label>
                    {e.isUrl ? (
                      <a
                        href={e.value}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="registry-link"
                        title={e.value}
                      >
                        {e.key.toLowerCase().includes('map') ? <MapPin size={11} aria-hidden /> : null}
                        {clip(e.value, 48)} <ExternalLink size={11} aria-hidden />
                      </a>
                    ) : (
                      <span>{isUrlValue(e.value) ? clip(e.value, 48) : e.value}</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Do Not Call checkbox */}
            <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <label className="check-row" style={{ fontSize: 12, margin: 0 }}>
                <input
                  type="checkbox"
                  checked={!!prospect.dnc}
                  onChange={(e) => onUpdate?.({ dnc: e.target.checked })}
                />
                <span className={prospect.dnc ? 'danger' : 'muted'}>Mark as Do Not Call (blocks the Call button)</span>
              </label>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Dialer() {
  const {
    prospects, loaded, activeId, setActiveId, refreshProspects, refreshStats, toast, patchLocal, setView, settings, updateProspect, stats,
    inbound, inboundEnded, setInboundEnded,
    activeCall, setActiveCall, clearActiveCall,
  } = useStore();
  const [tab, setTab] = useState('new');
  const [q, setQ] = useState('');
  const [phase, setPhase] = useState(() => activeCall?.phase || 'idle'); // idle | dialing | active
  const [callId, setCallId] = useState(() => activeCall?.callId || null);
  const [dial, setDial] = useState(() => activeCall?.dial || null); // { uri, full, protocol, mode, phone } handed to the softphone
  const [launched, setLaunched] = useState(() => !!activeCall?.launched); // OS accepted the dial URI
  const [done, setDone] = useState(() => new Set());
  const [autoNext, setAutoNext] = useState(true);
  const [flash, setFlash] = useState(null);
  const [noteFocus, setNoteFocus] = useState(0);
  const [quickNote, setQuickNote] = useState('');
  const [classifyModal, setClassifyModal] = useState(null); // { callId, duration, prospect }
  const [targetStage, setTargetStage] = useState('');
  const [customNote, setCustomNote] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [manualDialOpen, setManualDialOpen] = useState(false);
  const manualDialRef = useRef(false);
  manualDialRef.current = manualDialOpen;
  // { id, name, noteText } of the prospect being emailed, or null. Holding the target rather
  // than a bare boolean means the follow-up prompt can still address a prospect the agent has
  // already navigated away from.
  const [mailing, setMailing] = useState(null);
  const [verdict, setVerdict] = useState(null);    // email verdict for the banner chip
  const [followUp, setFollowUp] = useState(null);  // { id, name, noteText } — one-click follow-up
  // Mirrored like phaseRef/classifyRef: the composer's open state is read inside the keydown
  // handler, which must not act on a stale value.
  const mailingRef = useRef(false);
  mailingRef.current = mailing;

  const [sidebarMode, setSidebarMode] = useState('queue'); // 'queue' | 'recents'
  const [cockpitRecents, setCockpitRecents] = useState([]);
  const [cockpitRecentsLoading, setCockpitRecentsLoading] = useState(false);

  const loadCockpitRecents = useCallback(() => {
    setCockpitRecentsLoading(true);
    api.calls({ limit: 15 })
      .then((res) => setCockpitRecents(res.calls || []))
      .catch(() => { })
      .finally(() => setCockpitRecentsLoading(false));
  }, []);

  useEffect(() => {
    if (sidebarMode === 'recents') {
      loadCockpitRecents();
    }
  }, [sidebarMode, loadCockpitRecents]);

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
  const phaseRef = useRef(phase);
  const classifyRef = useRef(null);
  const dialLockRef = useRef(false);
  const logLockRef = useRef(false);
  const setPhaseSafe = useCallback((next) => {
    phaseRef.current = next;
    setPhase(next);
    if (next === 'idle') {
      clearActiveCall();
    }
  }, [clearActiveCall]);
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

  // ---- In-browser softphone (telephony_mode = 'webrtc') ---------------------------------
  // Same cockpit, no external app: the microphone, the media path and the hang-up all live in
  // the engine; this component only decides what to show and when to classify.
  const isWebrtc = settings?.telephony_mode === 'webrtc' || (typeof window !== 'undefined' && !!window.pulseNativeSip);
  const isWebrtcRef = useRef(false);
  isWebrtcRef.current = isWebrtc;
  const webrtcRef = useRef(null);
  const sessionRef = useRef(null);        // descriptor from GET /api/telephony/webrtc-session
  const webrtcLiveRef = useRef(false);    // audio genuinely flowing?
  const webrtcFinishRef = useRef(null);   // set below; called when the engine ends the call
  const [dtmfOpen, setDtmfOpen] = useState(false);
  const dtmfRef = useRef(false);
  dtmfRef.current = dtmfOpen;
  const [inCallTone, setInCallTone] = useState('');
  const inCallToneRef = useRef('');
  inCallToneRef.current = inCallTone;


  const sendInCallTone = useCallback((seq) => {
    const raw = String(seq !== undefined ? seq : inCallToneRef.current || '').trim();
    if (!raw) return;
    for (const d of raw) {
      if (DTMF_KEYS.includes(d)) {
        webrtcRef.current?.sendDtmf(d);
      }
    }
    toast(`Touch tone ${raw} sent to line`, 'info');
    setInCallTone('');
  }, [toast]);
  // "Discard without logging" throws away the talk time and anything typed during the call, so
  // it asks first. Confirming is a deliberate second click, never a stray one.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const confirmDiscardRef = useRef(false);
  confirmDiscardRef.current = confirmDiscard;

  // The phone is owned by the app shell (SoftphoneProvider) so the tab rings on any page.
  // Dialer only consumes that singleton — and registers its active/ended callbacks with it,
  // instead of building a second UserAgent behind the banner's back.
  const webrtc = useSoftphone();
  // Only the engine may promote the callbar to 'active', and it does so when audio really
  // flows (a live ICE connect, or the dry-run simulator auto-connecting). Everywhere else the
  // dialer used to go 'active' the instant the server answered, which drew a running timer
  // over a call that had no audio path at all — the exact bug this replaces.
  const engineActive = useCallback(() => {
    webrtcLiveRef.current = true;
    setLaunched(true);
    setPhaseSafe('active');
    refreshStats();
  }, [setPhaseSafe, refreshStats]);
  // Fires when the engine ends the session. The mic is already cold by then (the engine
  // releases it before reporting), so classification opens on a call that is truly over.
  const engineEnded = useCallback(() => {
    webrtcLiveRef.current = false;
    if (phaseRef.current !== 'idle') webrtcFinishRef.current?.();
  }, []);
  const handleRecordingReady = useCallback(async ({ blob, durationSec, callId: recCallId }) => {
    // SoftphoneProvider already uploads when recCallId is attached to the engine.
    if (recCallId) return;
    const idToUpload = callId || classifyRef.current?.callId;
    if (idToUpload && blob && blob.size > 0) {
      try {
        await api.uploadRecording(idToUpload, blob, durationSec);
      } catch (err) {
        console.warn('Background recording upload non-fatal failure:', err);
      }
    }
  }, [callId]);
  useEffect(() => {
    webrtc?.setCallHandlers?.({ onActive: engineActive, onEnded: engineEnded, onRecordingReady: handleRecordingReady });
  }, [webrtc, engineActive, engineEnded, handleRecordingReady]);
  webrtcRef.current = webrtc;
  // Readable synchronously from the key handler: while this is set, the banner owns the phone.
  const ringingRef = useRef(null);
  ringingRef.current = webrtc?.incomingCall || null;

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
      if (pinned && pinned.id === activeId) {
        const tabDef = queueTab(tab);
        if (!tabDef?.test || tabDef.test(pinned)) return pinned;
      }
    }
    return items[0] || null;
  }, [items, activeId, pinned, tab]);

  // Update root-level store activeCall state whenever call state changes
  useEffect(() => {
    if (phase === 'active' || phase === 'dialing') {
      setActiveCall?.({
        phase,
        callId,
        dial,
        launched,
        prospectId: active?.id || null,
        prospectName: active ? getProspectDisplayName(active) : (dial?.phone || ''),
        phone: dial?.phone || active?.phone || '',
      });
    } else if (phase === 'idle') {
      clearActiveCall?.();
    }
  }, [phase, callId, dial, launched, active, setActiveCall, clearActiveCall]);

  const { detail, reload } = useDetail(active?.id);
  const idx = active ? items.findIndex((p) => p.id === active.id) : -1;

  // The banner chip shows the live verdict for the active address, so the agent knows whether
  // a follow-up can even arrive before opening the composer. A verdict is cached per address —
  // it costs a DNS lookup and the answer does not change mid-session.
  const verdictCache = useRef(new Map());
  useEffect(() => {
    const addr = String(active?.email || '').trim();
    if (!addr) { setVerdict(null); return undefined; }
    if (verdictCache.current.has(addr)) { setVerdict(verdictCache.current.get(addr)); return undefined; }
    if (verdictCache.current.size > 200) verdictCache.current.clear();   // bounded
    let cancelled = false;
    api.verifyEmail(addr)
      .then((v) => { verdictCache.current.set(addr, v); if (!cancelled) setVerdict(v); })
      .catch(() => { if (!cancelled) setVerdict(null); });
    return () => { cancelled = true; };
  }, [active?.email]);

  // Auto-scroll the active queue item into view smoothly
  useEffect(() => {
    if (activeItemRef.current) {
      activeItemRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [active?.id]);

  // Synchronize tab when activeId changes externally (e.g. Prospects table 'Call')
  const prevActiveIdRef = useRef(activeId);
  useEffect(() => {
    if (!activeId) {
      prevActiveIdRef.current = null;
      return;
    }
    const isNewActive = prevActiveIdRef.current !== activeId;
    prevActiveIdRef.current = activeId;
    if (!isNewActive) return;

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

  // Walk forward from the current lead to the next one that actually has a number, wrapping at
  // the end of the loaded window. Used when C is pressed on a phoneless lead.
  const nextDiallableId = (list, currentId) => {
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) return null;
    const start = Math.max(0, arr.findIndex((p) => p.id === currentId));
    for (let step = 1; step <= arr.length; step++) {
      const cand = arr[(start + step) % arr.length];
      if (cand && cand.id !== currentId && cand.phone && !cand.dnc) return cand.id;
    }
    return null;
  };

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
    if (ringingRef.current) return;   // the phone is ringing: answer or decline it first
    if (!active || phaseRef.current !== 'idle' || classifyRef.current) return;
    if (active.dnc) return toast('This prospect is marked Do Not Call.', 'error');
    if (!active.phone) {
      // A lead with no number cannot be dialled, and refusing in place left the agent pressing
      // C against the same wall (the queue ranks phoneless leads last, but it does queue them).
      // Say why, then walk to the next lead that *can* be dialled.
      const next = nextDiallableId(items, active.id);
      if (!next) return toast('No phone number for this prospect.', 'error');
      toast(`No phone number for ${active.name || 'this prospect'} — skipped to the next lead.`, 'error');
      setActiveId(next);
      return;
    }
    // Danish 70/90 ranges cost real money. Ask first, because the call is logged and the
    // softphone is handed the number the moment this function continues.
    const nk = active.number_kind;
    if (nk && nk.expensive && !confirm(`${nk.label}\n${active.phone}\n\n${nk.note}\n\nDial anyway?`)) return;
    dialLockRef.current = true;
    setPhaseSafe('dialing');
    setLaunched(false);
    setFollowUp(null);   // a stale "send a follow-up" prompt must not outlive the next call
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
      setDial({ uri: r.dialUri, full: r.dialUriFull, protocol: r.protocol, mode: r.telephonyMode, engine: r.engine, phone: r.phone });
      patchLocal(active.id, { call_count: active.call_count + 1, last_called_at: new Date().toISOString() });
      const softphone = softphoneLabel(r.telephonyMode, r.engine);

      // ---- In-browser call: no OS dispatch and no invented 'active' ----
      // The server never hands out a sip:/tel: URI for this mode; the media session is built
      // here. The engine reports back only when the audio path is real (or, in test mode, when
      // the simulator has auto-connected), so the timer cannot start on a silent call.
      if (r.inBrowser) {
        const res = await webrtcRef.current.start(r.phone, { dryRun: !!r.dryRun, callId: r.callId });
        if (!res?.ok) {
          // Nothing ever left the machine, so the record the server just created is a phantom.
          // Remove it rather than leaving a call in history that no audio ever carried.
          try { await api.discardCall(r.callId); } catch { /* best effort */ }
          patchLocal(active.id, { call_count: active.call_count });
          setCallId(null);
          setDial(null);
          setPhaseSafe('idle');
          return toast(res?.reason || res?.error || 'The in-browser call could not start.', 'error');
        }
        if (r.dryRun) toast(`Test mode: ${r.dialUri} simulated in-browser`);
        else toast(`Pulse softphone dialing ${r.phone}…`);
        return;
      }

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
  }, [active, items, setActiveId, setPhaseSafe, toast, patchLocal, refreshStats]);

  // Re-dispatch the same URI when the OS prompt was dismissed or the softphone was closed.
  const relaunchSoftphone = useCallback(() => {
    if (!dial?.phone) return;
    const softphone = softphoneLabel(dial.mode, dial.engine);
    if (phaseRef.current === 'idle') return;
    // Test mode must never hand a dial URI to the OS — not even on a re-launch.
    if (settings?.dry_run === '1') {
      return toast(`Test mode is on: dialing ${dial.phone} stays simulated.`);
    }
    if (webrtcRef.current?.start) {
      webrtcRef.current.start(dial.phone, { dryRun: false, callId });
      setLaunched(true);
      toast(`Redialing ${dial.phone}…`);
      return;
    }
    const ok = dial.mode === 'softphone' && dial.uri ? dispatchDialUri(dial.uri) : false;
    setLaunched(ok);
    toast(ok ? `Re-launching ${dial.uri} in ${softphone}` : `Could not launch ${softphone} — open it and dial ${dial.phone} manually`, ok ? 'ok' : 'error');
  }, [dial, settings, callId, toast]);

  // The second half of a hang-up: everything except silencing the audio, which is over.
  // Split out because the in-browser engine calls it itself once it has released the mic.
  const openClassification = useCallback(() => {
    if (!callId || !active) return;
    const dur = secRef.current;
    setPhaseSafe('idle');
    setLaunched(false);
    setDtmfOpen(false);   // the touch-tone pad must not float over the classification dialog
    setTargetStage(active.stage || 'contacted');
    setCustomNote(quickNoteRef.current.trim());
    setClassifySafe({
      callId,
      duration: dur,
      prospect: active,
    });
  }, [callId, active, setPhaseSafe, setClassifySafe]);
  webrtcFinishRef.current = openClassification;

  // An inbound call that has been answered belongs to the cockpit from that moment: the same
  // call bar, the same talk timer, the same M / D / H keys as an outbound dial. The call row
  // was opened by the provider when the phone started ringing, so only the outcome is missing.
  useEffect(() => {
    if (!inbound?.answered || !inbound.callId) return;
    if (callId === inbound.callId && phaseRef.current !== 'idle') return;
    setCallId(inbound.callId);
    setDial({ uri: null, full: null, protocol: 'webrtc', mode: 'webrtc', phone: inbound.callerNumber });
    setLaunched(true);
    if (phaseRef.current === 'idle') setPhaseSafe('active');
  }, [inbound, callId, setPhaseSafe]);

  // The far end hung up (or the agent did): straight into the same 1-8 disposition modal an
  // outbound call ends in — same copilot, same follow-up prompt, same duration bookkeeping.
  useEffect(() => {
    if (!inboundEnded) return;
    setInboundEnded(null);
    setPhaseSafe('idle');
    setLaunched(false);
    setDtmfOpen(false);
    if (!inboundEnded.callId || !inboundEnded.prospect) return;
    setTargetStage(inboundEnded.prospect.stage || 'contacted');
    setCustomNote(quickNoteRef.current.trim());
    setClassifySafe({
      callId: inboundEnded.callId,
      duration: secRef.current,
      prospect: inboundEnded.prospect,
    });
  }, [inboundEnded, setInboundEnded, setPhaseSafe, setClassifySafe]);

  // When clicking hang up button, open the classification modal
  const hangUp = useCallback(() => {
    if (phaseRef.current !== 'active' || !callId || !active) return;
    // In-browser: hanging up means releasing the microphone, and the engine reports back the
    // moment it has done that — so classification happens with the mic already cold.
    if (isWebrtcRef.current) {
      webrtcRef.current?.hangUp();
      return;
    }
    openClassification();
  }, [callId, active, openClassification]);

  // Inline edits in the hero banner. The server normalizes anyway, but a rejection that only
  // arrives after the round-trip reads as "the app ate my edit", so an obviously wrong value
  // is refused here with the reason, and the field keeps what the agent typed.
  const savePhone = useCallback((raw) => {
    const issue = phoneIssue(raw, settings?.default_country_code);
    if (issue) { toast(issue, 'error'); return null; }
    return updateProspect(active?.id, { phone: String(raw ?? '').trim() });
  }, [active?.id, settings?.default_country_code, toast, updateProspect]);

  // The guard in front of the discard. Also the Escape path out of the classification modal,
  // which is exactly the case that used to wipe a call with one keystroke.
  const requestDiscard = useCallback(() => {
    // Nothing logged yet means nothing to lose, and the modal was cancelled before it opened.
    if (!callId && !classifyRef.current) return;
    setConfirmDiscard(true);
  }, [callId]);

  // The actual discard. Only ever reached from the confirmation.
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
    setDtmfOpen(false);
    setConfirmDiscard(false);
    // Discarding must not leave the microphone open in the in-browser mode.
    webrtcRef.current?.reset();
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
      // A good call is the one moment the follow-up email writes itself. Offer it while the
      // details are still fresh, carrying the note the agent just typed into the draft.
      if (shouldOfferFollowUp(outcomeId, chosenStage) && modal.prospect.email) {
        // Carry the address with the prompt: the agent may have auto-advanced to the next
        // prospect by the time they click, so the prompt cannot re-derive it from `active`.
        setFollowUp({ id: pid, name: getProspectDisplayName(modal.prospect), email: modal.prospect.email, noteText: noteToSave });
      }
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
      if (isWebrtcRef.current) webrtcRef.current?.hangUp?.();
      setCallId(null);
      setDial(null);
      setLaunched(false);
      clearQuickNote();
      if (shouldOfferFollowUp(outcome, null) && active.email) {
        setFollowUp({ id: finished, name: active.name, email: active.email, noteText: noteToSave });
      }
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

  // Opens the in-app composer for whatever prospect is on screen — the banner chip, the E
  // shortcut and the post-call follow-up prompt all funnel through here so they cannot drift.
  const openComposer = useCallback((target, noteText) => {
    const p = target || active;
    if (!p?.email) { toast('This prospect has no email address yet', 'error'); return; }
    setMailing({ id: p.id, name: getProspectDisplayName(p), email: p.email, noteText });
  }, [active, toast]);

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

  // Direct dial any custom/ad-hoc phone number directly
  const handleDirectDial = useCallback(async ({ phone, name }) => {
    if (dialLockRef.current || ringingRef.current || phaseRef.current !== 'idle' || classifyRef.current) return;
    dialLockRef.current = true;
    setPhaseSafe('dialing');
    setLaunched(false);
    setFollowUp(null);
    try {
      const r = await api.directDial({ phone, name });
      if (!r || !r.ok) {
        setPhaseSafe('idle');
        return toast(r?.error || 'Direct dial failed.', 'error');
      }

      if (r.prospect) {
        patchLocal(r.prospect.id, r.prospect);
        setPinned(r.prospect);
        setActiveId(r.prospect.id);
        refreshProspects();
        queue.refresh?.();
      }

      setCallId(r.callId);
      setDial({ uri: r.dialUri, full: r.dialUriFull, protocol: r.protocol, mode: r.telephonyMode, engine: r.engine, phone: r.phone });
      const softphone = softphoneLabel(r.telephonyMode, r.engine);

      if (r.inBrowser) {
        const res = await webrtcRef.current.start(r.phone, { dryRun: !!r.dryRun, callId: r.callId });
        if (!res?.ok) {
          try { await api.discardCall(r.callId); } catch { /* best effort */ }
          setCallId(null);
          setDial(null);
          setPhaseSafe('idle');
          return toast(res?.reason || res?.error || 'The in-browser call could not start.', 'error');
        }
        if (r.dryRun) toast(`Test mode: ${r.dialUri} simulated in-browser`);
        else toast(`Pulse softphone dialing ${r.phone}…`);
        return;
      }

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
  }, [setPhaseSafe, setCallId, setDial, patchLocal, setPinned, setActiveId, refreshProspects, queue, toast, refreshStats]);

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
      // The banner owns the keyboard while the phone rings (it also stops propagation, this is
      // the belt to that braces: a keystroke between two renders must not reach the dialer).
      if (ringingRef.current) return;
      // Single-character shortcuts work regardless of Shift/CapsLock; named keys stay verbatim.
      const k = typeof e.key === 'string' && e.key.length === 1 ? e.key.toLowerCase() : e.key;

      // Modal keyboard handling
      // The discard confirmation owns the keyboard while it is up.
      if (confirmDiscardRef.current) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setConfirmDiscard(false);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          handleDiscardCall();
        }
        return;
      }

      if (classifyRef.current || classifyModal) {
        if (e.key === 'Escape') {
          e.preventDefault();
          // Escape backs out of classifying; it must not be the keystroke that throws the call
          // away, so it opens the same confirmation the button does.
          requestDiscard();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          commitClassification('conversation', targetStage, customNote);
        } else if (/^[1-8]$/.test(e.key)) {
          e.preventDefault();
          commitClassification(OUTCOMES[Number(e.key) - 1].id, targetStage, customNote);
        }
        return;
      }

      // The touch-tone pad is a modal too: while it is open, digits are tones for the
      // provider's IVR, not call results. Otherwise "press 1 for sales" would classify
      // the call instead of navigating the menu.
      if (dtmfRef.current) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setDtmfOpen(false);
        } else if (DTMF_KEYS.includes(k)) {
          e.preventDefault();
          webrtcRef.current?.sendDtmf(k);
        }
        return;
      }

      // The composer and manual dialpad are modals: while open the dialer must stop listening, or a
      // keystroke aimed at inputs also places an unintentional call.
      if (mailingRef.current || manualDialRef.current) return;

      // Mute lives on M, like every other softphone. Only meaningful with a live mic.
      if (k === 'm' && isWebrtcRef.current && webrtcLiveRef.current) {
        e.preventDefault();
        const nowMuted = webrtcRef.current?.toggleMute(); // undefined = the daemon owns the answer
        if (typeof nowMuted === 'boolean') toast(nowMuted ? 'Microphone muted' : 'Microphone live');
        return;
      }
      if (k === 'd') {
        if (isWebrtcRef.current && webrtcLiveRef.current) {
          e.preventDefault();
          setDtmfOpen((v) => !v);
          return;
        }
        if (phaseRef.current === 'idle') {
          e.preventDefault();
          setManualDialOpen(true);
          return;
        }
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
      } else if (k === 'e') {
        // Email the active prospect. Shift/CapsLock work for free — `k` is already lowered,
        // and the input/textarea guard above keeps this out of the search and notes boxes.
        if (active?.email) {
          e.preventDefault();
          openComposer(active);
        }
      } else if (DTMF_KEYS.includes(k) && isWebrtcRef.current && (phaseRef.current === 'active' || webrtcLiveRef.current)) {
        // In-call touch tone dialer: when a WebRTC / native call is live (or in early media), digit keys
        // (0-9, *, #) work directly like a real dialer to navigate IVRs ("press 1 for English, press 2 for Danish")
        // instead of classifying the call or logging voicemail.
        e.preventDefault();
        webrtcRef.current?.sendDtmf(k);
        toast(`Tone ${k} sent`, 'info');
      } else if (phaseRef.current === 'active' && /^[1-8]$/.test(k) && !isWebrtcRef.current) {
        logOutcome(OUTCOMES[Number(k) - 1].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, classifyModal, startCall, hangUp, go, logOutcome, relaunchSoftphone, requestDiscard, handleDiscardCall, commitClassification, targetStage, customNote, active, openComposer, toast, setDtmfOpen, setManualDialOpen]);

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
  // "Finished" has to mean finished, not filtered-to-nothing: the tab itself must hold nothing
  // (not merely have nothing matching the current search) and the agent must have dialled
  // today — a fresh morning is not an achievement. A search that matches nothing while leads
  // remain is still just "Nobody matches".
  //
  // Leads with no phone number do *not* count as finished work. They cannot be dialled, and
  // the honest place to fix one is the row itself (the banner chip and the queue both offer
  // it), so the counter below keeps them visible instead of quietly declaring victory over
  // them. Pressing C on one skips to the next lead that can actually be dialled.
  const today = stats?.today || null;
  const tabEmpty = (counts?.[tab] ?? 0) === 0;
  const doneToday = Boolean(today && today.dials > 0 && !loading && tabEmpty);
  const phonelessLeft = items.filter((p) => !p.phone).length;
  const progress = queueProgress(items, done, tab);
  // Tab labels are chips ("To call"), not prose — spelling them into a sentence produced
  // "Every lead in to call has been called". These are the same three queues, said out loud.
  const tabProse = { new: 'the call list', follow: 'the follow-up list', all: 'the list' }[tab] || 'this queue';
  const softphone = softphoneLabel(settings?.telephony_mode, webrtc?.engine);
  const cc = ccLabel(settings?.default_country_code);
  const proto = settings?.softphone_protocol === 'tel' ? 'tel' : 'sip';
  // In-browser mode reports the engine's own state, so the strip under the callbar says
  // "Ringing" only while it really is ringing, and shows the engine's error when it fails.
  const webState = webrtc.state;
  const inboundActive = !!inbound?.answered;
  const activeName = active ? getProspectDisplayName(active) : '';
  const activeCompany = active?.company || '';
  const prospectTarget = activeName ? `${activeName}${activeCompany ? ` (${activeCompany})` : ''}` : '';

  const inflightText = isWebrtc
    ? webState === 'registering' ? `Registering with ${softphone}…`
      : webState === 'ringing' ? `Ringing ${prospectTarget || dial?.phone || active?.phone || ''}…`
        : webState === 'error' ? (webrtc.error || 'The in-browser call failed.')
          : webState === 'active' ? (dry && !inboundActive ? `Test mode: in-browser call simulated` : `${inboundActive ? 'Inbound call' : 'In-browser call live'} with ${inboundActive ? (inbound?.prospect?.name || inbound?.callerNumber) : (prospectTarget || dial?.phone || active?.phone || '')}`)
            : `Dialing ${prospectTarget || dial?.phone || active?.phone || ''}…`
    : dry
      ? `Simulating ${dial?.uri || `${proto}:${active?.phone || ''}`} · ${prospectTarget}`
      : launched || phase === 'dialing'
        ? `Dialing ${prospectTarget ? `${prospectTarget} via ` : ''}${softphone} (${cc})…`
        : `Waiting on ${softphone} (${cc}) · ${prospectTarget}`;
  const inflightClass = isWebrtc
    ? (webrtc.active ? 'live' : webState === 'error' ? 'err' : 'wait')
    : (dry ? 'dry' : launched ? 'live' : 'wait');

  return (
    <div className="dialer">
      {/* QUEUE / RECENTS SIDEBAR */}
      <section className="glass queue">
        <div className="cockpit-mode-toggle">
          <button
            type="button"
            className={`cockpit-tab ${sidebarMode === 'queue' ? 'active' : ''}`}
            onClick={() => setSidebarMode('queue')}
          >
            <Users size={12} /> Queue ({total || items.length})
          </button>
          <button
            type="button"
            className={`cockpit-tab ${sidebarMode === 'recents' ? 'active' : ''}`}
            onClick={() => setSidebarMode('recents')}
          >
            <History size={12} /> Recents
          </button>
        </div>

        {sidebarMode === 'queue' ? (
          <>
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
              {phonelessLeft > 0 && (
                <span className="meta-warn" title="These leads are in the queue but cannot be dialled until a number is added">
                  {phonelessLeft} without a number
                </span>
              )}
              <span>{done.size} dialed</span>
              <div style={{ display: 'inline-flex', gap: 6, marginLeft: 'auto' }}>
                <button className="btn xs" onClick={() => setManualDialOpen(true)} title="Dial any number directly (D)">
                  <Grid3x3 size={12} /> Keypad
                </button>
                <button className="btn xs primary" onClick={() => setShowAdd(true)} title="Add prospect directly to queue">
                  <Plus size={12} /> Add
                </button>
              </div>
            </div>
            <QueueList
              items={items}
              activeId={active?.id ?? null}
              done={done}
              progress={progress}
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
          </>
        ) : (
          <div className="cockpit-recents-list">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 4px 8px' }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Recent Activity
              </span>
              <button
                type="button"
                className="btn xs"
                onClick={loadCockpitRecents}
                disabled={cockpitRecentsLoading}
                title="Refresh recent calls"
              >
                <RotateCw size={11} className={cockpitRecentsLoading ? 'spin' : ''} />
              </button>
            </div>

            {cockpitRecentsLoading && cockpitRecents.length === 0 ? (
              <div style={{ padding: '30px 10px', textAlign: 'center', color: '#64748b', fontSize: 12 }}>
                <RotateCw size={18} className="spin text-cyan" style={{ margin: '0 auto 8px', display: 'block' }} />
                Loading recent calls…
              </div>
            ) : cockpitRecents.length === 0 ? (
              <div style={{ padding: '30px 10px', textAlign: 'center', color: '#64748b', fontSize: 12 }}>
                No recent calls logged yet.
              </div>
            ) : (
              cockpitRecents.map((rc) => {
                const isMissed = rc.direction === 'inbound' && ['ringing', 'missed', 'declined'].includes(rc.status);
                const isInbound = rc.direction === 'inbound';
                const meta = outcomeMeta(rc.outcome) || { label: rc.outcome || 'Logged', color: '#94a3b8' };
                return (
                  <div
                    key={rc.id}
                    className="cockpit-recent-item"
                    onClick={() => {
                      if (rc.prospect_id) {
                        setActiveId(rc.prospect_id);
                        toast(`Loaded ${rc.prospect_name || 'prospect'} into dialer`);
                      }
                    }}
                    title={rc.prospect_id ? `Click to view ${rc.prospect_name || 'prospect'}` : rc.phone || rc.caller_id}
                  >
                    <div className={`recent-icon ${isMissed ? 'missed' : isInbound ? 'inbound' : 'outbound'}`}>
                      {isMissed ? <PhoneMissed size={12} /> : isInbound ? <ArrowDownLeft size={12} /> : <ArrowUpRight size={12} />}
                    </div>
                    <div className="cockpit-recent-info">
                      <div className="cockpit-recent-title">
                        {rc.prospect_name || rc.caller_id || rc.phone || 'Unknown'}
                      </div>
                      <div className="cockpit-recent-sub">
                        <span>{isMissed ? 'Missed' : fmtDur(rc.duration_sec)}</span>
                        <span>•</span>
                        <span>{(rc.started_at || '').slice(11, 16)}</span>
                        {rc.outcome && (
                          <>
                            <span>•</span>
                            <span style={{ color: meta.color }}>{meta.label}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn xs primary"
                      style={{ padding: '3px 8px', fontSize: 11, flexShrink: 0 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (rc.prospect_id) {
                          setActiveId(rc.prospect_id);
                          toast(`Loaded ${rc.prospect_name || 'prospect'} into dialer`);
                        }
                      }}
                      title="Load into dialer"
                    >
                      <PhoneCall size={10} />
                    </button>
                  </div>
                );
              })
            )}

            <button
              type="button"
              className="btn sm ghost"
              style={{ width: '100%', marginTop: 10, fontSize: 12, justifyContent: 'center' }}
              onClick={() => setView('recents')}
            >
              Open Full Recents Page →
            </button>
          </div>
        )}
      </section>

      {/* CENTER STAGE */}
      <section className="stage">
        {active ? (
          <>
            {/* PROMINENT TOP HERO HEADER - NAME & EMAIL ALWAYS VISIBLE */}
            <div className="glass top-prospect-banner">
              <div className="banner-left">
                <Avatar name={getProspectDisplayName(active)} size={64} seed={active.id + (active.name || active.company || '')} />
                <div className="banner-titles">
                  <div className="banner-name-row">
                    <h2 className="banner-name">{getProspectDisplayName(active)}</h2>
                    {(active.pronunciation || (getProspectDisplayName(active) && getDanishPronunciation(getProspectDisplayName(active)))) && (
                      <button
                        type="button"
                        className="pronounce-chip"
                        onClick={() => speakPronunciation(getProspectDisplayName(active), active.pronunciation || getDanishPronunciation(getProspectDisplayName(active)))}
                        title="Click to hear Danish pronunciation in English phonetics"
                      >
                        <Volume2 size={13} /> {active.pronunciation || getDanishPronunciation(getProspectDisplayName(active))}
                      </button>
                    )}
                    {active.title && <span className="banner-title-badge">{active.title}</span>}
                    {active.dnc && <span className="dnc-badge sm"><Ban size={12} /> DNC</span>}
                  </div>
                  <div className="banner-contacts">
                    {active.phone ? (
                      <span className="banner-phone-chip">
                        <Phone size={14} /> <Editable className="banner-phone-edit" value={active.phone} placeholder="+45 20 12 34 56" onSave={savePhone} />
                      </span>
                    ) : (
                      <span className="banner-phone-chip missing">
                        <Phone size={14} /> <Editable className="banner-phone-edit" value="" placeholder="Click to add phone (+45 20 12 34 56)" onSave={savePhone} />
                      </span>
                    )}
                    {active.email ? (
                      <button
                        type="button"
                        className="banner-email-chip"
                        title={`Email ${active.email} in the app (E)`}
                        onClick={() => openComposer(active)}
                      >
                        <Mail size={14} /> <span>{active.email}</span>
                        {verdict && <VerifyBadge result={verdict} compact />}
                        <kbd className="chip-kbd">E</kbd>
                      </button>
                    ) : (
                      <span className="banner-email-chip muted"><Mail size={14} /> <span>No email listed</span></span>
                    )}
                    {active.company && active.name && (
                      <span className="banner-company-chip">
                        <Building2 size={14} /> <span>{active.company}</span>
                      </span>
                    )}
                    {active.location && (!active.name || !active.company) && (
                      <span className="banner-company-chip">
                        <MapPin size={14} /> <span>{active.location}</span>
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

            {/* EXTRA DETAILS & REGISTRY METADATA COLLAPSIBLE DROPDOWN */}
            <ExtraDetailsAccordion prospect={active} onUpdate={(patch) => updateProspect(active.id, patch)} />

            {/* SOFT PHONE STANDBY. A phone that is only registered while you dial cannot
                receive a call, so the state of the registration is part of the cockpit, not a
                setting buried two pages away. */}
            {isWebrtc && (
              <div className={`standby-strip ${webrtc.standby.state}`} title={webrtc.standby.reason || webrtc.standbyLabel}>
                <span className="standby-dot" />
                <span className="standby-txt">{webrtc.standbyLabel}</span>
                {webrtc.standby.reason && <span className="standby-why">{webrtc.standby.reason}</span>}
                {dry && (
                  <span className="standby-hint" title="Test mode: i simulates an incoming call, Shift+I makes the caller hang up">
                    <kbd className="chip-kbd">i</kbd> rings the phone
                  </span>
                )}
              </div>
            )}
            {/* Two tabs, one phone: the tab that lost the ring says so instead of silently
                swallowing the call. */}
            {isWebrtc && webrtc.standbyNote && (
              <div className="standby-strip busy" role="status">
                <span className="standby-dot" />
                <span className="standby-txt">{webrtc.standbyNote}</span>
              </div>
            )}

            {/* FLYNUMBER WHOLESALE SIP COPENHAGEN ROUTE STRIP */}
            <div className="standby-strip ready" style={{ margin: '6px 0', border: '1px solid rgba(56, 189, 248, 0.25)', background: 'rgba(15, 23, 42, 0.5)' }} title="FlyNumber Wholesale SIP · Copenhagen Line (+45 32 33 16 10) · Native Softphone & Free Inbound">
              <span className="standby-dot" style={{ background: '#38bdf8' }} />
              <span className="standby-txt" style={{ color: '#38bdf8', fontSize: 12 }}>
                FlyNumber Wholesale SIP · Copenhagen Line ({settings?.flynumber_did || '+45 32 33 16 10'}): Native SIP &amp; Free Inbound ($0/min)
              </span>
            </div>

            {/* CALL BAR */}
            <div className={`glass callbar ${phase}`}>
              <div className="callbar-glow" />
              <AnimatePresence>
                {calling && (
                  <motion.div
                    className={`inflight ${inflightClass}`}
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.22, ease: 'easeOut' }}
                  >
                    <span className="inflight-dot" />
                    {isWebrtc ? <Radio size={14} /> : dry ? <FlaskConical size={14} /> : launched ? <Headphones size={14} /> : <Wifi size={14} />}
                    {(activeName || activeCompany) && (
                      <span className="inflight-target-pill">
                        <span className="inflight-target-name">{activeName || 'Prospect'}</span>
                        {activeCompany && (
                          <span className="inflight-target-company">
                            <Building2 size={12} /> {activeCompany}
                          </span>
                        )}
                      </span>
                    )}
                    <span className="inflight-txt">{inflightText}</span>
                    {dial?.uri && <code className="inflight-uri">{dial.uri}</code>}
                    {isWebrtc && webrtc.active && (
                      <span className={`webrtc-badge ${webrtc.muted ? 'muted' : ''}`} title={webrtc.micLabel ? `Microphone: ${webrtc.micLabel}` : 'Microphone is live in the browser'}>
                        {webrtc.muted ? <MicOff size={12} /> : <Mic size={12} />}
                        {webrtc.muted ? 'WebRTC Active · Muted' : 'WebRTC Active · Mic Live'}
                      </span>
                    )}
                    {isWebrtc && webrtc.active && (
                      <>
                        <button
                          className={`btn xs ${webrtc.muted ? 'danger' : ''}`}
                          onClick={() => { const m = webrtc.toggleMute(); if (typeof m === 'boolean') toast(m ? 'Microphone muted' : 'Microphone live'); }}
                          title={webrtc.muted ? 'Unmute the microphone (M)' : 'Mute the microphone (M)'}
                        >
                          {webrtc.muted ? <MicOff size={12} /> : <Mic size={12} />} {webrtc.muted ? 'Unmute' : 'Mute'}
                          <kbd className="chip-kbd">M</kbd>
                        </button>
                        <button
                          className="btn xs"
                          onClick={() => setDtmfOpen((v) => !v)}
                          title="Touch tones for phone menus (D)"
                        >
                          <Grid3x3 size={12} /> Keypad <kbd className="chip-kbd">D</kbd>
                        </button>
                      </>
                    )}
                    {!isWebrtc && !dry && phase === 'active' && (
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
                        onClick={phase === 'active' ? hangUp : (inbound && !inbound.answered ? () => webrtc.answerInbound?.() : startCall)}
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
                    {phase === 'idle' && (
                      <button
                        className="icon-btn"
                        onClick={() => setManualDialOpen(true)}
                        title="Dial another number directly (D)"
                        style={{ marginLeft: 4, color: '#818cf8', borderColor: 'rgba(129, 140, 248, 0.3)' }}
                      >
                        <Grid3x3 size={17} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <Waveform active={phase === 'active'} level={isWebrtc ? webrtc.level : null} />

              {phase === 'active' && isWebrtc && (
                <div className="incall-dialer-strip">
                  <span className="incall-dialer-title">
                    <Grid3x3 size={15} /> Touch Tone (IVR):
                  </span>
                  <div className="incall-dialer-keys">
                    {DTMF_KEYS.map((d) => (
                      <button
                        key={d}
                        type="button"
                        className="incall-tone-btn"
                        onClick={() => webrtcRef.current?.sendDtmf(d)}
                        title={`Send ${d} immediately`}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                  <div className="incall-dialer-input-group">
                    <input
                      type="text"
                      className="incall-tone-input"
                      placeholder="Digit & Enter"
                      value={inCallTone}
                      onChange={(e) => setInCallTone(e.target.value.replace(/[^0-9*#A-Da-d]/g, ''))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          sendInCallTone();
                        }
                      }}
                      title="Type digit(s) and press Enter"
                    />
                    <button
                      type="button"
                      className="btn primary sm incall-enter-btn"
                      onClick={() => sendInCallTone()}
                      title="Send digit(s) into call"
                    >
                      Enter ↵
                    </button>
                  </div>
                  {webrtc.dtmfLog && (
                    <span className="incall-dialer-log" title="Last tones sent">
                      Sent: {webrtc.dtmfLog}
                    </span>
                  )}
                </div>
              )}

              <div className="outcome-head">
                <span>{phase === 'active' ? 'Click Hangup (Red) or pick a result below to classify:' : 'Call results unlock when a call starts'}</span>
                <label className="auto-next"><span>Auto-next</span><Switch checked={autoNext} onChange={setAutoNext} /></label>
              </div>
              <div className={`outcomes ${phase === 'active' ? 'live' : ''}`}>
                {OUTCOMES.map((o) => {
                  const Icon = ICONS[o.icon] || Circle;
                  return (
                    <motion.button key={o.id} whileTap={{ scale: 0.94 }} disabled={phase !== 'active'} className="outcome" style={{ '--c': o.color }} onClick={() => logOutcome(o.id)}>
                      <Icon size={17} /><span>{o.label}</span>
                    </motion.button>
                  );
                })}
              </div>
              {phase === 'active' && (
                <div className="row gap justify-between call-actions">
                  <div className="row gap">
                    <button className="btn danger sm" onClick={hangUp} title={dry ? 'Hang up and classify (H)' : `End the call in ${softphone}, then classify here (H)`}><PhoneOff size={14} /> Hang Up & Classify</button>
                    <button className="link-btn" onClick={requestDiscard}><SkipForward size={13} /> Discard without logging</button>
                  </div>
                  {!isWebrtc && !dry && dial?.uri && (
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
                  Switch to Live mode in Settings once {softphone} is registered with FlyNumber.
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

            {/* POST-CALL FOLLOW-UP PROMPT — one click from a good call to a written email */}
            <AnimatePresence>
              {followUp && !mailing && (
                <motion.div
                  className="glass followup-prompt"
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                >
                  <Mail size={17} />
                  <div className="followup-txt">
                    <b>Send {followUp.name || 'this prospect'} a follow-up email?</b>
                    <small>The draft already carries the call outcome, your notes and the meeting link.</small>
                  </div>
                  <div className="row gap">
                    <button
                      className="btn primary sm"
                      onClick={() => openComposer({ id: followUp.id, name: followUp.name, email: followUp.email }, followUp.noteText)}
                    >
                      <Send size={14} /> Send follow-up email
                    </button>
                    <button className="btn sm" onClick={() => setFollowUp(null)}>Not now</button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* KEYBOARD SHORTCUTS HINT BAR */}
            <div className="glass" style={{ padding: '10px 16px', borderRadius: 12, margin: '14px 0', border: '1px solid rgba(255,255,255,0.08)' }}>
              <div className="kbd-hint" style={{ margin: 0, justifyContent: 'center' }}>
                <Keyboard size={13} /> <kbd>C</kbd> call/hang up · <kbd>1-8</kbd> classify · <kbd>H</kbd> hang up &amp; classify · <kbd>E</kbd> email{isWebrtc ? ' · ' : ' · '}<kbd>M</kbd>{isWebrtc ? ' mute' : ''} · {isWebrtc ? <><kbd>D</kbd> keypad · </> : <><kbd>R</kbd> re-launch softphone · </>}<kbd>←</kbd><kbd>→</kbd> navigate · <kbd>N</kbd> notes · <kbd>X</kbd> extra details
              </div>
            </div>
          </>
        ) : doneToday ? (
          /* END OF QUEUE — not an empty search. Every lead in this tab is finished, and the
             agent has actually dialled today, so this is the reward screen rather than an
             error screen. */
          <motion.div className="glass queue-done" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 24 }}>
            <motion.div className="qd-trophy" initial={{ scale: 0, rotate: -20 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 300, damping: 12, delay: 0.08 }}>
              <Trophy size={34} strokeWidth={2.4} />
            </motion.div>
            <h2>Queue completed! 🎉</h2>
            <p className="muted">
              Every lead in {tabProse} has been called. Take the win, then decide what is next.
            </p>

            <div className="qd-stats">
              <div><b>{today.dials}</b><span>dials today</span></div>
              <div><b>{today.conversations}</b><span>conversations</span></div>
              <div><b>{today.meetings}</b><span>meetings booked</span></div>
              <div><b>{fmtDur(today.talkSec || 0)}</b><span>talk time</span></div>
            </div>

            <div className="qd-actions">
              <button className="btn primary glow" onClick={() => setView('dashboard')}>
                <LayoutDashboard size={15} /> Review today&apos;s dashboard
              </button>
              {tab !== 'all' && (
                <button className="btn" onClick={() => handleTabChange('all')}>
                  <Repeat size={15} /> Switch to all prospects
                </button>
              )}
              <button className="btn" onClick={() => setView('import')}>
                <Upload size={15} /> Import more leads
              </button>
              {q && (
                <button className="link-btn" onClick={() => setQ('')}>Clear the search “{q}”</button>
              )}
            </div>

            <div className="confetti" aria-hidden>
              {Array.from({ length: 22 }).map((_, i) => (
                <motion.i
                  key={i}
                  style={{ left: `${(i * 41) % 100}%`, background: ['#8b5cf6', '#22d3ee', '#34d399', '#f472b6', '#fbbf24'][i % 5] }}
                  initial={{ y: -16, opacity: 1, rotate: 0 }}
                  animate={{ y: 300, opacity: 0, rotate: 300 + i * 18 }}
                  transition={{ duration: 1.7 + (i % 5) * 0.2, delay: 0.2 + (i % 8) * 0.05, ease: 'easeIn' }}
                />
              ))}
            </div>
          </motion.div>
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

      {/* TOUCH-TONE PAD — navigate an IVR without leaving the cockpit */}
      <AnimatePresence>
        {isWebrtc && dtmfOpen && (
          <>
            <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setDtmfOpen(false)} />
            <motion.div
              className="modal dtmf-pad"
              initial={{ opacity: 0, scale: 0.94, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <DtmfPad
                log={webrtc.dtmfLog}
                onKey={(d) => webrtc.sendDtmf(d)}
                onClose={() => setDtmfOpen(false)}
                muted={webrtc.muted}
                onToggleMute={() => { const m = webrtc.toggleMute(); if (typeof m === 'boolean') toast(m ? 'Microphone muted' : 'Microphone live'); }}
              />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* DISCARD CONFIRMATION — the one screen between a stray click and a lost call */}
      <AnimatePresence>
        {confirmDiscard && (
          <>
            <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setConfirmDiscard(false)} />
            <motion.div
              className="modal glass confirm-modal"
              initial={{ opacity: 0, scale: 0.95, y: -12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: -8 }}
              role="dialog"
              aria-label="Confirm discard"
            >
              <div className="modal-head">
                <h3><SkipForward size={16} /> Discard this call?</h3>
                <button className="icon-btn" onClick={() => setConfirmDiscard(false)} title="Keep the call (Esc)"><X size={16} /></button>
              </div>
              <p className="muted small">
                Talk time and any notes typed during this call will not be saved.
                {sec > 0 ? ` You have ${fmtDur(sec)} on the clock.` : ''}
              </p>
              <div className="modal-foot">
                <button className="btn" onClick={() => setConfirmDiscard(false)} autoFocus>Keep Call</button>
                <button className="btn danger" onClick={handleDiscardCall}>
                  <Trash2 size={14} /> Discard Call
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Remote audio is mounted persistently at the App root level so audio plays across all views */}

      {/* CLASSIFICATION MODAL ON HANG UP */}
      <AnimatePresence>
        {classifyModal && (
          <>
            <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={requestDiscard} />
            <motion.div className="modal classify-modal" initial={{ opacity: 0, scale: 0.95, y: -20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: -20 }}>
              <div className="modal-head">
                <div>
                  <div className="eyebrow" style={{ color: '#38bdf8' }}>Call Finished ({fmtDur(classifyModal.duration)})</div>
                  <h3 style={{ fontSize: '20px', fontWeight: 800 }}>How would you classify {getProspectDisplayName(classifyModal.prospect)}?</h3>
                </div>
                <button className="icon-btn" onClick={requestDiscard} title="Discard call"><X size={16} /></button>
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
                <button className="btn danger" onClick={requestDiscard} title="Delete this call record without logging">Discard call</button>
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

      {/* IN-APP EMAIL COMPOSER — no mailto: hand-off, the send stays inside the cockpit */}
      <AnimatePresence>
        {mailing && (
          <EmailComposer
            key={mailing.id}
            prospectId={mailing.id}
            recipient={mailing.name}
            initial={mailing.email ? { to: mailing.email } : undefined}
            noteText={mailing.noteText}
            onSent={async () => {
              // The send appended a note server-side; pull the timeline and the queue back so
              // the email is visible immediately instead of after a reload.
              await Promise.all([reload(), queue.refresh()]);
            }}
            onClose={() => setMailing(null)}
          />
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

      {/* MANUAL DIALPAD MODAL */}
      <AnimatePresence>
        {manualDialOpen && (
          <ManualDialModal
            onClose={() => setManualDialOpen(false)}
            onDial={handleDirectDial}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
