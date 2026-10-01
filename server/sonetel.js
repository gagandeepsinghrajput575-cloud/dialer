// Minimal Sonetel client (OAuth2 password grant + callback API).
// Endpoints/credentials taken from Sonetel's official docs and Python SDK.
const { getSetting } = require('./db');

const AUTH_URL = 'https://api.sonetel.com/SonetelAuth/beta/oauth/token';
const CALLBACK_URL = 'https://public-api.sonetel.com/make-calls/call/call-back';
const BASIC = 'Basic ' + Buffer.from('sonetel-api:sonetel-api').toString('base64');

let cache = { token: null, exp: 0, user: null };

function creds() {
  return {
    username: process.env.SONETEL_USERNAME || getSetting('sonetel_username'),
    password: process.env.SONETEL_PASSWORD || getSetting('sonetel_password'),
  };
}

function jwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return (payload.exp || 0) * 1000;
  } catch {
    return Date.now() + 30 * 60 * 1000;
  }
}

async function getToken(force = false) {
  const { username, password } = creds();
  if (!username || !password) throw new Error('Sonetel username/password not set. Add them in Settings.');
  if (!force && cache.token && cache.user === username && Date.now() < cache.exp - 60_000) return cache.token;

  const body = new URLSearchParams({ grant_type: 'password', refresh: 'yes', username, password });
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { Authorization: BASIC, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok || !json.access_token) {
    throw new Error(`Sonetel login failed (${res.status}). Check your email/password. ${json.error_description || json.message || ''}`.trim());
  }
  cache = { token: json.access_token, exp: jwtExp(json.access_token), user: username };
  return cache.token;
}

async function callback({ call1, call2, show1 = 'automatic', show2 = 'automatic' }) {
  const attempt = async (token) =>
    fetch(CALLBACK_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ app_id: 'pulsedialer-1.0', call1, call2, show_1: show1, show_2: show2 }),
    });
  let res = await attempt(await getToken());
  if (res.status === 401) res = await attempt(await getToken(true));
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) {
    throw new Error(`Sonetel rejected the call (${res.status}): ${json.message || json.error || text.slice(0, 200)}`);
  }
  return { session_id: json.response && json.response.session_id, raw: json };
}

module.exports = { getToken, callback };
