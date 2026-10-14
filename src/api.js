// The server hands the app a random session token over the same trusted channel and
// expects it back on every write. A page on another site can never read it.
let sessionToken = '';
let tokenLoad = null;

function loadToken() {
  if (sessionToken) return Promise.resolve(sessionToken);
  if (!tokenLoad) {
    tokenLoad = fetch('/api/session')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { sessionToken = (j && j.token) || ''; return sessionToken; })
      .catch(() => '')
      .finally(() => { tokenLoad = null; });
  }
  return tokenLoad;
}

function toFetchSignal(sig) {
  if (!sig) return undefined;
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) {
    return undefined;
  }
  return sig;
}

async function req(method, url, body, isForm, retried, signal) {
  await loadToken();
  const headers = {};
  if (body && !isForm) headers['Content-Type'] = 'application/json';
  if (sessionToken) headers['x-pulse-token'] = sessionToken;
  headers['x-requested-with'] = 'pulse-dialer';
  const res = await fetch(url, {
    method,
    headers,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    signal: toFetchSignal(signal),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  // The server restarted and rotated its token — refetch once and replay the write.
  if (res.status === 401 && !retried) {
    sessionToken = '';
    await loadToken();
    return req(method, url, body, isForm, true, signal);
  }
  if (!res.ok) {
    const err = new Error((data && (data.error || data.message)) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}
export const api = {
  prospects: () => req('GET', '/api/prospects'),
  prospect: (id) => req('GET', `/api/prospects/${id}`),
  addProspect: (b) => req('POST', '/api/prospects', b),
  updateProspect: (id, b) => req('PATCH', `/api/prospects/${id}`, b),
  deleteProspect: (id) => req('DELETE', `/api/prospects/${id}`),
  clearProspects: () => req('POST', '/api/prospects/clear', {}),
  parseFile: (file) => { const f = new FormData(); f.append('file', file); return req('POST', '/api/import/parse', f, true); },
  aiAnalyzeLead: (b) => req('POST', '/api/import/ai-analyze', b),
  bulk: (b) => req('POST', '/api/prospects/bulk', b),
  batchPronounce: (b) => req('POST', '/api/prospects/pronunciations/batch', b || {}),
  // Multi-select actions from the prospects table. Both are atomic server-side, and both
  // answer with what was actually changed rather than what was asked for.
  bulkStage: (ids, stage) => req('POST', '/api/prospects/bulk-stage', { ids, stage }),
  bulkDelete: (ids) => req('POST', '/api/prospects/bulk-delete', { ids }),
  addNote: (id, body) => req('POST', `/api/prospects/${id}/notes`, { body }),
  deleteNote: (id) => req('DELETE', `/api/notes/${id}`),
  call: (id) => req('POST', `/api/prospects/${id}/call`, { tzOffset: new Date().getTimezoneOffset() }),
  logCall: (id, b) => req('PATCH', `/api/calls/${id}`, b),
  // The browser softphone received an INVITE: match the caller to a prospect (or provision a
  // placeholder lead) and open the ledger row the call will be classified against.
  inboundCall: (b) => req('POST', '/api/calls/inbound', b),
  // A ring that ended unanswered — the caller hung up, or the agent declined.
  missCall: (id, b) => req('POST', `/api/calls/${id}/missed`, b || {}),
  discardCall: (id) => req('POST', `/api/calls/${id}/discard`, {}),
  stats: () => req('GET', `/api/stats?tzOffset=${new Date().getTimezoneOffset()}`),
  exportProspectsUrl: () => '/api/prospects/export',
  settings: () => req('GET', '/api/settings'),
  saveSettings: (b) => req('PUT', '/api/settings', b),
  testSoftphone: (b) => req('POST', '/api/settings/test-softphone', b || {}),
  demo: () => req('POST', '/api/demo', {}),

  // ---- Phase A: queue intelligence, voicemail drop, copilot, follow-ups, ops ----
  queue: (opts = 'all', q = '') => {
    if (typeof opts === 'string') {
      return req('GET', `/api/queue?tab=${encodeURIComponent(opts)}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
    }
    const { tab = 'all', q: query = '', limit = 50, cursor = null, signal } = opts || {};
    const params = new URLSearchParams();
    if (tab) params.set('tab', tab);
    if (query) params.set('q', query);
    if (limit) params.set('limit', String(limit));
    if (cursor) params.set('cursor', String(cursor));
    return req('GET', `/api/queue?${params.toString()}`, null, false, false, signal);
  },
  searchProspects: (q, limit = 25) => req('GET', `/api/prospects/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  followUps: () => req('GET', '/api/prospects/follow-ups'),
  voicemailDrop: (id, b) => req('POST', `/api/calls/${id}/voicemail-drop`, b || {}),
  summarizeCall: (id) => req('POST', `/api/calls/${id}/summary`, {}),
  businessHours: () => req('GET', '/api/telephony/business-hours'),
  // Credentials for the in-browser softphone. Token-gated like everything else, and the
  // server only releases the SIP password when the operator turned the handoff on.
  webrtcSession: () => req('GET', '/api/telephony/webrtc-session'),
  callerIds: () => req('GET', '/api/telephony/caller-ids'),
  voicemailGreeting: () => req('GET', '/api/telephony/voicemail-greeting'),
  uploadGreeting: (file) => { const f = new FormData(); f.append('file', file); return req('POST', '/api/telephony/voicemail-greeting', f, true); },
  greetingUrl: () => '/api/telephony/voicemail-greeting/file',
  scheduleFollowUp: (id, at) => req('POST', `/api/telephony/prospects/${id}/follow-up`, { at }),
  followUpEmail: (id, b) => req('POST', `/api/telephony/prospects/${id}/follow-up-email`, b || {}),
  health: () => req('GET', '/api/health'),
  // ---- email: verify, draft, attach, send ----
  emailStatus: () => req('GET', '/api/email/status'),
  verifyEmail: (email, deep) => req('POST', '/api/email/verify', { email, ...(deep === undefined ? {} : { deep }) }),
  verifyEmails: (emails) => req('POST', '/api/email/verify-batch', { emails }),
  emailDraft: (id, b) => req('POST', `/api/email/prospects/${id}/draft`, b || {}),
  emailAttachments: () => req('GET', '/api/email/attachments'),
  attachFile: (file) => { const f = new FormData(); f.append('file', file); return req('POST', '/api/email/attachments', f, true); },
  dropAttachment: (id) => req('DELETE', `/api/email/attachments/${id}`),
  sendEmail: (b) => req('POST', '/api/email/send', b),
  // Local catch-all outbox: the ledger of everything the sandbox sink captured.
  getOutbox: (opts = {}) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    if (opts.q) params.set('q', String(opts.q));
    const qs = params.toString();
    return req('GET', `/api/email/outbox${qs ? `?${qs}` : ''}`);
  },
  getOutboxMessage: (id) => req('GET', `/api/email/outbox/${id}`),
  deleteOutboxMessage: (id) => req('DELETE', `/api/email/outbox/${id}`),
  clearOutbox: () => req('DELETE', '/api/email/outbox'),
  // A plain URL, for an <a download> that cannot carry the token header (same pattern as the
  // voicemail greeting). Reads are same-origin, so this is not a way around the CSRF guard.
  outboxAttachmentUrl: (id, index) => `/api/email/outbox/${id}/attachments/${index}`,
  outboxAttachmentDownloadUrl: (id, index) => `/api/email/outbox/${id}/attachments/${index}?download=1`,
  testSmtp: () => req('POST', '/api/email/test', {}),

  backups: () => req('GET', '/api/settings/backups'),
  createBackup: (reason = 'manual') => req('POST', '/api/settings/backups', { reason }),
  backupDownloadUrl: (file) => `/api/settings/backups/${encodeURIComponent(file)}`,
  exportJsonUrl: () => '/api/prospects/export?format=json',

  // ---- In-Browser Web Audio Recordings (Zero Extra Charges) ----
  recordings: (opts = {}) => {
    const { search = '', outcome = '', direction = '', limit = 50, offset = 0 } = opts;
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (outcome) params.set('outcome', outcome);
    if (direction) params.set('direction', direction);
    if (limit) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    return req('GET', `/api/recordings?${params.toString()}`);
  },
  uploadRecording: (callId, blob, durationSec = 0) => {
    const form = new FormData();
    form.append('audio', blob, `call-${callId}.webm`);
    form.append('duration_sec', String(Math.round(durationSec)));
    return req('POST', `/api/recordings/${callId}`, form, true);
  },
  deleteRecording: (callId) => req('DELETE', `/api/recordings/${callId}`),
  demoRecordings: () => req('POST', '/api/recordings/demo', {}),
  recordingAudioUrl: (callId) => `/api/recordings/${callId}/audio`,
  recordingChats: (callId) => req('GET', `/api/recordings/${callId}/chats`),
  createRecordingChat: (callId, title) => req('POST', `/api/recordings/${callId}/chats`, { title }),
  getRecordingChat: (callId, chatId) => req('GET', `/api/recordings/${callId}/chats/${chatId}`),
  deleteRecordingChat: (callId, chatId) => req('DELETE', `/api/recordings/${callId}/chats/${chatId}`),
  recordingAiChat: (callId, body) => req('POST', `/api/recordings/${callId}/ai-chat`, body),
  getRecordingScript: () => req('GET', '/api/recordings/script'),
  updateRecordingScript: (script) => req('PUT', '/api/recordings/script', { script }),

  // ---- FlyNumber Copenhagen Inbound DID (+45 32 33 16 10) ----
  flynumber: () => req('GET', '/api/telephony/flynumber'),
  saveFlynumber: (data) => req('POST', '/api/telephony/flynumber', data),
};
