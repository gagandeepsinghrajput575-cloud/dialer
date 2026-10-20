// The one object the Electron main process owns. It normalises whichever engine is live into the
// IPC contract (dial/answer/decline/hangup/dtmf in, incoming_call/answered/ended out) and keeps
// the SQLite ledger honest, whether audio runs in Chromium or in Linphone.
const { sipUri, telUri } = require('./config');

class TelephonyBridge {
  constructor({ ua = null, ledger = null, emit = () => {}, forward = () => {}, handoff = () => {}, now = Date.now, media = true } = {}) {
    this.ua = ua;
    this.ledger = ledger;
    this.emit = emit;
    this.forward = forward;
    this.handoff = handoff;
    this.now = now;
    // false = signalling-only engine: never answer into a silent call, hand media to the OS.
    this.media = media;
    this.current = null;
    this.ledgerCallId = null;
    this.ledgerChain = Promise.resolve(null);
    this.unsubscribe = null;
  }

  start() {
    if (this.ua && typeof this.ua.on === 'function') this.unsubscribe = this.ua.on((event) => this.engineEvent(event));
    return this;
  }

  stop() {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
  }

  // ---- engine -> IPC + ledger -----------------------------------------------------------
  engineEvent(event) {
    if (!event) return;
    if (event.type === 'incoming') {
      this.current = { engineCallId: event.callId, callerPhone: event.callerPhone };
      this.ledgerCallId = null;
      this.emit({
        type: 'incoming_call', callerPhone: event.callerPhone, callerName: event.callerName || '',
        callId: event.callId, canAnswer: this.media, handoffUri: this.media ? '' : sipUri(event.callerPhone),
        at: event.at || this.now(),
      });
      this.ledgerChain = Promise.resolve(this.ledger ? this.ledger.inbound({ callerPhone: event.callerPhone }) : null)
        .then((result) => {
          this.ledgerCallId = result && result.callId ? result.callId : null;
          // Hand the row to the cockpit so it adopts this call instead of opening a second one.
          if (this.ledgerCallId) {
            this.emit({
              type: 'ledger', callId: this.ledgerCallId,
              prospect: (result && result.prospect) || null,
              matched: !!(result && result.matched),
              provisional: !!(result && result.provisional),
            });
          }
          return result;
        })
        .catch(() => null);
      return;
    }

    if (event.type === 'answered') {
      this.emit({ type: 'answered', direction: event.direction, callId: event.callId, at: event.at || this.now() });
      if (event.direction === 'inbound') this.queueLedger('answered');
      return;
    }

    if (event.type === 'ended') {
      this.emit({
        type: 'ended', direction: event.direction, callId: event.callId,
        reason: event.reason, durationSec: event.durationSec, at: event.at || this.now(),
      });
      if (event.direction === 'inbound') {
        if (event.reason === 'canceled' || event.reason === 'declined') this.queueLedger('missed', { reason: event.reason === 'declined' ? 'declined' : 'missed' });
        else this.queueLedger('ended', { durationSec: event.durationSec, reason: event.reason });
      }
      this.current = null;
      return;
    }

    if (event.type === 'registration' || event.type === 'alive' || event.type === 'timeout' || event.type === 'ringing') {
      this.emit({ ...event, engine: this.ua ? 'native-sip' : 'webrtc' });
    }
  }

  queueLedger(kind, data = {}) {
    this.ledgerChain = this.ledgerChain.then(() => {
      const id = this.ledgerCallId;
      if (!id || !this.ledger) return null;
      if (kind === 'answered') return this.ledger.answered(id);
      if (kind === 'ended') return this.ledger.ended(id, data);
      if (kind === 'missed') return this.ledger.missed(id, data);
      return null;
    }).catch(() => null);
    return this.ledgerChain;
  }

  // ---- IPC commands ---------------------------------------------------------------------
  dial(payload = {}) {
    if (this.ua && this.media) return this.ua.dial(payload);
    if (this.ua) {
      const handoff = this.openSoftphone(payload.phone);
      return { ok: true, handoff: true, uri: handoff.uri };
    }
    this.forward('dial', payload);
    return { ok: true, forwarded: true };
  }

  answer() {
    // INVARIANT: answering never rejects the call. If this engine cannot carry audio, the ring
    // is left intact and the caller is handed to Linphone by the UI — the caller keeps ringing
    // instead of hearing a busy tone because Pulse could not reach its own microphone.
    if (this.ua && this.media) return { ok: this.ua.answer() };
    if (this.ua) {
      const phone = this.current ? this.current.callerPhone : '';
      return { ok: false, reason: 'no-media-engine', handoff: phone ? sipUri(phone) : '' };
    }
    this.forward('answer');
    return { ok: true, forwarded: true };
  }

  decline() {
    if (this.ua) return { ok: this.ua.decline() };
    this.forward('decline');
    return { ok: true, forwarded: true };
  }

  hangup() {
    if (this.ua) return { ok: this.ua.hangup() };
    this.forward('hangup');
    return { ok: true, forwarded: true };
  }

  dtmf({ digit } = {}) {
    if (this.ua) return { ok: this.ua.dtmf(digit) };
    this.forward('dtmf', { digit });
    return { ok: true, forwarded: true };
  }

  // Option E/A: no native media pipeline is required — the OS softphone dials the carrier URI.
  openSoftphone(phone, protocol = 'sip') {
    const uri = protocol === 'tel' ? telUri(phone) : sipUri(phone);
    this.handoff(uri);
    return { ok: true, uri };
  }

  status() {
    return {
      engine: this.ua ? (this.media ? 'linphone' : 'native-sip') : 'webrtc',
      media: this.media,
      canAnswer: this.media,
      registered: !!(this.ua && this.ua.registered),
      state: this.ua ? this.ua.state : 'idle',
      callId: this.ledgerCallId,
      callerPhone: this.current ? this.current.callerPhone : null,
      activeCallId: this.current ? this.current.engineCallId : null,
    };
  }
}

module.exports = { TelephonyBridge };
