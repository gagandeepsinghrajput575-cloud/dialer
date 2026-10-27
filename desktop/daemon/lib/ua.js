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
const { viaOf, contactOf } = require('./transport');
const mediaLayer = require('./media');
const { probeCarrier } = require('./reachability');
const sdp = require('./sdp');
const rtp = require('./rtp');
const g711 = require('./g711');

class UserAgent extends EventEmitter {
  constructor({ transport, audio, account, userAgent = 'PulseSIP/1.0', publicIp = '', apiBase = '', log = () => {} }) {
    super();
    this.transport = transport;
    this.audio = audio;
    this.account = { port: 5060, transport: 'udp', expires: registration.REGISTER_EXPIRES, ...(account || {}) };
    this.userAgent = userAgent;
    this.publicIp = publicIp;
    this.apiBase = apiBase;
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
    // An absent or undefined key means "not supplied", never "erase it". The renderer is
    // deliberately never given the SIP password, so its register command carries domain, port,
    // user and callerId only — and spreading that over the account wiped the password the daemon
    // had loaded from the API. The call still worked, because the live registration survived, but
    // the refresh at 80% of the expiry could no longer authenticate: the phone went deaf to
    // inbound calls a few minutes into a shift, which reads as "the app stops working randomly".
    const patch = {};
    for (const [k, v] of Object.entries(account || {})) {
      if (v === undefined) continue;
      if (k === 'password' && !v && this.account.password) continue;
      patch[k] = v;
    }
    const next = { ...this.account, ...patch };
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

  /**
   * Would a dial leave this machine at all?
   *
   * A live registration is better evidence than any probe, so while `registered` this answers
   * instantly and the normal dial path pays nothing. Otherwise one OPTIONS goes out with a bounded
   * wait: ~200 ms when the network carries SIP, `timeoutMs` when it does not.
   */
  async checkCarrier({ timeoutMs = 1500, force = false } = {}) {
    const domain = this.account?.domain;
    const port = Number(this.account?.port) || (this.transport?.mode === 'tls' ? 5061 : 5060);
    if (!domain) {
      return { ok: false, reason: 'no-account', ms: 0, host: '', port, error: 'No SIP account is configured.' };
    }

    // Over TLS the connection *is* the evidence. A UDP OPTIONS probe to 5061 would be answered by
    // nobody and would fail every dial, so ask the socket instead: connected is stronger proof
    // than any datagram, and a connect attempt exercises the real path.
    if (this.transport?.mode === 'tls') {
      if (this.transport.connected) {
        return { ok: true, cached: true, ms: 0, host: domain, port, via: 'tls' };
      }
      const started = Date.now();
      try {
        await Promise.race([
          this.transport.ensureConnected({ host: domain, port }),
          new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
            timer.unref?.();
          }),
        ]);
        const result = { ok: true, cached: false, ms: Date.now() - started, host: domain, port, via: 'tls' };
        this.carrierProbe = { ...result, at: Date.now() };
        this.carrierSuspect = false;
        return result;
      } catch (e) {
        const result = { ok: false, reason: 'tls', ms: Date.now() - started, host: domain, port,
          error: String(e?.message || e) };
        this.carrierProbe = { ...result, at: Date.now() };
        this.log('sip', `carrier unreachable over TLS: ${domain}:${port} (${result.error})`);
        return result;
      }
    }

    if (!force && !this.carrierSuspect && this.registration?.state === 'registered') {
      return { ok: true, cached: true, ms: 0, host: domain, port };
    }
    const result = await probeCarrier({ host: domain, port, timeoutMs });
    this.carrierProbe = { ...result, at: Date.now() };
    if (result.ok) {
      // The path carries SIP again; a registration that looked healthy can be trusted once more.
      this.carrierSuspect = false;
    }
    if (!result.ok) {
      this.log('sip', `carrier unreachable: ${domain}:${port} (${result.reason}, ${result.ms} ms)`);
    } else if (result.status) {
      this.log('sip', `carrier reachable: ${domain}:${port} (${result.status}, ${result.ms} ms)`);
    }
    return result;
  }

  // ---- calls ---------------------------------------------------------------------------
  async dial(number, { callId: externalId = null } = {}) {
    if (this.standingCall()) return { ok: false, reason: 'busy', error: 'A call is already in progress.' };
    const clean = String(number || '').trim();
    if (!clean) return { ok: false, reason: 'invalid', error: 'No number to dial.' };

    // The INVITE client transaction waits Timer B = 64 * T1 = 32 s before it gives up, which is
    // exactly the "stuck on Calling…" the operator sees on a network that swallows SIP. Ask the
    // carrier first: if it is not answering, fail in ~1.5 s with something actionable.
    const reach = await this.checkCarrier();
    if (!reach.ok) {
      const host = this.account?.domain || 'the carrier';
      const port = Number(this.account?.port) || 5060;
      if (reach.reason === 'no-account') {
        return { ok: false, reason: 'no-account', error: reach.error };
      }
      return {
        ok: false,
        reason: 'carrier_unreachable',
        error: `${host}:${port} did not answer in ${Math.round(reach.ms)} ms, so this call could never `
          + 'connect. The network is not carrying SIP — switch to a mobile hotspot (or a network with '
          + 'SIP ALG disabled) and dial again.',
        detail: { host, port, ms: reach.ms, cause: reach.reason, status: reach.status || '' },
      };
    }

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

  async answer(callId, externalId = null) {
    const dialog = this.find(callId);
    if (!dialog) return { ok: false, error: 'No such call.' };
    if (externalId) dialog.externalId = externalId;
    if (this.active && this.active !== dialog) return { ok: false, error: 'Another call is already live.' };
    const ok = await dialog.answer();
    return { ok, callId: dialog.id, externalId: dialog.externalId };
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
    if (wasLive) {
      await dialog.bye();
      dialog.end('normal');
    } else if (dialog.direction === 'inbound') {
      // A caller who is still ringing has to be told no. end() only refuses when asked to, and
      // ring()'s missed-call timer is guarded by `!ended`, so hanging up used to leave them
      // ringing into a vacuum until the carrier gave up. 603 is "a human declined"; the missed
      // timer keeps 486 for a ring nobody answered.
      dialog.end('rejected', { sendReject: 603 });
    } else {
      // Outbound and not yet answered: without CANCEL the customer's phone rings on for another
      // 30-60 s after the agent hung up, and someone answers a call that no longer exists.
      dialog.end('canceled', { sendCancel: true });
    }
    return { ok: true, callId: dialog.id };
  }

  /**
   * The call occupying the audio device, if any. A ringing leg occupies it exactly as much as a
   * live one — `active` is only set on the 200 OK, so testing that alone let a second INVITE ring
   * a second time and left the operator with two incoming calls and one microphone.
   */
  standingCall() {
    if (this.active) return this.active;
    return [...this.dialogs.values()].find((d) => !d.ended && d.state !== 'terminated') || null;
  }

  find(callId) {
    if (callId === undefined || callId === null) return this.active;
    return this.dialogs.get(Number(callId))
      || [...this.dialogs.values()].find((d) => d.externalId === callId)
      || null;
  }

  async sendDtmf(digit) {
    const dialog = this.active || this.standingCall();
    if (!dialog?.media) return { ok: false, error: 'No live call to send tones on.' };
    const packets = dialog.media.dtmf(digit);
    for (const packet of packets) dialog.media.send(packet);

    // Stream in-band dual-tone PCM audio over G.711 alongside RFC 2833 packets
    // so automated IVRs, PBXs, and carrier gateways hear the tone in both formats
    const pcm = rtp.generateDtmfPcm(digit, 160);
    if (pcm && dialog.media.session) {
      const frameLen = 160;
      for (let offset = 0; offset < pcm.length; offset += frameLen) {
        const framePcm = pcm.subarray(offset, offset + frameLen);
        const encoded = g711.encode(framePcm, dialog.media.codec);
        dialog.media.send(dialog.media.session.packet(encoded, false));
      }
    }
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
    // Order matters: a re-INVITE on a dialog we already hold is a media update from the *same*
    // caller, not a second caller. Tested after the busy guard, an answered call answered its own
    // re-INVITE with 486 — which is how hold/resume and a carrier's media-relay move dropped calls.
    const existing = this.dialogByCallId(msg.first('call-id'));
    if (existing) {
      // RFC 3261 §14: a 200 OK to a re-INVITE carries an answer. The old one carried no body and
      // no Content-Type, which reads as "my media is gone" — carriers answer that with a BYE, so
      // putting a customer on hold dropped the call. Renegotiate instead: take their offer, point
      // the receive path at it, and answer with the media we actually have.
      if (msg.body) existing.remoteSdp = sdp.parse(msg.body);
      const body = existing.media
        ? sdp.build({ ip: this.publicIp || this.transport.localHost, port: existing.media.port })
        : '';
      const headers = existing.responseHeaders();
      if (body) headers['Content-Type'] = 'application/sdp';
      this.applyRemoteSdp(existing);
      ctx.reply(serialize({ startLine: 'SIP/2.0 200 OK', headers, body }));
      return;
    }
    if (this.standingCall()) {
      ctx.reply(serialize({ startLine: 'SIP/2.0 486 Busy Here', headers: this.minimalReply(msg) }));
      return this.emit('rejected_incoming', { reason: 'busy', callerPhone: caller.user });
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
      Contact: contactOf(this.transport, { user: this.account.user, domain: this.account.domain, port: this.account.port }),
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
    this.emit('connected', { callId: dialog.id, externalId: dialog.externalId, direction: dialog.direction, codec: dialog.codec || 'PCMU' });
  }

  onDialogEnded(dialog, { reason, status = 0, detail = '' } = {}) {
    // A dialog that died with no answer at all is the signature of a network that swallowed the
    // INVITE (Timer B). Registration can still look healthy at that moment — the ALG's rewriting
    // only breaks dialog routing — so remember it and force a probe before the next dial instead of
    // walking into another 32 s wait.
    if (reason === 'timeout') this.carrierSuspect = true;
    if (this.active === dialog) { this.active = null; this.stopPump(); }
    const durationSec = dialog.durationSec;
    this.releaseMedia(dialog);
    this.dialogs.delete(dialog.id);
    this.emit('ended', {
      callId: dialog.id,
      externalId: dialog.externalId,
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
      carrier: this.carrierProbe
        ? { ok: this.carrierProbe.ok, ms: this.carrierProbe.ms, at: this.carrierProbe.at,
            status: this.carrierProbe.status || '', cause: this.carrierProbe.reason || '' }
        : null,
      call: dialog ? {
        callId: dialog.id, direction: dialog.direction, state: dialog.state,
        number: dialog.callerPhone, codec: dialog.codec, durationSec: dialog.durationSec,
      } : null,
      dialogs: this.dialogs.size,
    };
  }

  close() {
    this.stopRegistrationTimer();
    this.stopKeepalive?.();
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
