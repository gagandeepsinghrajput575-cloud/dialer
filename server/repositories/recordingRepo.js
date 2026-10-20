// Data access for call recordings.
// Stores and queries recorded audio tracks linked to calls and prospects.
// Operates 100% locally on the filesystem with zero carrier or cloud storage charges.
const { db } = require('../db');

function get(id) {
  return db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) || null;
}

function getByCallId(callId) {
  return db.prepare('SELECT * FROM recordings WHERE call_id = ?').get(callId) || null;
}

function insert({ callId, prospectId = null, filename, durationSec = 0, sizeBytes = 0, mimeType = 'audio/webm' }) {
  const stmt = db.prepare(`
    INSERT INTO recordings(call_id, prospect_id, filename, duration_sec, size_bytes, mime_type)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(call_id) DO UPDATE SET
      prospect_id = excluded.prospect_id,
      filename = excluded.filename,
      duration_sec = excluded.duration_sec,
      size_bytes = excluded.size_bytes,
      mime_type = excluded.mime_type,
      created_at = datetime('now')
  `);
  const info = stmt.run(callId, prospectId, filename, Math.round(durationSec), Math.round(sizeBytes), mimeType);
  return getByCallId(callId);
}

function remove(callId) {
  const info = db.prepare('DELETE FROM recordings WHERE call_id = ?').run(callId);
  return info.changes > 0;
}

const escapeLike = (s) => String(s).replace(/[\\%_]/g, (m) => `\\${m}`);

function buildFilters({ search = '', outcome = '', direction = '' } = {}) {
  const wheres = [];
  const params = [];

  if (search && search.trim()) {
    const s = `%${escapeLike(search.trim())}%`;
    wheres.push("(p.name LIKE ? ESCAPE '\\' OR p.company LIKE ? ESCAPE '\\' OR p.phone LIKE ? ESCAPE '\\' OR c.caller_id LIKE ? ESCAPE '\\')");
    params.push(s, s, s, s);
  }

  if (outcome && outcome.trim()) {
    wheres.push('c.outcome = ?');
    params.push(outcome.trim());
  }

  if (direction && direction.trim()) {
    wheres.push('c.direction = ?');
    params.push(direction.trim());
  }

  const whereClause = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
  return { whereClause, params };
}

function list({ search = '', outcome = '', direction = '', limit = 50, offset = 0 } = {}) {
  const { whereClause, params } = buildFilters({ search, outcome, direction });
  const sql = `
    SELECT
      r.id,
      r.call_id,
      r.filename,
      r.duration_sec,
      r.size_bytes,
      r.mime_type,
      r.created_at,
      c.started_at,
      c.ended_at,
      c.outcome,
      c.duration_sec AS call_duration,
      c.direction,
      c.caller_id,
      c.summary,
      c.next_step,
      p.id AS prospect_id,
      p.name AS prospect_name,
      p.company,
      p.phone,
      p.email,
      p.stage
    FROM recordings r
    JOIN calls c ON c.id = r.call_id
    LEFT JOIN prospects p ON p.id = c.prospect_id
    ${whereClause}
    ORDER BY r.id DESC
    LIMIT ? OFFSET ?
  `;
  return db.prepare(sql).all(...params, Math.min(200, Math.max(1, limit)), Math.max(0, offset));
}

function count({ search = '', outcome = '', direction = '' } = {}) {
  const { whereClause, params } = buildFilters({ search, outcome, direction });
  const sql = `
    SELECT COUNT(*) AS total
    FROM recordings r
    JOIN calls c ON c.id = r.call_id
    LEFT JOIN prospects p ON p.id = c.prospect_id
    ${whereClause}
  `;
  return db.prepare(sql).get(...params)?.total || 0;
}

module.exports = {
  get,
  getByCallId,
  insert,
  remove,
  list,
  count,
};
