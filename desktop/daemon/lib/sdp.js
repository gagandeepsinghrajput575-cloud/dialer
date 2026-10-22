// SDP for a single G.711 audio stream, plus RFC 2833 telephone-event for DTMF.
//
// Deliberately tiny: one m= line, one codec family the whole PSTN understands, and the
// offer/answer rules that matter for a trunk (honour the peer's payload numbers, keep the
// session sendrecv, and never claim a codec we cannot encode).
'use strict';

const PT_PCMU = 0;
const PT_PCMA = 8;
const PT_DTMF = 101;
const RATE = 8000;

// Payload type -> { name, encode, decode } is resolved in g711.js; SDP only names them.
const CODECS = [
  { pt: PT_PCMU, name: 'PCMU', rate: RATE },
  { pt: PT_PCMA, name: 'PCMA', rate: RATE },
];

const DTMF_EVENTS = '0-16';

/**
 * Build our offer/answer body.
 * @param {object} o { ip, port, sessionId, payloadTypes }
 */
function build({ ip, port, sessionId, payloadTypes = [PT_PCMU, PT_PCMA] }) {
  const id = sessionId || Math.floor(Date.now() / 1000);
  const audioPts = payloadTypes.filter((pt) => pt !== PT_DTMF);
  const lines = [
    'v=0',
    `o=pulse-sip ${id} ${id} IN IP4 ${ip}`,
    's=Pulse Dialer',
    `c=IN IP4 ${ip}`,
    't=0 0',
    `m=audio ${port} RTP/AVP ${[...audioPts, PT_DTMF].join(' ')}`,
    ...audioPts.map((pt) => `a=rtpmap:${pt} ${nameOf(pt)}/${RATE}`),
    `a=rtpmap:${PT_DTMF} telephone-event/${RATE}`,
    `a=fmtp:${PT_DTMF} ${DTMF_EVENTS}`,
    'a=ptime:20',
    'a=sendrecv',
  ];
  // A media-less answer (port 0) must not advertise payloads.
  if (!port) return lines.slice(0, 5).concat(['m=audio 0 RTP/AVP 0']).join('\r\n') + '\r\n';
  return lines.join('\r\n') + '\r\n';
}

const nameOf = (pt) => (pt === PT_PCMA ? 'PCMA' : 'PCMU');

/**
 * Parse a remote SDP body into what the media path needs.
 * @returns {object} { ip, port, payloadTypes, dtmfPt, codecs, direction, raw }
 */
function parse(body) {
  const raw = String(body || '');
  const out = {
    ip: '', port: 0, payloadTypes: [], dtmfPt: 0, codecs: [], direction: 'sendrecv', raw,
    sessionId: '',
  };
  if (!raw.trim()) return out;
  let inAudio = false;
  for (const line of raw.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const type = line[0];
    const value = line.slice(eq + 1).trim();
    if (type === 'o') out.sessionId = value.split(/\s+/)[1] || '';
    if (type === 'c' && !inAudio) {
      const parts = value.split(/\s+/);
      out.ip = (parts[2] || '').split('/')[0];
    } else if (type === 'm') {
      const parts = value.split(/\s+/);
      inAudio = parts[0] === 'audio';
      if (inAudio) {
        out.port = parseInt(parts[1], 10) || 0;
        out.payloadTypes = parts.slice(3).map((n) => parseInt(n, 10)).filter(Number.isFinite);
      }
    } else if (inAudio && type === 'c') {
      out.ip = (value.split(/\s+/)[2] || '').split('/')[0] || out.ip;
    } else if (inAudio && type === 'a') {
      const m = /^rtpmap:(\d+)\s+([\w-]+)\/(\d+)/i.exec(value);
      if (m) {
        const pt = Number(m[1]);
        out.codecs.push({ pt, name: m[2].toUpperCase(), rate: Number(m[3]) });
        if (m[2].toUpperCase() === 'TELEPHONE-EVENT') out.dtmfPt = pt;
      }
      if (/^(sendrecv|sendonly|recvonly|inactive)$/.test(value)) out.direction = value;
    }
  }
  if (!out.dtmfPt && out.payloadTypes.includes(PT_DTMF)) out.dtmfPt = PT_DTMF;
  return out;
}

/**
 * Choose the payload type to send: the peer's first codec we can actually encode.
 * @returns {{pt:number, name:string}|null}
 */
function negotiate(remote, supported = [PT_PCMU, PT_PCMA]) {
  const list = remote?.payloadTypes || [];
  for (const pt of list) {
    if (supported.includes(pt)) return { pt, name: nameOf(pt) };
  }
  // A trunk that offered nothing we support is answered with our own preference; the far end
  // may still reject it, which surfaces as a 488 and a readable error rather than silence.
  return supported.length ? { pt: supported[0], name: nameOf(supported[0]) } : null;
}

module.exports = { build, parse, negotiate, CODECS, PT_PCMU, PT_PCMA, PT_DTMF, RATE, DTMF_EVENTS, nameOf };
