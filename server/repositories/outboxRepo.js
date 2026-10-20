// Data access for the local catch-all mail sink.
//
// When the operator points SMTP at "local", nothing leaves the machine: mail is written here
// instead of being transmitted, so the whole compose → send → preview loop is demonstrable
// with no credentials and no cloud account. The rows are therefore the *only* record of what
// was "sent", which is why the bodies are stored verbatim rather than summarised.
const { db } = require('../db');

// Attachment payloads are kept inline as base64 so a badge in the previewer can actually
// download something. That is only sane for the local sink's demo-sized files, so each one is
// bounded and anything larger degrades to metadata with stored: false.
const MAX_STORED_ATTACHMENT_BYTES = 512 * 1024;
const MAX_STORED_TOTAL_BYTES = 2 * 1024 * 1024;

const parseJson = (raw, fallback) => {
  try {
    const v = JSON.parse(raw);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;   // a corrupt row must not take the outbox down with it
  }
};

// Buffers cannot be JSON-serialised, so the caller's nodemailer-shaped attachments are
// reduced to something both the database and the previewer can hold.
function serializeAttachments(attachments = []) {
  const out = [];
  let used = 0;
  for (const a of Array.isArray(attachments) ? attachments : []) {
    if (!a) continue;
    const content = Buffer.isBuffer(a.content) ? a.content : (a.content ? Buffer.from(a.content) : null);
    const bytes = Number.isFinite(Number(a.bytes)) ? Number(a.bytes) : (content ? content.length : 0);
    const entry = {
      filename: String(a.filename || 'attachment').slice(0, 200),
      contentType: String(a.contentType || 'application/octet-stream'),
      bytes,
      stored: false,
    };
    if (content && content.length <= MAX_STORED_ATTACHMENT_BYTES && used + content.length <= MAX_STORED_TOTAL_BYTES) {
      entry.contentBase64 = content.toString('base64');
      entry.stored = true;
      used += content.length;
    }
    out.push(entry);
  }
  return out;
}

// The API shape. Never returns contentBase64 in a listing — a list of 50 messages should not
// carry megabytes of base64, and the previewer only needs the bytes of the message it opens.
function toMessage(row, { includeAttachmentData = false } = {}) {
  if (!row) return null;
  const attachments = parseJson(row.attachments_json, []).map((a) => ({
    filename: a.filename,
    contentType: a.contentType,
    bytes: a.bytes,
    stored: !!a.stored,
    ...(includeAttachmentData && a.contentBase64 ? { contentBase64: a.contentBase64 } : {}),
  }));
  return {
    id: row.id,
    prospectId: row.prospect_id ?? null,
    prospectName: row.prospect_name || null,
    to: String(row.to_address || '').split(',').map((s) => s.trim()).filter(Boolean),
    from: row.from_address || '',
    replyTo: row.reply_to || '',
    subject: row.subject || '',
    text: row.text_body || '',
    html: row.html_body || '',
    attachments,
    headers: parseJson(row.headers_json, {}),
    createdAt: row.created_at,
    // Convenience for the list pane: the strongest signal of what the row actually is.
    isLocalSink: parseJson(row.headers_json, {})['X-Pulse-Transport'] === 'local-sink',
  };
}

function insert({ prospectId = null, to, from, replyTo = '', subject, text = '', html = '', attachments = [], headers = {} } = {}) {
  const recipients = (Array.isArray(to) ? to : [to]).map((t) => String(t ?? '').trim()).filter(Boolean);
  if (!recipients.length) throw new Error('outbox insert needs at least one recipient');
  const info = db.prepare(`
    INSERT INTO outbox (prospect_id, to_address, from_address, reply_to, subject, text_body, html_body, attachments_json, headers_json)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    prospectId === null || prospectId === undefined ? null : Number(prospectId),
    recipients.join(', '),
    String(from || ''),
    String(replyTo || ''),
    String(subject || ''),
    String(text || ''),
    String(html || ''),
    JSON.stringify(serializeAttachments(attachments)),
    JSON.stringify(headers || {}),
  );
  return get(info.lastInsertRowid);
}

const SELECT_ONE = `
  SELECT o.*, p.name AS prospect_name
  FROM outbox o
  LEFT JOIN prospects p ON p.id = o.prospect_id
`;

const get = (id) => toMessage(db.prepare(`${SELECT_ONE} WHERE o.id = ?`).get(Number(id)), { includeAttachmentData: true });

const escapeLike = (s) => String(s).replace(/[\\%_]/g, (m) => `\\${m}`);

// Newest first, with an optional substring search across the fields an agent would search by.
function list({ limit = 50, offset = 0, q = '' } = {}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  const term = String(q || '').trim();
  // Attachment filenames are searched too: "the quote I sent" is as likely to be remembered
  // as a file name as it is as a subject line, and it costs nothing on a local ledger.
  const where = term
    ? `WHERE (o.subject LIKE ? ESCAPE '\\' OR o.to_address LIKE ? ESCAPE '\\' OR o.from_address LIKE ? ESCAPE '\\' OR o.text_body LIKE ? ESCAPE '\\'
             OR o.attachments_json LIKE ? ESCAPE '\\' OR IFNULL(p.name, '') LIKE ? ESCAPE '\\')`
    : '';
  const args = term ? Array.from({ length: 6 }, () => `%${escapeLike(term)}%`) : [];
  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM outbox o LEFT JOIN prospects p ON p.id = o.prospect_id ${where}
  `).get(...args).n;
  const rows = db.prepare(`${SELECT_ONE} ${where} ORDER BY o.id DESC LIMIT ? OFFSET ?`).all(...args, lim, off);
  return { messages: rows.map((r) => toMessage(r)), total, limit: lim, offset: off, query: term };
}

// The raw attachment payload, decoded on demand for the download endpoint.
function attachmentBuffer(id, index) {
  const row = db.prepare('SELECT attachments_json FROM outbox WHERE id = ?').get(Number(id));
  if (!row) return null;
  const a = parseJson(row.attachments_json, [])[Number(index)];
  if (!a || !a.contentBase64) return null;
  return { filename: a.filename, contentType: a.contentType, content: Buffer.from(a.contentBase64, 'base64') };
}

const remove = (id) => db.prepare('DELETE FROM outbox WHERE id = ?').run(Number(id)).changes;
const clear = () => db.prepare('DELETE FROM outbox').run().changes;
const count = () => db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n;

module.exports = {
  insert, get, list, remove, clear, count, attachmentBuffer,
  serializeAttachments, toMessage, MAX_STORED_ATTACHMENT_BYTES, MAX_STORED_TOTAL_BYTES,
};
