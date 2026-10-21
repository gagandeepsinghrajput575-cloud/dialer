// Pure data access for calls. Stats filters are passed in by the services layer.
const { db } = require('../db');

const insert = (call) => {
  const info = db.prepare(
    'INSERT INTO calls(prospect_id, status, dry_run, dial_uri, caller_id, direction) VALUES(?,?,?,?,?,?)'
  ).run(call.prospect_id, call.status || 'initiated', call.dry_run ? 1 : 0, call.dial_uri || null, call.caller_id || null,
    call.direction === 'inbound' ? 'inbound' : 'outbound');
  return get(info.lastInsertRowid);
};

// An inbound ring. It shares every column with an outbound dial and differs only in direction
// and in where the caller's number is kept: for an inbound call `caller_id` is the *caller*,
// not the number we presented.
const createInbound = ({ prospectId, callerId = '', status = 'ringing', dryRun = false } = {}) =>
  insert({ prospect_id: prospectId, status, dry_run: dryRun, caller_id: callerId, direction: 'inbound' });

// The same ring can be delivered more than once (a forked INVITE, a retry after a dropped
// socket). An unanswered inbound row for this caller inside the window *is* that ring.
const findOpenInbound = (callerId, withinSec = 120) =>
  db.prepare(
    `SELECT * FROM calls
     WHERE direction = 'inbound' AND status = 'ringing' AND caller_id = ?
       AND started_at >= datetime('now', ?)
     ORDER BY id DESC LIMIT 1`
  ).get(callerId, `-${withinSec} seconds`) || null;
const get = (id) => db.prepare('SELECT * FROM calls WHERE id = ?').get(id);
const remove = (id) => db.prepare('DELETE FROM calls WHERE id = ?').run(id);

// patch: outcome, duration_sec, vm_dropped, summary, next_step, follow_up_at, ended_at
// Column names are validated against the schema before they reach the SQL string.
const PATCH_COLUMNS = new Set([
  'outcome', 'duration_sec', 'status', 'dry_run', 'session_id', 'error',
  'started_at', 'ended_at', 'dial_uri', 'caller_id', 'vm_dropped', 'summary', 'next_step', 'follow_up_at',
]);

function patch(id, fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!PATCH_COLUMNS.has(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (!sets.length) return get(id);
  db.prepare(`UPDATE calls SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return get(id);
}

const listByProspect = (prospectId, limit = 50) =>
  db.prepare('SELECT * FROM calls WHERE prospect_id = ? ORDER BY id DESC LIMIT ?').all(prospectId, limit);

const lastByProspect = (prospectId) =>
  db.prepare('SELECT * FROM calls WHERE prospect_id = ? ORDER BY id DESC LIMIT 1').get(prospectId);

const all = () => db.prepare('SELECT * FROM calls').all();

// `extraWhere` is a trusted, service-built SQL fragment (e.g. "AND dry_run = 0").
const since = (sinceIso, extraWhere = '') =>
  db.prepare(`SELECT * FROM calls WHERE started_at >= ? AND status NOT IN ('failed', 'discarded', 'canceled') ${extraWhere}`).all(sinceIso);

const countSince = (sinceIso, extraWhere = '') =>
  db.prepare(`SELECT COUNT(*) c FROM calls WHERE started_at >= ? AND status NOT IN ('failed', 'discarded', 'canceled') ${extraWhere}`).get(sinceIso).c;

const recent = (limit = 8, extraWhere = '') =>
  db.prepare(
    `SELECT c.id, c.outcome, c.duration_sec, c.started_at, c.status, c.vm_dropped, c.dial_uri,
            p.id prospect_id, p.name, p.company
     FROM calls c JOIN prospects p ON p.id = c.prospect_id
     WHERE c.status NOT IN ('failed', 'discarded', 'canceled') ${extraWhere} ORDER BY c.id DESC LIMIT ?`
  ).all(limit);

const escapeLike = (s) => String(s).replace(/[\\%_]/g, (m) => `\\${m}`);

function buildHistoryFilters({ search = '', direction = '', filter = '', outcome = '', dryRun = null } = {}) {
  // Discarded rows never existed; canceled ones are dials the agent aborted before answer.
  // Neither is an attempt worth reviewing, and neither may inflate the cap or the funnel.
  const wheres = ["c.status NOT IN ('discarded', 'canceled')"];
  const params = [];

  if (dryRun !== null) {
    wheres.push('c.dry_run = ?');
    params.push(dryRun ? 1 : 0);
  }

  if (search && search.trim()) {
    const s = `%${escapeLike(search.trim())}%`;
    wheres.push("(p.name LIKE ? ESCAPE '\\' OR p.company LIKE ? ESCAPE '\\' OR p.phone LIKE ? ESCAPE '\\' OR c.caller_id LIKE ? ESCAPE '\\')");
    params.push(s, s, s, s);
  }

  if (direction && direction !== 'all') {
    wheres.push('c.direction = ?');
    params.push(direction.trim());
  }

  if (filter === 'missed') {
    wheres.push("(c.direction = 'inbound' AND c.status IN ('ringing', 'missed', 'declined'))");
  } else if (filter === 'connected') {
    wheres.push("c.duration_sec > 0 AND c.status NOT IN ('missed', 'declined', 'failed')");
  } else if (filter === 'voicemail') {
    wheres.push("(c.vm_dropped = 1 OR c.outcome = 'voicemail')");
  } else if (filter === 'recordings') {
    wheres.push('r.id IS NOT NULL');
  }

  if (outcome && outcome.trim()) {
    wheres.push('c.outcome = ?');
    params.push(outcome.trim());
  }

  const whereClause = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
  return { whereClause, params };
}

function listHistory({ search = '', direction = '', filter = '', outcome = '', dryRun = null, limit = 50, offset = 0 } = {}) {
  const { whereClause, params } = buildHistoryFilters({ search, direction, filter, outcome, dryRun });
  const sql = `
    SELECT
      c.id,
      c.prospect_id,
      c.outcome,
      c.duration_sec,
      c.status,
      c.dry_run,
      c.started_at,
      c.ended_at,
      c.dial_uri,
      c.caller_id,
      c.vm_dropped,
      c.summary,
      c.next_step,
      c.follow_up_at,
      c.direction,
      p.name AS prospect_name,
      p.company,
      p.title,
      p.phone,
      p.stage,
      p.pronunciation,
      r.id AS recording_id,
      CASE WHEN r.id IS NOT NULL THEN 1 ELSE 0 END AS has_recording
    FROM calls c
    LEFT JOIN prospects p ON p.id = c.prospect_id
    LEFT JOIN recordings r ON r.call_id = c.id
    ${whereClause}
    ORDER BY c.id DESC
    LIMIT ? OFFSET ?
  `;
  return db.prepare(sql).all(...params, Math.min(200, Math.max(1, limit)), Math.max(0, offset));
}

function countHistory({ search = '', direction = '', filter = '', outcome = '', dryRun = null } = {}) {
  const { whereClause, params } = buildHistoryFilters({ search, direction, filter, outcome, dryRun });
  const sql = `
    SELECT COUNT(*) AS total
    FROM calls c
    LEFT JOIN prospects p ON p.id = c.prospect_id
    LEFT JOIN recordings r ON r.call_id = c.id
    ${whereClause}
  `;
  return db.prepare(sql).get(...params)?.total || 0;
}

function historySummary({ dryRun = null } = {}) {
  const dryClause = dryRun !== null ? `AND c.dry_run = ${dryRun ? 1 : 0}` : '';
  const sql = `
    SELECT
      COUNT(*) AS total_calls,
      SUM(CASE WHEN c.direction = 'inbound' THEN 1 ELSE 0 END) AS inbound_calls,
      SUM(CASE WHEN c.direction = 'outbound' THEN 1 ELSE 0 END) AS outbound_calls,
      SUM(CASE WHEN c.direction = 'inbound' AND c.status IN ('ringing', 'missed', 'declined') THEN 1 ELSE 0 END) AS missed_calls,
      SUM(CASE WHEN c.duration_sec > 0 THEN c.duration_sec ELSE 0 END) AS total_duration_sec
    FROM calls c
    WHERE c.status != 'discarded' ${dryClause}
  `;
  const row = db.prepare(sql).get() || {};
  return {
    totalCalls: row.total_calls || 0,
    inboundCalls: row.inbound_calls || 0,
    outboundCalls: row.outbound_calls || 0,
    missedCalls: row.missed_calls || 0,
    totalDurationSec: row.total_duration_sec || 0,
  };
}

module.exports = {
  insert, createInbound, findOpenInbound, get, remove, patch, listByProspect, lastByProspect, all, since, countSince, recent, listHistory, countHistory, historySummary, PATCH_COLUMNS,
};
