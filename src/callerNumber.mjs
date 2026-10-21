// Who is calling: the number the provider actually asserted, in priority order.
//
// Telnyx can put the caller in P-Asserted-Identity, Remote-Party-ID, Diversion or the plain
// From header depending on the trunk and on whether the call was forwarded. All four are read,
// and sip.js's parsed identities are preferred over the raw headers when they exist. Pure and
// dependency-free so the ordering can be tested without a carrier.

export function extractCallerNumber(invitation) {
  if (!invitation) return 'Unknown';

  const parseSipUriUser = (rawVal) => {
    if (!rawVal) return '';
    const str = String(rawVal);
    const m = str.match(/sip(?:s)?:([^@>;]+)/i);
    if (m && m[1]) {
      const u = m[1].trim();
      if (u && !['anonymous', 'unknown'].includes(u.toLowerCase())) return u;
    }
    return '';
  };

  const getHdr = (name) => {
    try {
      if (typeof invitation.request?.getHeader === 'function') {
        const v = invitation.request.getHeader(name);
        if (v) return v;
      }
      if (typeof invitation.incomingInviteRequest?.message?.getHeader === 'function') {
        const v = invitation.incomingInviteRequest.message.getHeader(name);
        if (v) return v;
      }
    } catch { /* ignore */ }
    return null;
  };

  // 1. Asserted Identity (P-Asserted-Identity parsed by sip.js)
  const assertedUser = invitation.assertedIdentity?.uri?.user;
  if (assertedUser && !['anonymous', 'unknown'].includes(String(assertedUser).toLowerCase())) {
    return String(assertedUser).trim();
  }

  // 2. Explicit P-Asserted-Identity / Remote-Party-ID / Diversion headers
  for (const h of ['P-Asserted-Identity', 'Remote-Party-ID', 'Diversion']) {
    const raw = getHdr(h);
    const parsed = parseSipUriUser(raw);
    if (parsed) return parsed;
  }

  // 3. Remote Identity URI user (From user parsed by sip.js)
  const remoteUser = invitation.remoteIdentity?.uri?.user;
  if (remoteUser && !['anonymous', 'unknown'].includes(String(remoteUser).toLowerCase())) {
    return String(remoteUser).trim();
  }

  // 4. Raw From header
  const rawFrom = getHdr('From');
  const fromUser = parseSipUriUser(rawFrom);
  if (fromUser) return fromUser;

  // 5. Display names if they contain digits or useful identity
  const remoteDisplay = invitation.remoteIdentity?.displayName;
  if (remoteDisplay && remoteDisplay.trim() && !['anonymous', 'unknown'].includes(remoteDisplay.toLowerCase())) {
    return remoteDisplay.trim();
  }
  const assertedDisplay = invitation.assertedIdentity?.displayName;
  if (assertedDisplay && assertedDisplay.trim() && !['anonymous', 'unknown'].includes(assertedDisplay.toLowerCase())) {
    return assertedDisplay.trim();
  }

  return (remoteUser && String(remoteUser).trim()) || 'Unknown';
}

/**
 * The outbound CLI header.
 *
 * Telnyx takes the caller ID from P-Asserted-Identity when the number is provisioned on the
 * connection, and falls back to the connection's portal `ani_override` otherwise. Sending it
 * only for a plausible E.164 value keeps a malformed setting (or a header-injection attempt)
 * off the wire.
 *
 * @param {string} callerId e.g. '+4532331610'
 * @param {string} server   SIP domain, e.g. 'sip.telnyx.com'
 * @returns {string[]} zero or one `P-Asserted-Identity` header
 */
export function callerIdHeaders(callerId, server) {
  const id = String(callerId || '').trim();
  if (!id || !server) return [];
  if (!/^\+?\d{6,15}$/.test(id)) return [];
  return [`P-Asserted-Identity: <sip:${id}@${server}>`];
}
