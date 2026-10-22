// The SIP user agent: one registration, one live call, one audio device.
//
// Scope decisions that keep this honest on a real trunk:
//   * One audio device is a physical fact, so a second INVITE while a call is live is answered
//     486 Busy Here rather than being queued — the operator hears one customer at a time.
//   * Registration lives in register.js and media in media.js; this file is only the call
//     lifecycle, which is the part that has to be readable end to end when a call misbehaves.
//   * Every way out of a call — BYE, CANCEL, a 4xx, a timeout, a dead socket, a local hang-up
//     — lands in Dialog.end(), so exactly one `ended` event is ever emitted per leg.
'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const { buildUri, serialize, identityOf } = require('./sipMessage');
const { Dialog } = require('./dialog');
const registration = require('./register');
const mediaLayer = require('./media');

class UserAgent extends EventEmitter {
  constructor({ transport, audio, account, userAgent = 'PulseSIP/1.0', publicIp = '', log = () => {} }) {
    super();
    this.transport = transport;
    this.audio = audio;
    this.account = { port: 5060, transport: 'udp', expires: registration.REGISTER_EXPIRES, ...(account || {}) };
    this.userAgent = userAgent;
    this.publicIp = publicIp;
    this.logFn = log;
    this.dialogs = new Map();
    this.active = null;
    this.cseq = Math.floor(Math.random() * 100) + 1;
    this.muted = false;
    registration.attach(this);
    mediaLayer.attach(this);
    this.registration.account = `${this.account.user}@${this.account.domain}`;
    transport.on('request', (msg, ctx) => this.onRequest(msg, ctx));
    transport.on('transport_error', (err) => this.log('transport', err.message));
  }

  log(scope, message) {
    try { this.logFn(scope, message); } catch { /* logging must never break a call */ }
  }

  setAccount(account) {
    const next = { ...this.account, ...account };
    const changed = ['domain', 'user', 'password', 'port', 'callerId']
      .some((k) => String(this.account?.[k] ?? '') !== String(next[k] ?? ''));
    this.account = next;
    this.registration.account = `${this.account.user}@${this.account.domain}`;
    return changed;
  }

  validateAccount() {
    const missing = [];
    if (!this.account.domain) missing.push('domain');
    if (!this.account.user) missing.push('user');
    if (!this.account.password) missing.push('password');
    return missing;
  }

  // ---- calls ---------------------------------------------------------------------------
  async dial(number, { callId: externalId = null } = {}) {
    if (this.active) return { ok: false, reason: 'busy', error: 'A call is already in progress.' };
    const clean = String(number || '').trim();
    if (!clean) return { ok: false, reason: 'invalid', error: 'No number to dial.' };
    const dialog = new Dialog({ ua: this, direction: 'outbound', number: clean });
    dialog.externalId = externalId;
    this.dialogs.set(dialog.id, dialog);
    this.emit('dialing', { callId: dialog.id, number: clean, direction: 'outbound' });
    try {
      await dialog.invite();
    } catch (e) {
      dialog.end('failed', { detail: String(e?.message || e) });
      return { ok: false, reason: 'failed', error: String(e?.message || e) };
    }
    return { ok: true, callId: dialog.id, number: clean };
  }

  async answer(callId) {
    const dialog = this.find(callId);
    if (!dialog) return { ok: false, error: 'No such call.' };
    if (this.active && this.active !== dialog) return { ok: false, error: 'Another call is already live.' };
    const ok = await dialog.answer();
    return { ok, callId: dialog.id };
  }

  async reject(callId, code = 486) {
    const dialog = this.find(callId);
    if (!dialog) return { ok: false, error: 'No such call.' };
    await dialog.reject(code);
    return { ok: true, callId: dialog.id };
  }

  async hangup(callId) {
    const dialog = callId === undefined || callId === null ? this.active : this.find(callId);
    if (!dialog) return { ok: false, error: 'No call in progress.' };
    const wasLive = dialog.state === 'confirmed';
    if (wasLive) await dialog.bye();
    dialog.end(wasLive ? 'normal' : 'canceled');
    return { ok: true, callId: dialog.id };
  }

  find(callId) {
    if (callId === undefined || callId === null) return this.active;
    return this.dialogs.get(Number(callId))
      || [...this.dialogs.values()].find((d) => d.externalId === callId)
      || null;
  }

  async sendDtmf(digit) {
    const dialog = this.active;
    if (!dialog?.media) return { ok: false, error: 'No live call to send tones on.' };
    const packets = dialog.media.dtmf(digit);
    for (const packet of packets) dialog.media.send(packet);
    return { ok: true, digit: String(digit), packets: packets.length };
  }

  setMute(enabled) {
    this.muted = !!enabled;
    if (this.active?.media) this.active.media.setMuted(this.muted);
    this.emit('mute', { enabled: this.muted });
    return { ok: true, muted: this.muted };
  }

  // ---- inbound -------------------------------------------------------------------------
  async onRequest(msg, ctx) {
    if (msg.method === 'ACK') {
      // Always tell the transport, even for a dialog we do not recognise: that is what stops a
      // 200 OK being retransmitted at a peer that already acknowledged it.
      this.transport.noteAck(msg.first('call-id'));
      return this.dialogByCallId(msg.first('call-id'))?.noteAck();
    }
    if (msg.method === 'CANCEL') {
      const dialog = this.dialogByCallId(msg.first('call-id'));
      ctx.reply(serialize({ startLine: 'SIP/2.0 200 OK', headers: this.replyHeadersFor(msg, dialog, 'CANCEL') }));
      if (dialog && dialog.state !== 'confirmed') dialog.end('canceled');
      return;
    }
    if (msg.method === 'BYE') {
      const dialog = this.dialogByCallId(msg.first('call-id'));
      ctx.reply(serialize({ startLine: 'SIP/2.0 200 OK', headers: this.replyHeadersFor(msg, dialog, 'BYE') }));
      dialog?.end('remote-ended');
      return;
    }
    if (msg.method === 'OPTIONS') {
      // Carriers probe liveness; answering 200 keeps the trunk from marking this line down.
      ctx.reply(serialize({ startLine: 'SIP/2.0 200 OK', headers: { ...this.minimalReply(msg), Allow: 'INVITE, ACK, CANCEL, BYE, OPTIONS' } }));
      return;
    }
    if (msg.method !== 'INVITE') {
      ctx.reply(serialize({ startLine: 'SIP/2.0 405 Method Not Allowed', headers: this.minimalReply(msg) }));
      return;
    }
    const caller = identityOf(msg.first('from'));
    if (this.active) {
      ctx.reply(serialize({ startLine: 'SIP/2.0 486 Busy Here', headers: this.minimalReply(msg) }));
      return this.emit('rejected_incoming', { reason: 'busy', callerPhone: caller.user });
    }
    // A re-INVITE inside a dialog we already hold is a media update, not a second caller.
    const existing = this.dialogByCallId(msg.first('call-id'));
    if (existing) {
      ctx.reply(serialize({ startLine: 'SIP/2.0 200 OK', headers: existing.responseHeaders() }));
      return;
    }
    const dialog = new Dialog({ ua: this, direction: 'inbound', request: msg });
    this.dialogs.set(dialog.id, dialog);
    this.emit('incoming', { callId: dialog.id, callerPhone: dialog.callerPhone, callerName: dialog.displayName });
    try {
      await dialog.ring();
      this.emit('ringing', { callId: dialog.id, direction: 'inbound' });
    } catch (e) {
      dialog.end('failed', { detail: String(e?.message || e) });
    }
  }

  /**
   * Headers for a response to an in-dialog request. An *outbound* leg has no stored INVITE to
   * echo, so its answers are built from the request in hand; an inbound leg reuses the dialog's
   * own tags. Getting this backwards throws on a live call, which is why it is one helper.
   */
  replyHeadersFor(msg, dialog, method) {
    if (dialog?.request && dialog.direction === 'inbound') return dialog.responseHeaders({ method });
    return this.minimalReply(msg, method);
  }

  // The bare header set a response needs to be matched by the sender of `msg`.
  minimalReply(msg, method) {
    const cseq = msg.first('cseq') || '';
    return {
      Via: msg.first('via'),
      From: msg.first('from'),
      // An in-dialog response keeps the To tag the dialog already established instead of
      // inventing a second one, which would fork the far end's view of the call.
      To: /;tag=/i.test(String(msg.first('to') || '')) && this.active
        ? msg.first('to')
        : `${msg.first('to')};tag=${crypto.randomBytes(4).toString('hex')}`,
      'Call-ID': msg.first('call-id'),
      CSeq: method ? `${String(cseq).split(/\s+/)[0]} ${method}` : cseq,
      Contact: `<${buildUri({ user: this.account.user, host: this.transport.host, port: this.transport.port })}>`,
      'User-Agent': this.userAgent,
    };
  }

  dialogByCallId(callIdHeader) {
    return [...this.dialogs.values()].find((d) => d.callId === callIdHeader) || null;
  }

  // ---- lifecycle -----------------------------------------------------------------------
  onCallConfirmed(dialog) {
    if (this.active && this.active !== dialog) this.active.end('failed', { detail: 'replaced by a new call' });
    this.active = dialog;
    if (!this.applyRemoteSdp(dialog)) this.log('media', 'no usable remote SDP — audio will not flow');
    this.startPump(dialog);
    if (this.muted) dialog.media?.setMuted(true);
    this.emit('connected', { callId: dialog.id, direction: dialog.direction, codec: dialog.codec || 'PCMU' });
  }

  onDialogEnded(dialog, { reason, status = 0, detail = '' } = {}) {
    if (this.active === dialog) { this.active = null; this.stopPump(); }
    const durationSec = dialog.durationSec;
    this.releaseMedia(dialog);
    this.dialogs.delete(dialog.id);
    this.emit('ended', {
      callId: dialog.id,
      direction: dialog.direction,
      // `remote-ended` is a normal hang-up to the app: the customer said goodbye.
      reason: reason === 'remote-ended' ? 'normal' : reason,
      rawReason: reason,
      status, detail, durationSec,
      callerPhone: dialog.callerPhone,
    });
  }

  status() {
    const dialog = this.active;
    return {
      // Never the raw registration object: it holds a timer handle, and JSON.stringify on a
      // Node Timeout throws on its circular async-resource back-reference. That single field
      // once made every command after a successful REGISTER answer with nothing at all.
      registration: {
        state: this.registration.state,
        account: this.registration.account,
        expires: this.registration.expires,
        attempt: this.registration.attempt,
        refreshScheduled: !!this.registration.timer,
      },
      audio: this.audio?.describe?.() || { name: 'none' },
      muted: this.muted,
      transport: { host: this.transport.host, port: this.transport.port },
      call: dialog ? {
        callId: dialog.id, direction: dialog.direction, state: dialog.state,
        number: dialog.callerPhone, codec: dialog.codec, durationSec: dialog.durationSec,
      } : null,
      dialogs: this.dialogs.size,
    };
  }

  close() {
    this.stopRegistrationTimer();
    for (const dialog of [...this.dialogs.values()]) {
      if (dialog.state === 'confirmed') dialog.bye().catch(() => {});
      dialog.end('failed', { detail: 'daemon shutting down' });
    }
    this.stopPump();
    for (const socket of this.mediaSockets) socket.close();
    this.mediaSockets = [];
    this.transport.close();
  }
}

module.exports = { UserAgent, REGISTER_EXPIRES: registration.REGISTER_EXPIRES, RETRY_MS: registration.RETRY_MS };
