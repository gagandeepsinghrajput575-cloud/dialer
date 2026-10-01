require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { db, getSetting, setSetting, allSettings } = require('./db');
const sonetel = require('./sonetel');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

const STAGES = ['new', 'contacted', 'interested', 'followup', 'meeting', 'won', 'lost'];
const OUTCOMES = ['no_answer', 'voicemail', 'wrong_number', 'gatekeeper', 'hung_up', 'conversation', 'meeting_booked', 'dnc'];
const PICKUP = ['gatekeeper', 'hung_up', 'conversation', 'meeting_booked'];
const CONVO = ['conversation', 'meeting_booked'];
const FIELDS = ['name', 'phone', 'email', 'company', 'title', 'location', 'website'];

// ---------- helpers ----------
function cleanStr(val) {
  if (val === null || val === undefined) return '';
  const s = String(val).trim();
  const lower = s.toLowerCase();
  if (['null', 'undefined', 'n/a', 'na', 'none', '-', '--', 'nil'].includes(lower)) return '';
  return s;
}

function normalizePhone(raw) {
  if (!raw) return '';
  let s = cleanStr(raw);
  if (!s) return '';
  if (/@/.test(s) || /^sip:/i.test(s)) return s; // SIP address, keep as is
  const hasPlus = s.startsWith('+');
  let digits = s.replace(/\D/g, '');
  if (!digits || digits.length < 5) return ''; // ignore clearly junk numbers (< 5 digits)
  if (hasPlus) return '+' + digits;
  if (digits.startsWith('00')) return '+' + digits.slice(2);
  const cc = String(getSetting('default_country_code') || '').replace(/\D/g, '');
  if (cc && digits.startsWith('0')) digits = digits.replace(/^0+/, '');
  if (cc && digits.length <= 10) return '+' + cc + digits;
  if (cc && digits.startsWith(cc) && digits.length > 10) return '+' + digits;
  return '+' + digits;
}

function escapeCsv(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

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
  const phone = normalizePhone(b.phone);
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
      vals.push(f === 'phone' ? normalizePhone(b[f]) : cleanStr(b[f]));
    }
  }
  if ('stage' in b && STAGES.includes(b.stage)) { sets.push('stage = ?'); vals.push(b.stage); }
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
  db.prepare('DELETE FROM prospects WHERE id = ?').run(req.params.id);
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
  const existing = new Set(db.prepare("SELECT phone FROM prospects WHERE phone != ''").all().map((r) => r.phone));
  const ins = db.prepare('INSERT INTO prospects(name,phone,email,company,title,location,website,extra) VALUES(?,?,?,?,?,?,?,?)');
  const mappedCols = new Set(Object.values(mapping).filter(Boolean));
  let added = 0, dupes = 0, empty = 0;
  const JUNK_NAMES = new Set(['total', 'grand total', 'subtotal', 'average', 'summary', 'count', 'page 1', 'rows', 'name', 'full name', 'prospect', 'unnamed']);

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
      v.phone = normalizePhone(v.phone);
      if (v.email && !v.email.includes('@')) {
        v.email = '';
      }
      // Check for junk header/summary/footer row
      const isJunkPattern = /^(total|grand total|subtotal|average|summary|count|page \d+.*|sheet\d*|workbook.*|rows?|name|full name|prospect|unnamed|untitled|header|notes)$/i.test(v.name.trim());
      if (v.name && (JUNK_NAMES.has(v.name.toLowerCase()) || isJunkPattern)) { empty++; continue; }
      if (!v.phone && !v.name && !v.email) { empty++; continue; }
      // A contact with no phone, no email, and no company is almost always a header or label
      if (!v.phone && !v.email && !v.company) { empty++; continue; }
      if (!v.phone && !v.email && v.name.length < 2) { empty++; continue; }

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
  const body = String((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ error: 'Empty note' });
  const info = db.prepare('INSERT INTO notes(prospect_id, body) VALUES(?,?)').run(req.params.id, body);
  touch(req.params.id);
  res.json(db.prepare('SELECT * FROM notes WHERE id = ?').get(info.lastInsertRowid));
});
app.patch('/api/notes/:id', (req, res) => {
  db.prepare('UPDATE notes SET body = ? WHERE id = ?').run(String(req.body.body || ''), req.params.id);
  res.json(db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id));
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

// Discard an aborted/cancelled call
app.post('/api/calls/:id/discard', (req, res) => {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id);
  if (call) {
    db.prepare('DELETE FROM calls WHERE id = ?').run(call.id);
    db.prepare("UPDATE prospects SET call_count = MAX(0, call_count - 1), updated_at = datetime('now') WHERE id = ?").run(call.prospect_id);
  }
  res.json({ ok: true });
});

app.delete('/api/calls/:id', (req, res) => {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id);
  if (call) {
    db.prepare('DELETE FROM calls WHERE id = ?').run(call.id);
    db.prepare("UPDATE prospects SET call_count = MAX(0, call_count - 1), updated_at = datetime('now') WHERE id = ?").run(call.prospect_id);
  }
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

// ---------- static client ----------
const dist = path.join(__dirname, '..', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`Pulse Dialer running on http://localhost:${PORT}`));
