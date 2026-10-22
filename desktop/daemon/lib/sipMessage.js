// SIP message framing: parse a datagram into a usable object, build one back into bytes.
//
// Only what a UDP user agent actually needs — no TCP segmentation, no SIPS, no SIP over
// WebSocket (that is the browser engine's job). Header names are case-insensitive and the
// compact forms a real trunk sends (v, f, t, l, c, k) are expanded, because FlyNumber's
// proxy uses them and a parser that does not would read an empty Call-ID.
'use strict';

const COMPACT = {
  v: 'via', f: 'from', t: 'to', i: 'call-id', l: 'content-length', c: 'content-type',
  k: 'supported', m: 'contact', e: 'content-encoding', s: 'subject', r: 'refer-to',
};

const HEADER_ORDER = [
  'via', 'from', 'to', 'call-id', 'cseq', 'contact', 'max-forwards',
  'authorization', 'www-authenticate', 'proxy-authenticate', 'proxy-authorization',
  'supported', 'allow', 'user-agent', 'content-type',
];

function unfold(raw) {
  // A header may be continued on the next line with leading whitespace (RFC 3261 7.3.1).
  return String(raw).replace(/\r?\n[ \t]+/g, ' ');
}

/**
 * @param {Buffer|string} data a single SIP datagram
 * @returns {object|null} { kind, method, uri, status, reason, headers, raw, body }
 */
function parse(data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data || '');
  // The blank line separating headers from body is CRLFCRLF on the wire; a hand-built test
  // datagram may use LFLF, and both have to parse or the daemon looks broken in a harness.
  const crlf = text.indexOf('\r\n\r\n');
  const split = crlf >= 0 ? crlf : text.indexOf('\n\n');
  const sepLen = crlf >= 0 ? 4 : 2;
  const head = split >= 0 ? text.slice(0, split) : text;
  const body = split >= 0 ? text.slice(split + sepLen) : '';
  const lines = unfold(head).split(/\r?\n/);
  const startLine = (lines.shift() || '').trim();
  if (!startLine) return null;

  const headers = Object.create(null);
  const push = (name, value) => {
    const key = name.toLowerCase();
    if (headers[key] === undefined) headers[key] = value;
    else if (Array.isArray(headers[key])) headers[key].push(value);
    else headers[key] = [headers[key], value];
  };
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const rawName = line.slice(0, colon).trim().toLowerCase();
    push(COMPACT[rawName] || rawName, line.slice(colon + 1).trim());
  }

  const msg = { headers, first: (n) => firstOf(headers[n]), raw: text, body };
  if (startLine.startsWith('SIP/2.0')) {
    const m = /^SIP\/2\.0\s+(\d{3})\s*(.*)$/.exec(startLine);
    if (!m) return null;
    return Object.assign(msg, { kind: 'response', status: Number(m[1]), reason: m[2].trim() });
  }
  const m = /^([A-Z]+)\s+(\S+)\s+SIP\/2\.0/.exec(startLine);
  if (!m) return null;
  return Object.assign(msg, { kind: 'request', method: m[1], uri: m[2] });
}

const firstOf = (v) => (Array.isArray(v) ? v[0] : v);

// `sip:+4520123456@host;user=phone` -> { user, host, port, params }
function parseUri(uri) {
  const s = String(uri || '').replace(/^<|>$/g, '').trim();
  const m = /^(sips?):([^@>]*)(?:@([^;>?]*))?(.*)$/i.exec(s);
  if (!m) return { user: '', host: '', port: 0, params: {}, raw: s };
  const params = {};
  for (const part of String(m[4] || '').split(';').filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq < 0) params[part.toLowerCase()] = '';
    else params[part.slice(0, eq).toLowerCase()] = part.slice(eq + 1);
  }
  const hostPort = String(m[3] || '');
  const colon = hostPort.lastIndexOf(':');
  const host = colon > 0 ? hostPort.slice(0, colon) : hostPort;
  const port = colon > 0 ? parseInt(hostPort.slice(colon + 1), 10) || 0 : 0;
  return { scheme: m[1].toLowerCase(), user: decodeUser(m[2]), host, port, params, raw: s };
}

function decodeUser(user) {
  try { return decodeURIComponent(String(user || '')); } catch { return String(user || ''); }
}

function buildUri({ user = '', host = '', port = 0, params = {} } = {}) {
  const hp = port && port !== 5060 ? `${host}:${port}` : host;
  const q = Object.entries(params).map(([k, v]) => (v === '' ? `;${k}` : `;${k}=${v}`)).join('');
  return `sip:${user}@${hp}${q}`;
}

// Serialize. `headers` may repeat a name (Via on a forwarded request) by passing an array.
function serialize({ startLine, headers = {}, body = '' }) {
  const lines = [startLine];
  const names = Object.keys(headers);
  names.sort((a, b) => {
    const ia = HEADER_ORDER.indexOf(a.toLowerCase());
    const ib = HEADER_ORDER.indexOf(b.toLowerCase());
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  for (const name of names) {
    const value = headers[name];
    for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
  }
  const payload = body == null ? '' : String(body);
  lines.push(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}`);
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${payload}`, 'utf8');
}

// The Contact/Via host the far end should reply to. A private address behind NAT is replaced
// by whatever the peer saw us as (rport/received), which is why callers pass `learned`.
function addressOf(msg, learned) {
  const via = parseVia(msg.first('via'));
  const host = learned?.host || via.received || via.host;
  const port = learned?.port || via.rport || via.port || 5060;
  return { host, port: Number(port) || 5060 };
}

function parseVia(via) {
  const s = String(via || '');
  const semi = s.indexOf(';');
  const head = semi < 0 ? s : s.slice(0, semi);
  const params = {};
  for (const part of (semi < 0 ? '' : s.slice(semi + 1)).split(';').filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq > 0) params[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  const m = /SIP\/2\.0\/(\w+)\s+([^:;\s]+)(?::(\d+))?/i.exec(head);
  return {
    transport: (m?.[1] || 'UDP').toUpperCase(),
    host: m?.[2] || '',
    port: Number(m?.[3] || 0),
    branch: params.branch || '',
    rport: Number(params.rport || 0),
    received: params.received || '',
    params,
  };
}

function parseCSeq(msg) {
  const m = /^(\d+)\s+([A-Z]+)/i.exec(String(msg?.first?.('cseq') || ''));
  return { seq: Number(m?.[1] || 0), method: (m?.[2] || '').toUpperCase() };
}

// The display name and user of a From/To header: what the UI shows as "who is calling".
function identityOf(headerValue) {
  const s = String(headerValue || '');
  const nameMatch = /^\s*"([^"]*)"/.exec(s) || /^\s*([^<;"][^<;]*)</.exec(s);
  const uri = /<([^>]*)>/.exec(s)?.[1] || s.split(';')[0].trim();
  return { displayName: (nameMatch?.[1] || '').trim(), uri, user: parseUri(uri).user };
}

module.exports = {
  parse, serialize, parseUri, buildUri, parseVia, parseCSeq, identityOf, addressOf,
  firstOf, COMPACT, HEADER_ORDER,
};
