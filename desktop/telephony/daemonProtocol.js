// The control dialect of a headless Linphone (`linphone-daemon` / `linphonec`).
//
// Pure functions only: this module turns intent into command lines and daemon chatter into
// normalised events. Choosing a binary, spawning it and restarting it is the supervisor's job.
// Keeping the dialect here is what makes an in-app CoreAudio engine testable on CI.

const DTMF = /^[0-9*#A-D]$/i;
const USER_PART = /sip(?:s)?:([^@>;\s]+)/i;

const proxyFor = (domain) => `sip:${String(domain || '').replace(/^sips?:/i, '').replace(/^\/+|\/+$/g, '')}`;

// `register sip:user@domain sip:domain <secret>` — the credential goes to stdin only.
function buildRegistration({ user, domain, password }) {
  const host = String(domain || '').replace(/^sips?:/i, '').replace(/:\d+$/, '');
  return [`register sip:${user}@${host} ${proxyFor(host)} ${password}`];
}

function buildCall(phone, domain) {
  const target = String(phone || '').trim();
  if (!target) return null;
  if (/^sips?:/i.test(target)) return `call ${target}`;
  return `call sip:${target}@${String(domain || '').replace(/^sips?:/i, '')}`;
}

const buildAnswer = (callId) => `answer ${Number(callId)}`;
const buildTerminate = (callId) => `terminate ${Number(callId)}`;
const buildMute = (on = true) => (on ? 'mute' : 'unmute');

function buildDtmf(digit) {
  const value = String(digit || '').toUpperCase();
  return DTMF.test(value) ? `dtmf ${value}` : null;
}

// Command lines are logged; the registration line is not.
const redact = (line) => String(line || '')
  .replace(/^(register\s+\S+\s+\S+)\s+.*$/i, '$1 ••••••')
  .replace(/(password[=:]\s*)\S+/gi, '$1••••••');

const peerFrom = (raw) => {
  const match = USER_PART.exec(String(raw || ''));
  return match ? match[1] : String(raw || '').replace(/^"|"$/g, '');
};

// linphonec and linphone-daemon disagree on wording between versions, so every rule here
// accepts both the "state changed to X" and the "with ... is X" families. Anything that is
// neither is chatter and returns null — the supervisor must never invent a call event.
function parseDaemonLine(line) {
  const text = String(line || '').trim();
  if (!text) return null;

  let match = /^linphonec\s*[>:]/i.exec(text);
  if (match) return { type: 'prompt', raw: text };

  match = /receiving new incoming call from\s+"?([^",]+)"?,?\s+assigned id\s+(\d+)/i.exec(text);
  if (match) return { type: 'incoming', peer: peerFrom(match[1]), callId: Number(match[2]), raw: text };

  match = /call\s+(\d+)\s+with\s+"([^"]+)"\s+is\s+ringing/i.exec(text);
  if (match) return { type: 'ringing', callId: Number(match[1]), peer: peerFrom(match[2]), raw: text };

  match = /call\s+(\d+)\s*(?:with\s+"[^"]*"\s*)?(?:is\s+)?connected/i.exec(text)
    || /call\s+(\d+)\s*:\s*state changed to\s+connected/i.exec(text);
  if (match) return { type: 'answered', callId: Number(match[1]), raw: text };

  match = /call\s+(\d+)\s*(?:with\s+"[^"]*"\s*)?(?:is\s+)?ended/i.exec(text)
    || /call\s+(\d+)\s*:\s*state changed to\s+end\b/i.exec(text);
  if (match) {
    const reason = /declined/i.test(text) ? 'declined' : /busy/i.test(text) ? 'busy' : /terminated|hang ?up|remote/i.test(text) ? 'remote' : 'ended';
    return { type: 'ended', callId: Number(match[1]), reason, raw: text };
  }

  match = /call\s+(\d+).*?(?:declined|busy here)/i.exec(text);
  if (match) return { type: 'ended', callId: Number(match[1]), reason: 'declined', raw: text };

  match = /registration on proxy\s+\S+\s+(successful|succeeded|failed|error)/i.exec(text);
  if (match) return { type: 'registration', state: /^success/i.test(match[1]) ? 'registered' : 'failed', raw: text };

  return null;
}

module.exports = {
  buildRegistration, buildCall, buildAnswer, buildTerminate, buildDtmf, buildMute, parseDaemonLine, redact,
};
