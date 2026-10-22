// Browser- and Node-safe helpers: no React, no framework, nothing that needs a bundler.
//
// `src/utils.js` holds the UI half (hooks, stage/outcome metadata, date formatting) and imports
// React for it. Everything in here is plain functions — a phone number, a mutex, a dial URI — and
// deliberately has *no* framework dependency, because two consumers run outside the browser build:
//
//   * `src/nativeSip.js`, the desktop daemon's phone, which is exercised by `node` tests where
//     resolving React is not even possible, and
//   * anything else that must be loadable in a plain VM.
//
// Pulling React into that graph would make the native engine untestable headlessly, so the split is
// the point, not a tidy-up. `utils.js` re-exports every name below, so no existing importer moves.
'use strict';


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

// ---- client-side field validation --------------------------------------------------------
// The server is the authority (it normalizes and rejects), but a rejection that only arrives
// after a round-trip reads as "the app lost my edit". These mirror the server's rules closely
// enough to catch the mistake at the keystroke, and they live here so the hero banner, the
// prospect card and any future inline editor can never disagree about what is valid.

// Same placeholders the server treats as "no value at all", so typing "N/A" clears the field
// instead of being stored as a phone number.
const PLACEHOLDERS = new Set(['null', 'undefined', 'n/a', 'na', 'none', '-', '--', 'nil']);
export function cleanStr(val) {
  if (val === null || val === undefined) return '';
  const s = String(val).trim();
  return PLACEHOLDERS.has(s.toLowerCase()) ? '' : s;
}

// National subscriber length (digits after the country code, no trunk prefix). Denmark only
// for now, matching the server's NATIONAL_LENGTH table.
export const NATIONAL_LENGTH = { 45: 8 };
export const MIN_PHONE_DIGITS = 5;

// A faithful client-side mirror of telephonyService.normalizePhone. It exists so the inline
// editors can answer "would the server refuse this?" *before* the round-trip; the server stays
// the authority. Mirroring it exactly — rather than approximating with a digit count — is what
// stops the UI from blocking an edit the server would happily have stored.
export function normalizePhoneClient(raw, countryCode = '45') {
  const s = cleanStr(raw);
  if (!s) return '';
  if (/@/.test(s) || /^(sip|tel):/i.test(s)) return s;     // SIP address / dial URI — kept as-is
  const hasPlus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits || digits.length < MIN_PHONE_DIGITS) return '';
  const cc = String(countryCode ?? '').replace(/\D/g, '');
  const len = cc ? NATIONAL_LENGTH[Number(cc)] : undefined;

  if (hasPlus || digits.startsWith('00')) {
    const intl = digits.startsWith('00') ? digits.slice(2) : digits;
    if (len && intl.startsWith(cc)) return intl.length === cc.length + len ? `+${intl}` : '';
    return intl.length >= MIN_PHONE_DIGITS + 1 ? `+${intl}` : '';
  }
  if (!cc) return `+${digits}`;
  const national = digits.replace(/^0+/, '');
  if (national.startsWith(cc)) {
    if (len && national.length === cc.length + len) return `+${national}`;
    if (!len && national.length > 10) return `+${national}`;
  }
  if (len && national.length === len) return `+${cc}${national}`;
  if (!len && national.length <= 10) return `+${cc}${national}`;
  return digits;
}

// Returns a human message when the value would be refused (or normalizes to nothing while
// still looking like a number), and null when it is fine. Clearing a phone is allowed: plenty
// of leads genuinely have no number yet.
export function phoneIssue(raw, countryCode = '45') {
  const given = cleanStr(raw);
  if (!given) return null;
  if (/@/.test(given) || /^(sip|tel):/i.test(given)) return null;
  if (normalizePhoneClient(given, countryCode)) return null;
  return 'Please enter a valid phone number (e.g. +45 20 12 34 56)';
}
