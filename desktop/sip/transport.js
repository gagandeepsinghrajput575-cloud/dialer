// SIP over UDP (default) or TCP on port 5060. The native leg talks directly to the carrier's
// edge, which is the whole point: no WebSocket framing, no browser sandbox, no SDP translation.
const dgram = require('dgram');
const net = require('net');
const { parse, frame } = require('./message');

class SipTransport {
  constructor({ host, port = 5060, protocol = 'udp', createSocket = null, onMessage = () => {}, onError = () => {} }) {
    this.host = host;
    this.port = port;
    this.protocol = protocol === 'tcp' ? 'tcp' : 'udp';
    this.createSocket = createSocket;
    this.onMessage = onMessage;
    this.onError = onError;
    this.socket = null;
    this.carry = '';
  }

  get localPort() {
    try {
      const address = this.socket && this.socket.address ? this.socket.address() : null;
      return address && address.port ? address.port : 0;
    } catch {
      return 0;
    }
  }

  start() {
    if (this.socket) return this;
    this.socket = this.createSocket
      ? this.createSocket(this.protocol)
      : this.protocol === 'tcp'
        ? net.createConnection({ host: this.host, port: this.port })
        : dgram.createSocket('udp4');

    this.socket.on('error', (err) => this.onError(err));
    this.socket.on('message', (buf) => this.receive(buf));
    this.socket.on('data', (buf) => this.receive(buf));
    if (this.protocol === 'udp' && typeof this.socket.bind === 'function') {
      this.socket.bind(0, '0.0.0.0');
    }
    return this;
  }

  receive(chunk) {
    this.carry += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    const { messages, rest } = frame(this.carry);
    this.carry = rest;
    for (const raw of messages) {
      try {
        this.onMessage(parse(raw), raw);
      } catch (err) {
        this.onError(err);
      }
    }
  }

  send(text) {
    if (!this.socket) throw new Error('SIP transport is not started');
    if (this.protocol === 'tcp') this.socket.write(text);
    else this.socket.send(Buffer.from(text, 'utf8'), this.port, this.host, (err) => err && this.onError(err));
  }

  stop() {
    const socket = this.socket;
    this.socket = null;
    this.carry = '';
    if (socket && typeof socket.close === 'function') {
      try { socket.close(); } catch { /* already closed */ }
    }
  }
}

module.exports = { SipTransport };
