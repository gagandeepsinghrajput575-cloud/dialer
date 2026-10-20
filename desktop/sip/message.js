// Minimal RFC 3261 message codec: parse, serialise, respond and reframe.
// Deliberately not a full parser — it covers what Telnyx actually sends (compact headers,
// folded lines, multiple Via values, SDP bodies) and nothing else.
const COMPACT = { i: 'call-id', m: 'contact', f: 'from', t: 'to', v: 'via', l: 'content-length', c: 'content-type', s: 'subject', k: 'supported' };

const DISPLAY = {
  via: 'Via', from: 'From', to: 'To', 'call-id': 'Call-ID', cseq: 'CSeq', contact: 'Contact',
  'max-forwards': 'Max-Forwards', 'content-type': 'Content-Type', 'content-length': 'Content-Length',
  expires: 'Expires', authorization: 'Authorization', 'proxy-authorization': 'Proxy-Authorization',
  'user-agent': 'User-Agent', subject: 'Subject', supported: 'Supported',
  'www-authenticate': 'WWW-Authenticate', 'proxy-authenticate': 'Proxy-Authenticate',
};

const canonical = (name) => {
  const key = String(name || '').trim().toLowerCase();
  return COMPACT[key] || key;
};

function parse(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  const cut = text.indexOf('\n\n');
  const head = cut === -1 ? text : text.slice(0, cut);
  const body = cut === -1 ? '' : text.slice(cut + 2);
  const lines = head.split('\n');
  const startLine = (lines.shift() || '').trim();
  const headers = {};
  let lastName = '';
  for (const line of lines) {
    if (/^[ \t]/.test(line) && lastName) {
      headers[lastName] = `${headers[lastName]} ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = canonical(line.slice(0, colon));
    const value = line.slice(colon + 1).trim();
    lastName = key;
    if (headers[key] === undefined) headers[key] = value;
    else if (Array.isArray(headers[key])) headers[key].push(value);
    else headers[key] = [headers[key], value];
  }
  const request = /^([A-Z]+)\s+(\S+)\s+SIP\/2\.0$/i.exec(startLine);
  const response = /^SIP\/2\.0\s+(\d{3})\s*(.*)$/i.exec(startLine);
  return {
    raw: String(raw || ''),
    startLine,
    method: request ? request[1].toUpperCase() : null,
    uri: request ? request[2] : null,
    status: response ? Number(response[1]) : null,
    reason: response ? response[2].trim() : '',
    headers,
    body,
  };
}

const header = (msg, name) => {
  const value = msg && msg.headers ? msg.headers[canonical(name)] : undefined;
  return Array.isArray(value) ? value[0] || '' : value || '';
};

const headerAll = (msg, name) => {
  const value = msg && msg.headers ? msg.headers[canonical(name)] : undefined;
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
};

function serialize({ startLine, headers = {}, body = '' }) {
  const lines = [startLine];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    const label = DISPLAY[canonical(name)];
    for (const one of Array.isArray(value) ? value : [value]) lines.push(`${label || name}: ${one}`);
  }
  if (!Object.keys(headers).some((name) => canonical(name) === 'content-length')) {
    lines.push(`Content-Length: ${Buffer.byteLength(body, 'utf8')}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n${body}`;
}

// A response inherits the transaction identity of its request. The To tag is added once and
// never overwritten: retransmitted 200 OKs must carry the tag the first one committed to.
function buildResponse(request, status, reason, { toTag = '', headers = {}, body = '' } = {}) {
  const to = header(request, 'to');
  const carry = {
    via: headerAll(request, 'via'),
    from: header(request, 'from'),
    to: toTag && !/;tag=/i.test(to) ? `${to};tag=${toTag}` : to,
    'call-id': header(request, 'call-id'),
    cseq: header(request, 'cseq'),
    ...headers,
  };
  return serialize({ startLine: `SIP/2.0 ${status} ${reason}`, headers: carry, body });
}

// Reframes a byte stream/datagram into whole messages. Content-Length is authoritative, so a
// body containing CRLFCRLF (every SDP answer does) is never mistaken for a message boundary.
function frame(chunk) {
  let buffer = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
  const messages = [];
  while (buffer.length) {
    const separator = buffer.search(/\r?\n\r?\n/);
    if (separator === -1) break;
    const headerText = buffer.slice(0, separator);
    const declared = /content-length:\s*(\d+)/i.exec(headerText);
    const bodyLength = declared ? Number(declared[1]) : 0;
    const bodyStart = separator + (buffer.startsWith('\r\n\r\n', separator) ? 4 : 2);
    if (buffer.length < bodyStart + bodyLength) break;
    messages.push(buffer.slice(0, bodyStart + bodyLength));
    buffer = buffer.slice(bodyStart + bodyLength);
  }
  return { messages, rest: buffer };
}

module.exports = { parse, serialize, buildResponse, header, headerAll, frame, canonical };
