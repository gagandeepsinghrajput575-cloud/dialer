// A small SIP user agent: REGISTER over UDP/TCP 5060, OPTIONS keepalive, inbound INVITE
// handling with an immediate 180 Ringing, and outbound INVITE/BYE/DTMF.
//
// It is deliberately not a media stack. The desktop's default engine keeps audio inside
// Chromium (CoreAudio under Electron, autoplay unlocked); this agent is the native signalling
// path, and when a call must be answered here the media is handed to the OS softphone.
const crypto = require('crypto');
const { parse, serialize, header, buildResponse } = require('./message');
const { parseChallenge, authorization } = require('./digest');
const { buildSdp } = require('./sdp');
const { SipCall } = require('./call');
const { TransactionTable } = require('./transaction');
const { dialogMessage, dialogRequest, bareUri } = require('./dialog');

const random = (bytes = 10) => crypto.randomBytes(bytes).toString('hex');
const branch = () => `z9hG4bK-${random(8)}`;

class SipUserAgent {
  constructor({ config = {}, transport = null, now = Date.now, onEvent = () => {}, expires = 300, t1 = 500 } = {}) {
    this.cfg = {
      user: '', password: '', domain: 'sip.telnyx.com', port: 5060,
      transport: 'udp', displayName: 'Pulse Dialer', contactHost: '0.0.0.0', ...config,
    };
    this.transport = transport;
    this.now = now;
    this.onEvent = onEvent;
    this.expires = Number(expires) || 300;
    this.t1 = Number(t1) || 500;
    this.callId = `${random()}@pulse`;
    this.localTag = random(6);
    this.cseq = 0;
    this.state = 'idle';
    this.registered = false;
    this.refreshAt = 0;
    this.challenge = null;
    this.registrationAttempts = 0;
    this.call = null;
    this.timers = new Set();
    this.transactions = new TransactionTable({
      send: (text) => this.transport.send(text),
      t1: this.t1,
      onTimeout: (method) => this.onTransactionTimeout(method),
    });
    this.listeners = new Set();
    if (transport) transport.onMessage = (msg) => this.handle(msg);
  }

  random() { return random(8); }

  get protocol() { return this.cfg.transport === 'tcp' ? 'TCP' : 'UDP'; }
  get localPort() { return (this.transport && this.transport.localPort) || 5060; }
  get identity() { return `<sip:${this.cfg.user}@${this.cfg.domain}>`; }
  get contact() { return `<sip:${this.cfg.user}@${this.cfg.contactHost}:${this.localPort};transport=${this.cfg.transport}>`; }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of [this.onEvent, ...this.listeners]) {
      try { listener(event); } catch { /* a broken observer must never break the call */ }
    }
  }

  // ---- timers ---------------------------------------------------------------------------
  timer(fn, ms) {
    const handle = setTimeout(() => { this.timers.delete(handle); fn(); }, Math.max(1, ms));
    if (handle.unref) handle.unref();
    this.timers.add(handle);
    return handle;
  }

  clearTimer(handle) {
    if (!handle) return;
    clearTimeout(handle);
    this.timers.delete(handle);
  }

  // ---- lifecycle ------------------------------------------------------------------------
  start() {
    if (this.transport && typeof this.transport.start === 'function') this.transport.start();
    this.register();
    return this;
  }

  stop() {
    for (const handle of this.timers) clearTimeout(handle);
    this.timers.clear();
    this.transactions.stop();
    this.call = null;
    this.state = 'stopped';
    this.registered = false;
    if (this.transport && typeof this.transport.stop === 'function') this.transport.stop();
  }

  register() {
    this.registrationAttempts = 0;
    this.challenge = null;
    this.state = 'registering';
    this.emit({ type: 'registration', state: 'registering', at: this.now() });
    this.sendRegister();
  }

  sendRegister() {
    const uri = `sip:${this.cfg.domain}`;
    this.cseq += 1;
    const seq = this.cseq;
    const headers = {
      via: `SIP/2.0/${this.protocol} ${this.cfg.contactHost}:${this.localPort};branch=${branch()};rport`,
      'max-forwards': '70',
      from: `${this.identity};tag=${this.localTag}`,
      to: this.identity,
      'call-id': this.callId,
      cseq: `${seq} REGISTER`,
      contact: `${this.contact};expires=${this.expires}`,
      expires: String(this.expires),
      'user-agent': 'PulseDialer/1.0',
    };
    if (this.challenge && this.cfg.password) {
      headers.authorization = authorization({
        username: this.cfg.user, password: this.cfg.password, method: 'REGISTER', uri, challenge: this.challenge, nc: seq,
      });
    }
    const text = serialize({ startLine: `REGISTER ${uri} SIP/2.0`, headers });
    this.track(this.callId, seq, 'REGISTER', text);
    this.transport.send(text);
    return text;
  }

  // ---- transactions ---------------------------------------------------------------------
  track(callId, seq, method, text) { return this.transactions.add(callId, seq, method, text); }

  resolve(msg) { return this.transactions.resolve(msg); }

  onTransactionTimeout(method) {
    this.emit({ type: 'timeout', method, at: this.now() });
    if (method === 'REGISTER') this.registrationFailed('No response from the carrier');
  }

  // ---- inbound messages -----------------------------------------------------------------
  handle(input) {
    const msg = typeof input === 'string' ? parse(input) : input;
    if (!msg || (!msg.method && !msg.status)) return null;
    return msg.status ? this.onResponse(msg) : this.onRequest(msg);
  }

  onResponse(msg) {
    const { method } = this.resolve(msg);
    const status = msg.status;

    if (method === 'REGISTER') return this.onRegisterResponse(msg, status);
    if (method === 'INVITE' && this.call) return this.onInviteResponse(msg, status);
    if (method === 'OPTIONS' && status === 200) this.emit({ type: 'alive', at: this.now() });
    return true;
  }

  onRegisterResponse(msg, status) {
    if (status === 401 || status === 407) {
      const challenge = status === 401 ? header(msg, 'www-authenticate') : header(msg, 'proxy-authenticate');
      if (!this.cfg.password) return this.registrationFailed('Carrier requires credentials');
      if (this.registrationAttempts >= 2) return this.registrationFailed('Authentication loop');
      this.challenge = parseChallenge(challenge);
      this.registrationAttempts += 1;
      this.sendRegister();
      return true;
    }
    if (status === 200) {
      this.registered = true;
      this.state = 'registered';
      const seconds = this.expiresIn(msg);
      const refreshSec = Math.max(30, Math.floor(seconds * 0.9));
      this.refreshAt = this.now() + refreshSec * 1000;
      this.emit({ type: 'registration', state: 'registered', expiresAt: this.refreshAt, at: this.now() });
      this.timer(() => this.sendRegister(), refreshSec * 1000);
      return true;
    }
    if (status >= 300) return this.registrationFailed(`Carrier rejected registration (${status})`);
    return true;
  }

  expiresIn(msg) {
    const contactExpiry = /;expires=(\d+)/i.exec(header(msg, 'contact'));
    if (contactExpiry) return Number(contactExpiry[1]);
    const declared = parseInt(header(msg, 'expires'), 10);
    return Number.isFinite(declared) && declared > 0 ? declared : this.expires;
  }

  registrationFailed(reason) {
    this.registered = false;
    this.state = 'failed';
    this.emit({ type: 'registration', state: 'failed', reason, at: this.now() });
    return true;
  }

  onInviteResponse(msg, status) {
    if (status === 401 || status === 407) return this.retryInvite(msg, status);
    if (status < 200) {
      if (status === 180 || status === 183) {
        this.call.state = 'ringing';
        this.emit({ type: 'ringing', direction: 'outbound', callId: this.call.callId, at: this.now() });
      }
      return true;
    }
    if (status < 300) return this.call.confirm(msg), true;
    return this.call.fail(status), true;
  }

  retryInvite(msg, status) {
    const challenge = status === 401 ? header(msg, 'www-authenticate') : header(msg, 'proxy-authenticate');
    if (!this.cfg.password || this._inviteRetried || !this._outbound) return this.call.fail(status), true;
    this.challenge = parseChallenge(challenge);
    this.call = null;
    this.dial(this._outbound, true);
    return true;
  }

  onRequest(msg) {
    switch (msg.method) {
      case 'INVITE': return this.onInvite(msg);
      case 'ACK': return true;
      case 'BYE': return this.onBye(msg);
      case 'CANCEL': return this.onCancel(msg);
      case 'OPTIONS': this.sendResponse(msg, 200, 'OK'); return true;
      case 'INFO': {
        this.sendResponse(msg, 200, 'OK');
        const digit = /Signal=([0-9*#A-D])/i.exec(msg.body);
        if (digit) this.emit({ type: 'dtmf', digit: digit[1].toUpperCase(), at: this.now() });
        return true;
      }
      default: this.sendResponse(msg, 405, 'Method Not Allowed'); return true;
    }
  }

  onInvite(msg) {
    if (this.call) { this.sendResponse(msg, 486, 'Busy Here'); return true; }
    const from = header(msg, 'from');
    const caller = /sip:([^@;>]+)/.exec(from);
    const display = /^"([^"]+)"/.exec(from);
    this.call = new SipCall({
      ua: this, direction: 'inbound', invite: msg, fromUser: this.cfg.user,
      remoteUri: from, remoteTarget: header(msg, 'contact') || from, now: this.now, host: this.cfg.contactHost,
    });
    this.call.ring();
    this.emit({
      type: 'incoming',
      callerPhone: caller ? caller[1] : '',
      callerName: display ? display[1] : '',
      callId: header(msg, 'call-id'),
      from,
      at: this.now(),
    });
    return true;
  }

  onBye(msg) {
    if (!this.call || header(msg, 'call-id') !== this.call.callId) {
      this.sendResponse(msg, 481, 'Call/Transaction Does Not Exist');
      return true;
    }
    this.sendResponse(msg, 200, 'OK');
    this.call.end('remote');
    return true;
  }

  onCancel(msg) {
    this.sendResponse(msg, 200, 'OK');
    if (this.call && this.call.callId === header(msg, 'call-id')) this.call.canceled();
    return true;
  }

  clearCall(call) {
    if (this.call === call) this.call = null;
  }

  // ---- outbound and in-dialog requests ---------------------------------------------------
  dial({ phone = '', callerId = '' } = {}, routed = false) {
    if (this.call) return { ok: false, reason: 'busy' };
    if (!phone) return { ok: false, reason: 'no-number' };
    this._outbound = { phone, callerId };
    this._inviteRetried = routed;
    const target = `sip:${phone}@${this.cfg.domain}`;
    const callId = `${random()}@pulse`;
    this.cseq += 1;
    const seq = this.cseq;
    const fromUser = callerId || this.cfg.user;
    const headers = {
      via: `SIP/2.0/${this.protocol} ${this.cfg.contactHost}:${this.localPort};branch=${branch()}`,
      'max-forwards': '70',
      from: `"${this.cfg.displayName}" <sip:${fromUser}@${this.cfg.domain}>;tag=${this.localTag}`,
      to: `<sip:${phone}@${this.cfg.domain}>`,
      'call-id': callId,
      cseq: `${seq} INVITE`,
      contact: this.contact,
      'content-type': 'application/sdp',
      'user-agent': 'PulseDialer/1.0',
    };
    if (routed && this.challenge) {
      headers.authorization = authorization({
        username: this.cfg.user, password: this.cfg.password, method: 'INVITE', uri: target, challenge: this.challenge, nc: seq,
      });
    }
    const body = buildSdp({ host: this.cfg.contactHost, port: 0, sessionId: this.now(), version: 1 });
    const text = serialize({ startLine: `INVITE ${target} SIP/2.0`, headers, body });
    this.call = new SipCall({
      ua: this, direction: 'outbound', callId, fromUser,
      remoteUri: `<sip:${phone}@${this.cfg.domain}>`, remoteTarget: `sip:${phone}@${this.cfg.domain}`, now: this.now,
    });
    this.call.state = 'dialing';
    this.track(callId, seq, 'INVITE', text);
    this.transport.send(text);
    return { ok: true, callId };
  }

  answer() { return this.call ? this.call.answer() : false; }
  decline() { return this.call ? this.call.decline() : false; }
  hangup() { return this.call ? this.call.hangup() : false; }
  dtmf(digit) {
    if (!/^[0-9*#A-D]$/i.test(String(digit || ''))) return false;
    return this.call ? this.call.dtmf(String(digit).toUpperCase()) : false;
  }

  sendResponse(request, status, reason, options = {}) {
    const text = buildResponse(request, status, reason, { toTag: this.localTag, ...options });
    this.transport.send(text);
    return text;
  }

  dialogMessage(call, method, body = '', contentType = '') {
    return dialogMessage(this, call, method, body, contentType);
  }

  dialogRequest(call, method, body = '', contentType = '') {
    return dialogRequest(this, call, method, body, contentType);
  }

  sendAck(call) {
    return call ? this.dialogRequest(call, 'ACK') : '';
  }

  sendDtmf(call, digit) {
    return this.dialogRequest(call, 'INFO', `Signal=${digit}\r\nDuration=160\r\n`, 'application/dtmf-relay') !== '';
  }
}

module.exports = { SipUserAgent };
