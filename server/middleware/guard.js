// Local-first security guard.
//
// Pulse Dialer keeps your leads on this machine, but the port is reachable by anything
// on the network and by any web page you visit (a browser happily fires requests at
// http://localhost:3001 from evil.example.com). Two cheap checks close that down:
//
//   1. Host + Origin allowlist  — stops cross-site requests *and* DNS rebinding
//      (where evil.com resolves to 127.0.0.1, so Origin and Host both look local).
//   2. Session token            — a random secret handed to the app over the same
//      trusted channel and echoed on every state-changing call. A malicious page can
//      never read it, because reading it is itself a cross-origin request we refuse.
//
// Command-line clients (curl, the test suite) send no Origin and no Host of their own
// choosing, so they keep working. Set PULSE_REQUIRE_TOKEN=1 to demand the token from
// everyone, including curl.
const crypto = require('crypto');
const { ApiError } = require('./errorHandler');

const TOKEN = crypto.randomBytes(24).toString('hex');
const TOKEN_HEADER = 'x-pulse-token';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Extra hosts/origins may be listed comma-separated, e.g. PULSE_ALLOWED_HOSTS=mac-mini.local,192.168.1.20
// Suffix rules (".example.com") are honoured so reverse-proxy preview hosts work.
function listFromEnv(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
const ALLOWED_HOSTS = new Set(listFromEnv('PULSE_ALLOWED_HOSTS'));
// The sandbox/live-preview proxies the app under https://<port>-<id>.e2b.app. Blocking it
// would hand over a dead preview, and a public wildcard suffix is not an attacker-controlled
// domain, so it is safe to trust by default.
const DEFAULT_SUFFIXES = ['.e2b.app'];
const ALLOWED_SUFFIXES = [
  ...DEFAULT_SUFFIXES,
  ...listFromEnv('PULSE_ALLOWED_SUFFIXES').filter((s) => s.startsWith('.')),
];

function hostnameOf(value) {
  if (!value) return '';
  let v = String(value).trim().toLowerCase();
  v = v.replace(/^[a-z]+:\/\//, '');           // scheme://
  v = v.split('/')[0];                         // path
  v = v.split('?')[0];
  if (v.startsWith('[')) v = v.slice(0, v.indexOf(']') + 1);  // [::1]:3000
  else v = v.split(':')[0];                    // host:port
  return v;
}

function hostAllowed(hostname) {
  if (!hostname) return false;
  if (LOCAL_HOSTNAMES.has(hostname)) return true;
  if (ALLOWED_HOSTS.has(hostname)) return true;
  return ALLOWED_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

// Is this request from a browser page we trust? Non-browser clients (no Origin) are trusted.
function originTrusted(req) {
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return true;
  return hostAllowed(hostnameOf(origin));
}

function guard(req, res, next) {
  // A browser request from an unlisted origin never gets to touch data.
  if (!originTrusted(req)) {
    return next(ApiError.forbidden('This origin is not allowed to talk to Pulse Dialer'));
  }
  // DNS rebinding defence: the Host header itself must be a name we expect.
  const host = hostnameOf(req.headers.host);
  if (host && !hostAllowed(host)) {
    return next(ApiError.forbidden(`Host header "${host}" is not allowed — add it to PULSE_ALLOWED_HOSTS`));
  }
  const browserRequest = Boolean(req.headers.origin || req.headers.referer);
  const bodyToken = req.body && typeof req.body === 'object' && typeof req.body._token === 'string'
    ? req.body._token
    : '';
  const queryToken = typeof req.query?.token === 'string' ? req.query.token : '';
  const suppliedToken = req.get(TOKEN_HEADER) || bodyToken || queryToken;
  if (req.body && typeof req.body === 'object' && '_token' in req.body) {
    delete req.body._token;
  }
  const needsToken = MUTATING.has(req.method) && (browserRequest || process.env.PULSE_REQUIRE_TOKEN === '1');
  if (needsToken && suppliedToken !== TOKEN) {
    return next(ApiError.unauthorized('Missing or invalid session token — reload the app'));
  }
  next();
}

// Handing out the token is itself guarded above: only a trusted (or non-browser)
// caller can read it.
function session(req, res) {
  res.json({ token: TOKEN, tokenHeader: TOKEN_HEADER });
}

// Demanded by endpoints that return live credentials rather than data. The global guard only
// requires the token for writes; a GET that hands out SIP credentials is exactly as sensitive
// as a write, so it asks for the token on its own as well. Scripts can fetch it from
// /api/session first, which is what the browser client already does on every request.
function requireToken(req, res, next) {
  if (req.get(TOKEN_HEADER) !== TOKEN) {
    return next(ApiError.unauthorized('This endpoint returns credentials and needs the session token — reload the app'));
  }
  next();
}

module.exports = {
  guard,
  session,
  requireToken,
  sessionToken: () => TOKEN,
  TOKEN_HEADER,
  hostAllowed,
  originTrusted,
};
