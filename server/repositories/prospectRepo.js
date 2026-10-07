// Pure data access for prospects. No business rules here — normalization and queue logic
// live in the services layer.
const { db } = require('../db');
const { STAGES } = require('../config/defaults');

const safeJson = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
const toApi = (r) => (r ? { ...r, dnc: !!r.dnc, extra: safeJson(r.extra) } : r);

const list = () => db.prepare('SELECT * FROM prospects ORDER BY id DESC').all().map(toApi);
const get = (id) => toApi(db.prepare('SELECT * FROM prospects WHERE id = ?').get(id));
const raw = (id) => db.prepare('SELECT * FROM prospects WHERE id = ?').get(id);
const count = () => db.prepare('SELECT COUNT(*) c FROM prospects').get().c;
const dncCount = () => db.prepare('SELECT COUNT(*) c FROM prospects WHERE dnc = 1').get().c;

function insert(p) {
  const info = db.prepare(
    'INSERT INTO prospects(name,phone,email,company,title,location,website,extra,stage) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(p.name || '', p.phone || '', p.email || '', p.company || '', p.title || '', p.location || '', p.website || '',
    JSON.stringify(p.extra || {}), STAGES.includes(p.stage) ? p.stage : 'new');
  return get(info.lastInsertRowid);
}

// patch: already-normalized column values only.
// SQLite binds numbers/strings/null only — callers pass booleans for flags like `dnc`.
const bindable = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v);

// Column names cannot be bound as parameters, so they are checked against the real schema
// instead of being interpolated from whatever a caller passes.
const COLUMNS = new Set([
  'name', 'phone', 'email', 'company', 'title', 'location', 'website', 'extra', 'stage',
  'dnc', 'follow_up_at', 'call_count', 'last_called_at', 'last_outcome',
]);

function update(id, patch) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!COLUMNS.has(k)) continue; // ignore anything that is not a real column
    sets.push(`${k} = ?`);
    vals.push(bindable(v));
  }
  if (!sets.length) return get(id);
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE prospects SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return get(id);
}

const touch = (id) => db.prepare("UPDATE prospects SET updated_at = datetime('now') WHERE id = ?").run(id);
const remove = (id) => db.prepare('DELETE FROM prospects WHERE id = ?').run(id);
const clearAll = () => db.prepare('DELETE FROM prospects').run();

function markCalled(id) {
  db.prepare("UPDATE prospects SET call_count = call_count + 1, last_called_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
}
function unmarkCalled(id) {
  db.prepare("UPDATE prospects SET call_count = MAX(0, call_count - 1), updated_at = datetime('now') WHERE id = ?").run(id);
}

function stageCounts() {
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const r of db.prepare('SELECT stage, COUNT(*) c FROM prospects GROUP BY stage').all()) counts[r.stage] = r.c;
  return counts;
}

const phones = () => new Set(db.prepare("SELECT phone FROM prospects WHERE phone != ''").all().map((r) => r.phone));

// LIKE treats % and _ as wildcards, so a search for "%" used to match every row.
const escapeLike = (s) => String(s).replace(/[\\%_]/g, (m) => `\\${m}`);

function search(needle, limit = 25) {
  const like = `%${escapeLike(String(needle || '').toLowerCase())}%`;
  return db.prepare(
    `SELECT * FROM prospects
     WHERE lower(name) LIKE ? ESCAPE '\\' OR lower(company) LIKE ? ESCAPE '\\'
        OR lower(phone) LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\'
     ORDER BY id DESC LIMIT ?`
  ).all(like, like, like, like, limit).map(toApi);
}

// Prospects with a follow-up due at or before `untilIso`.
function followUpsDue(untilIso) {
  return db.prepare("SELECT * FROM prospects WHERE follow_up_at IS NOT NULL AND follow_up_at != '' AND follow_up_at <= ? ORDER BY follow_up_at ASC").all(untilIso).map(toApi);
}

// Bulk insert inside one transaction; rows must already be normalized.
// Chunking keeps a 50k-row import from building one enormous statement/wal frame while still
// being all-or-nothing: any failure rolls the whole batch back.
const BULK_CHUNK = 2000;

function bulkInsert(rows) {
  const ins = db.prepare('INSERT INTO prospects(name,phone,email,company,title,location,website,extra) VALUES(?,?,?,?,?,?,?,?)');
  const tx = db.transaction((list) => {
    let n = 0;
    for (const r of list) {
      ins.run(r.name, r.phone, r.email, r.company, r.title, r.location, r.website, JSON.stringify(r.extra || {}));
      n++;
    }
    return n;
  });
  let added = 0;
  const all = db.transaction(() => {
    for (let i = 0; i < rows.length; i += BULK_CHUNK) added += tx(rows.slice(i, i + BULK_CHUNK));
    return added;
  });
  return all();
}

// Lowercased addresses, for duplicate detection. A person reached on a mobile and a
// landline is one contact, and the email is usually the thing that gives it away.
const emails = () => new Set(
  db.prepare("SELECT email FROM prospects WHERE email IS NOT NULL AND email <> ''").all()
    .map((r) => String(r.email).trim().toLowerCase())
);

module.exports = {
  emails,
  toApi, list, get, raw, count, dncCount, insert, update, touch, remove, clearAll,
  markCalled, unmarkCalled, stageCounts, phones, search, followUpsDue, bulkInsert,
  COLUMNS, escapeLike, BULK_CHUNK,
};
