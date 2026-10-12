// The incoming call banner.
//
// It floats over whatever the agent is doing — a callback is not an event that politely waits
// for the Dialer page — and it is a modal on purpose: while the phone rings, nothing else on
// screen may claim the keyboard. Enter answers, Escape declines, and every other keystroke is
// swallowed so a half-typed shortcut cannot dial somebody else mid-ring.
import React, { useEffect, useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Phone, PhoneOff, PhoneIncoming, UserPlus, Building2, History, Mic } from 'lucide-react';
import { useStore } from '../store.jsx';
import { stageMeta } from '../utils.js';
import { useSoftphone } from '../softphone.jsx';
import { Avatar } from './ui.jsx';

function CallerWave() {
  // The ring is audibly pulsed (1 s on / 4 s off), so the bars pulse with it: a silent-looking
  // animation over a silent phone is the kind of detail that erodes trust in the whole UI.
  //
  // Reduced motion turns it into five static bars rather than a slower animation — the ring
  // tone still tells the agent the phone is ringing, and nothing on screen moves (WCAG 2.3.3).
  const reduce = useReducedMotion();
  return (
    <div className="incoming-wave" aria-hidden>
      {Array.from({ length: 5 }).map((_, i) => (
        <motion.i
          key={i}
          animate={reduce ? undefined : { scaleY: [0.25, 1, 0.4, 0.85, 0.25] }}
          transition={reduce ? undefined : { duration: 5, times: [0, 0.18, 0.2, 0.21, 1], repeat: Infinity, ease: 'easeInOut', delay: i * 0.05 }}
        />
      ))}
    </div>
  );
}

export default function IncomingCallModal() {
  const { inbound } = useStore();
  const { incomingCall, answerInbound, declineInbound } = useSoftphone();
  const answerRef = useRef(null);
  const restoreFocusRef = useRef(null);
  const open = !!inbound && !!incomingCall && !incomingCall.answered;

  const answer = () => { if (open) answerInbound(); };
  const decline = () => { if (open) declineInbound(); };

  useEffect(() => {
    if (!open) return undefined;

    // Focus moves into the banner so Enter/Space activate Answer natively, and returns to
    // wherever the agent was once the ring is over.
    restoreFocusRef.current = typeof document !== 'undefined' ? document.activeElement : null;
    answerRef.current?.focus?.();

    const onKey = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        answer();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        decline();
        return;
      }
      if (e.key === 'Tab') {
        // Focus trap: with two controls the trap is a cycle between them and the banner.
        const nodes = [...document.querySelectorAll('.incoming-call button:not(:disabled)')];
        if (!nodes.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Everything else belongs to the banner while it is up. The dialer's shortcuts are on
      // window; stopping propagation here is what keeps "C" from dialing behind the ring.
      e.stopPropagation();
    };

    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      const el = restoreFocusRef.current;
      if (el && typeof el.focus === 'function' && document.contains(el)) el.focus();
    };
  }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Derived with optional chaining throughout: this component is mounted for the whole session
  // (that is what lets the exit spring run), so every render before the first ring passes
  // through here with `inbound === null`.
  const p = inbound?.prospect;
  const known = !!p && !!inbound?.matched;
  const caller = inbound?.callerNumber || '';
  const title = known ? (p.name || p.company || caller) : caller;
  const previousCalls = known ? (p.call_count || 0) : 0;
  const lastNote = known && p.notes && p.notes.length ? p.notes[0].body : '';
  const line = known
    ? [p.title, p.company].filter(Boolean).join(' · ')
    : inbound?.loading ? 'Looking up caller…' : 'Unknown caller';

  return (
    <AnimatePresence>
      {open && (
      <>
      <motion.div
        className="incoming-scrim"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        aria-hidden
      />
      <motion.section
        className="incoming-call glass"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="incoming-title"
        aria-describedby="incoming-sub"
        initial={{ opacity: 0, y: 26, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 18, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      >
        {/* The screen reader announcement carries the identity, not just the noise. */}
        <p className="incoming-live sr-only" role="alert" aria-live="assertive">
          {`Incoming call from ${title}${known && p.company ? `, ${p.company}` : ''}`}
        </p>

        <div className="incoming-head">
          <span className="incoming-badge"><PhoneIncoming size={13} /> Incoming call</span>
          <CallerWave />
        </div>

        <div className="incoming-body">
          <Avatar name={p?.name || inbound.callerNumber} size={52} seed={p?.id || inbound.callerNumber} />
          <div className="incoming-id">
            <h3 id="incoming-title" className="incoming-name">{title}</h3>
            <p id="incoming-sub" className="incoming-sub">
              {known && p.company ? <Building2 size={13} /> : <Phone size={13} />}
              <span>{line}</span>
            </p>
            <p className="incoming-number">{inbound.callerNumber}</p>
          </div>
        </div>

        {known && (
          <div className="incoming-crm">
            <span className="incoming-chip">
              <History size={12} /> {previousCalls === 0 ? 'First call' : `${previousCalls} previous call${previousCalls === 1 ? '' : 's'}`}
            </span>
            {p.stage && <span className="incoming-chip stage">{stageMeta(p.stage).label}</span>}
            {lastNote && <p className="incoming-note" title={lastNote}>“{lastNote.slice(0, 120)}”</p>}
          </div>
        )}

        {!known && !inbound.loading && !inbound.logError && (
          <p className="incoming-hint">
            <UserPlus size={13} /> Answering creates a new lead with this number.
          </p>
        )}
        {inbound.logError && <p className="incoming-hint warn">{inbound.logError}</p>}
        {!incomingCall.simulated && (
          <p className="incoming-hint quiet"><Mic size={12} /> Your microphone opens when you answer.</p>
        )}

        <div className="incoming-actions">
          <button type="button" className="btn incoming-decline" onClick={decline} title="Decline (Esc)">
            <PhoneOff size={16} /> Decline <kbd className="chip-kbd">Esc</kbd>
          </button>
          <button type="button" ref={answerRef} className="btn incoming-answer" onClick={answer} title="Answer (Enter)">
            <Phone size={16} /> Answer <kbd className="chip-kbd">Enter</kbd>
          </button>
        </div>
      </motion.section>
      </>
      )}
    </AnimatePresence>
  );
}
