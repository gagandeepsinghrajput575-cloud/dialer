// In-dialog requests (ACK, BYE, INFO). Kept apart from the user agent so the dialog framing has
// one home and the UA stays under the project's 350-line ceiling.
const { serialize } = require('./message');

const bareUri = (value) => String(value || '').replace(/^</, '').replace(/>.*$/, '').replace(/;tag=[^;>]*/gi, '');

function dialogMessage(ua, call, method, body = '', contentType = '') {
  ua.cseq += 1;
  const to = call.direction === 'inbound'
    ? call.remoteUri
    : `${call.remoteTarget}${call.remoteTag ? `;tag=${call.remoteTag}` : ''}`;
  const headers = {
    via: `SIP/2.0/${ua.protocol} ${ua.cfg.contactHost}:${ua.localPort};branch=z9hG4bK-${ua.random()}`,
    'max-forwards': '70',
    from: `<sip:${call.fromUser}@${ua.cfg.domain}>;tag=${call.localTag}`,
    to,
    'call-id': call.callId,
    cseq: `${ua.cseq} ${method}`,
    contact: ua.contact,
  };
  if (contentType) headers['content-type'] = contentType;
  return serialize({ startLine: `${method} ${bareUri(call.remoteTarget || call.remoteUri)} SIP/2.0`, headers, body });
}

function dialogRequest(ua, call, method, body = '', contentType = '') {
  const text = dialogMessage(ua, call, method, body, contentType);
  ua.transport.send(text);
  return text;
}

module.exports = { dialogMessage, dialogRequest, bareUri };
