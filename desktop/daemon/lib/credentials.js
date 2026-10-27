// The daemon fetches its SIP account with a capability that never reaches the renderer.
'use strict';

const DEFAULT_TIMEOUT_MS = 4000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(base, path, token, timeoutMs = DEFAULT_TIMEOUT_MS, daemonToken = '') {
  const url = `${String(base).replace(/\/+$/, '')}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        ...(token ? { 'x-pulse-token': token } : {}),
        ...(daemonToken ? { 'x-pulse-daemon-token': daemonToken } : {}),
        accept: 'application/json',
      },
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
    if (!res.ok) {
      const error = new Error(json?.error || `${res.status} ${res.statusText} from ${path}`);
      error.status = res.status;
      throw error;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function load(apiBase) {
  if (!apiBase) throw new Error('No API base URL — pass --api-base or PULSE_API_BASE.');
  const daemonToken = String(process.env.PULSE_DAEMON_TOKEN || '');
  if (!daemonToken) throw new Error('No desktop supervisor capability token; use the desktop app to fetch SIP credentials.');
  const session = await getJson(apiBase, '/api/session', '');
  const token = session?.token;
  if (!token) throw new Error('The API did not hand out a session token.');

  // The desktop supervisor publishes its capability in the heartbeat just before spawning us.
  // On a cold start this first request can race that beat; retry only its temporary 401.
  let credentials;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      credentials = await getJson(apiBase, '/api/telephony/carrier-credentials', token, DEFAULT_TIMEOUT_MS, daemonToken);
      break;
    } catch (e) {
      if (e.status !== 401 || attempt === 29) throw e;
      await sleep(200);
    }
  }
  if (!credentials?.configured) {
    const missing = (credentials?.missing || []).join(', ') || 'credentials';
    throw new Error(`No carrier SIP account is configured yet (missing: ${missing}).`);
  }
  return { token, credentials };
}

module.exports = { load, getJson, DEFAULT_TIMEOUT_MS };
