import { useEffect, useRef, useState } from 'react';

export const STAGES = [
  { id: 'new', label: 'New', color: '#94a3b8' },
  { id: 'contacted', label: 'Contacted', color: '#38bdf8' },
  { id: 'interested', label: 'Interested', color: '#a78bfa' },
  { id: 'followup', label: 'Follow-up', color: '#fbbf24' },
  { id: 'meeting', label: 'Meeting', color: '#f472b6' },
  { id: 'won', label: 'Won', color: '#34d399' },
  { id: 'lost', label: 'Lost', color: '#f87171' },
];
export const stageMeta = (id) => STAGES.find((s) => s.id === id) || STAGES[0];

export const OUTCOMES = [
  { id: 'no_answer', label: 'No answer', key: '1', color: '#94a3b8', icon: 'PhoneOff' },
  { id: 'voicemail', label: 'Voicemail', key: '2', color: '#64748b', icon: 'Voicemail' },
  { id: 'wrong_number', label: 'Wrong number', key: '3', color: '#fb923c', icon: 'Ban' },
  { id: 'gatekeeper', label: 'Gatekeeper', key: '4', color: '#fbbf24', icon: 'ShieldHalf' },
  { id: 'hung_up', label: 'Hung up', key: '5', color: '#f87171', icon: 'PhoneMissed' },
  { id: 'conversation', label: 'Conversation', key: '6', color: '#38bdf8', icon: 'MessagesSquare' },
  { id: 'meeting_booked', label: 'Meeting booked', key: '7', color: '#34d399', icon: 'CalendarCheck' },
  { id: 'dnc', label: 'Do not call', key: '8', color: '#ef4444', icon: 'OctagonX' },
];
export const outcomeMeta = (id) => OUTCOMES.find((o) => o.id === id);

export const parseTime = (s) => (s ? new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z')) : null);

export function timeAgo(s) {
  const d = parseTime(s);
  if (!d) return '';
  const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  if (sec < 86400 * 7) return `${Math.round(sec / 86400)}d ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
export const fmtDateTime = (s) => {
  const d = parseTime(s);
  return d ? d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
};
export const fmtDur = (sec) => {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};
export const pct = (n) => `${Math.round((n || 0) * 100)}%`;

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
const GRADS = [
  ['#8b5cf6', '#22d3ee'], ['#f472b6', '#8b5cf6'], ['#22d3ee', '#34d399'], ['#fbbf24', '#f472b6'],
  ['#60a5fa', '#a78bfa'], ['#34d399', '#38bdf8'], ['#fb7185', '#fbbf24'],
];
export function gradFor(seed) {
  let h = 0;
  for (const c of String(seed || 'x')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [a, b] = GRADS[h % GRADS.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

export function useCountUp(target, duration = 700) {
  const [val, setVal] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf;
    const tick = (t) => {
      const k = Math.min(1, (t - start) / duration);
      const e = 1 - Math.pow(1 - k, 3);
      setVal(a + (target - a) * e);
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

export function useTimer(running) {
  const [sec, setSec] = useState(0);
  const startRef = useRef(null);
  useEffect(() => {
    if (!running) return undefined;
    startRef.current = Date.now();
    setSec(0);
    const i = setInterval(() => setSec((Date.now() - startRef.current) / 1000), 250);
    return () => clearInterval(i);
  }, [running]);
  return sec;
}

// ---------- direct softphone dialing ----------
// The softphone that answers a sip:/tel: URI on the agent's desktop.
export const SOFTPHONE_LABEL = { softphone: 'Zoiper', webrtc: 'browser softphone' };
export const softphoneLabel = (mode) => SOFTPHONE_LABEL[mode] || SOFTPHONE_LABEL.softphone;
export const ccLabel = (cc) => (cc ? `+${String(cc).replace(/\D/g, '')}` : '');

// Cross-tab mutual exclusion. The per-tab dialLockRef cannot see a second open tab, so two
// tabs could both dial the same prospect and both log a call. navigator.locks is the
// browser's own mutex; where it is missing (older engines, jsdom) we degrade to running the
// work directly, which is exactly today's behaviour — never worse.
export function withCrossTabLock(key, fn) {
  if (typeof navigator === 'undefined' || !navigator.locks || typeof navigator.locks.request !== 'function') {
    return Promise.resolve({ blocked: false, value: undefined, ran: false, noApi: true }).then((r) => fn().then((v) => ({ ...r, value: v, ran: true })));
  }
  return navigator.locks.request(key, { ifAvailable: true }, (lock) => {
    if (!lock) return { blocked: true, ran: false, noApi: false };
    return Promise.resolve()
      .then(fn)
      .then((value) => ({ blocked: false, value, ran: true, noApi: false }));
  });
}

// The same mutex, held instead of raced: an inbound call needs the lock for its whole
// lifetime (ringing -> answered -> hung up), because that lock is what stops a second tab
// from ringing over the top of the first one. `release()` is idempotent.
export async function holdCrossTabLock(key, lockManager = (typeof navigator !== 'undefined' ? navigator.locks : null)) {
  if (!lockManager || typeof lockManager.request !== 'function') {
    // No Lock API (older engines, jsdom): the tab rings. A second tab is not a case we can
    // detect here, and refusing to ring at all would be worse than ringing twice.
    return { held: true, noApi: true, reason: null, release: async () => {} };
  }

  let decide;
  const decision = new Promise((resolve) => { decide = resolve; });
  let releaseHeld = () => {};
  const heldUntil = new Promise((resolve) => { releaseHeld = resolve; });
  let released = false;

  try {
    lockManager.request(key, { ifAvailable: true }, (lock) => {
      if (!lock) { decide(false); return undefined; }
      decide(true);
      return heldUntil;     // the lock is held for as long as the call lasts
    }).catch(() => decide(false));
  } catch {
    decide(false);
  }

  const held = await decision;
  if (!held) return { held: false, noApi: false, reason: 'another-tab', release: async () => {} };
  return {
    held: true,
    noApi: false,
    reason: null,
    release: async () => { if (!released) { released = true; releaseHeld(); } },
  };
}

// Two numbers are the same person when their national significant digits agree. The caller ID
// in a SIP From header may be '+4520123456', '004520123456' or '20123456' depending on the
// carrier, and the row on file may have been imported with or without the country code.
export const phoneDigits = (value) => String(value || '').replace(/\D/g, '');

export function samePhone(a, b) {
  const da = phoneDigits(a);
  const db = phoneDigits(b);
  if (da.length < 8 || db.length < 8) return false;   // shorter than a Danish number: too weak to match
  if (da === db) return true;
  return da.slice(-8) === db.slice(-8);               // same national number, different country-code style
}

// Best-effort E.164 for *display and matching* — the server normalizes authoritatively on the
// way into the database. Never invents a country code, and never rewrites a foreign number as
// if it were Danish.
export function formatCallerNumber(raw, countryCode = '') {
  const digits = phoneDigits(raw);
  if (!digits) return '';
  const cc = phoneDigits(countryCode);
  if (raw.toString().trim().startsWith('+')) return `+${digits}`;
  if (digits.startsWith('00') && digits.length > 2) return `+${digits.slice(2)}`;
  if (cc && digits.startsWith(cc) && digits.length > cc.length + 4) return `+${digits}`;
  if (cc && digits.length === 8) return `+${cc}${digits}`;   // national format, country code known
  return digits;
}

// Hand the dial URI to the OS so the registered softphone (Zoiper, Linphone, Telephone)
// dials out immediately.
//
// This clicks a real <a> rather than pointing a hidden iframe at the URI. Browsers only
// show the "Open Zoiper?" external-protocol prompt when the navigation is tied to user
// activation, and an iframe src set from a timer/key handler routinely loses it — the dial
// then fails *silently*, which is the worst possible outcome for a power dialer. A click on
// an anchor we created inside the keydown handler keeps the activation, and target="_self"
// on an unknown scheme never navigates the page away.
export function dispatchDialUri(uri) {
  if (!uri || typeof document === 'undefined') return false;
  try {
    const a = document.createElement('a');
    a.href = uri;
    a.rel = 'noopener noreferrer';
    a.target = '_self';
    a.setAttribute('aria-hidden', 'true');
    a.style.cssText = 'position:fixed;top:-1000px;left:-1000px;width:1px;height:1px;opacity:0';
    document.body.appendChild(a);
    a.click();
    if (a.parentNode) a.remove();
    return true;
  } catch {
    // Older engines: a plain assignment still reaches the OS handler.
    try { window.location.href = uri; return true; } catch { return false; }
  }
}
