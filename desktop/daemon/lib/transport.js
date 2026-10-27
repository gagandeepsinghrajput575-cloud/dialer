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
const tls = require('tls');
const { EventEmitter } = require('events');
const { parse, addressOf, parseCSeq, buildUri } = require('./sipMessage');

// The transaction key a serialized request belongs to. Re-parsing our own bytes would work but
// costs a parse per retransmit; the builder already knows both values, so it passes them.
function keyOf({ buf, branch: explicitBranch, method: explicitMethod }) {
  if (explicitBranch && explicitMethod) return `${explicitBranch}|${explicitMethod.toUpperCase()}`;
  const msg = parse(buf);
  const branch = explicitBranch || /branch=([^;]+)/.exec(String(msg?.first('via') || ''))?.[1] || '';
  const method = explicitMethod || (msg?.kind === 'request' ? msg.method : parseCSeq(msg).method);
  return `${branch}|${String(method).toUpperCase()}`;
}

/**
 * `Via` for a request, from any transport-shaped object.
 *
 * These two helpers keep the message builders ignorant of which channel they are talking to, and
 * keep the hand-rolled transport doubles in the test suite (written before the TLS work) working:
 * anything without `via()`/`contactUri()` is treated as the UDP transport it was written as.
 */
function viaOf(transport, branch) {
  if (transport && typeof transport.via === 'function') return transport.via(branch);
  return `SIP/2.0/UDP ${transport.host}:${transport.port};rport;branch=${branch}`;
}

/** `<Contact>` plus its header params (`;alias` over TLS), from any transport-shaped object. */
function contactOf(transport, { user, domain, port } = {}) {
  if (transport && typeof transport.contactUri === 'function') {
    return `<${transport.contactUri({ user, domain, port })}>${transport.contactParams || ''}`;
  }
  return `<${buildUri({ user, host: transport.host, port: transport.port })}>`;
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
  /**
   * @param {object} o
   * @param {'udp'|'tls'} [o.mode]  UDP behaves exactly as before; TLS is opt-in.
   * @param {object} [o.tls] extra options for tls.connect (a `ca` bundle, a shorter connect
   *   timeout). `rejectUnauthorized: false` exists for the test harness, not for production.
   */
  constructor({ localAddress = '', sipPort = 0, mode = 'udp', tls: tlsOptions = null } = {}) {
    super();
    this.mode = mode === 'tls' ? 'tls' : 'udp';
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
    this.bound = false;

    // TLS: one long-lived connection, opened lazily on the first send. No per-message NAT mapping
    // for a SIP ALG to corrupt, which is the entire point of the mode.
    this.tlsOptions = tlsOptions || {};
    this.socket = null;               // dgram socket in udp mode, tls socket in tls mode
    this.connected = false;
    this.connecting = null;
    this.buffer = '';                 // stream reassembly, TLS only
    this.remoteHost = '';
    this.remotePort = 0;
    if (this.mode === 'udp') this.initUdp();
  }

  initUdp() {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    this.socket = socket;
    socket.on('message', (buf, rinfo) => this.onMessage(buf, rinfo));
    socket.on('error', (err) => this.emit('transport_error', err));
  }

  /** Switch transport at runtime, before the first REGISTER (credentials arrive after boot). */
  setMode(mode) {
    const next = mode === 'tls' ? 'tls' : 'udp';
    if (next === this.mode) return this.mode;
    for (const tx of this.transactions.values()) tx.stop();
    this.transactions.clear();
    try { this.mode === 'tls' ? this.socket?.destroy() : this.socket?.close(); } catch { /* gone */ }
    this.socket = null;
    this.connected = false;
    this.connecting = null;
    this.buffer = '';
    this.bound = false;
    this.mode = next;
    if (next === 'udp') this.initUdp();
    return this.mode;
  }

  async open() {
    if (this.mode === 'tls' || this.bound) return this.address;
    await new Promise((resolve, reject) => {
      const done = (err) => (err ? reject(err) : resolve());
      this.socket.once('error', done);
      this.socket.bind(0, this.localAddress, () => {
        this.socket.removeListener('error', done);
        this.address = this.socket.address();
        this.bound = true;
        resolve();
      });
    });
    return this.address;
  }

  /** `SIP/2.0/UDP` or `SIP/2.0/TLS`, for every Via we build. */
  get viaPrefix() { return this.mode === 'tls' ? 'SIP/2.0/TLS' : 'SIP/2.0/UDP'; }

  // What goes into Via/Contact/SDP: never the wildcard bind address.
  get host() {
    if (this.mode === 'tls') return this.remoteHost || this.advertisedAddress;
    const bound = this.address?.address;
    if (bound && bound !== '0.0.0.0' && bound !== '::') return bound;
    return this.advertisedAddress;
  }

  get port() {
    if (this.mode === 'tls') return this.remotePort || this.sipPort || 5061;
    return this.sipPort || this.address?.port || 5060;
  }

  /**
   * A Via for a request we originate.
   *
   * `alias` (RFC 5923) asks the proxy to reuse this connection for everything addressed to us,
   * which is what lets in-dialog requests reach a client behind NAT.
   */
  via(branch) {
    if (this.mode === 'tls') return `SIP/2.0/TLS ${this.host}:${this.port};rport;branch=${branch};alias`;
    return `SIP/2.0/UDP ${this.host}:${this.port};rport;branch=${branch}`;
  }

  /**
   * Contact for REGISTER/INVITE. Over UDP it stays the LAN address the router forwards to. Over
   * TLS a private address is meaningless to the carrier, so advertise the trunk's own domain and
   * let `alias` route the dialog back down this connection.
   */
  contactUri({ user, domain, port } = {}) {
    if (this.mode === 'tls') {
      return buildUri({ user, host: domain || this.host, port: port || this.port, params: { transport: 'tls' } });
    }
    return buildUri({ user, host: this.host, port: this.port });
  }

  /** `;alias` has to follow the Contact for TLS; empty otherwise. */
  get contactParams() { return this.mode === 'tls' ? ';alias' : ''; }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const tx of this.transactions.values()) tx.stop();
    this.transactions.clear();
    if (this.mode === 'tls') {
      this.connected = false;
      try { this.socket?.destroy(); } catch { /* already gone */ }
      this.socket = null;
      return;
    }
    try { this.socket.close(); } catch { /* already closed */ }
  }

  static resolveHost(hostname) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return Promise.resolve(hostname);
    return new Promise((resolve, reject) => {
      dns.lookup(hostname, { family: 4, hints: 0 }, (err, address) => (err ? reject(err) : resolve(address)));
    });
  }

  async send(buf, target) {
    if (this.mode === 'tls') return this.sendTls(buf, target);
    if (!this.bound) await this.open();
    const ip = await Transport.resolveHost(target.host);
    await new Promise((resolve, reject) => {
      this.socket.send(buf, 0, buf.length, target.port || 5060, ip, (err) => (err ? reject(err) : resolve()));
    });
    return { host: ip, port: target.port || 5060 };
  }

  async sendTls(buf, target = {}) {
    await this.ensureConnected(target);
    await new Promise((resolve, reject) => {
      this.socket.write(buf, (err) => (err ? reject(err) : resolve()));
    });
    // The target is ignored on a connection-oriented transport: the connection *is* the route,
    // which is exactly why the ALG has nothing to rewrite.
    return { host: this.remoteHost, port: this.remotePort };
  }

  async ensureConnected(target = {}) {
    if (this.socket && this.connected && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    const host = target.host || this.remoteHost;
    const port = Number(target.port) || this.remotePort || this.sipPort || 5061;
    if (!host) throw new Error('transport: no SIP host to connect yet');
    this.connecting = (async () => {
      const ip = await Transport.resolveHost(host);
      await new Promise((resolve, reject) => {
        const socket = tls.connect({
          host: ip,
          port,
          // SNI and certificate identity are the domain, never the resolved IP (RFC 6066 forbids
          // an IP literal here, and the carrier's certificate names the domain anyway).
          ...(/^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? {} : { servername: host }),
          rejectUnauthorized: this.tlsOptions.rejectUnauthorized !== false,
          ...(this.tlsOptions.ca ? { ca: this.tlsOptions.ca } : {}),
        });
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error(`TLS connect to ${host}:${port} timed out`));
        }, Number(this.tlsOptions.connectTimeoutMs) || 8000);
        timer.unref?.();
        const fail = (err) => {
          clearTimeout(timer);
          this.connected = false;
          this.emit('transport_error', err);
          reject(err);
        };
        socket.once('error', fail);
        socket.once('secureConnect', () => {
          clearTimeout(timer);
          socket.removeListener('error', fail);
          socket.setNoDelay(true);
          socket.on('data', (chunk) => this.onStream(chunk));
          socket.on('error', (err) => {
            this.connected = false;
            this.emit('transport_error', err);
          });
          socket.on('close', () => {
            // The next send() dials again; registration's retry ladder re-registers.
            this.connected = false;
            this.buffer = '';
            this.emit('transport_closed');
          });
          this.socket = socket;
          this.connected = true;
          this.remoteHost = host;
          this.remotePort = port;
          resolve();
        });
      });
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  /**
   * Reassemble SIP messages from a TCP/TLS byte stream.
   *
   * A stream has no message boundaries, so each message is framed by its headers plus the
   * `Content-Length` inside them. A lone CRLF (or a run of them) is an RFC 5626 keep-alive and is
   * discarded; a partial message stays buffered until the rest arrives, and several messages in
   * one chunk are all dispatched.
   */
  onStream(chunk) {
    this.buffer += chunk.toString('utf8');
    this.buffer = this.buffer.replace(/^(?:\r\n)+/, '');
    for (;;) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const lines = this.buffer.slice(0, end).split('\r\n');
      const startLine = lines[0] || '';
      if (!startLine) { this.buffer = this.buffer.slice(end + 4); continue; }
      let length = 0;
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i <= 0) continue;
        const name = line.slice(0, i).trim().toLowerCase();
        if (name === 'content-length' || name === 'l') {
          length = Number.parseInt(line.slice(i + 1).trim(), 10) || 0;
        }
      }
      const total = end + 4 + length;
      if (this.buffer.length < total) return;      // wait for the body
      const raw = this.buffer.slice(0, total);
      this.buffer = this.buffer.slice(total);
      this.onMessage(Buffer.from(raw, 'utf8'), { address: this.remoteHost, port: this.remotePort });
    }
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
    // RFC 3261 §17.1.1.2: a reliable transport does not retransmit. The connection either
    // delivers the request or closes, and the registration ladder / preflight handle that.
    const reliable = this.mode === 'tls';
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
      if (!reliable) {
        let interval = T1;
        const retransmit = () => {
          this.send(msg, target).catch(() => {});
          interval = Math.min(interval * 2, 4 * T1);
          tx.retransmit = setTimeout(retransmit, interval);
        };
        tx.retransmit = setTimeout(retransmit, interval);
      }
      tx.timeout = setTimeout(() => {
        tx.stop();
        this.transactions.delete(key);
        onTimeout?.();
      }, TIMER_F);
      return tx;
    }

    // Timer A: double the interval each time until a provisional arrives; Timer B ends it.
    if (!reliable) {
      let interval = T1;
      const retransmit = () => {
        this.send(msg, target).catch(() => {});
        interval *= 2;
        tx.retransmit = setTimeout(retransmit, interval);
      };
      tx.retransmit = setTimeout(retransmit, interval);
    }
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

module.exports = { Transport, keyOf, defaultLocalAddress, viaOf, contactOf, T1, TIMER_B, TIMER_F, TIMER_H };
