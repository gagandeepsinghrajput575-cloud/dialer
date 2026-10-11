// Email verification + sending.
//
// Verification is layered cheapest-and-most-reliable first, because each layer answers a
// different question and the expensive one is also the least trustworthy:
//
//   1. syntax          — is it shaped like an address at all
//   2. role address    — info@/salg@ are real but rarely reach a person
//   3. disposable      — throwaway inbox, the lead will never see the mail
//   4. typo            — "gmial.com" is almost certainly "gmail.com"
//   5. MX lookup       — the domain has no mail server, so nothing can ever arrive
//   6. SMTP RCPT probe — asks the mail server directly. Genuinely informative, but large
//                        providers accept *everything* at RCPT stage and answer later with
//                        a bounce, so a "pass" here is weak evidence, and probing can get a
//                        residential IP greylisted. Off unless explicitly enabled.
//
// Nothing here can prove a specific human owns an inbox. The verdict is deliberately a
// confidence level, not a yes/no.
const net = require('net');
const dns = require('dns').promises;
const nodemailer = require('nodemailer');
const settingsRepo = require('../repositories/settingsRepo');
const outboxRepo = require('../repositories/outboxRepo');
const { ApiError } = require('../middleware/errorHandler');

// Practical upper bound from RFC 5321 — 64 char local part, 255 total.
const SYNTAX_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// Throwaway inboxes that expire in minutes to days.
const DISPOSABLE = new Set([
  'mailinator.com', '10minutemail.com', '10minutemail.net', 'guerrillamail.com', 'guerrillamail.net',
  'sharklasers.com', 'temp-mail.org', 'tempmail.com', 'throwawaymail.com', 'yopmail.com',
  'trashmail.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'fakeinbox.com',
  'mohmal.com', 'emailondeck.com', 'burnermail.io', 'tempinbox.com', 'spamgourmet.com',
]);

// Mailboxes that exist but belong to a department, not the person you spoke to.
const ROLE_PREFIXES = ['info', 'info.', 'salg', 'sales', 'kontakt', 'contact', 'admin', 'post', 'postmaster',
  'webmaster', 'abuse', 'noreply', 'no-reply', 'newsletter', 'support', 'help', 'office', 'hello', 'hej', 'kundeservice'];

// The domains a Dane (or anyone) most often mistypes.
const COMMON_DOMAINS = ['gmail.com', 'googlemail.com', 'hotmail.com', 'outlook.com', 'live.dk', 'live.com',
  'yahoo.com', 'yahoo.dk', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'msn.com',
  'mail.dk', 'mail.com', 'aol.com', 'zoho.com', 'fastmail.com', 'gmx.com', 'gmx.de', 'tutanota.com'];

const DEFAULT_MX_TIMEOUT_MS = 4000;
const RCPT_TIMEOUT_MS = 6000;

// --- Levenshtein, capped so a 250-char domain cannot cost quadratic time ---
function distance(a, b, max = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > max) return max + 1;      // prune: already too far to suggest
    prev = row;
  }
  return prev[b.length];
}

function suggestDomain(domain) {
  // A domain we already recognise is not a typo, whatever else it resembles. Without this
  // guard "gmail.com" gets "corrected" to "mail.com", which is exactly the wrong advice.
  if (COMMON_DOMAINS.includes(domain)) return null;
  let best = null;
  for (const known of COMMON_DOMAINS) {
    const d = distance(domain, known, 2);
    // d === 0 means the domain is already a known-good one — suggesting it back at the
    // user ("did you mean gmail.com?" for gmail.com) is noise, so require a real edit.
    if (d >= 1 && d <= 2 && (!best || d < best.d)) best = { domain: known, d };
  }
  return best ? best.domain : null;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
  ]);
}

async function lookupMx(domain, timeoutMs = DEFAULT_MX_TIMEOUT_MS) {
  try {
    const records = await withTimeout(dns.resolveMx(domain), timeoutMs, 'MX lookup');
    if (!records || !records.length) return { ok: false, code: 'NO_RECORD', exchanges: [] };
    const sorted = records.sort((a, b) => a.priority - b.priority);
    // example.com answers with a single empty exchange — that is not a usable mail server.
    const usable = sorted.filter((r) => r.exchange && r.exchange.trim() && r.exchange !== '.');
    return { ok: usable.length > 0, code: usable.length ? null : 'EMPTY_EXCHANGE', exchanges: sorted.map((r) => r.exchange) };
  } catch (e) {
    const code = e.code === 'ENOTFOUND' ? 'NXDOMAIN'
      : e.code === 'ENODATA' ? 'NO_RECORD'
      : /timed out/.test(String(e.message)) ? 'TIMEOUT' : 'DNS_ERROR';
    return { ok: false, code, exchanges: [], error: String(e.message || e) };
  }
}

// Ask the mail server whether it will accept this recipient. See the caveat at the top.
async function probeRcpt(address, { from, timeoutMs = RCPT_TIMEOUT_MS } = {}) {
  const domain = address.split('@')[1];
  const mx = await lookupMx(domain);
  if (!mx.ok) return { attempted: false, accepted: false, reason: mx.code };
  const host = mx.exchanges[0];
  const sender = from || `verify@${(require('os').hostname() || 'localhost').split('.')[0]}`;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; try { socket.destroy(); } catch { /* ignore */ } resolve(v); } };
    const socket = net.connect({ port: 25, host }, () => {});
    socket.setTimeout(timeoutMs);
    let stage = 'connect';
    let buffer = '';

    const send = (line) => { try { socket.write(line + '\r\n'); } catch { finish({ attempted: true, accepted: false, reason: 'WRITE_FAILED' }); } };

    socket.on('timeout', () => finish({ attempted: true, accepted: false, reason: 'TIMEOUT', host }));
    socket.on('error', (e) => finish({ attempted: true, accepted: false, reason: e.code === 'ECONNREFUSED' ? 'PORT_25_BLOCKED' : 'SOCKET_ERROR', host }));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      // Multi-line SMTP replies use "250-..." until the final "250 ...".
      while ((nl = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const code = parseInt(line.slice(0, 3), 10);
        if (line.length > 3 && line[3] === '-') continue;     // more lines coming

        if (stage === 'connect') {
          if (code === 220) { stage = 'ehlo'; send(`EHLO ${(require('os').hostname() || 'localhost').split('.')[0]}`); }
          else finish({ attempted: true, accepted: false, reason: `GREETING_${code}`, host });
        } else if (stage === 'ehlo') {
          if (code === 250) { stage = 'mail'; send(`MAIL FROM:<${sender}>`); }
          else finish({ attempted: true, accepted: false, reason: `EHLO_${code}`, host });
        } else if (stage === 'mail') {
          if (code === 250) { stage = 'rcpt'; send(`RCPT TO:<${address}>`); }
          else finish({ attempted: true, accepted: false, reason: `MAIL_${code}`, host });
        } else if (stage === 'rcpt') {
          // 550/551/553 = refused. 250 = accepted *at this stage only*.
          const accepted = code === 250 || code === 251;
          stage = 'quit';
          send('QUIT');
          finish({ attempted: true, accepted, code, reason: accepted ? 'ACCEPTED' : `REFUSED_${code}`, host });
        }
      }
    });
    // Never hang the request: if the server accepts the socket but never speaks, give up.
    setTimeout(() => finish({ attempted: true, accepted: false, reason: 'NO_RESPONSE', host }), timeoutMs + 500);
  });
}

// The verdict the UI shows. `level` drives the colour; `reasons` are human sentences.
async function verify(rawEmail, options = {}) {
  const email = String(rawEmail ?? '').trim();
  const result = {
    email,
    level: 'invalid',            // 'valid' | 'risky' | 'invalid'
    ok: false,
    reasons: [],
    suggestion: null,
    domain: null,
    mx: null,
    checks: { syntax: false, disposable: false, role: false, typo: false, mx: false, rcpt: null },
  };
  if (!email) { result.reasons.push('No email address given.'); return result; }
  if (email.length > 254) { result.reasons.push('Address is longer than 254 characters.'); return result; }

  if (!SYNTAX_RE.test(email)) { result.reasons.push('This is not a validly formed address.'); return result; }
  result.checks.syntax = true;

  const [local, domain] = email.split('@');
  const dom = domain.toLowerCase();
  result.domain = dom;

  if (DISPOSABLE.has(dom)) {
    result.checks.disposable = true;
    result.level = 'invalid';
    result.reasons.push(`${dom} is a throwaway inbox — mail to it expires unread.`);
    return result;
  }

  if (ROLE_PREFIXES.includes(local.toLowerCase().replace(/\..*$/, ''))) {
    result.checks.role = true;
    result.reasons.push(`"${local}@" is a department mailbox, not a person — expect a slower reply.`);
  }

  const suggestion = suggestDomain(dom);
  if (suggestion) {
    result.checks.typo = true;
    result.suggestion = `${local}@${suggestion}`;
    result.reasons.push(`Did you mean ${local}@${suggestion}? "${dom}" is not a domain we recognise.`);
  }

  const mx = await lookupMx(dom, options.mxTimeoutMs);
  result.mx = mx;
  result.checks.mx = mx.ok;
  if (!mx.ok) {
    result.level = 'invalid';
    // Lead with the fatal fact: a role-address or typo note is advice, this is why it failed.
    result.reasons.unshift(mx.code === 'NXDOMAIN'
      ? `The domain ${dom} does not exist — nothing can ever arrive here.`
      : mx.code === 'TIMEOUT'
        ? `DNS timed out looking up ${dom}, so this could not be confirmed.`
        : `${dom} has no mail server (no MX records).`);
    return result;
  }

  // MX is good. A typo with a live MX is still risky (typo-squat domains do exist).
  if (result.checks.typo) {
    result.level = 'risky';
    result.ok = true;
    result.reasons.push('The domain does accept mail, but check the spelling before you send.');
  } else if (result.checks.role) {
    result.level = 'risky';
    result.ok = true;
  } else {
    result.level = 'valid';
    result.ok = true;
    result.reasons.push(`${dom} has working mail servers.`);
  }

  if (options.deep) {
    result.checks.rcpt = await probeRcpt(email, { from: options.from });
    if (result.checks.rcpt.attempted) {
      if (!result.checks.rcpt.accepted && result.checks.rcpt.reason !== 'PORT_25_BLOCKED' && result.checks.rcpt.reason !== 'TIMEOUT') {
        result.level = 'invalid';
        result.ok = false;
        result.reasons.push(`The mail server for ${dom} refused this exact address (${result.checks.rcpt.reason}).`);
      } else if (result.checks.rcpt.reason === 'PORT_25_BLOCKED' || result.checks.rcpt.reason === 'TIMEOUT') {
        result.reasons.push('Deep check skipped — this network blocks outbound port 25.');
      } else {
        result.reasons.push('The mail server accepted this address at handshake (providers still bounce later, so treat this as weak evidence).');
      }
    }
  }
  return result;
}

// Batch verify, with bounded concurrency so a 500-row list does not open 500 DNS queries.
async function verifyMany(emails, { concurrency = 8, mxTimeoutMs = DEFAULT_MX_TIMEOUT_MS } = {}) {
  const out = [];
  const queue = [...emails];
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, 16)) }, async () => {
    while (queue.length) {
      const idx = emails.length - queue.length;
      const email = queue.shift();
      out[idx] = await verify(email, { mxTimeoutMs });
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------- sending

// The catch-all sink. `smtp_host === 'local'` means "do not transmit": mail is written to the
// outbox table instead, so the compose → send → preview loop works with no credentials at all.
// The distinction from an empty host matters and is load-bearing: empty must stay *unconfigured*
// (that is the guard the whole app relies on), local is deliberately configured-but-offline.
const LOCAL_SINK_HOST = 'local';
const LOCAL_SINK_FROM = 'agent@pulse.dialer';

function smtpConfig() {
  const s = settingsRepo.all();
  const host = String(s.smtp_host || '').trim();
  const user = String(s.smtp_user || '').trim();
  const pass = String(s.smtp_pass || '').trim();
  const isLocalSink = host.toLowerCase() === LOCAL_SINK_HOST;
  return {
    host, port: Number(s.smtp_port || 587), secure: String(s.smtp_secure) === '1',
    user, pass,
    // A From header is mandatory in the previewer, and the sink is exactly where someone is
    // most likely to have typed no identitity yet — so it gets a working default, and only it.
    from: String(s.smtp_from || '').trim() || user || (isLocalSink ? LOCAL_SINK_FROM : ''),
    isLocalSink,
    configured: isLocalSink || Boolean(host && user && pass),
  };
}

// A Message-ID that is obviously local and cannot collide with a real provider's.
function localMessageId() {
  const rand = require('crypto').randomBytes(6).toString('hex');
  return `local-${Date.now()}-${rand}@pulse.dialer`;
}

// Strip CR/LF and control characters out of anything that becomes a mail header. Without
// this a subject containing "\r\nBcc: attacker@evil.dk" injects its own headers, which is
// how a contact form becomes an open relay.
function sanitizeHeader(value, max = 300) {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

// ---------------------------------------------------------------- transport reuse
// Building a transport per send re-does TCP + TLS + AUTH every time, which is slow and gets
// aggressive providers rate-limiting an agent who sends a burst of follow-ups. Keep one
// pooled transport and rebuild it only when the SMTP settings actually change.
let cachedTransport = null;
let cachedFingerprint = '';

const fingerprintOf = (cfg) => [cfg.host, cfg.port, cfg.secure ? 1 : 0, cfg.user, cfg.pass, cfg.from].join('\u0000');

function buildTransport(cfg) {
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    pool: true,                 // reuse connections across sends
    maxConnections: 3,          // a desktop agent never needs more
    maxMessages: 50,            // recycle a connection before the provider drops it
    // Fail fast rather than leaving the agent staring at a spinner.
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
  });
}

// The one place that decides whether an existing transport can be reused.
function transportFor(cfg) {
  const fingerprint = fingerprintOf(cfg);
  if (cachedTransport && cachedFingerprint === fingerprint) return cachedTransport;
  dropTransport();                                  // settings changed — the old auth is stale
  cachedTransport = buildTransport(cfg);
  cachedFingerprint = fingerprint;
  return cachedTransport;
}

function dropTransport() {
  if (!cachedTransport) return;
  try { cachedTransport.close(); } catch { /* already dead — nothing to reclaim */ }
  cachedTransport = null;
  cachedFingerprint = '';
}

// Called when settings change so the next send cannot reuse credentials that were edited
// out from under it (a corrected typo in the password would otherwise never take effect).
const invalidateTransport = dropTransport;

// Nodemailer surfaces server responses verbatim, and an AUTH failure often echoes the
// username. Never let a credential reach the client or the log.
function redact(message, cfg) {
  let out = String(message ?? '');
  for (const secret of [cfg?.pass, cfg?.user]) {
    if (secret && secret.length >= 3) out = out.split(secret).join('•••');
  }
  return out.slice(0, 300);
}

// Send failures must stay inside the request: a rejected promise nobody awaited would take
// the process down. Everything that can throw is funnelled through here.
function smtpFailure(e, cfg) {
  if (e && e.isApiError) return e;                       // already a clean 4xx
  const detail = redact(e?.message || e, cfg);
  return ApiError.badRequest(`Sending failed — ${detail}`);
}

async function sendTest() {
  const cfg = smtpConfig();
  if (!cfg.configured) throw ApiError.badRequest('SMTP is not configured yet — set host, username and password in Settings.');
  if (cfg.isLocalSink) {
    // There is no server to reach: the sink is this process's own database. Reporting success
    // is not a shortcut, it is the truth — and the UI says which mode it is in.
    return {
      ok: true, host: LOCAL_SINK_HOST, port: cfg.port, secure: false, from: cfg.from,
      local: true, message: 'Local Outbox Sink ready',
    };
  }
  try {
    await transportFor(cfg).verify();
    return { ok: true, host: cfg.host, port: cfg.port, secure: cfg.secure, from: cfg.from };
  } catch (e) {
    // A failed verify means this transport is not worth keeping around.
    dropTransport();
    throw ApiError.badRequest(`Could not reach ${cfg.host}:${cfg.port} — ${redact(e.message || e, cfg)}`);
  }
}

async function send({ to, subject, text, html, attachments = [], replyTo, prospectId = null }) {
  const cfg = smtpConfig();

  // Coerce first, then validate, so a stray undefined can never become the literal string
  // "undefined" in a recipient header.
  const recipients = (Array.isArray(to) ? to : [to])
    .map((t) => String(t ?? '').trim())
    .filter(Boolean);

  if (!recipients.length) throw ApiError.badRequest('No recipient given.');
  for (const r of recipients) {
    if (!SYNTAX_RE.test(r)) throw ApiError.badRequest(`"${r}" is not a valid email address.`);
  }
  if (!String(subject || '').trim()) throw ApiError.badRequest('The email needs a subject.');
  if (!cfg.configured) throw ApiError.badRequest('SMTP is not configured yet — set host, username and password in Settings.');

  const headers = {
    from: sanitizeHeader(cfg.from || cfg.user, 320),
    to: recipients.join(', '),
    replyTo: replyTo ? sanitizeHeader(replyTo, 320) : undefined,
    subject: sanitizeHeader(subject, 300),
  };

  // ---- local catch-all sink: capture instead of transmit ----
  // Everything above this line already ran, so the sink enforces exactly the same guards as a
  // live send (valid recipients, a subject, sanitized headers). It only replaces the transport.
  if (cfg.isLocalSink) {
    const messageId = localMessageId();
    const sentAt = new Date().toISOString();
    const storedHeaders = {
      From: headers.from,
      To: headers.to,
      ...(headers.replyTo ? { 'Reply-To': headers.replyTo } : {}),
      Subject: headers.subject,
      'Message-ID': messageId,
      Date: new Date(sentAt).toUTCString(),
      'X-Pulse-Transport': 'local-sink',
    };
    try {
      const row = outboxRepo.insert({
        prospectId,
        to: recipients,
        from: headers.from,
        replyTo: headers.replyTo || '',
        subject: headers.subject,
        text: String(text || ''),
        html: String(html || ''),
        attachments,
        headers: storedHeaders,
      });
      return {
        ok: true,
        messageId,
        accepted: recipients,
        rejected: [],
        to: recipients,
        sentAt,
        local: true,          // the UI branches on this to say "captured", not "sent"
        outboxId: row?.id ?? null,
      };
    } catch (e) {
      // A sink that cannot write is a real failure — never report a captured mail that is not
      // in the ledger, or the agent believes it was sent when nothing was recorded.
      throw ApiError.badRequest(`Local outbox could not store the message — ${redact(e?.message || e, cfg)}`);
    }
  }

  try {
    const info = await transportFor(cfg).sendMail({
      ...headers,
      text: String(text || ''),
      html: html || undefined,
      attachments: attachments.map((a) => ({
        filename: sanitizeHeader(a.filename || 'attachment', 200),
        content: a.content,                       // Buffer
        contentType: a.contentType || undefined,
      })),
    });
    return {
      ok: true,
      messageId: info.messageId,
      accepted: (info.accepted || []).map(String),
      rejected: (info.rejected || []).map(String),
      to: recipients,
      sentAt: new Date().toISOString(),
    };
  } catch (e) {
    throw smtpFailure(e, cfg);
  }
}

module.exports = {
  verify, verifyMany, send, sendTest, smtpConfig, probeRcpt, lookupMx, suggestDomain,
  buildTransport, transportFor, invalidateTransport, sanitizeHeader, redact, localMessageId,
  LOCAL_SINK_HOST, LOCAL_SINK_FROM,
  SYNTAX_RE, DISPOSABLE, DEFAULT_MX_TIMEOUT_MS,
};
