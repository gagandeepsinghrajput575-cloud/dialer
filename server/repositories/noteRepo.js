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
const all = () => db.prepare('SELECT prospect_id, body, created_at FROM notes ORDER BY id DESC').all();

module.exports = { insert, get, update, remove, listByProspect, all };
