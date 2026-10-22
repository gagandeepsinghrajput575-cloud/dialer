// Credential fetch: the daemon pulls its own SIP account from the local API.
//
// The SIP secret is deliberately *not* routed through the renderer. The browser only learns
// that a native engine exists; the daemon — a local process on the same machine — authenticates
// with the session token from GET /api/session and reads GET /api/telephony/carrier-credentials.
// That keeps the existing rule ("this secret never reaches the browser") true in native mode.
'use strict';

const DEFAULT_TIMEOUT_MS = 4000;

async function getJson(base, path, token, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const url = `${String(base).replace(/\/+$/, '')}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { ...(token ? { 'x-pulse-token': token } : {}), accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
    if (!res.ok) throw new Error(json?.error || `${res.status} ${res.statusText} from ${path}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} apiBase e.g. http://127.0.0.1:3001
 * @returns {Promise<{token:string, credentials:object}>}
 */
async function load(apiBase) {
  if (!apiBase) throw new Error('No API base URL — pass --api-base or PULSE_API_BASE.');
  const session = await getJson(apiBase, '/api/session', '');
  const token = session?.token;
  if (!token) throw new Error('The API did not hand out a session token.');
  const credentials = await getJson(apiBase, '/api/telephony/carrier-credentials', token);
  if (!credentials?.configured) {
    const missing = (credentials?.missing || []).join(', ') || 'credentials';
    throw new Error(`No carrier SIP account is configured yet (missing: ${missing}).`);
  }
  return { token, credentials };
}

module.exports = { load, getJson, DEFAULT_TIMEOUT_MS };
