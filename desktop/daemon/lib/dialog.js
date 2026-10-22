// One call leg: the SIP INVITE dialog in both directions.
//
// A bug here costs money and trust — a dialog that never tears down rings a customer back, and
// a missed ACK leaves the carrier retransmitting 200 OK forever. So the state machine is
// explicit and teardown is idempotent: BYE, CANCEL, a 4xx, a transport failure and a local
// hang-up all land in the same `end()`, which emits exactly once.
'use strict';

const crypto = require('crypto');
const { buildUri, parseUri, identityOf, parseCSeq, serialize } = require('./sipMessage');
const sdp = require('./sdp');
const digest = require('./digest');

const STATES = ['idle', 'calling', 'proceeding', 'early', 'confirmed', 'terminating', 'terminated'];
const ACK_TIMEOUT_MS = 32000;

const tag = () => crypto.randomBytes(6).toString('hex');
const callId = (host) => `${crypto.randomBytes(8).toString('hex')}@${host}`;
const branch = () => `z9hG4bK${crypto.randomBytes(8).toString('hex')}`;

class Dialog {
  // `ua` is the owning user agent (transport, account, emitter); `direction` is 'outbound' or
  // 'inbound'; `request` is the inbound INVITE (inbound only) and `number` the callee (outbound).
  constructor({ ua, direction, request = null, number = '' }) {
    this.ua = ua;
    this.direction = direction;
    this.state = 'idle';
    this.request = request;
    this.number = number;
    this.id = Dialog.nextId();
    this.callId = request ? request.first('call-id') : callId(ua.account.domain);
    this.localTag = tag();
    this.remoteTag = '';
    this.cseq = request ? parseCSeq(request).seq : Math.floor(Math.random() * 1000) + 1;
    this.remoteTarget = '';
    this.requestUri = '';
    this.routeSet = [];
    this.localSdp = null;
    this.remoteSdp = null;
    this.codec = null;
    this.media = null;
    this.ended = false;
    this.endReason = '';
    this.answeredAt = 0;
    this.timers = new Set();
    this.reply = null;              // inbound: how to answer the INVITE we were handed
    this.remoteAddress = null;
    this.remoteIdentity = request ? identityOf(request.first('from')) : null;
    if (request) {
      this.remoteAddress = request.remote;
      this.remoteTag = parseTag(request.first('from'));
      this.requestUri = parseUri(request.uri || request.first('to')).raw || String(request.uri || '');
      this.remoteSdp = sdp.parse(request.body);
    }
  }

  static nextId() {
    Dialog._seq = (Dialog._seq || 0) + 1;
    return Dialog._seq;
  }

  get callerPhone() {
    if (this.direction === 'inbound') return this.remoteIdentity?.user || '';
    return this.number;
  }

  get displayName() { return this.remoteIdentity?.displayName || ''; }

  get durationSec() {
    return this.answeredAt ? Math.max(0, Math.round((Date.now() - this.answeredAt) / 1000)) : 0;
  }

  later(fn, ms) {
    const id = setTimeout(() => { this.timers.delete(id); fn(); }, ms);
    this.timers.add(id);
    return id;
  }

  transition(next) {
    if (this.state === next || this.ended) return;
    this.state = next;
    this.ua.emit('state', { callId: this.id, state: next, direction: this.direction });
  }

  // ---- common header plumbing ----------------------------------------------------------
  /**
   * @param {object} o
   * @param {string} o.toHeader the complete To value (with or without a tag) — callers pass a
   *   finished header rather than a bare URI, because an inbound response must echo the
   *   request's To verbatim and only append our tag.
   */
  baseHeaders({ method, toHeader, toUri, toTag, extra = {}, via } = {}) {
    const ua = this.ua;
    const account = ua.account;
    const fromUri = buildUri({ user: account.user, host: account.domain });
    const fromDisplay = account.callerId || '';
    const headers = {
      Via: via || `SIP/2.0/UDP ${ua.transport.host}:${ua.transport.port};rport;branch=${branch()}`,
      'Max-Forwards': '70',
      From: `${fromDisplay ? `"${fromDisplay}" ` : ''}<${fromUri}>;tag=${this.localTag}`,
      To: toHeader || `<${toUri}>${toTag ? `;tag=${toTag}` : ''}`,
      'Call-ID': this.callId,
      CSeq: `${this.cseq} ${method}`,
      Contact: `<${buildUri({ user: account.user, host: ua.transport.host, port: ua.transport.port })}>`,
      'User-Agent': ua.userAgent,
      Allow: 'INVITE, ACK, CANCEL, BYE, OPTIONS, INFO',
    };
    // `extra` wins: an in-dialog or inbound response must carry the peer's Via/From verbatim.
    return Object.assign(headers, extra);
  }

  // Headers of a response to the INVITE we were handed: the request's Via/From/Call-ID/CSeq,
  // plus our tag. Anything else and the far end cannot match the answer to its dialog.
  responseHeaders({ method = 'INVITE', extra = {} } = {}) {
    const seq = parseCSeq(this.request).seq;
    return this.baseHeaders({
      method,
      toHeader: `${this.request.first('to')};tag=${this.localTag}`,
      extra: {
        Via: this.request.first('via'),
        From: this.request.first('from'),
        CSeq: `${seq} ${method}`,
        ...extra,
      },
    });
  }

  remoteAddressFor() {
    const hint = this.ua.transport.peerFor(this.callId, null);
    return this.remoteAddress || hint || { host: this.ua.account.domain, port: this.ua.account.port };
  }

  // ---- outbound ------------------------------------------------------------------------
  async invite() {
    const account = this.ua.account;
    const toUri = buildUri({ user: this.number, host: account.domain, params: { user: 'phone' } });
    this.transition('calling');
    await this.sendInvite({ toUri, toTag: '', authHeader: null });
    // No answer at all is still an answer the operator needs: 32 s and the leg is over.
    this.later(() => { if (!this.ended && this.state !== 'confirmed') this.end('timeout', { sendCancel: true }); }, ACK_TIMEOUT_MS);
  }

  async sendInvite({ toUri, toTag = '', authHeader = null }) {
    const media = await this.ua.openMediaSocket();
    this.media = this.media || media;
    const body = sdp.build({
      ip: this.ua.publicIp || this.ua.transport.host,
      port: this.media.port,
    });
    this.localSdp = sdp.parse(body);
    const viaBranch = branch();
    const headers = this.baseHeaders({
      method: 'INVITE', toUri, toTag,
      via: `SIP/2.0/UDP ${this.ua.transport.host}:${this.ua.transport.port};rport;branch=${viaBranch}`,
      extra: { 'Content-Type': 'application/sdp', ...(authHeader ? { Authorization: authHeader } : {}) },
    });
    const msg = serialize({ startLine: `INVITE ${toUri} SIP/2.0`, headers, body });
    const target = this.remoteAddressFor();
    this.ua.log('sip', `>> INVITE ${this.number} (${target.host}:${target.port})`);

    this.ua.transport.request({
      msg,
      branch: viaBranch,
      method: 'INVITE',
      target,
      invite: true,
      onProvisional: (res) => this.onProvisional(res),
      onFinal: (res) => this.onFinalResponse(res, { toUri, target }),
      onTimeout: () => this.end('timeout'),
    });
  }

  onProvisional(res) {
    if (this.ended) return;
    this.remoteTag = this.remoteTag || parseTag(res.first('to'));
    if (res.status === 100) return this.transition('proceeding');
    if (res.body) {
      this.remoteSdp = sdp.parse(res.body);
      this.transition('early');
      this.ua.startEarlyMedia?.(this);
    }
    this.transition(this.state === 'early' ? 'early' : 'proceeding');
    this.ua.emit('provisional', { callId: this.id, status: res.status, reason: res.reason });
  }

  async onFinalResponse(res, { toUri }) {
    if (this.ended) return;
    if (res.synthetic || res.status === 0) return this.end('failed', { detail: res.reason });

    // Digest challenge: answer it once, with the same Call-ID and a fresh CSeq/branch.
    if ((res.status === 401 || res.status === 407) && !this.triedAuth) {
      this.triedAuth = true;
      const headerName = res.status === 407 ? 'proxy-authenticate' : 'www-authenticate';
      const challenge = digest.pick(digest.parseChallenges(res.first(headerName)));
      if (challenge) {
        this.cseq += 1;
        const authHeader = digest.respond({
          method: 'INVITE', uri: toUri, username: this.ua.account.user,
          password: this.ua.account.password, challenge, nc: 1,
        });
        return this.sendInvite({ toUri, authHeader });
      }
    }

    if (res.status >= 200 && res.status < 300) {
      this.remoteTag = parseTag(res.first('to')) || this.remoteTag;
      this.remoteTarget = parseUri(contactUri(res.first('contact'))).raw || this.requestUri || toUri;
      if (res.body) this.remoteSdp = sdp.parse(res.body);
      await this.sendAck(res);
      this.confirm(res);
      return;
    }
    await this.sendAck(res);
    this.end(reasonForStatus(res.status), { status: res.status, detail: res.reason });
  }

  async sendAck(response) {
    // The ACK for a non-2xx is a hop-by-hop transaction answer; for a 2xx it is dialog-forming
    // and carries our tag. Either way it goes where the response actually came from, which a
    // carrier behind a proxy makes different from where the INVITE was sent.
    const uri = this.remoteTarget || this.requestUri
      || buildUri({ user: this.number, host: this.ua.account.domain, params: { user: 'phone' } });
    const headers = this.baseHeaders({ method: 'ACK', toUri: uri, toTag: this.remoteTag });
    delete headers.Allow;
    const msg = serialize({ startLine: `ACK ${uri} SIP/2.0`, headers });
    const target = this.ua.transport.peerFor(this.callId, this.remoteAddressFor());
    try {
      await this.ua.transport.send(msg, target);
      this.ua.log('sip', `>> ACK (${target.host}:${target.port})`);
    } catch { /* a lost ACK is recovered by the far end's 200 OK retransmit */ }
  }

  confirm(response) {
    this.transition('confirmed');
    this.answeredAt = Date.now();
    this.ua.onCallConfirmed(this, response);
  }

  // ---- inbound -------------------------------------------------------------------------
  async ring() {
    const headers = this.responseHeaders();
    delete headers['Content-Type'];
    const msg = serialize({ startLine: 'SIP/2.0 180 Ringing', headers });
    this.reply = { key: ackKey(this.request), status: 180, callId: this.callId };
    this.transition('proceeding');
    await this.ua.transport.replyTo(this.request, msg, this.remoteAddress, this.reply.key);
    this.ua.log('sip', `<< 180 Ringing (${this.callerPhone})`);
    // A ring nobody answers is a missed call, not a dialog left open forever.
    this.later(() => { if (!this.ended && this.state !== 'confirmed') this.end('missed', { sendReject: 486 }); }, ACK_TIMEOUT_MS);
  }

  async answer() {
    if (this.ended) return false;
    this.media = await this.ua.openMediaSocket();
    const body = sdp.build({ ip: this.ua.publicIp || this.ua.transport.host, port: this.media.port });
    this.localSdp = sdp.parse(body);
    const headers = this.responseHeaders({ extra: { 'Content-Type': 'application/sdp' } });
    const msg = serialize({ startLine: 'SIP/2.0 200 OK', headers, body });
    const key = ackKey(this.request);
    this.reply = { key, status: 200, callId: this.callId };
    await this.ua.transport.replyTo(this.request, msg, this.remoteAddress, key);
    this.ua.log('sip', `<< 200 OK (answered ${this.callerPhone})`);
    this.confirm(null);
    // No ACK inside Timer H means the far end never heard the answer: release the microphone
    // instead of holding a call the customer is not on.
    this.later(() => { if (!this.ackSeen && !this.ended) this.end('failed', { detail: 'no ACK' }); }, ACK_TIMEOUT_MS);
    return true;
  }

  async reject(code = 486) {
    if (this.ended) return false;
    const reason = code === 603 ? 'Decline' : code === 480 ? 'Temporarily Unavailable' : 'Busy Here';
    const msg = serialize({ startLine: `SIP/2.0 ${code} ${reason}`, headers: this.responseHeaders() });
    try {
      await this.ua.transport.replyTo(this.request, msg, this.remoteAddress, ackKey(this.request));
    } catch { /* the caller's own retransmit timer handles a lost reply */ }
    this.ua.log('sip', `<< ${code} ${reason} (${this.callerPhone})`);
    this.end(code === 603 ? 'rejected' : 'busy');
    return true;
  }

  noteAck() {
    this.ackSeen = true;
    // Keyed on Call-ID, not on the branch: a 2xx ACK carries its own branch, and the 200 OK we
    // retransmit for an outbound answer has to stop the moment that ACK lands.
    this.ua.transport.noteAck(this.callId);
  }

  // ---- teardown ------------------------------------------------------------------------
  async bye() {
    if (this.ended || this.state !== 'confirmed') return;
    this.transition('terminating');
    const uri = this.remoteTarget || this.requestUri
      || buildUri({ user: this.number, host: this.ua.account.domain });
    this.cseq += 1;
    const headers = this.baseHeaders({ method: 'BYE', toUri: uri, toTag: this.remoteTag });
    delete headers.Allow;
    const msg = serialize({ startLine: `BYE ${uri} SIP/2.0`, headers });
    const target = this.ua.transport.peerFor(this.callId, this.remoteAddressFor());
    // Fire and forget: the call is over locally either way, and a lost BYE is the carrier's
    // session timer to clean up.
    try { await this.ua.transport.send(msg, target); this.ua.log('sip', `>> BYE (${target.host})`); } catch { /* gone */ }
  }

  async cancel() {
    if (this.ended || this.state === 'confirmed') return;
    const uri = this.requestUri || buildUri({ user: this.number, host: this.ua.account.domain });
    const headers = this.baseHeaders({ method: 'CANCEL', toUri: uri, toTag: '' });
    headers.CSeq = `${this.cseq} CANCEL`;
    const msg = serialize({ startLine: `CANCEL ${uri} SIP/2.0`, headers });
    const target = this.ua.transport.peerFor(this.callId, this.remoteAddressFor());
    try { await this.ua.transport.send(msg, target); this.ua.log('sip', '>> CANCEL'); } catch { /* best effort */ }
  }

  /**
   * The single way out. Idempotent on purpose: a BYE crossing a local hang-up fires twice and
   * must produce exactly one `ended` event, or the UI logs the same call twice.
   */
  end(reason = 'normal', { sendCancel = false, sendReject = 0, status = 0, detail = '' } = {}) {
    if (this.ended) return;
    this.ended = true;
    this.endReason = reason;
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    if (sendCancel) this.cancel().catch(() => {});
    if (sendReject && this.request) this.reject(sendReject).catch(() => {});
    this.transition('terminated');
    this.ua.onDialogEnded(this, { reason, status, detail });
  }
}

// ---- small helpers ---------------------------------------------------------------------
const parseTag = (v) => /;\s*tag=([^;>]+)/i.exec(String(v || ''))?.[1] || '';
// `<sip:x@y>;param` -> `sip:x@y`; a Contact with no angle brackets is the whole value.
const contactUri = (v) => /<([^>]*)>/.exec(String(v || ''))?.[1] || String(v || '').split(',')[0].trim();
// The key a retransmitted request answers to: branch + method (RFC 3261 §17.2.3).
const ackKey = (r) => `${/branch=([^;]+)/.exec(String(r.first('via') || ''))?.[1] || ''}|${r.method}`;

function reasonForStatus(status) {
  if (status === 486 || status === 600) return 'busy';
  if (status === 487) return 'canceled';
  if (status === 603 || status === 403) return 'rejected';
  if (status === 408 || status === 480) return 'timeout';
  if (status === 404 || status === 410) return 'notfound';
  if (status === 401 || status === 407) return 'auth';
  if (status >= 400) return 'failed';
  return 'normal';
}

module.exports = { Dialog, STATES, reasonForStatus, parseTag, contactUri, ackKey, branch, tag, callId };
