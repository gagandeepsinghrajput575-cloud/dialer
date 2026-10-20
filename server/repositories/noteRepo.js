// Pure data access for notes.
const { db } = require('../db');

const insert = (prospectId, body) => {
  const info = db.prepare('INSERT INTO notes(prospect_id, body) VALUES(?,?)').run(prospectId, body);
  return get(info.lastInsertRowid);
};
const get = (id) => db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
const update = (id, body) => { db.prepare('UPDATE notes SET body = ? WHERE id = ?').run(body, id); return get(id); };
const remove = (id) => db.prepare('DELETE FROM notes WHERE id = ?').run(id);
const listByProspect = (prospectId) => db.prepare('SELECT * FROM notes WHERE prospect_id = ? ORDER BY id DESC').all(prospectId);
const all = () => db.prepare('SELECT id, prospect_id, body, created_at FROM notes ORDER BY id DESC').all();

// Email is a first-class touchpoint, so a sent email has to land in the same activity feed as
// the call notes — otherwise the agent's history has holes exactly where a conversation
// continued off the phone. One writer for this line keeps the wording (and any future test
// against it) in a single place.
function logEmail(prospectId, { subject = '', recipients = [], attachmentCount = 0 } = {}) {
  const to = (Array.isArray(recipients) ? recipients : [recipients])
    .map((r) => String(r ?? '').trim())
    .filter(Boolean)
    .join(', ');
  const count = Number.isFinite(Number(attachmentCount)) ? Math.max(0, Number(attachmentCount)) : 0;
  const line = `📧 Sent email: "${String(subject).replace(/"/g, "'").slice(0, 120)}" to ${to} (attachments: ${count})`;
  return insert(prospectId, line);
}

module.exports = { insert, get, update, remove, listByProspect, all, logEmail };
