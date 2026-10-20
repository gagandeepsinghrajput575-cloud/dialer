// One SIP dialog. Every terminal path funnels through end(), so a CANCEL race, a duplicate BYE
// and a user hang-up can never emit two "ended" events or log two ledger rows.
const { header } = require('./message');
const { buildSdp } = require('./sdp');

const tagOf = (value) => {
  const match = /;tag=([^;>\s]+)/i.exec(String(value || ''));
  return match ? match[1] : '';
};

class SipCall {
  constructor({ ua, direction, invite = null, callId = '', localTag = '', fromUser = '', remoteUri = '', remoteTarget = '', remoteTag = '', now = Date.now, host = '0.0.0.0', mediaPort = 0 }) {
    this.ua = ua;
    this.direction = direction;
    this.invite = invite;
    this.callId = callId || header(invite, 'call-id');
    this.localTag = localTag || ua.localTag;
    this.fromUser = fromUser || ua.cfg.user;
    this.remoteUri = remoteUri || header(invite, 'from');
    this.remoteTarget = remoteTarget || header(invite, 'contact') || this.remoteUri;
    this.remoteTag = remoteTag || tagOf(this.remoteUri);
    this.now = now;
    this.host = host;
    this.mediaPort = mediaPort;
    this.state = 'idle';
    this.startedAt = now();
    this.answeredAt = 0;
    this.endedAt = 0;
  }

  // 100 first (stops the INVITE retransmission), then 180 immediately. Telnyx's SBC kills a
  // call at 10 s without a provisional response; both are written before the UI is asked to ring.
  ring() {
    if (this.state !== 'idle') return false;
    this.ua.sendResponse(this.invite, 100, 'Trying');
    this.ua.sendResponse(this.invite, 180, 'Ringing');
    this.state = 'ringing';
    return true;
  }

  answer() {
    if (this.direction !== 'inbound' || (this.state !== 'ringing' && this.state !== 'early')) return false;
    const sdp = buildSdp({ host: this.host, port: this.mediaPort, sessionId: this.now(), version: 1 });
    this.ua.sendResponse(this.invite, 200, 'OK', { headers: { 'content-type': 'application/sdp' }, body: sdp });
    this.connect();
    return true;
  }

  confirm(response) {
    if (this.direction !== 'outbound' || this.state === 'connected' || this.state === 'ended') return false;
    this.remoteTag = tagOf(header(response, 'to')) || this.remoteTag;
    this.remoteTarget = header(response, 'contact') || this.remoteTarget;
    this.connect();
    this.ua.sendAck(this);
    return true;
  }

  connect() {
    this.state = 'connected';
    this.answeredAt = this.now();
    this.ua.emit({ type: 'answered', direction: this.direction, callId: this.callId, at: this.answeredAt });
  }

  decline(status = 486, reason = 'Busy Here') {
    if (this.direction !== 'inbound' || this.state === 'ended' || this.state === 'connected') return false;
    this.ua.sendResponse(this.invite, status, reason);
    this.end(status === 486 ? 'declined' : 'rejected');
    return true;
  }

  canceled() {
    if (this.state === 'ended' || this.state === 'connected') return false;
    this.ua.sendResponse(this.invite, 487, 'Request Terminated');
    this.end('canceled');
    return true;
  }

  fail(status) {
    if (this.state === 'ended') return false;
    this.end('rejected', status);
    return true;
  }

  hangup() {
    if (this.state === 'ended') return false;
    if (this.state === 'connected') {
      this.ua.dialogRequest(this, 'BYE');
      this.end('local');
      return true;
    }
    if (this.direction === 'outbound') this.ua.dialogRequest(this, 'CANCEL');
    this.end('local');
    return true;
  }

  dtmf(digit) {
    if (this.state !== 'connected') return false;
    return this.ua.sendDtmf(this, digit);
  }

  end(reason, status = 0) {
    if (this.state === 'ended') return false;
    this.state = 'ended';
    this.endedAt = this.now();
    this.ua.emit({
      type: 'ended',
      direction: this.direction,
      callId: this.callId,
      reason,
      status,
      durationSec: this.answeredAt ? Math.max(0, Math.round((this.endedAt - this.answeredAt) / 1000)) : 0,
      at: this.endedAt,
    });
    this.ua.clearCall(this);
    return true;
  }
}

module.exports = { SipCall, tagOf };
