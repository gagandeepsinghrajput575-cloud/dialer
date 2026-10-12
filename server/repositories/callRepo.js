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
  db.prepare(`SELECT * FROM calls WHERE started_at >= ? AND status != 'failed' AND status != 'discarded' ${extraWhere}`).all(sinceIso);

const countSince = (sinceIso, extraWhere = '') =>
  db.prepare(`SELECT COUNT(*) c FROM calls WHERE started_at >= ? AND status != 'failed' AND status != 'discarded' ${extraWhere}`).get(sinceIso).c;

const recent = (limit = 8, extraWhere = '') =>
  db.prepare(
    `SELECT c.id, c.outcome, c.duration_sec, c.started_at, c.status, c.vm_dropped, c.dial_uri,
            p.id prospect_id, p.name, p.company
     FROM calls c JOIN prospects p ON p.id = c.prospect_id
     WHERE c.status != 'failed' AND c.status != 'discarded' ${extraWhere} ORDER BY c.id DESC LIMIT ?`
  ).all(limit);

module.exports = {
  insert, createInbound, findOpenInbound, get, remove, patch, listByProspect, lastByProspect, all, since, countSince, recent, PATCH_COLUMNS,
};
