import { buildQueueQuery } from './queue.js';

// The server refuses mutating requests that do not carry this header. A
// cross-origin page cannot set it without triggering a CORS preflight, which the
// server declines — that is what stops a malicious website from driving the API.
const CSRF_HEADER = { 'X-Requested-With': 'pulse-dialer' };
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function req(method, url, body, isForm, opts) {
  const headers = { ...(MUTATING.has(method) ? CSRF_HEADER : {}) };
  if (body && !isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    signal: opts?.signal,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error((data && (data.error || data.message)) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}
export const api = {
  prospects: () => req('GET', '/api/prospects'),
  /** Server-backed, cursor-paginated dialer queue. See GET /api/queue. */
  queue: ({ tab = 'all', q = '', limit, cursor = null, signal } = {}) =>
    req('GET', `/api/queue?${buildQueueQuery({ tab, q, limit, cursor })}`, null, false, { signal }),
  prospect: (id) => req('GET', `/api/prospects/${id}`),
  addProspect: (b) => req('POST', '/api/prospects', b),
  updateProspect: (id, b) => req('PATCH', `/api/prospects/${id}`, b),
  deleteProspect: (id) => req('DELETE', `/api/prospects/${id}`),
  clearProspects: () => req('POST', '/api/prospects/clear', {}),
  parseFile: (file) => { const f = new FormData(); f.append('file', file); return req('POST', '/api/import/parse', f, true); },
  bulk: (b) => req('POST', '/api/prospects/bulk', b),
  addNote: (id, body) => req('POST', `/api/prospects/${id}/notes`, { body }),
  deleteNote: (id) => req('DELETE', `/api/notes/${id}`),
  call: (id) => req('POST', `/api/prospects/${id}/call`, { tzOffset: new Date().getTimezoneOffset() }),
  logCall: (id, b) => req('PATCH', `/api/calls/${id}`, b),
  discardCall: (id) => req('POST', `/api/calls/${id}/discard`, {}),
  stats: () => req('GET', `/api/stats?tzOffset=${new Date().getTimezoneOffset()}`),
  exportProspectsUrl: () => '/api/prospects/export',
  settings: () => req('GET', '/api/settings'),
  saveSettings: (b) => req('PUT', '/api/settings', b),
  testSettings: () => req('POST', '/api/settings/test', {}),
  demo: () => req('POST', '/api/demo', {}),
};
