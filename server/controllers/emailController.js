// Email endpoints: verify an address, stage attachments, send, and report SMTP readiness.
//
// Attachments are staged in memory under a random token and expire, so a half-composed
// email cannot pin megabytes forever and a token from yesterday cannot be replayed.
const crypto = require('crypto');
const emailService = require('../services/emailService');
const prospectRepo = require('../repositories/prospectRepo');
const noteRepo = require('../repositories/noteRepo');
const outboxRepo = require('../repositories/outboxRepo');
const settingsRepo = require('../repositories/settingsRepo');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');


const MAX_ATTACHMENTS = 5;
const MAX_EACH_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_TTL_MS = 15 * 60 * 1000;

/** @type {Map<string,{filename:string,contentType:string,content:Buffer,createdAt:number}>} */
const staged = new Map();

function sweep(now = Date.now()) {
  for (const [id, a] of staged) if (now - a.createdAt > ATTACHMENT_TTL_MS) staged.delete(id);
}
setInterval(sweep, 60_000).unref?.();

const status = asyncHandler(async (req, res) => {
  sweep();
  const cfg = emailService.smtpConfig();
  res.json({
    configured: cfg.configured,
    host: cfg.host, port: cfg.port, secure: cfg.secure, from: cfg.from,
    // The composer and Settings both branch on this: "configured" alone cannot distinguish a
    // real mail account from the on-disk sink, and the two must never be worded the same.
    localSink: cfg.isLocalSink,
    outboxCount: outboxRepo.count(),
    missing: cfg.isLocalSink ? [] : ['host', 'user', 'pass'].filter((k) => !cfg[k]),
    deepVerify: String(settingsRepo.get('email_verify_deep')) === '1',
    meetLink: String(settingsRepo.get('meet_link') || ''),
    stagedAttachments: staged.size,
  });
});

const verifyOne = asyncHandler(async (req, res) => {
  const email = String(req.body?.email ?? '');
  const deep = req.body?.deep === undefined
    ? String(settingsRepo.get('email_verify_deep')) === '1'
    : Boolean(req.body.deep);
  res.json(await emailService.verify(email, { deep, from: emailService.smtpConfig().from }));
});

// Batch verify, e.g. straight after an import so a bad column is obvious immediately.
const verifyBatch = asyncHandler(async (req, res) => {
  const emails = Array.isArray(req.body?.emails) ? req.body.emails.slice(0, 500).map(String) : [];
  if (!emails.length) throw ApiError.badRequest('No email addresses given.');
  const results = await emailService.verifyMany(emails);
  const summary = { valid: 0, risky: 0, invalid: 0 };
  for (const r of results) summary[r.level] = (summary[r.level] || 0) + 1;
  res.json({ results, summary, checked: results.length });
});

const stageAttachment = asyncHandler(async (req, res) => {
  sweep();
  const file = req.file;
  if (!file) throw ApiError.badRequest('No file received.');
  if (file.size > MAX_EACH_BYTES) {
    throw ApiError.badRequest(`"${file.originalname}" is ${Math.round(file.size / 1048576)} MB — the limit is 10 MB.`);
  }
  const live = [...staged.values()].length;
  if (live >= MAX_ATTACHMENTS) throw ApiError.badRequest(`At most ${MAX_ATTACHMENTS} attachments per email.`);
  const id = crypto.randomBytes(12).toString('hex');
  staged.set(id, {
    filename: String(file.originalname || 'attachment').slice(0, 200),
    contentType: file.mimetype || 'application/octet-stream',
    content: file.buffer,
    createdAt: Date.now(),
  });
  res.json({ id, filename: String(file.originalname), bytes: file.size, contentType: file.mimetype });
});

const listAttachments = asyncHandler(async (req, res) => {
  sweep();
  res.json({
    attachments: [...staged.entries()].map(([id, a]) => ({
      id, filename: a.filename, bytes: a.content.length, contentType: a.contentType,
      expiresInSeconds: Math.max(0, Math.round((ATTACHMENT_TTL_MS - (Date.now() - a.createdAt)) / 1000)),
    })),
  });
});

const dropAttachment = asyncHandler(async (req, res) => {
  const existed = staged.delete(String(req.params.id || ''));
  if (!existed) throw ApiError.notFound('No staged attachment with that id (it may have expired).');
  res.json({ ok: true });
});

// Compose a draft for a prospect: the follow-up template with every placeholder filled in,
// plus the meeting link if one is configured.
const draftFor = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const prospect = prospectRepo.get(id);
  if (!prospect) throw ApiError.notFound('Prospect not found');
  const followUp = require('../services/followUpService');
  const draft = followUp.renderEmail(id, { noteText: req.body?.noteText, at: req.body?.at });
  const meetLink = String(settingsRepo.get('meet_link') || '');
  // The template may already place the link via {{meet_link}}. Only append it when the
  // rendered body does not contain it, so the link never shows up twice.
  const body = meetLink && !draft.body.includes(meetLink)
    ? `${draft.body}\n\nMødelink: ${meetLink}`
    : draft.body;
  const notes = noteRepo.listByProspect(id).slice(0, 3).map((n) => n.body);
  res.json({
    to: draft.to, subject: draft.subject, body,
    prospect: { id: prospect.id, name: prospect.name, email: prospect.email, company: prospect.company },
    verification: prospect.email ? await emailService.verify(prospect.email) : null,
    meetLink, recentNotes: notes, followUpAt: draft.followUpAt, placeholders: draft.placeholders,
    smtpConfigured: emailService.smtpConfig().configured,
  });
});

const send = asyncHandler(async (req, res) => {
  sweep();
  const b = req.body || {};
  const to = Array.isArray(b.to) ? b.to : String(b.to || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!to.length) throw ApiError.badRequest('No recipient given.');

  // Refuse to fire off to an address we already know is dead — that is how a domain gets
  // your sending reputation flagged. `force: true` overrides after a warning.
  if (!b.force) {
    for (const addr of to) {
      const v = await emailService.verify(addr);
      if (!v.ok) {
        throw ApiError.badRequest(`"${addr}" will not receive mail: ${v.reasons[0]}`, [{ field: 'to', issue: v.level }]);
      }
    }
  }

  const wanted = (Array.isArray(b.attachments) ? b.attachments : []).slice(0, MAX_ATTACHMENTS);
  const attachments = [];
  const missing = [];
  for (const id of wanted) {
    const a = staged.get(String(id));
    if (!a) { missing.push(String(id)); continue; }
    attachments.push({ filename: a.filename, content: a.content, contentType: a.contentType });
  }
  if (missing.length) throw ApiError.badRequest('One or more attachments expired — please attach them again.');

  const result = await emailService.send({
    to, subject: b.subject, text: b.body, html: b.html, attachments,
    replyTo: b.replyTo || settingsRepo.get('smtp_reply_to') || undefined,
    // In local sink mode this is what links the captured message back to its prospect, so the
    // previewer can offer "open prospect" instead of showing a bare address.
    prospectId: b.prospectId ? Number(b.prospectId) : null,
  });

  // Sent mail belongs in the prospect's history, next to the call notes.
  if (b.prospectId) {
    const pid = Number(b.prospectId);
    if (prospectRepo.get(pid)) {
      const note = noteRepo.logEmail(pid, {
        subject: b.subject,
        recipients: to,
        attachmentCount: attachments.length,
      });
      result.loggedAsNote = true;
      result.noteId = note?.id ?? null;
    }
  }
  for (const id of wanted) staged.delete(String(id));   // consumed
  res.json(result);
});

const testConnection = asyncHandler(async (req, res) => {
  const r = await emailService.sendTest();
  // In sink mode the "connection" that was just verified is the outbox itself, so hand back
  // how much is in it — that is what the Settings button counts.
  res.json(r.local ? { ...r, outboxCount: outboxRepo.count() } : r);
});

// ---------------------------------------------------------------- local outbox
const outboxList = asyncHandler(async (req, res) => {
  const { limit, offset, q } = req.query;
  res.json(outboxRepo.list({ limit, offset, q }));
});

const outboxGet = asyncHandler(async (req, res) => {
  const msg = outboxRepo.get(req.params.id);
  if (!msg) throw ApiError.notFound('No captured message with that id');
  res.json(msg);
});

const outboxDelete = asyncHandler(async (req, res) => {
  const changes = outboxRepo.remove(req.params.id);
  if (!changes) throw ApiError.notFound('No captured message with that id');
  res.json({ ok: true, deleted: changes, total: outboxRepo.count() });
});

const outboxClear = asyncHandler(async (req, res) => {
  const deleted = outboxRepo.clear();
  res.json({ ok: true, deleted, total: 0 });
});

// One attachment, decoded from the ledger. Rendered inline for images (so the previewer can
// show them) and as a download for everything else.
const outboxAttachment = asyncHandler(async (req, res) => {
  const found = outboxRepo.attachmentBuffer(req.params.id, req.params.index);
  if (!found) throw ApiError.notFound('That attachment is not stored for this message');
  const safeName = emailService.sanitizeHeader(found.filename, 200).replace(/["\\]/g, '') || 'attachment';
  // Images render inline so the previewer can show them; ?download=1 forces the browser to
  // save instead, which is what the badge's download button asks for.
  const inline = !(req.query?.download === '1') && /^image\//.test(found.contentType || '');
  res.setHeader('Content-Type', found.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`);
  res.setHeader('Content-Length', String(found.content.length));
  res.send(found.content);
});

module.exports = {
  status, verifyOne, verifyBatch, stageAttachment, listAttachments, dropAttachment, draftFor, send, testConnection,
  outboxList, outboxGet, outboxDelete, outboxClear, outboxAttachment,
  _staged: staged, _sweep: sweep, MAX_ATTACHMENTS, MAX_EACH_BYTES,
};
