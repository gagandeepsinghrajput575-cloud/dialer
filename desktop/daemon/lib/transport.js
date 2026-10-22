// UDP transport + SIP transaction timers (RFC 3261 §17).
//
// One socket carries signalling for every dialog: the daemon is a single user agent, so there
// is no reason to open a socket per call. Retransmission is the part that is easy to get
// wrong and expensive to debug in the field — a lost INVITE looks exactly like a carrier that
// does not answer — so Timer A/B live here rather than in the call logic.
'use strict';

const dgram = require('dgram');
const dns = require('dns');
const os = require('os');
const { EventEmitter } = require('events');
const { parse, addressOf, parseCSeq } = require('./sipMessage');

// The transaction key a serialized request belongs to. Re-parsing our own bytes would work but
// costs a parse per retransmit; the builder already knows both values, so it passes them.
function keyOf({ buf, branch: explicitBranch, method: explicitMethod }) {
  if (explicitBranch && explicitMethod) return `${explicitBranch}|${explicitMethod.toUpperCase()}`;
  const msg = parse(buf);
  const branch = explicitBranch || /branch=([^;]+)/.exec(String(msg?.first('via') || ''))?.[1] || '';
  const method = explicitMethod || (msg?.kind === 'request' ? msg.method : parseCSeq(msg).method);
  return `${branch}|${String(method).toUpperCase()}`;
}

const T1 = 500;                       // RTT estimate
const TIMER_B = 64 * T1;              // INVITE client transaction timeout (32 s)
const TIMER_F = 64 * T1;              // non-INVITE client transaction timeout
const TIMER_H = 64 * T1;              // wait for ACK after sending 200 OK
const MAX_RESPONSE_CACHE = 64;

/**
 * The address to advertise in SDP and Contact. `0.0.0.0` binds fine but is meaningless to a
 * peer, so the first non-internal IPv4 interface wins — on a laptop behind NAT that is the LAN
 * address the carrier's relay can actually reach (or the router forwards to).
 */
function defaultLocalAddress() {
  const all = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
  // Link-local (169.254.x) and CGNAT (100.64/10) addresses are reachable by nobody: a sandbox
  // or a Mac with no network yet will offer one, and putting it in SDP means no audio at all.
  const routable = all.find((i) => !/^(169\.254|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(i.address));
  return routable?.address || all[0]?.address || '127.0.0.1';
}

class Transport extends EventEmitter {
  constructor({ localAddress = '', sipPort = 0 } = {}) {
    super();
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    // An explicit '' must not become Node's default (which on a dual-stack host can be IPv6 and
    // then refuses to send to an IPv4 literal). Binding 0.0.0.0 keeps everything IPv4.
    this.localAddress = localAddress || '0.0.0.0';
    this.advertisedAddress = localAddress && localAddress !== '0.0.0.0' ? localAddress : defaultLocalAddress();
    this.sipPort = sipPort;           // advertised in Via/Contact when non-zero
    this.address = { address: '0.0.0.0', port: 0, family: 'IPv4' };
    this.peerHints = new Map();       // Call-ID -> {host,port} the far end actually used
    this.transactions = new Map();    // branch|method -> client transaction
    this.responseCache = [];          // retransmitted final responses for a repeated request
    this.closed = false;

    this.socket.on('message', (buf, rinfo) => this.onMessage(buf, rinfo));
    this.socket.on('error', (err) => this.emit('transport_error', err));
  }

  async open() {
    await new Promise((resolve, reject) => {
      const done = (err) => (err ? reject(err) : resolve());
      this.socket.once('error', done);
      this.socket.bind(0, this.localAddress, () => {
        this.socket.removeListener('error', done);
        this.address = this.socket.address();
        resolve();
      });
    });
    return this.address;
  }

  // What goes into Via/Contact/SDP: never the wildcard bind address.
  get host() {
    const bound = this.address?.address;
    if (bound && bound !== '0.0.0.0' && bound !== '::') return bound;
    return this.advertisedAddress;
  }

  get port() { return this.sipPort || this.address?.port || 5060; }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const tx of this.transactions.values()) tx.stop();
    this.transactions.clear();
    try { this.socket.close(); } catch { /* already closed */ }
  }

  static resolveHost(hostname) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return Promise.resolve(hostname);
    return new Promise((resolve, reject) => {
      dns.lookup(hostname, { family: 4, hints: 0 }, (err, address) => (err ? reject(err) : resolve(address)));
    });
  }

  async send(buf, target) {
    const ip = await Transport.resolveHost(target.host);
    await new Promise((resolve, reject) => {
      this.socket.send(buf, 0, buf.length, target.port || 5060, ip, (err) => (err ? reject(err) : resolve()));
    });
    return { host: ip, port: target.port || 5060 };
  }

  // A malformed datagram or a throwing handler must never take the daemon down: it sits on the
  // audio path of a live call, where a crash is worse than a dropped packet.
  onMessage(buf, rinfo) {
    let msg = null;
    try { msg = parse(buf); } catch { return; }
    if (!msg) return;
    msg.remote = { host: rinfo.address, port: rinfo.port };
    if (msg.kind === 'response') this.onResponse(msg, rinfo);
    else this.onRequest(msg, rinfo);
  }

  onResponse(msg, rinfo) {
    const via = msg.first('via') || '';
    const branch = /branch=([^;]+)/.exec(via)?.[1] || '';
    const cseq = parseCSeq(msg);
    const key = `${branch}|${cseq.method}`;
    const tx = this.transactions.get(key);
    // Remember where responses really come from: a carrier behind a proxy answers from an
    // address that is not in its own Via, and re-INVITEs/BYEs must go where the media is.
    const callId = msg.first('call-id');
    if (callId) this.peerHints.set(callId, { host: rinfo.address, port: rinfo.port });
    if (!tx) return this.emit('unmatched_response', msg);

    if (msg.status < 200) {
      tx.stopRetransmit();
      tx.onProvisional?.(msg);
      return;
    }
    tx.stop();
    this.transactions.delete(key);
    tx.onFinal?.(msg);
    this.emit('response', msg);
  }

  onRequest(msg, rinfo) {
    const callId = msg.first('call-id');
    if (callId) this.peerHints.set(callId, { host: rinfo.address, port: rinfo.port });

    // A retransmitted request (same branch+CSeq) gets the cached final response, not a second
    // INVITE: answering twice is how a caller ends up with two audio paths.
    const via = msg.first('via') || '';
    const branch = /branch=([^;]+)/.exec(via)?.[1] || '';
    const key = `${branch}|${msg.method}`;
    if (branch && this.responseCache.some((e) => e.key === key)) {
      const entry = this.responseCache.find((e) => e.key === key);
      entry.at = Date.now();
      this.send(entry.buf, rinfo).catch(() => {});
      return;
    }
    try {
      this.emit('request', msg, {
        reply: (response) => this.replyTo(msg, response, rinfo, key),
        remote: rinfo,
      });
    } catch (e) {
      this.emit('transport_error', e);
    }
  }

  async replyTo(request, response, rinfo, key) {
    const buf = response;
    const status = Number(/^SIP\/2\.0\s+(\d{3})/.exec(buf.toString('utf8'))?.[1] || 0);
    if (key && status >= 200) this.cacheResponse(key, buf, request.first('call-id'));
    const target = addressOf(request, { host: rinfo.address, port: rinfo.port });
    try {
      await this.send(buf, target);
    } catch { /* a lost reply is the far end's retransmit problem */ }
    // 200 OK to an INVITE is retransmitted with Timer G until the ACK arrives, and stops at
    // Timer H either way — a peer that never ACKs must not be shouted at forever.
    if (request.method === 'INVITE' && status >= 200 && status < 300) {
      const entry = this.responseCache[this.responseCache.length - 1];
      entry.stopRetransmit = this.scheduleAckRetransmit(buf, target);
      const guard = setTimeout(() => entry.stopRetransmit?.(), TIMER_H);
      guard.unref?.();
    }
    return target;
  }

  scheduleAckRetransmit(buf, target) {
    let interval = T1;
    let timer = null;
    const tick = () => {
      this.send(buf, target).catch(() => {});
      interval = Math.min(interval * 2, T1 * 64);
      timer = setTimeout(tick, interval);
      timer.unref?.();
    };
    timer = setTimeout(tick, interval);
    timer.unref?.();
    return () => { if (timer) { clearTimeout(timer); timer = null; } };
  }

  cacheResponse(key, buf, callId) {
    this.responseCache.push({ key, buf, callId, at: Date.now(), stopRetransmit: null });
    if (this.responseCache.length > MAX_RESPONSE_CACHE) this.responseCache.shift();
  }

  /** Stop retransmitting the 2xx we sent for this dialog, because the ACK arrived. */
  noteAck(callIdHeader) {
    for (const entry of this.responseCache) {
      if (entry.callId === callIdHeader) { entry.stopRetransmit?.(); entry.stopRetransmit = null; }
    }
  }

  /**
   * Client transaction: send, retransmit while unanswered, and time out honestly.
   * @param {object} o { msg: Buffer, branch, method, target, invite, onProvisional, onFinal, onTimeout }
   */
  request({ msg, branch: explicitBranch, method: explicitMethod, target, invite = false, onProvisional, onFinal, onTimeout }) {
    const key = keyOf({ buf: msg, branch: explicitBranch, method: explicitMethod });
    const tx = {
      key, onProvisional, onFinal, retransmit: null, timeout: null,
      stopRetransmit() { if (this.retransmit) { clearTimeout(this.retransmit); this.retransmit = null; } },
      stop() {
        this.stopRetransmit();
        if (this.timeout) { clearTimeout(this.timeout); this.timeout = null; }
      },
    };
    this.transactions.set(key, tx);
    this.send(msg, target).catch((err) => {
      tx.stop();
      this.transactions.delete(key);
      // A socket that cannot even send must not throw inside a callback chain: report a
      // synthetic transport failure so the call ends with a reason the UI can show.
      const synthetic = { synthetic: true, status: 0, reason: `transport: ${err.message}`, headers: {}, first: () => '' };
      try { onFinal?.(synthetic); } catch { onTimeout?.(); }
    });

    if (!invite) {
      // Timer E/F: retransmit with capped exponential backoff, then give up.
      let interval = T1;
      const retransmit = () => {
        this.send(msg, target).catch(() => {});
        interval = Math.min(interval * 2, 4 * T1);
        tx.retransmit = setTimeout(retransmit, interval);
      };
      tx.retransmit = setTimeout(retransmit, interval);
      tx.timeout = setTimeout(() => {
        tx.stop();
        this.transactions.delete(key);
        onTimeout?.();
      }, TIMER_F);
      return tx;
    }

    // Timer A: double the interval each time until a provisional arrives; Timer B ends it.
    let interval = T1;
    const retransmit = () => {
      this.send(msg, target).catch(() => {});
      interval *= 2;
      tx.retransmit = setTimeout(retransmit, interval);
    };
    tx.retransmit = setTimeout(retransmit, interval);
    tx.timeout = setTimeout(() => {
      tx.stop();
      this.transactions.delete(key);
      onTimeout?.();
    }, TIMER_B);
    const wrapped = tx.onProvisional;
    tx.onProvisional = (m) => { tx.stopRetransmit(); wrapped?.(m); };
    return tx;
  }

  peerFor(callId, fallback) {
    return this.peerHints.get(callId) || fallback;
  }
}

module.exports = { Transport, keyOf, defaultLocalAddress, T1, TIMER_B, TIMER_F, TIMER_H };
