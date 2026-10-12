// Repository for AI Recording Coach chat sessions and messages.
// Enforces local persistence in SQLite with full foreign key cascades to calls.
const { db } = require('../db');

function listChats(callId) {
  const cid = Number(callId);
  if (!Number.isInteger(cid) || cid <= 0) return [];
  return db.prepare(`
    SELECT c.*, 
           (SELECT COUNT(*) FROM recording_chat_messages m WHERE m.chat_id = c.id) as message_count,
           (SELECT content FROM recording_chat_messages m WHERE m.chat_id = c.id ORDER BY id DESC LIMIT 1) as last_message
    FROM recording_chats c
    WHERE c.call_id = ?
    ORDER BY c.updated_at DESC, c.id DESC
  `).all(cid);
}

function getChat(chatId) {
  const id = Number(chatId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const chat = db.prepare('SELECT * FROM recording_chats WHERE id = ?').get(id);
  if (!chat) return null;

  const messages = listMessages(id);
  return {
    ...chat,
    messages,
  };
}

function createChat(callId, title = 'Coaching Session') {
  const cid = Number(callId);
  if (!Number.isInteger(cid) || cid <= 0) throw new Error('Invalid call ID');
  const t = (title || 'Coaching Session').slice(0, 120);

  const stmt = db.prepare(`
    INSERT INTO recording_chats(call_id, title, created_at, updated_at)
    VALUES(?, ?, datetime('now'), datetime('now'))
  `);
  const res = stmt.run(cid, t);
  return getChat(res.lastInsertRowid);
}

function touchChat(chatId, title = null) {
  const id = Number(chatId);
  if (!Number.isInteger(id) || id <= 0) return;
  if (title) {
    db.prepare("UPDATE recording_chats SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title.slice(0, 120), id);
  } else {
    db.prepare("UPDATE recording_chats SET updated_at = datetime('now') WHERE id = ?").run(id);
  }
}

function deleteChat(chatId) {
  const id = Number(chatId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const res = db.prepare('DELETE FROM recording_chats WHERE id = ?').run(id);
  return res.changes > 0;
}

function clearChats(callId) {
  const cid = Number(callId);
  if (!Number.isInteger(cid) || cid <= 0) return 0;
  const res = db.prepare('DELETE FROM recording_chats WHERE call_id = ?').run(cid);
  return res.changes;
}

function listMessages(chatId) {
  const cid = Number(chatId);
  if (!Number.isInteger(cid) || cid <= 0) return [];
  const rows = db.prepare(`
    SELECT * FROM recording_chat_messages 
    WHERE chat_id = ? 
    ORDER BY id ASC
  `).all(cid);

  return rows.map((r) => {
    let parsedMeta = {};
    try {
      parsedMeta = JSON.parse(r.meta || '{}');
    } catch {}
    return {
      ...r,
      meta: parsedMeta,
    };
  });
}

function createMessage(chatId, { role, content, meta = {} }) {
  const cid = Number(chatId);
  if (!Number.isInteger(cid) || cid <= 0) throw new Error('Invalid chat ID');
  if (!['user', 'assistant'].includes(role)) throw new Error('Role must be user or assistant');

  const metaStr = typeof meta === 'object' && meta !== null ? JSON.stringify(meta) : '{}';

  const stmt = db.prepare(`
    INSERT INTO recording_chat_messages(chat_id, role, content, meta, created_at)
    VALUES(?, ?, ?, ?, datetime('now'))
  `);
  const res = stmt.run(cid, role, String(content || ''), metaStr);
  touchChat(cid);

  return {
    id: res.lastInsertRowid,
    chat_id: cid,
    role,
    content: String(content || ''),
    meta: typeof meta === 'object' && meta !== null ? meta : {},
    created_at: new Date().toISOString(),
  };
}

module.exports = {
  listChats,
  getChat,
  createChat,
  touchChat,
  deleteChat,
  clearChats,
  listMessages,
  createMessage,
};
