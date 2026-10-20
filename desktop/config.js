// Carrier constants and OS-handoff helpers. No Electron imports here: this module is shared by
// the main process, the renderer facade and the server descriptor, and must stay testable on CI.
const CARRIER = Object.freeze({
  provider: 'telnyx',
  domain: 'sip.telnyx.com',
  port: 5060,
  transport: 'udp',
  user: 'usertanishkarajput43011498',
  did: '+4532331610',
  displayDid: '+45 32 33 16 10',
});

const RUNTIME = 'darwin-coreaudio-native';

const sipUri = (phone) => `sip:${String(phone || '').trim()}@${CARRIER.domain}`;
const telUri = (phone) => `tel:${String(phone || '').trim()}`;
const forwardingUri = (user = CARRIER.user, host = CARRIER.domain) => `sip:${user}@${host}:${CARRIER.port}`;

// pulse://dial?number=%2B4520123456 — the OS protocol handler, menu-bar dial and deep links
// all land here. Anything that is not an explicit, well-formed dial is ignored.
function parseDeepLink(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return null; }
  if (parsed.protocol !== 'pulse:') return null;
  const action = (parsed.hostname || parsed.pathname.replace(/^\/+/, '')).toLowerCase();
  if (action !== 'dial') return null;
  const phone = String(parsed.searchParams.get('number') || '').trim();
  if (!/^\+?[0-9*#]{3,20}$/.test(phone)) return null;
  return { action: 'dial', phone };
}

module.exports = { CARRIER, RUNTIME, sipUri, telUri, forwardingUri, parseDeepLink };
