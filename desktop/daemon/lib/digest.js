// HTTP digest authentication (RFC 2617 / RFC 7616 subset) for SIP REGISTER and INVITE.
//
// Carriers answer the first REGISTER with `401` + `WWW-Authenticate: Digest realm=…, nonce=…`
// and expect the same request again with an `Authorization` header. Only MD5 + qop=auth is
// implemented: that is what every SIP trunk in production still speaks, and MD5 here is a
// protocol requirement, not a password-storage choice.
'use strict';

const crypto = require('crypto');

const md5 = (s) => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');

/**
 * Parse one or more challenge headers into a list of parameter maps.
 * `WWW-Authenticate: Digest realm="x", nonce="y", qop="auth", algorithm=MD5`
 */
function parseChallenges(value) {
  const out = [];
  for (const header of Array.isArray(value) ? value : [value]) {
    const line = String(header || '').trim();
    if (!line) continue;
    const schemeMatch = /^(\w+)\s+(.*)$/s.exec(line);
    const scheme = (schemeMatch?.[1] || 'Digest').toLowerCase();
    const rest = schemeMatch?.[2] || '';
    const params = Object.create(null);
    // Split on commas that are *not* inside a quoted string.
    const re = /(\w[\w-]*)\s*=\s*("((?:[^"\\]|\\.)*)"|[^,]*)/g;
    let m;
    while ((m = re.exec(rest)) !== null) {
      params[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[2].trim();
    }
    out.push({ scheme, params, raw: line });
  }
  return out;
}

const pick = (challenges) => challenges.find((c) => c.scheme === 'digest' && c.params.nonce) || challenges[0] || null;

/**
 * Build the credential header value answering a challenge.
 * @param {object} opts { method, uri, username, password, challenge, nc, cnonce }
 * @returns {string} e.g. `Digest username="…", realm="…", nonce="…", uri="…", response="…"`
 */
function respond({ method, uri, username, password, challenge, nc = 1, cnonce }) {
  const p = challenge?.params || {};
  const realm = p.realm || '';
  const nonce = p.nonce || '';
  const qopList = String(p.qop || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const qop = qopList.includes('auth') ? 'auth' : '';
  const algorithm = String(p.algorithm || 'MD5').toUpperCase();
  if (algorithm !== 'MD5' && algorithm !== 'MD5-SESS') {
    throw new Error(`Unsupported digest algorithm "${algorithm}"`);
  }
  const ha1Base = md5(`${username}:${realm}:${password}`);
  const ha1 = algorithm === 'MD5-SESS' ? md5(`${ha1Base}:${nonce}:${cnonce || ''}`) : ha1Base;
  const ha2 = md5(`${String(method).toUpperCase()}:${uri}`);
  const ncHex = String(nc).padStart(8, '0');
  const usedCnonce = cnonce || crypto.randomBytes(8).toString('hex');
  const response = qop
    ? md5(`${ha1}:${nonce}:${ncHex}:${usedCnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  const parts = [
    `username="${quote(username)}"`,
    `realm="${quote(realm)}"`,
    `nonce="${quote(nonce)}"`,
    `uri="${quote(uri)}"`,
    `response="${response}"`,
  ];
  if (algorithm !== 'MD5') parts.push(`algorithm=${algorithm}`);
  if (qop) parts.push(`qop=${qop}`, `nc=${ncHex}`, `cnonce="${usedCnonce}"`);
  if (p.opaque) parts.push(`opaque="${quote(p.opaque)}"`);
  return `Digest ${parts.join(', ')}`;
}

// Only `\` and `"` need escaping inside a quoted-string.
const quote = (s) => String(s ?? '').replace(/([\\"])/g, '\\$1');

module.exports = { md5, parseChallenges, pick, respond, quote };
