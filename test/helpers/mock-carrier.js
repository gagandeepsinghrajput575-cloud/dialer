// A mock SIP carrier for testing the daemon: UDP, digest auth, INVITE both ways, RTP.
//
// This is the "far end" the daemon talks to in the test suite. It is deliberately literal
// about the protocol — it verifies the digest response instead of waving it through, and it
// retransmits nothing — so a daemon that only works against a forgiving peer fails here.
'use strict';

const dgram = require('dgram');
const crypto = require('crypto');

const md5 = (s) => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');

function parseMessage(text) {
  const [head, ...rest] = String(text).split('\r\n\r\n');
  const lines = head.split('\r\n');
  const startLine = lines.shift();
  const headers = Object.create(null);
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { startLine, headers, body: rest.join('\r\n\r\n'), text: String(text) };
}

function sdp({ ip, port, pt = 0 }) {
  return [
    'v=0', `o=carrier 1 1 IN IP4 ${ip}`, 's=carrier', `c=IN IP4 ${ip}`, 't=0 0',
    `m=audio ${port} RTP/AVP ${pt} 101`, `a=rtpmap:${pt} ${pt === 8 ? 'PCMA' : 'PCMU'}/8000`,
    'a=rtpmap:101 telephone-event/8000', 'a=fmtp:101 0-16', 'a=sendrecv', '',
  ].join('\r\n');
}

class MockCarrier {
  /**
   * @param {object} o { realm, nonce, user, password, codecPt, behaviour }
   *   behaviour: 'answer' (200 after 180), 'busy' (486), 'noanswer' (180 then silence)
   */
  constructor({ realm = 'flynumber', nonce = 'mocknonce123', user = 'alice', password = 'secret', codecPt = 0, behaviour = 'answer' } = {}) {
    this.realm = realm;
    this.nonce = nonce;
    this.user = user;
    this.password = password;
    this.codecPt = codecPt;
    this.behaviour = behaviour;
    this.sip = dgram.createSocket('udp4');
    this.rtp = dgram.createSocket('udp4');
    this.messages = [];          // every SIP *request* received, in order
    this.receivedResponses = []; // every SIP *response* received (e.g. our 180/200 answered)
    this.sent = [];              // every SIP message this carrier sent, in order
    this.rtpReceived = [];       // { payloadType, seq, payload }
    this.registrations = 0;
    this.authFailures = 0;
    this.peer = null;            // where the daemon's SIP comes from
    this.dialog = null;          // { callId, fromTag, toTag, via, cseq, remoteTarget }
    this.answered = false;
    this.onEvent = () => {};
    this.sipPort = 0;
    this.rtpPort = 0;
  }

  async listen() {
    this.sipPort = await bind(this.sip);
    this.rtpPort = await bind(this.rtp);
    this.sip.on('message', (buf, rinfo) => this.onSip(buf.toString('utf8'), rinfo));
    this.rtp.on('message', (buf, rinfo) => this.onRtp(buf, rinfo));
    return { sipPort: this.sipPort, rtpPort: this.rtpPort };
  }

  close() {
    for (const s of [this.sip, this.rtp]) { try { s.close(); } catch { /* already closed */ } }
  }

  // ---- SIP -----------------------------------------------------------------------------
  onSip(text, rinfo) {
    if (!text || text === '\r\n\r\n' || text === '\r\n' || !text.trim()) return;
    this.peer = rinfo;
    const msg = parseMessage(text);
    this.onEvent(msg);
    const method = msg.startLine.split(' ')[0];
    if (/^SIP\/2\.0/.test(msg.startLine)) { this.receivedResponses.push(msg); return this.onResponse(msg); }
    this.messages.push(msg);
    if (method === 'REGISTER') return this.onRegister(msg);
    if (method === 'INVITE') return this.onInvite(msg);
    if (method === 'ACK') { this.ackSeen = true; return; }
    if (method === 'BYE') {
      this.byeSeen = true;
      this.send(msg, 200, 'OK');
      this.onEvent({ synthetic: 'bye' });
      return;
    }
    if (method === 'CANCEL') { this.cancelSeen = true; return this.send(msg, 200, 'OK'); }
    if (method === 'OPTIONS') return this.send(msg, 200, 'OK', { Allow: 'INVITE, ACK, BYE, OPTIONS' });
    this.send(msg, 405, 'Method Not Allowed');
  }

  onRegister(msg) {
    const auth = msg.headers.authorization || '';
    if (!auth) {
      this.send(msg, 401, 'Unauthorized', {
        'WWW-Authenticate': `Digest realm="${this.realm}", nonce="${this.nonce}", qop="auth", algorithm=MD5`,
      });
      return;
    }
    if (!this.digestIsCorrect(msg)) { this.authFailures += 1; return this.send(msg, 403, 'Forbidden'); }
    this.registrations += 1;
    this.send(msg, 200, 'OK', { Expires: msg.headers.expires || '300', Contact: msg.headers.contact });
  }

  // Recompute the response from the credential header: a daemon that hashes the wrong
  // elements (method, uri, nc, cnonce, qop) is refused exactly like a real carrier refuses it.
  digestIsCorrect(msg) {
    const auth = msg.headers.authorization || '';
    const params = {};
    const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g;
    let m;
    while ((m = re.exec(auth)) !== null) params[m[1]] = m[2] !== undefined ? m[2] : m[3].trim();
    if (params.username !== this.user || params.realm !== this.realm || params.nonce !== this.nonce) return false;
    const method = msg.startLine.split(' ')[0];
    const ha1 = md5(`${this.user}:${this.realm}:${this.password}`);
    const ha2 = md5(`${method}:${params.uri}`);
    const expected = params.qop === 'auth'
      ? md5(`${ha1}:${this.nonce}:${params.nc}:${params.cnonce}:auth:${ha2}`)
      : md5(`${ha1}:${this.nonce}:${ha2}`);
    return expected === params.response;
  }

  onInvite(msg) {
    const toTag = crypto.randomBytes(5).toString('hex');
    this.dialog = {
      callId: msg.headers['call-id'], fromTag: /tag=([^;]+)/.exec(msg.headers.from)?.[1] || '',
      toTag, via: msg.headers.via, cseq: msg.headers.cseq, requestUri: msg.startLine.split(' ')[1],
    };
    if (this.behaviour === 'busy') return this.send(msg, 486, 'Busy Here', { To: `${msg.headers.to};tag=${toTag}` });
    this.send(msg, 100, 'Trying');
    this.send(msg, 180, 'Ringing', { To: `${msg.headers.to};tag=${toTag}` });
    if (this.behaviour === 'noanswer') return;
    this.answered = true;
    this.send(msg, 200, 'OK', {
      To: `${msg.headers.to};tag=${toTag}`,
      'Content-Type': 'application/sdp',
      Contact: `<sip:${this.user}@127.0.0.1:${this.sipPort}>`,
    }, {}, sdp({ ip: '127.0.0.1', port: this.rtpPort, pt: this.codecPt }));
  }

  onResponse(msg) {
    // The daemon answering our inbound INVITE.
    const status = Number(/^SIP\/2\.0\s+(\d+)/.exec(msg.startLine)?.[1] || 0);
    this.lastResponseStatus = status;
    if (status === 200 && this.inboundDialog) {
      this.inboundAnswered = true;
      this.sendAck(msg);
    }
  }

  sendAck(msg) {
    const d = this.inboundDialog;
    const request = [
      `ACK ${d.requestUri} SIP/2.0`,
      `Via: ${msg.headers.via}`,
      `From: ${d.from}`,
      `To: ${msg.headers.to}`,
      `Call-ID: ${d.callId}`,
      `CSeq: ${d.cseq.split(' ')[0]} ACK`,
      `Max-Forwards: 70`,
      'Content-Length: 0',
      '', '',
    ].join('\r\n');
    this.sip.send(Buffer.from(request), this.peer.port, this.peer.address);
    this.messages.push(parseMessage(request));
  }

  /** Ring the daemon: an inbound INVITE from a customer. */
  async callIn({ from = '+4520123456', to = this.user } = {}) {
    if (!this.peer) throw new Error('The daemon has not sent anything yet — nothing to invite.');
    const callIdHeader = `${crypto.randomBytes(8).toString('hex')}@carrier`;
    const fromTag = crypto.randomBytes(5).toString('hex');
    const branchId = `z9hG4bK${crypto.randomBytes(6).toString('hex')}`;
    const requestUri = `sip:${to}@127.0.0.1:${this.sipPort}`;
    const fromHeader = `"Customer" <sip:${from}@sip.flynumber.com>;tag=${fromTag}`;
    const cseq = '1 INVITE';
    this.inboundDialog = { callId: callIdHeader, from: fromHeader, cseq, requestUri };
    const body = sdp({ ip: '127.0.0.1', port: this.rtpPort, pt: this.codecPt });
    const invite = [
      `INVITE ${requestUri} SIP/2.0`,
      `Via: SIP/2.0/UDP 127.0.0.1:${this.sipPort};branch=${branchId};rport`,
      'Max-Forwards: 70',
      `From: ${fromHeader}`,
      `To: <sip:${to}@sip.flynumber.com>`,
      `Call-ID: ${callIdHeader}`,
      `CSeq: ${cseq}`,
      `Contact: <sip:${from}@127.0.0.1:${this.sipPort}>`,
      'Content-Type: application/sdp',
      `User-Agent: MockCarrier/1.0`,
      `Content-Length: ${Buffer.byteLength(body)}`,
      '', body,
    ].join('\r\n');
    await send(this.sip, Buffer.from(invite), this.peer);
    this.messages.push(parseMessage(invite));
    return { callId: callIdHeader, branch: branchId };
  }

  /** The customer hangs up. */
  async byeInbound() {
    const d = this.inboundDialog;
    if (!d) return false;
    const bye = [
      `BYE ${d.requestUri} SIP/2.0`,
      `Via: SIP/2.0/UDP 127.0.0.1:${this.sipPort};branch=z9hG4bK${crypto.randomBytes(6).toString('hex')}`,
      `From: ${d.from}`,
      `To: ${this.lastToHeader || d.from}`,
      `Call-ID: ${d.callId}`,
      `CSeq: 2 BYE`,
      'Content-Length: 0',
      '', '',
    ].join('\r\n');
    await send(this.sip, Buffer.from(bye), this.peer);
    this.messages.push(parseMessage(bye));
    return true;
  }

  /** The customer gives up while it is ringing. */
  async cancelInbound() {
    const d = this.inboundDialog;
    if (!d) return false;
    const cancel = [
      `CANCEL ${d.requestUri} SIP/2.0`,
      `Via: SIP/2.0/UDP 127.0.0.1:${this.sipPort};branch=z9hG4bK${crypto.randomBytes(6).toString('hex')}`,
      `From: ${d.from}`,
      `To: <sip:${this.user}@sip.flynumber.com>`,
      `Call-ID: ${d.callId}`,
      `CSeq: ${d.cseq.split(' ')[0]} CANCEL`,
      'Content-Length: 0',
      '', '',
    ].join('\r\n');
    await send(this.sip, Buffer.from(cancel), this.peer);
    this.messages.push(parseMessage(cancel));
    return true;
  }

  send(msg, status, reason, extraHeaders = {}, _unused, body = '') {
    if (!this.peer) return;
    const to = extraHeaders.To || msg.headers.to;
    const lines = [`SIP/2.0 ${status} ${reason}`, `Via: ${msg.headers.via}`, `From: ${msg.headers.from}`, `To: ${to}`];
    for (const [name, value] of Object.entries(extraHeaders)) {
      if (name === 'To' || value === undefined) continue;
      lines.push(`${name}: ${value}`);
    }
    lines.push(`Call-ID: ${msg.headers['call-id']}`, `CSeq: ${msg.headers.cseq}`);
    if (status === 200 && !extraHeaders.Contact) lines.push(`Contact: <sip:${this.user}@127.0.0.1:${this.sipPort}>`);
    if (body) lines.push('Content-Type: application/sdp');
    lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
    if (status >= 200 && msg.startLine.startsWith('INVITE')) this.lastToHeader = to;
    const out = Buffer.from(`${lines.join('\r\n')}\r\n\r\n${body}`);
    // Replies are recorded separately from requests, so "the carrier challenged with 401" and
    // "the daemon sent a REGISTER" stay two distinct, unambiguous assertions.
    this.sent.push(parseMessage(out.toString('utf8')));
    this.sip.send(out, this.peer.port, this.peer.address);
  }

  // ---- RTP -----------------------------------------------------------------------------
  onRtp(buf, rinfo) {
    if (buf.length < 12) return;
    // Where the daemon's media really comes from: the address we send our audio back to.
    if (rinfo) this.daemonRtp = { address: rinfo.address, port: rinfo.port };
    const payloadType = buf[1] & 0x7f;
    this.rtpReceived.push({
      payloadType,
      seq: buf.readUInt16BE(2),
      timestamp: buf.readUInt32BE(4),
      payload: buf.subarray(12),
    });
  }

  /** Send audio to the daemon, so its receive path has something to decode. */
  async sendRtp(bytes, { payloadType = this.codecPt, seq = this.rtpSeq = (this.rtpSeq || 0) + 1, timestamp = seq * 160, marker = false } = {}) {
    const header = Buffer.alloc(12);
    header[0] = 0x80;
    header[1] = (marker ? 0x80 : 0) | payloadType;
    header.writeUInt16BE(seq & 0xffff, 2);
    header.writeUInt32BE(timestamp >>> 0, 4);
    header.writeUInt32BE(0xcafebabe, 8);
    const target = this.daemonRtp;
    if (!target) return false;
    await send(this.rtp, Buffer.concat([header, bytes]), target);
    return true;
  }

  /** Learn where the daemon's media comes from (it sends first, or we learn from its SDP). */
  setDaemonRtp(host, port) { this.daemonRtp = { address: host, port }; }

  // ---- assertions ----------------------------------------------------------------------
  method(name) { return this.messages.filter((m) => m.startLine.startsWith(name)); }
  // Status lines this carrier produced, whether they are still in `sent` or came back to us.
  responses(status) {
    const prefix = `SIP/2.0 ${status}`;
    return [...this.sent, ...this.receivedResponses].filter((m) => m.startLine.startsWith(prefix));
  }
  lastMessage(method) { const list = this.method(method); return list[list.length - 1] || null; }
}

function bind(socket) {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => resolve(socket.address().port));
  });
}

function send(socket, buf, target) {
  return new Promise((resolve, reject) => {
    socket.send(buf, 0, buf.length, target.port, target.address, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = { MockCarrier, parseMessage, sdp, md5 };
