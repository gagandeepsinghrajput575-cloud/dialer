import { useEffect, useRef, useState } from 'react';
import { cleanStr } from './utils/plain.js';

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

/**
 * Deterministic human-facing name for a prospect.
 * Resolves: name -> company -> extra details -> website domain -> phone -> id.
 * Prevents blank "(no name)" / "Unnamed Prospect" displays across the app.
 */
export function getProspectDisplayName(p) {
  if (!p) return 'Unnamed Prospect';
  if (p.name && String(p.name).trim()) return String(p.name).trim();
  if (p.company && String(p.company).trim()) return String(p.company).trim();

  let extra = {};
  if (typeof p.extra === 'string') {
    try { extra = JSON.parse(p.extra); } catch {}
  } else if (typeof p.extra === 'object' && p.extra !== null) {
    extra = p.extra;
  }
  if (extra['Company / Legal Name'] && String(extra['Company / Legal Name']).trim()) {
    return String(extra['Company / Legal Name']).trim();
  }
  if (extra['Website Name'] && String(extra['Website Name']).trim()) {
    return String(extra['Website Name']).trim();
  }
  if (extra['Best Public Decision-Maker'] && String(extra['Best Public Decision-Maker']).trim()) {
    return String(extra['Best Public Decision-Maker']).trim();
  }
  if (extra['Google Maps URL']) {
    try {
      const u = new URL(extra['Google Maps URL']);
      const q = u.searchParams.get('query');
      if (q) {
        const comp = q.split(',')[0].trim();
        if (comp) return comp;
      }
    } catch {}
  }
  if (p.website) {
    try {
      const host = new URL(p.website.startsWith('http') ? p.website : `https://${p.website}`).hostname.replace(/^www\./, '');
      if (host) return host;
    } catch {}
  }
  if (p.phone) return `Lead ${p.phone}`;
  return p.id ? `Lead #${p.id}` : 'Unnamed Prospect';
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
export const SOFTPHONE_LABEL = { softphone: 'Zoiper', webrtc: 'browser softphone', native: 'native softphone' };
// `engine` is the second half of an in-app call: 'webrtc' means the browser holds the media,
// 'native' means the desktop daemon does. Callers that do not know it get the mode's own label.
export const softphoneLabel = (mode, engine) => (engine && SOFTPHONE_LABEL[engine]) || SOFTPHONE_LABEL[mode] || SOFTPHONE_LABEL.softphone;
export const ccLabel = (cc) => (cc ? `+${String(cc).replace(/\D/g, '')}` : '');

// The framework-free half lives in `./utils/plain.js` so `src/nativeSip.js` (and any plain-Node
// consumer) can use it without pulling React into its module graph. Every name is re-exported here
// unchanged: the 15-odd components that import from '../utils.js' keep working exactly as before.
export {
  withCrossTabLock, holdCrossTabLock, phoneDigits, samePhone, formatCallerNumber, dispatchDialUri,
  cleanStr, NATIONAL_LENGTH, MIN_PHONE_DIGITS, normalizePhoneClient, phoneIssue,
} from './utils/plain.js';

// Deliberately loose: the point is to catch "name@gmail" and "hello world@x" before they are
// saved, not to re-implement RFC 5322. Anything with an @ and a dotted domain passes.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
export function emailIssue(raw) {
  const s = cleanStr(raw);
  if (!s) return null;                       // clearing an address is allowed
  return EMAIL_RE.test(s) ? null : 'Please enter a valid email address (e.g. name@company.dk)';
}
