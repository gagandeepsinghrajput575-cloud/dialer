// Telephony business logic: Danish number normalization, softphone dial URIs,
// caller-ID pool rotation and the Danish calling window.
const fs = require('fs');
const path = require('path');
const settings = require('../repositories/settingsRepo');
const { audioDir } = require('../config/env');
const { NATIONAL_LENGTH, SOFTPHONE_PROTOCOLS, TELEPHONY_MODES } = require('../config/defaults');

function cleanStr(val) {
  if (val === null || val === undefined) return '';
  const s = String(val).trim();
  const lower = s.toLowerCase();
  if (['null', 'undefined', 'n/a', 'na', 'none', '-', '--', 'nil'].includes(lower)) return '';
  return s;
}

// Danish numbers are 8 digits with no trunk prefix: 20 12 34 56 -> +4520123456.
// Rules, in order:
//   1. SIP addresses (user@domain) and sip:/tel: URIs are returned untouched.
//   2. Anything with fewer than MIN_DIGITS digits is junk and becomes '' (never stored).
//   3. A number that already carries the default country code must have the full national
//      length — `+45 123` is rejected instead of being stored as a bogus +45123.
//   4. A national-format number is given the default country code.
//   5. Anything else is kept exactly as typed (digits only). We never invent a country code
//      and never silently strip a foreign trunk prefix: 07911123456 stays 07911123456 so the
//      agent can see and fix it, rather than becoming the meaningless +7911123456.
const MIN_DIGITS = 5;

function normalizePhone(raw) {
  if (raw === null || raw === undefined) return '';
  const s = cleanStr(raw);
  if (!s) return '';
  if (/@/.test(s) || /^(sip|tel):/i.test(s)) return s; // SIP address / dial URI — keep as is
  const hasPlus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits || digits.length < MIN_DIGITS) return ''; // clearly junk

  const cc = String(settings.get('default_country_code') || '').replace(/\D/g, '');
  const len = cc ? NATIONAL_LENGTH[Number(cc)] : undefined;

  if (hasPlus || digits.startsWith('00')) {
    const intl = digits.startsWith('00') ? digits.slice(2) : digits;
    if (len && intl.startsWith(cc)) return intl.length === cc.length + len ? '+' + intl : '';
    // Unknown country code: accept it if it is long enough to be a real number.
    return intl.length >= MIN_DIGITS + 1 ? '+' + intl : '';
  }

  if (!cc) return '+' + digits;
  const national = digits.replace(/^0+/, ''); // drop a national trunk prefix

  // Already carries the country code, e.g. 4520123456
  if (national.startsWith(cc)) {
    if (len && national.length === cc.length + len) return '+' + national;
    if (!len && national.length > 10) return '+' + national;
  }
  // Local number: attach the default country code
  if (len && national.length === len) return '+' + cc + national;
  if (!len && national.length <= 10) return '+' + cc + national;

  // Not recognizable as the default country: keep the digits the user actually typed.
  return digits;
}

const protocol = () => {
  const p = String(settings.get('softphone_protocol') || 'sip').toLowerCase();
  return SOFTPHONE_PROTOCOLS.includes(p) ? p : 'sip';
};
const mode = () => {
  const m = String(settings.get('telephony_mode') || 'softphone').toLowerCase();
  return TELEPHONY_MODES.includes(m) ? m : 'softphone';
};

// What the OS hands to Zoiper/Linphone/Telephone: sip:+4520123456 or tel:+4520123456
const buildDialUri = (phone, proto = protocol()) => `${proto}:${phone}`;

// Same number addressed straight at the VOIP.SO domain — handy as a manual fallback.
function buildDialUriFull(phone) {
  const server = String(settings.get('voipso_sip_server') || '').trim();
  if (!server || /@/.test(phone)) return buildDialUri(phone);
  return `sip:${phone}@${server}`;
}

const sipConfigured = () => !!String(settings.get('voipso_sip_user') || '').trim();

// ---------------------------------------------------------------- in-browser WebRTC softphone
// The browser registers to the SIP server over a WebSocket gateway. Providers name that
// endpoint differently, so it is a setting; when it is blank we derive the conventional
// :8089/ws path from the SIP server rather than refusing to work. Nothing here is guessed
// silently — `webrtcSession()` reports which of the two it used so the UI can say so.
const WEBRTC_WS_PORT = 8089;
const WEBRTC_WS_PATH = '/ws';

function webrtcServer() {
  return String(settings.get('voipso_sip_server') || '').trim();
}

function webrtcWsUrl() {
  const explicit = String(settings.get('webrtc_ws_url') || '').trim();
  if (explicit) return explicit;
  const server = webrtcServer();
  return server ? `wss://${server}:${WEBRTC_WS_PORT}${WEBRTC_WS_PATH}` : '';
}

// What the browser addresses the call to. transport=ws tells the far end this leg arrives
// over the WebSocket gateway rather than a UDP/TCP trunk.
function buildWebRtcUri(phone) {
  const server = webrtcServer();
  const clean = String(phone || '').trim();
  return server ? `sip:${clean}@${server};transport=ws` : `sip:${clean};transport=ws`;
}

// Is the browser softphone in a state where pressing C could actually connect?
function webrtcReadiness() {
  const wsUrl = webrtcWsUrl();
  const server = webrtcServer();
  const user = String(settings.get('voipso_sip_user') || '').trim();
  const hasPassword = !!String(settings.get('voipso_sip_password') || '').trim();
  const missing = [];
  if (!server) missing.push('server');
  if (!user) missing.push('user');
  if (!hasPassword) missing.push('password');
  if (!wsUrl) missing.push('wsUrl');
  return { wsUrl, server, user, hasPassword, missing, configured: missing.length === 0 };
}

// The descriptor the browser needs to open a session. The SIP password is only included
// when the agent has explicitly opted into the handoff (Settings → Telephony), because the
// rest of the app promises this secret never leaves the server; the UI explains the trade-off.
function webrtcSession() {
  const r = webrtcReadiness();
  const handoff = settings.getBool('webrtc_credential_handoff');
  const password = String(settings.get('voipso_sip_password') || '');
  return {
    mode: 'webrtc',
    configured: r.configured,
    missing: r.missing,
    wsUrl: r.wsUrl,
    wsUrlSource: String(settings.get('webrtc_ws_url') || '').trim() ? 'settings' : (r.server ? 'derived' : 'none'),
    server: r.server,
    username: r.user,
    // Normalized like every other caller ID the app shows or sends: the browser puts this
    // straight into the SIP From header, so '+45 20 12 34 56' would be a malformed one.
    callerId: normalizePhone(settings.get('caller_id')) || nextCallerId().callerId || '',
    password: handoff ? password : '',
    hasPassword: r.hasPassword,
    credentialHandoff: handoff,
    // A browser cannot register without the secret, so a closed handoff is a blocking
    // condition the UI must surface rather than an optional nicety.
    canRegister: r.configured && handoff,
    micDevice: String(settings.get('webrtc_mic_device') || ''),
    speakerDevice: String(settings.get('webrtc_speaker_device') || ''),
  };
}

// ---- multi-DID rotation (spam shield) ----
// Caller IDs are normalized once and rotated round-robin. The cursor is persisted so the
// rotation keeps its place across restarts.
const MAX_POOL = 20;

function callerIdPool() {
  const raw = String(settings.get('caller_id_pool') || '');
  const primary = String(settings.get('caller_id') || '').trim();
  // Split, drop empty tokens, normalize (which drops junk like "+4511"), de-duplicate.
  const parts = raw.split(/[,\n;]+/).map((x) => x.trim()).filter(Boolean);
  const all = [...new Set([primary, ...parts].filter(Boolean).map((x) => normalizePhone(x)).filter(Boolean))];
  return all.slice(0, MAX_POOL);
}

function nextCallerId() {
  const pool = callerIdPool();
  if (!pool.length) return { callerId: '', poolSize: 0, index: 0 };
  const cursor = parseInt(settings.get('caller_id_cursor'), 10) || 0;
  const index = ((cursor % pool.length) + pool.length) % pool.length;
  settings.set('caller_id_cursor', String(index + 1));
  return { callerId: pool[index], poolSize: pool.length, index };
}

// ---- Danish business hours (Europe/Copenhagen) ----
// Intl formatters are expensive to construct, and one is built per request — cache per tz.
const fmtCache = new Map();
function formatterFor(tz) {
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    fmtCache.set(tz, fmt);
  }
  return fmt;
}

function partsIn(tz, date = new Date()) {
  const map = {};
  for (const p of formatterFor(tz).formatToParts(date)) map[p.type] = p.value;
  const hour = parseInt(map.hour === '24' ? '0' : map.hour, 10);
  const minute = parseInt(map.minute, 10);
  const second = parseInt(map.second || '0', 10);
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(map.weekday); // 0 = Sun
  const isoDay = dayIndex === 0 ? 7 : dayIndex; // 1 = Monday
  return { date: `${map.year}-${map.month}-${map.day}`, hour, minute, second, dayIndex, isoDay, iso: date };
}

// Minutes a timezone is ahead of UTC at a given instant (DST aware).
function tzOffsetMinutes(tz, date = new Date()) {
  const p = partsIn(tz, date);
  const asUtc = Date.UTC(
    parseInt(p.date.slice(0, 4), 10), parseInt(p.date.slice(5, 7), 10) - 1, parseInt(p.date.slice(8, 10), 10),
    p.hour, p.minute, p.second
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

// A wall-clock time in `tz` -> the matching UTC instant. Two passes so a DST transition
// (where the offset changes between the guess and the answer) still resolves correctly.
function zonedTimeToUtc(dateStr, hhmm, tz) {
  const [hh, mm] = String(hhmm).split(':').map((x) => parseInt(x, 10) || 0);
  const guess = Date.UTC(
    parseInt(dateStr.slice(0, 4), 10), parseInt(dateStr.slice(5, 7), 10) - 1, parseInt(dateStr.slice(8, 10), 10),
    hh, mm, 0
  );
  let offset = tzOffsetMinutes(tz, new Date(guess));
  let utc = guess - offset * 60000;
  const offset2 = tzOffsetMinutes(tz, new Date(utc));
  if (offset2 !== offset) { offset = offset2; utc = guess - offset * 60000; }
  return new Date(utc);
}

// The Copenhagen date N days from `now`, as YYYY-MM-DD. Calendar arithmetic is done on the
// date itself rather than by adding N x 24h to an instant, which drifts across a DST change.
function zonedDate(offsetDays = 0, tz = 'Europe/Copenhagen', now = new Date()) {
  const base = partsIn(tz, now).date;
  const d = new Date(`${base}T12:00:00Z`); // noon UTC: never wraps to the neighbouring day
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '0:0').split(':').map((x) => parseInt(x, 10) || 0);
  return h * 60 + m;
};

function businessHours(now = new Date()) {
  const tz = String(settings.get('business_tz') || 'Europe/Copenhagen');
  const start = String(settings.get('business_hours_start') || '08:30');
  const end = String(settings.get('business_hours_end') || '16:30');
  const parsedDays = String(settings.get('business_days') || '')
    .split(',').map((d) => parseInt(d, 10)).filter((d) => d >= 1 && d <= 7);
  const days = parsedDays.length ? [...new Set(parsedDays)].sort((a, b) => a - b) : [1, 2, 3, 4, 5];

  const p = partsIn(tz, now);
  const isoDay = p.isoDay;
  const mins = p.hour * 60 + p.minute;
  const isBusinessDay = days.includes(isoDay);
  const open = isBusinessDay && mins >= toMinutes(start) && mins < toMinutes(end);

  // "Minutes until open" has to survive the end of the day and the weekend: after the
  // window closes it counts forward to the next business day's start, not back to zero.
  let minutesUntilOpen = null;
  if (!open) {
    if (isBusinessDay && mins < toMinutes(start)) {
      minutesUntilOpen = toMinutes(start) - mins;
    } else {
      let ahead = 1;
      let nextDay = (isoDay % 7) + 1;
      while (!days.includes(nextDay) && ahead < 8) { nextDay = (nextDay % 7) + 1; ahead++; }
      const extraDays = isBusinessDay ? 1 : ahead;
      minutesUntilOpen = (24 * 60 - mins) + toMinutes(start) + (extraDays - 1) * 24 * 60;
    }
  }

  return {
    tz,
    startsAt: start,
    endsAt: end,
    businessDays: days,
    localTime: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`,
    localDate: p.date,
    isBusinessDay,
    open,
    minutesUntilClose: open ? toMinutes(end) - mins : null,
    minutesUntilOpen,
    label: `Danish calling window ${start}–${end} (${tz})`,
  };
}

// ---- voicemail drop greeting ----
const VM_FILENAME = 'vm_danish.mp3';

function voicemailGreeting() {
  const configured = String(settings.get('vm_greeting') || '').trim() || VM_FILENAME;
  const file = path.join(audioDir, path.basename(configured));
  const exists = fs.existsSync(file);
  return {
    configured,
    expectedPath: path.join('data', 'audio', path.basename(configured)),
    file: path.basename(configured),
    exists,
    bytes: exists ? fs.statSync(file).size : 0,
    url: `/api/telephony/voicemail-greeting/file`,
    hint: exists
      ? 'Greeting is ready. Reach a voicemail box, press V, then play the drop in your softphone.'
      : `Record a Danish greeting and save it as data/audio/${VM_FILENAME} (or upload it in Settings).`,
  };
}

function sampleDialUri(number = '20123456') {
  return buildDialUri(normalizePhone(number), protocol());
}

// Danish number ranges that cost money or are not a person.
//   70 xx xx xx  shared cost  — the caller pays a chunk of the call
//   90 xx xx xx  premium rate — genuinely expensive, per-minute charges
//   80 xx xx xx  freephone    — free, but a service line, not a contact
// One bad row in a purchased list is an expensive afternoon, so the dialer asks first.
const DK_SPECIAL_RANGES = [
  { prefix: '90', kind: 'premium', label: 'Premium rate (90)', expensive: true,
    note: 'This is a premium-rate number. Per-minute charges apply and they are not trivial.' },
  { prefix: '70', kind: 'shared_cost', label: 'Shared cost (70)', expensive: true,
    note: 'This is a shared-cost number — you pay part of the call.' },
  { prefix: '80', kind: 'freephone', label: 'Freephone (80)', expensive: false,
    note: 'This is a freephone service line, not a direct personal number.' },
];

// Returns null for a foreign or non-8-digit number: we only claim to know Danish ranges.
function numberKind(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  let national = null;
  if (digits.startsWith('45') && digits.length === 10) national = digits.slice(2);
  else if (!digits.startsWith('45') && digits.length === 8) national = digits;
  if (!national) return null;
  const head = national.slice(0, 2);
  const match = DK_SPECIAL_RANGES.find((r) => r.prefix === head);
  if (!match) return null;
  return { ...match, national: `${head} ${national.slice(2, 4)} ${national.slice(4, 6)} ${national.slice(6, 8)}` };
}

module.exports = {
  cleanStr, normalizePhone, protocol, mode, buildDialUri, buildDialUriFull, sipConfigured,
  numberKind, DK_SPECIAL_RANGES,
  callerIdPool, nextCallerId, businessHours, toMinutes, voicemailGreeting, sampleDialUri, VM_FILENAME,
  partsIn, tzOffsetMinutes, zonedTimeToUtc, zonedDate, MIN_DIGITS, MAX_POOL,
  webrtcWsUrl, webrtcServer, buildWebRtcUri, webrtcReadiness, webrtcSession, WEBRTC_WS_PORT, WEBRTC_WS_PATH,
};
