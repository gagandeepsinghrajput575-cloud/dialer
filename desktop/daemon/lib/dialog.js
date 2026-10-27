// One call leg: the SIP INVITE dialog in both directions.
//
// A bug here costs money: a dialog that never tears down rings a customer back, and a missed ACK
// leaves the carrier retransmitting 200 OK forever. Every way out lands in one idempotent `end()`.
'use strict';

const crypto = require('crypto');
const { buildUri, parseUri, identityOf, parseCSeq, serialize } = require('./sipMessage');
const { viaOf, contactOf } = require('./transport');
const sdp = require('./sdp');
const digest = require('./digest');

const STATES = ['idle', 'calling', 'proceeding', 'early', 'confirmed', 'terminating', 'terminated'];
const ACK_TIMEOUT_MS = 32000;

const tag = () => crypto.randomBytes(6).toString('hex');
const callId = (host) => `${crypto.randomBytes(8).toString('hex')}@${host}`;
const branch = () => `z9hG4bK${crypto.randomBytes(8).toString('hex')}`;

class Dialog {
  // `ua` owns transport/account/emitter; `request` is the inbound INVITE, `number` the callee.
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
    this.dialogTo = request ? toUriOf(request.first('to')) : '';
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

  static nextId() { Dialog._seq = (Dialog._seq || 0) + 1; return Dialog._seq; }

  get callerPhone() { return this.direction === 'inbound' ? this.remoteIdentity?.user || '' : this.number; }

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
    this.ua.emit('state', { callId: this.id, state: next, direction: this.direction });  // never poll
  }

  // ---- common header plumbing ----------------------------------------------------------
  // `toHeader` is a whole To value, not a bare URI: an inbound response echoes the request's To.
  baseHeaders({ method, toHeader, toUri, toTag, extra = {}, via } = {}) {
    const ua = this.ua;
    const account = ua.account;
    const fromUri = buildUri({ user: account.user, host: account.domain });
    const fromDisplay = account.callerId || '';
    const headers = {
      Via: via || viaOf(ua.transport, branch()),
      'Max-Forwards': '70',
      From: `${fromDisplay ? `"${fromDisplay}" ` : ''}<${fromUri}>;tag=${this.localTag}`,
      To: toHeader || `<${toUri}>${toTag ? `;tag=${toTag}` : ''}`,
      'Call-ID': this.callId,
      CSeq: `${this.cseq} ${method}`,
      Contact: contactOf(ua.transport, { user: account.user, domain: account.domain, port: account.port }),
      'User-Agent': ua.userAgent, Allow: 'INVITE, ACK, CANCEL, BYE, OPTIONS, INFO',
    };
    return Object.assign(headers, extra);   // `extra` wins: the peer's Via/From go out verbatim
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

  // The request-URI is the peer's Contact (§12.2.1.1); the To stays the dialog's own To plus the
  // peer's tag. A To built from the Contact does not identify this dialog, and FreeSWITCH severs
  // such a call with BYE four seconds after answer (Timer H). `Allow` goes: it starts dialogs.
  inDialogRequest(method) {
    const uri = this.remoteTarget || this.requestUri
      || buildUri({ user: this.number, host: this.ua.account.domain, params: { user: 'phone' } });
    const toTag = method === 'CANCEL' ? '' : this.remoteTag;   // CANCEL predates the dialog (§9.1)
    const headers = this.baseHeaders({ method, toHeader: `<${this.dialogTo || uri}>${toTag ? `;tag=${toTag}` : ''}` });
    delete headers.Allow;
    return { uri, headers };
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
    await this.sendInvite({ toUri, toTag: '' });
    // No answer at all is still an answer the operator needs: 32 s and the leg is over.
    this.later(() => { if (!this.ended && this.state !== 'confirmed') this.end('timeout', { sendCancel: true }); }, ACK_TIMEOUT_MS);
  }

  // `auth` is { name, value }: a 407 is answered with Proxy-Authorization, a 401 with Authorization.
  async sendInvite({ toUri, toTag = '', auth = null }) {
    const media = await this.ua.openMediaSocket();
    this.media = this.media || media;
    // Over TLS the carrier expects secure media; an offer in the clear is refused with 488.
    const secure = this.ua.transport.mode === 'tls';
    if (secure && !this.srtpKey) {
      // RFC 4568 SDES: 16-byte key + 14-byte salt, base64.
      this.srtpKey = crypto.randomBytes(30).toString('base64');
    }
    const body = sdp.build({
      ip: this.ua.publicIp || this.ua.transport.localHost,
      port: this.media.port,
      secure,
      crypto: secure ? `1 AES_CM_128_HMAC_SHA1_80 inline:${this.srtpKey}` : '',
    });
    this.localSdp = sdp.parse(body);
    const viaBranch = branch();
    const headers = this.baseHeaders({
      method: 'INVITE', toUri, toTag,
      via: viaOf(this.ua.transport, viaBranch),
      extra: { 'Content-Type': 'application/sdp', ...(auth ? { [auth.name]: auth.value } : {}) },
    });
    const msg = serialize({ startLine: `INVITE ${toUri} SIP/2.0`, headers, body });
    const target = this.remoteAddressFor();
    this.ua.log('sip', `>> INVITE ${this.number} (${target.host}:${target.port})`);

    this.ua.transport.request({
      msg, branch: viaBranch, method: 'INVITE', target, invite: true,
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
    if (this.state !== 'early') this.transition('proceeding');
    this.ua.emit('provisional', { callId: this.id, status: res.status, reason: res.reason });
  }

  async onFinalResponse(res, { toUri }) {
    if (this.ended) return;
    if (res.synthetic || res.status === 0) return this.end('failed', { detail: res.reason });

    // A rejected call is the hardest thing to diagnose from the outside: 488 "Not Acceptable Here"
    // says nothing about *which* part of the offer the carrier refused. Carriers put that in a
    // Warning or Reason header, so put it in the log where an operator can see it.
    if (res.status >= 300) {
      const why = res.first('warning') || res.first('reason') || '';
      this.ua.log('sip', `<< ${res.status} ${res.reason || ''}${why ? ` — ${why}` : ''}`);
    }

    // Digest challenge: answer it once, with the same Call-ID and a fresh CSeq/branch.
    if ((res.status === 401 || res.status === 407) && !this.triedAuth) {
      this.triedAuth = true;
      const proxy = res.status === 407;
      const challenge = digest.pick(digest.parseChallenges(res.first(proxy ? 'proxy-authenticate' : 'www-authenticate')));
      if (challenge) {
        this.cseq += 1;
        const value = digest.respond({
          method: 'INVITE', uri: toUri, username: this.ua.account.user, nc: 1, challenge,
          password: this.ua.account.password,
        });
        return this.sendInvite({ toUri, auth: { name: proxy ? 'Proxy-Authorization' : 'Authorization', value } });
      }
    }

    if (res.status >= 200 && res.status < 300) {
      this.remoteTag = parseTag(res.first('to')) || this.remoteTag;
      this.dialogTo = toUriOf(res.first('to')) || this.dialogTo;
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
    // Non-2xx: a hop-by-hop transaction answer. 2xx: dialog-forming, and it carries our tag. Either
    // way it goes where the response came from — behind a carrier proxy that is *not* where the
    // INVITE went (§12.2.1.1), so an ACK sent to the INVITE target is a BYE four seconds later.
    const { uri, headers } = this.inDialogRequest('ACK');
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
    delete headers['Content-Type'];   // a 180 carries no body
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
    const body = sdp.build({ ip: this.ua.publicIp || this.ua.transport.localHost, port: this.media.port });
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

  async reject(code = 486, { fromEnd = false } = {}) {
    if (this.ended && !fromEnd) return false;
    const reason = code === 603 ? 'Decline' : code === 480 ? 'Temporarily Unavailable' : 'Busy Here';
    const msg = serialize({ startLine: `SIP/2.0 ${code} ${reason}`, headers: this.responseHeaders() });
    try { await this.ua.transport.replyTo(this.request, msg, this.remoteAddress, ackKey(this.request)); } catch {}
    this.ua.log('sip', `<< ${code} ${reason} (${this.callerPhone})`);
    this.end(code === 603 ? 'rejected' : 'busy');
    return true;
  }

  noteAck() {
    this.ackSeen = true;
    // Keyed on Call-ID, not branch: a 2xx ACK brings its own branch, and our retransmitted 200 OK
    // has to stop the moment it lands.
    this.ua.transport.noteAck(this.callId);
  }

  // ---- teardown ------------------------------------------------------------------------
  async bye() {
    if (this.ended || this.state !== 'confirmed') return;
    this.transition('terminating');
    this.cseq += 1;
    const { uri, headers } = this.inDialogRequest('BYE');
    const msg = serialize({ startLine: `BYE ${uri} SIP/2.0`, headers });  // fire and forget
    const target = this.ua.transport.peerFor(this.callId, this.remoteAddressFor());
    try { await this.ua.transport.send(msg, target); this.ua.log('sip', `>> BYE (${target.host})`); } catch { /* gone */ }
  }

  async cancel({ fromEnd = false } = {}) {
    if ((this.ended && !fromEnd) || this.state === 'confirmed') return;
    const { uri, headers } = this.inDialogRequest('CANCEL');
    headers.CSeq = `${this.cseq} CANCEL`;   // CANCEL shares the INVITE's CSeq number (RFC 3261 §9.1)
    const msg = serialize({ startLine: `CANCEL ${uri} SIP/2.0`, headers });
    const target = this.ua.transport.peerFor(this.callId, this.remoteAddressFor());
    try { await this.ua.transport.send(msg, target); this.ua.log('sip', '>> CANCEL'); } catch { /* best effort */ }
  }

  // The single way out, idempotent on purpose: a BYE crossing a local hang-up fires twice and must
  // still produce exactly one `ended` event, or the UI logs the same call twice.
  end(reason = 'normal', { sendCancel = false, sendReject = 0, status = 0, detail = '' } = {}) {
    if (this.ended) return;
    this.ended = true;
    this.endReason = reason;
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    // fromEnd is the one bypass of the `ended` guard. Without it these two send nothing at all —
    // which is why hanging up on a ringing call never sent the CANCEL and the customer rang on.
    if (sendCancel) this.cancel({ fromEnd: true }).catch(() => {});
    if (sendReject && this.request) this.reject(sendReject, { fromEnd: true }).catch(() => {});
    // Not transition(): it refuses to move an ended dialog, and `ended` is already set above.
    if (this.state !== 'terminated') {
      this.state = 'terminated';
      this.ua.emit('state', { callId: this.id, state: 'terminated', direction: this.direction });
    }
    this.ua.onDialogEnded(this, { reason, status, detail });
  }
}

// `;tag=abc`, and what a trunk sends: `; tag = abc`, `;tag=abc ;user=phone`
const parseTag = (v) => /;\s*tag\s*=\s*([^;>\s]+)/i.exec(String(v || ''))?.[1]?.trim() || '';
// The *first* Contact URI, the one §12.2.1.1 binds a dialog to. Split the comma *before* seeking
// angle brackets: over `sip:a@h, <sip:b@h2>` a whole-value regex returns the second.
const contactUri = (value) => {
  const raw = String(value || '');
  let i = 0;
  for (let quoted = false; i < raw.length; i += 1) {
    if (raw[i] === '"') quoted = !quoted;
    else if (raw[i] === ',' && !quoted) break;
  }
  const head = raw.slice(0, i).trim();       // `"Doe, John" <sip:j@h>, <sip:k@h2>` -> the first one
  const uri = (/<([^>]*)>/.exec(head) || [])[1] ?? head;
  return /^(sips?|tel):/i.test(uri.trim()) ? uri.trim() : '';
};
// A To value down to its bare URI: the last <…> wins, so a display name may hold one.
const toUriOf = (v) => (/.*<([^<>]*)>/.exec(String(v || ''))?.[1] || String(v || '').replace(/\s*;[^<>]*/g, '')).trim();

// The key a retransmitted request answers to: branch + method (RFC 3261 §17.2.3).
const ackKey = (r) => `${/branch=([^;]+)/.exec(String(r.first('via') || ''))?.[1] || ''}|${r.method}`;

function reasonForStatus(status) {
  if (status === 486 || status === 600) return 'busy';
  if (status === 487) return 'canceled';
  if (status === 603 || status === 403) return 'rejected';
  if (status === 408 || status === 480) return 'timeout';   // Timer B/F, or the far end gave up
  if (status === 404 || status === 410) return 'notfound';
  if (status === 401 || status === 407) return 'auth';   // a challenge we could not answer
  return status >= 400 ? 'failed' : 'normal';
}

module.exports = { Dialog, STATES, reasonForStatus, parseTag, contactUri, ackKey, branch, tag, callId };
