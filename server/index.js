require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { db, getSetting, setSetting, allSettings } = require('./db');
const sonetel = require('./sonetel');
// Pure, side-effect-free cores. They live in their own modules so they can be
// require()d by the property suite without booting Express or opening the DB.
const { cleanStr } = require('./services/text');
const { normalizePhone } = require('./services/telephony');
const { escapeCsv } = require('./services/csv');
const { isJunkName, isEmptyRow } = require('./services/imports');
const {
  QUEUE_TABS, QUEUE_DEFAULT_LIMIT, QUEUE_MAX_LIMIT, HAS_PHONE,
  queueSearch, encodeCursor, decodeCursor, cursorPredicate,
} = require('./services/queue');

const app = express();

// ---------- request hardening ----------
// The browser client is always same-origin in a supported setup: the vite dev
// server proxies /api, and production serves dist/ from this same process. So a
// wildcard CORS policy bought nothing and advertised the whole API to every
// website the operator ever visited. Origins are opt-in via CORS_ORIGIN.
const CORS_ORIGINS = String(process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: CORS_ORIGINS.length ? CORS_ORIGINS : false }));

// Tightening CORS is not enough on its own: it hides the *response*, it does not
// stop the *request*. A cross-origin `fetch` with a text/plain body is a "simple
// request" — no preflight — and endpoints like POST /api/prospects/clear never
// read the body, so the damage would already be done. Requiring a custom header
// on every mutating call is what actually blocks it: a simple request cannot set
// one, and setting it forces a preflight, which the policy above refuses.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_HEADER = 'x-requested-with';
const CSRF_TOKEN = 'pulse-dialer';
app.use('/api', (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.get(CSRF_HEADER) !== CSRF_TOKEN) {
    return res.status(403).json({ error: 'Cross-site request refused: missing X-Requested-With header.' });
  }
  next();
});

// No helmet dependency needed for this set.
//
// frame-ancestors is configurable because this app is routinely viewed through
// a reverse proxy in an iframe (preview environments, an internal portal). A
// hardcoded 'none' would render those blank. The default stays locked down and
// the operator opts in with e.g. FRAME_ANCESTORS="https://*.example.com".
const FRAME_ANCESTORS = String(process.env.FRAME_ANCESTORS || "'none'").trim() || "'none'";
const CSP = [
  "default-src 'self'", "base-uri 'self'", "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "font-src 'self' data:", "connect-src 'self'", "form-action 'self'",
  `frame-ancestors ${FRAME_ANCESTORS}`, "object-src 'none'",
].join('; ');
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // X-Frame-Options cannot express a per-origin allowlist, so it is only sent
  // for the locked-down default; CSP frame-ancestors covers the rest.
  if (FRAME_ANCESTORS === "'none'") res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use(express.json({ limit: '25mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// Growth limits. Both endpoints are unauthenticated by design (single-operator
// tool), so without a ceiling one stray loop — or one hostile page — could grow
// the database without bound.
const DEMO_MAX_PROSPECTS = 500;
const BULK_MAX_ROWS = 100000;

const STAGES = ['new', 'contacted', 'interested', 'followup', 'meeting', 'won', 'lost'];
const OUTCOMES = ['no_answer', 'voicemail', 'wrong_number', 'gatekeeper', 'hung_up', 'conversation', 'meeting_booked', 'dnc'];
const PICKUP = ['gatekeeper', 'hung_up', 'conversation', 'meeting_booked'];
const CONVO = ['conversation', 'meeting_booked'];
const FIELDS = ['name', 'phone', 'email', 'company', 'title', 'location', 'website'];

// ---------- helpers ----------
// cleanStr, normalizePhone and escapeCsv now live in server/services/ so they can
// be fuzzed without starting the server. See test/unit/property.test.js.

const toApi = (r) => (r ? { ...r, dnc: !!r.dnc, extra: safeJson(r.extra) } : r);
function safeJson(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

function getStartOfDay(offsetDays = 0, tzOffsetMin = null) {
  if (tzOffsetMin !== null && Number.isFinite(tzOffsetMin)) {
    const now = Date.now();
    const clientLocal = new Date(now - tzOffsetMin * 60000);
    clientLocal.setUTCDate(clientLocal.getUTCDate() + offsetDays);
    clientLocal.setUTCHours(0, 0, 0, 0);
    return new Date(clientLocal.getTime() + tzOffsetMin * 60000);
  }
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
}

function statsFilter() {
  // while in dry-run mode show test calls; once live, exclude them
  return getSetting('dry_run') === '1' ? '' : 'AND dry_run = 0';
}
function touch(id) {
  db.prepare("UPDATE prospects SET updated_at = datetime('now') WHERE id = ?").run(id);
}
function todaysDials(tzOffset = null) {
  const since = sqlTime(getStartOfDay(0, tzOffset));
  return db.prepare(`SELECT COUNT(*) c FROM calls WHERE started_at >= ? AND status != 'failed' AND status != 'discarded' ${statsFilter()}`).get(since).c;
}

// ---------- prospects ----------
app.get('/api/prospects', (req, res) => {
  const rows = db.prepare('SELECT * FROM prospects ORDER BY id DESC').all();
  res.json(rows.map(toApi));
});

// ---------- server-backed dialer queue ----------
// Keyset (cursor) pagination over the same ordering the dialer has always used:
// prospects that have a phone number first, then ascending id. A cursor is an
// opaque base64url blob of the last row's sort key, so inserts/deletes between
// pages can never duplicate or skip a row the way OFFSET would. The codec and the
// search builder live in server/services/queue.js.

app.get('/api/queue', (req, res) => {
  const tab = String(req.query.tab ?? 'all');
  if (!Object.prototype.hasOwnProperty.call(QUEUE_TABS, tab)) {
    return res.status(400).json({ error: `Unknown tab "${tab}"` });
  }
  const rawLimit = req.query.limit === undefined ? NaN : Number(req.query.limit);
  if (req.query.limit !== undefined && (!Number.isFinite(rawLimit) || rawLimit < 1)) {
    return res.status(400).json({ error: 'limit must be a number >= 1' });
  }
  const limit = Math.min(QUEUE_MAX_LIMIT, Math.max(1, Math.floor(Number.isFinite(rawLimit) ? rawLimit : QUEUE_DEFAULT_LIMIT)));

  const q = String(req.query.q ?? '').trim();
  const search = queueSearch(q);
  const stageSql = QUEUE_TABS[tab] ? ` AND ${QUEUE_TABS[tab]}` : '';

  // One search-aware pass gives the badge count for every tab plus this tab's total.
  const c = db
    .prepare(
      `SELECT COUNT(*) AS allCount,
              COALESCE(SUM(CASE WHEN stage = 'new' THEN 1 ELSE 0 END), 0) AS newCount,
              COALESCE(SUM(CASE WHEN stage IN ('contacted','interested','followup') THEN 1 ELSE 0 END), 0) AS followCount
       FROM prospects WHERE dnc = 0${search.sql}`
    )
    .get(...search.params);
  const counts = { new: c.newCount, follow: c.followCount, all: c.allCount };
  const total = tab === 'new' ? counts.new : tab === 'follow' ? counts.follow : counts.all;

  // Cursor predicate for "strictly after the last row we served".
  let cursorSql = '';
  let cursorParams = [];
  if (req.query.cursor) {
    const cur = decodeCursor(req.query.cursor);
    if (!cur) return res.status(400).json({ error: 'Malformed cursor' });
    const pred = cursorPredicate(cur);
    cursorSql = pred.sql;
    cursorParams = pred.params;
  }

  const rows = db
    .prepare(
      `SELECT *, ${HAS_PHONE} AS has_phone FROM prospects
       WHERE dnc = 0${stageSql}${search.sql}${cursorSql}
       ORDER BY ${HAS_PHONE} DESC, id ASC
       LIMIT ?`
    )
    .all(...search.params, ...cursorParams, limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map((r) => {
    const { has_phone, ...rest } = r;
    return toApi(rest);
  });

  res.json({
    items,
    total,
    counts,
    hasMore,
    limit,
    tab,
    q,
    nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]) : null,
  });
});

// CSV Export of all prospects with notes and call metadata
app.get('/api/prospects/export', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM prospects ORDER BY id DESC').all();
    const notes = db.prepare('SELECT prospect_id, body, created_at FROM notes ORDER BY id DESC').all();
    const notesByProspect = {};
    for (const n of notes) {
      if (!notesByProspect[n.prospect_id]) notesByProspect[n.prospect_id] = [];
      notesByProspect[n.prospect_id].push(n.body);
    }

    const headers = [
      'ID', 'Name', 'Phone', 'Email', 'Company', 'Title', 'Stage',
      'Do Not Call', 'Calls Count', 'Last Called At', 'Last Outcome',
      'Follow Up Date', 'Location', 'Website', 'Notes', 'Created At'
    ];

    const csvRows = [headers.join(',')];
    for (const r of rows) {
      const prospectNotes = (notesByProspect[r.id] || []).join(' | ');
      const line = [
        r.id,
        escapeCsv(r.name),
        escapeCsv(r.phone),
        escapeCsv(r.email),
        escapeCsv(r.company),
        escapeCsv(r.title),
        escapeCsv(r.stage),
        r.dnc ? 'YES' : 'NO',
        r.call_count,
        escapeCsv(r.last_called_at || ''),
        escapeCsv(r.last_outcome || ''),
        escapeCsv(r.follow_up_at || ''),
        escapeCsv(r.location || ''),
        escapeCsv(r.website || ''),
        escapeCsv(prospectNotes),
        escapeCsv(r.created_at)
      ];
      csvRows.push(line.join(','));
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pulse-prospects-${dateStr}.csv"`);
    res.send(csvRows.join('\r\n'));
  } catch (e) {
    res.status(500).json({ error: 'Failed to generate export: ' + e.message });
  }
});

app.get('/api/prospects/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM prospects WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const notes = db.prepare('SELECT * FROM notes WHERE prospect_id = ? ORDER BY id DESC').all(p.id);
  const calls = db.prepare('SELECT * FROM calls WHERE prospect_id = ? ORDER BY id DESC LIMIT 50').all(p.id);
  res.json({ ...toApi(p), notes, calls });
});

app.post('/api/prospects', (req, res) => {
  const b = req.body || {};
  const phone = normalizePhone(b.phone, getSetting('default_country_code'));
  const info = db
    .prepare(
      'INSERT INTO prospects(name,phone,email,company,title,location,website,extra,stage) VALUES(?,?,?,?,?,?,?,?,?)'
    )
    .run(cleanStr(b.name), phone, cleanStr(b.email), cleanStr(b.company), cleanStr(b.title), cleanStr(b.location), cleanStr(b.website), JSON.stringify(b.extra || {}), STAGES.includes(b.stage) ? b.stage : 'new');
  res.json(toApi(db.prepare('SELECT * FROM prospects WHERE id = ?').get(info.lastInsertRowid)));
});

app.patch('/api/prospects/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM prospects WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const sets = [];
  const vals = [];
  for (const f of FIELDS) {
    if (f in b) {
      sets.push(`${f} = ?`);
      vals.push(f === 'phone' ? normalizePhone(b[f], getSetting('default_country_code')) : cleanStr(b[f]));
    }
  }
  if ('stage' in b) {
    // Silently dropping an invalid stage let a client believe a move succeeded
    // while the row never changed. Say no instead.
    if (!STAGES.includes(b.stage)) return res.status(400).json({ error: `Unknown stage "${b.stage}"` });
    sets.push('stage = ?'); vals.push(b.stage);
  }
  if ('dnc' in b) { sets.push('dnc = ?'); vals.push(b.dnc ? 1 : 0); }
  if ('follow_up_at' in b) { sets.push('follow_up_at = ?'); vals.push(b.follow_up_at || null); }
  if ('extra' in b) { sets.push('extra = ?'); vals.push(JSON.stringify(b.extra || {})); }
  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    db.prepare(`UPDATE prospects SET ${sets.join(', ')} WHERE id = ?`).run(...vals, p.id);
  }
  res.json(toApi(db.prepare('SELECT * FROM prospects WHERE id = ?').get(p.id)));
});

app.delete('/api/prospects/:id', (req, res) => {
  const info = db.prepare('DELETE FROM prospects WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.post('/api/prospects/clear', (req, res) => {
  db.prepare('DELETE FROM prospects').run();
  res.json({ ok: true });
});

// ---------- import ----------
app.post('/api/import/parse', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', raw: false, cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    const headers = rows.length ? Object.keys(rows[0]) : [];
    res.json({ headers, rows, filename: req.file.originalname });
  } catch (e) {
    res.status(400).json({ error: 'Could not read that file: ' + e.message });
  }
});

app.post('/api/prospects/bulk', (req, res) => {
  const { rows = [], mapping = {}, skipDuplicates = true } = req.body || {};
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows must be an array' });
  if (rows.length > BULK_MAX_ROWS) {
    return res.status(400).json({ error: `Too many rows: ${rows.length}. The limit is ${BULK_MAX_ROWS} per import — split the file.` });
  }
  const countryCode = String(getSetting('default_country_code') || '').replace(/\D/g, '');
  const existing = new Set(db.prepare("SELECT phone FROM prospects WHERE phone != ''").all().map((r) => r.phone));
  const ins = db.prepare('INSERT INTO prospects(name,phone,email,company,title,location,website,extra) VALUES(?,?,?,?,?,?,?,?)');
  const mappedCols = new Set(Object.values(mapping).filter(Boolean));
  let added = 0, dupes = 0, empty = 0;

  const tx = db.transaction(() => {
    for (const row of rows) {
      const v = {};
      for (const f of FIELDS) v[f] = mapping[f] ? cleanStr(row[mapping[f]]) : '';
      // allow first+last name mapping
      if (mapping.first_name || mapping.last_name) {
        const fn = mapping.first_name ? cleanStr(row[mapping.first_name]) : '';
        const ln = mapping.last_name ? cleanStr(row[mapping.last_name]) : '';
        mappedCols.add(mapping.first_name); mappedCols.add(mapping.last_name);
        if (!v.name) v.name = `${fn} ${ln}`.trim();
      }
      v.phone = normalizePhone(v.phone, countryCode);
      if (v.email && !v.email.includes('@')) {
        v.email = '';
      }
      // Header/footer/summary furniture, and rows carrying nothing to store
      if (v.name && isJunkName(v.name)) { empty++; continue; }
      if (isEmptyRow(v)) { empty++; continue; }

      if (skipDuplicates && v.phone && existing.has(v.phone)) { dupes++; continue; }
      const extra = {};
      for (const [k, val] of Object.entries(row)) {
        const cleanedVal = cleanStr(val);
        if (!mappedCols.has(k) && cleanedVal !== '') extra[k] = cleanedVal;
      }
      ins.run(v.name, v.phone, v.email, v.company, v.title, v.location, v.website, JSON.stringify(extra));
      if (v.phone) existing.add(v.phone);
      added++;
    }
  });
  tx();
  res.json({ added, dupes, empty });
});

// ---------- notes ----------
app.post('/api/prospects/:id/notes', (req, res) => {
  const p = db.prepare('SELECT id FROM prospects WHERE id = ?').get(req.params.id);
  // Without this the INSERT hits the notes→prospects foreign key and Express
  // answered with an HTML 500 carrying the SqliteError and our file paths.
  if (!p) return res.status(404).json({ error: 'Prospect not found' });
  const body = String((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ error: 'Empty note' });
  const info = db.prepare('INSERT INTO notes(prospect_id, body) VALUES(?,?)').run(p.id, body);
  touch(p.id);
  res.json(db.prepare('SELECT * FROM notes WHERE id = ?').get(info.lastInsertRowid));
});
app.patch('/api/notes/:id', (req, res) => {
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  // req.body is undefined when the caller sends no JSON at all, which used to
  // throw a TypeError and answer with an HTML 500.
  const body = String((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ error: 'Empty note' });
  db.prepare('UPDATE notes SET body = ? WHERE id = ?').run(body, note.id);
  res.json(db.prepare('SELECT * FROM notes WHERE id = ?').get(note.id));
});
app.delete('/api/notes/:id', (req, res) => {
  db.prepare('DELETE FROM notes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- calling ----------
app.post('/api/prospects/:id/call', async (req, res) => {
  const p = db.prepare('SELECT * FROM prospects WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Prospect not found' });
  if (p.dnc) return res.status(403).json({ error: 'This prospect is marked Do Not Call.' });
  if (!p.phone) return res.status(400).json({ error: 'This prospect has no phone number.' });

  const tzOffset = req.body?.tzOffset !== undefined ? parseInt(req.body.tzOffset, 10) : null;
  const cap = parseInt(getSetting('daily_cap'), 10) || 0;
  if (cap && todaysDials(tzOffset) >= cap) {
    return res.status(429).json({ error: `Daily dial cap reached (${cap}). Raise it in Settings if you want to continue.` });
  }
  const dry = getSetting('dry_run') === '1';
  const myNumber = (getSetting('my_number') || '').trim();
  const callerId = (getSetting('caller_id') || 'automatic').trim() || 'automatic';

  const log = db.prepare('INSERT INTO calls(prospect_id, status, dry_run) VALUES(?,?,?)');
  try {
    let sessionId = null;
    if (!dry) {
      if (!myNumber) throw new Error('Set "Your phone / SIP address" in Settings first.');
      const r = await sonetel.callback({ call1: myNumber, call2: p.phone, show1: 'automatic', show2: callerId });
      sessionId = r.session_id || null;
    }
    const info = log.run(p.id, dry ? 'dry_run' : 'placed', dry ? 1 : 0);
    db.prepare("UPDATE calls SET session_id = ? WHERE id = ?").run(sessionId, info.lastInsertRowid);
    db.prepare("UPDATE prospects SET call_count = call_count + 1, last_called_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(p.id);
    res.json({ callId: info.lastInsertRowid, dryRun: dry, sessionId });
  } catch (e) {
    const info = log.run(p.id, 'failed', dry ? 1 : 0);
    db.prepare('UPDATE calls SET error = ? WHERE id = ?').run(e.message, info.lastInsertRowid);
    res.status(502).json({ error: e.message });
  }
});

app.patch('/api/calls/:id', (req, res) => {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id);
  if (!call) return res.status(404).json({ error: 'Call not found' });
  const { outcome, duration_sec } = req.body || {};
  if (outcome && !OUTCOMES.includes(outcome)) return res.status(400).json({ error: 'Bad outcome' });
  db.prepare("UPDATE calls SET outcome = COALESCE(?, outcome), duration_sec = COALESCE(?, duration_sec), ended_at = datetime('now') WHERE id = ?")
    .run(outcome || null, Number.isFinite(duration_sec) ? Math.round(duration_sec) : null, call.id);

  if (outcome) {
    const p = db.prepare('SELECT * FROM prospects WHERE id = ?').get(call.prospect_id);
    let stage = p.stage;
    let dnc = p.dnc;
    if (PICKUP.includes(outcome) && stage === 'new') stage = 'contacted';
    if (outcome === 'meeting_booked') stage = 'meeting';
    if (outcome === 'wrong_number') stage = 'lost';
    if (outcome === 'dnc') { dnc = 1; stage = 'lost'; }
    db.prepare("UPDATE prospects SET last_outcome = ?, stage = ?, dnc = ?, updated_at = datetime('now') WHERE id = ?")
      .run(outcome, stage, dnc, p.id);
  }
  res.json({ ok: true, prospect: toApi(db.prepare('SELECT * FROM prospects WHERE id = ?').get(call.prospect_id)) });
});

// Removing a call also gives the dial back: an aborted call should not count
// against the prospect's call_count or the operator's daily total. Both routes
// below were byte-identical copies of this.
//
// Idempotent on purpose — dropping a call that is already gone answers ok rather
// than 404, because the UI fires discard on unmount and a double-discard is
// harmless. Returns false when there was nothing to remove.
function dropCall(id) {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(id);
  if (!call) return false;
  db.prepare('DELETE FROM calls WHERE id = ?').run(call.id);
  db.prepare("UPDATE prospects SET call_count = MAX(0, call_count - 1), updated_at = datetime('now') WHERE id = ?").run(call.prospect_id);
  return true;
}

// Discard an aborted/cancelled call
app.post('/api/calls/:id/discard', (req, res) => {
  dropCall(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/calls/:id', (req, res) => {
  dropCall(req.params.id);
  res.json({ ok: true });
});

// ---------- stats ----------
app.get('/api/stats', (req, res) => {
  const f = statsFilter();
  const goal = parseInt(getSetting('daily_goal'), 10) || 0;
  const cap = parseInt(getSetting('daily_cap'), 10) || 0;
  const tzOffset = req.query.tzOffset !== undefined ? parseInt(req.query.tzOffset, 10) : null;

  const summarize = (rows) => {
    const s = { dials: rows.length, pickups: 0, conversations: 0, meetings: 0, voicemails: 0, talkSec: 0 };
    for (const r of rows) {
      if (PICKUP.includes(r.outcome)) s.pickups++;
      if (CONVO.includes(r.outcome)) s.conversations++;
      if (r.outcome === 'meeting_booked') s.meetings++;
      if (r.outcome === 'voicemail') s.voicemails++;
      if (CONVO.includes(r.outcome)) s.talkSec += r.duration_sec || 0;
    }
    s.pickupRate = s.dials ? s.pickups / s.dials : 0;
    s.conversationRate = s.pickups ? s.conversations / s.pickups : 0;
    s.meetingRate = s.conversations ? s.meetings / s.conversations : 0;
    s.avgTalkSec = s.conversations ? Math.round(s.talkSec / s.conversations) : 0;
    return s;
  };

  const since7 = sqlTime(getStartOfDay(-6, tzOffset));
  const rows = db.prepare(`SELECT * FROM calls WHERE started_at >= ? AND status != 'failed' AND status != 'discarded' ${f}`).all(since7);
  const byDay = {};
  for (let i = 6; i >= 0; i--) {
    const d = getStartOfDay(-i, tzOffset);
    byDay[d.toISOString().slice(0, 10)] = { date: d.toISOString(), rows: [] };
  }
  const todayStart = getStartOfDay(0, tzOffset).getTime();
  const todayRows = [];
  for (const r of rows) {
    const t = new Date(r.started_at.replace(' ', 'T') + 'Z');
    for (let i = 6; i >= 0; i--) {
      const startI = getStartOfDay(-i, tzOffset).getTime();
      const endI = startI + 86400000;
      if (t.getTime() >= startI && t.getTime() < endI) {
        const bucketKey = getStartOfDay(-i, tzOffset).toISOString().slice(0, 10);
        if (byDay[bucketKey]) byDay[bucketKey].rows.push(r);
        break;
      }
    }
    if (t.getTime() >= todayStart) todayRows.push(r);
  }
  const week = Object.values(byDay).map((d) => ({ date: d.date, ...summarize(d.rows) }));

  const stageCounts = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const r of db.prepare('SELECT stage, COUNT(*) c FROM prospects GROUP BY stage').all()) stageCounts[r.stage] = r.c;
  const total = db.prepare('SELECT COUNT(*) c FROM prospects').get().c;
  const dncCount = db.prepare('SELECT COUNT(*) c FROM prospects WHERE dnc = 1').get().c;

  const recent = db
    .prepare(
      `SELECT c.id, c.outcome, c.duration_sec, c.started_at, c.status, p.id prospect_id, p.name, p.company
       FROM calls c JOIN prospects p ON p.id = c.prospect_id
       WHERE c.status != 'failed' AND c.status != 'discarded' ${f.replace('dry_run', 'c.dry_run')} ORDER BY c.id DESC LIMIT 8`
    )
    .all();

  res.json({ today: summarize(todayRows), week, goal, cap, stageCounts, total, dncCount, recent });
});

// ---------- settings ----------
app.get('/api/settings', (req, res) => {
  const s = allSettings();
  const hasPassword = !!(process.env.SONETEL_PASSWORD || s.sonetel_password);
  delete s.sonetel_password;
  res.json({ ...s, has_password: hasPassword, env_credentials: !!(process.env.SONETEL_USERNAME && process.env.SONETEL_PASSWORD) });
});
app.put('/api/settings', (req, res) => {
  const b = req.body || {};
  const allowed = ['sonetel_username', 'sonetel_password', 'my_number', 'caller_id', 'default_country_code', 'dry_run', 'daily_goal', 'daily_cap'];
  for (const k of allowed) {
    if (!(k in b)) continue;
    if (k === 'sonetel_password' && !b[k]) continue; // blank = keep existing
    setSetting(k, typeof b[k] === 'boolean' ? (b[k] ? '1' : '0') : b[k]);
  }
  res.json({ ok: true });
});
app.post('/api/settings/test', async (req, res) => {
  try {
    await sonetel.getToken(true);
    res.json({ ok: true, message: 'Connected to Sonetel successfully.' });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---------- demo data ----------
app.post('/api/demo', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) c FROM prospects').get().c;
  if (total >= DEMO_MAX_PROSPECTS) {
    return res.status(409).json({ error: `Demo data is capped at ${DEMO_MAX_PROSPECTS} prospects (already ${total}). Delete some first.` });
  }
  const demo = [
    ['Aarav Mehta', '+919810012345', 'aarav@northwind.in', 'Northwind Logistics', 'Operations Head', 'Delhi, IN'],
    ['Priya Sharma', '+919811123456', 'priya@brightlabs.io', 'BrightLabs', 'Founder & CEO', 'Noida, IN'],
    ['Rohan Gupta', '+919899034567', 'rohan@stackify.co', 'Stackify', 'VP Sales', 'Gurugram, IN'],
    ['Neha Kapoor', '+919873045678', 'neha@lumenhealth.com', 'Lumen Health', 'Marketing Director', 'Mumbai, IN'],
    ['Vikram Singh', '+919818056789', 'vikram@orbitpay.in', 'OrbitPay', 'CTO', 'Bengaluru, IN'],
    ['Ananya Iyer', '+919910067890', 'ananya@greenloop.org', 'GreenLoop', 'Head of Growth', 'Chennai, IN'],
    ['Karan Malhotra', '+919958078901', 'karan@peakfit.in', 'PeakFit', 'Owner', 'Ghaziabad, IN'],
    ['Sneha Reddy', '+919717089012', 'sneha@cloudnest.dev', 'CloudNest', 'Product Manager', 'Hyderabad, IN'],
  ];
  const ins = db.prepare('INSERT INTO prospects(name,phone,email,company,title,location,extra,stage) VALUES(?,?,?,?,?,?,?,?)');
  const stages = ['new', 'new', 'contacted', 'interested', 'followup', 'new', 'meeting', 'new'];
  db.transaction(() => demo.forEach((d, i) => {
    const info = ins.run(...d, JSON.stringify({ 'Lead source': 'Demo list', 'Company size': ['11-50', '51-200', '201-500'][i % 3] }), stages[i]);
    if (stages[i] !== 'new') db.prepare('INSERT INTO notes(prospect_id, body) VALUES(?,?)').run(info.lastInsertRowid, 'Sample note: asked to send a short deck over email.');
  }))();
  res.json({ ok: true });
});

// ---------- api fallthrough + error handling ----------
// Anything under /api that matched no route answers as JSON. It used to fall
// through to Express's HTML 404, which the client's res.json() cannot parse, so
// a typo'd endpoint surfaced as an opaque "Request failed (404)".
app.use('/api', (req, res) => {
  res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}` });
});

// ---------- static client ----------
const dist = path.join(__dirname, '..', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}


// Last resort. The real error is logged server-side; the client gets something
// safe. The default handler was returning HTML 500s containing the SqliteError
// text and absolute paths from this machine.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  let status = Number.isInteger(err && err.status) ? err.status : 500;
  let message = String((err && err.message) || 'Request failed');
  if (err && err.name === 'MulterError') {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large (30MB limit).' : `Upload failed: ${err.code}`;
  } else if (err && err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Malformed JSON body.';
  } else if (err && err.type === 'entity.too.large') {
    status = 413;
    message = 'Request body is too large.';
  }
  if (status >= 500) console.error(`[api] ${req.method} ${req.originalUrl}`, err);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : message });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`Pulse Dialer running on http://localhost:${PORT}`));
