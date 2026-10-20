// RFC 2617 digest authentication. Telnyx answers an unauthenticated REGISTER with 401 and a
// single nonce; we answer once with MD5 qop=auth and reuse the challenge for the dialog.
const crypto = require('crypto');

const md5 = (value) => crypto.createHash('md5').update(String(value), 'utf8').digest('hex');

function parseChallenge(value) {
  const header = String(value || '').replace(/^Digest\s+/i, '');
  const params = {};
  const pattern = /([a-zA-Z0-9_-]+)=(?:"([^"]*)"|([^,\s]*))/g;
  let match = pattern.exec(header);
  while (match) {
    params[match[1].toLowerCase()] = match[2] !== undefined ? match[2] : match[3];
    match = pattern.exec(header);
  }
  return params;
}

// Returns a ready-to-send Authorization/Proxy-Authorization value.
// `nc` is the hex nonce count; a fresh cnonce per request is caller-supplied so retries differ.
function authorization({ username, password, method, uri, challenge, cnonce = crypto.randomBytes(8).toString('hex'), nc = 1 }) {
  const c = typeof challenge === 'string' ? parseChallenge(challenge) : challenge || {};
  const realm = c.realm || '';
  const nonce = c.nonce || '';
  const algorithm = String(c.algorithm || 'MD5').toUpperCase();
  if (algorithm !== 'MD5') throw new Error(`Unsupported digest algorithm: ${algorithm}`);

  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const offersAuth = String(c.qop || '').split(',').map((q) => q.trim()).includes('auth');
  const ncHex = Math.max(1, Number(nc) || 1).toString(16).padStart(8, '0');
  const response = offersAuth
    ? md5(`${ha1}:${nonce}:${ncHex}:${cnonce}:auth:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    'algorithm=MD5',
  ];
  if (c.opaque) parts.push(`opaque="${c.opaque}"`);
  if (offersAuth) parts.push('qop=auth', `nc=${ncHex}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(', ')}`;
}

module.exports = { md5, parseChallenge, authorization };
