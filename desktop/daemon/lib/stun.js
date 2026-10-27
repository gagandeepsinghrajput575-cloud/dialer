// STUN binding discovery, for the media address in SDP.
//
// Measured on this network: a TLS call connects, the daemon sends RTP, and `wire: 0` — no packets
// ever come back. The carrier sends media strictly to the address in our offer, and behind CGNAT
// `publicIP:localPort` is not a mapping that exists: the ISP rewrites the source port per socket.
// So the offer has to carry the mapping the carrier will actually see, which is what a STUN
// Binding Request from *this* socket returns.
//
// Only the one attribute that matters is parsed (XOR-MAPPED-ADDRESS, RFC 5389 §15.2); a full STUN
// stack would be dead weight in a softphone that asks one question.
'use strict';

const crypto = require('crypto');
const dns = require('dns');

const MAGIC = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const ATTR_MAPPED_ADDRESS = 0x0001;

function bindingRequest() {
  const header = Buffer.alloc(20);
  header.writeUInt16BE(BINDING_REQUEST, 0);
  header.writeUInt16BE(0, 2);
  header.writeUInt32BE(MAGIC, 4);
  crypto.randomBytes(12).copy(header, 8);
  return header;
}

/** @returns {{ip:string, port:number}|null} */
function parseBindingResponse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 20) return null;
  if (buf.readUInt16BE(0) !== BINDING_SUCCESS) return null;
  if (buf.readUInt32BE(4) !== MAGIC) return null;
  let offset = 20;
  const end = Math.min(buf.length, 20 + buf.readUInt16BE(2));
  while (offset + 4 <= end) {
    const type = buf.readUInt16BE(offset);
    const length = buf.readUInt16BE(offset + 2);
    const value = buf.slice(offset + 4, offset + 4 + length);
    if (type === ATTR_XOR_MAPPED_ADDRESS && value.length >= 8) {
      const family = value[1];
      if (family !== 0x01) return null;                       // IPv4 only; text is all this needs
      const port = value.readUInt16BE(2) ^ (MAGIC >>> 16);
      const ip = [
        value[4] ^ ((MAGIC >>> 24) & 0xff),
        value[5] ^ ((MAGIC >>> 16) & 0xff),
        value[6] ^ ((MAGIC >>> 8) & 0xff),
        value[7] ^ (MAGIC & 0xff),
      ].join('.');
      return { ip, port };
    }
    if (type === ATTR_MAPPED_ADDRESS && value.length >= 8) {
      return { ip: `${value[4]}.${value[5]}.${value[6]}.${value[7]}`, port: value.readUInt16BE(2) };
    }
    offset += 4 + length + ((4 - (length % 4)) % 4);
  }
  return null;
}

/**
 * Ask `server` what this socket looks like from outside.
 *
 * Runs on the caller's socket on purpose: a mapping learned from another socket is a different
 * port, which is exactly the mistake that produced `wire: 0` in the first place.
 */
async function discover(socket, { server = 'stun.l.google.com', port = 19302, timeoutMs = 1200 } = {}) {
  const ip = await new Promise((resolve, reject) => {
    dns.lookup(server, { family: 4 }, (err, address) => (err ? reject(err) : resolve(address)));
  });
  const request = bindingRequest();
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeListener('message', onMessage);
      resolve(value);
    };
    const onMessage = (buf) => {
      const mapped = parseBindingResponse(buf);
      if (mapped) finish(mapped);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    socket.on('message', onMessage);
    try {
      socket.send(request, port, ip, () => { /* a lost request simply times out */ });
    } catch {
      finish(null);
    }
  });
}

module.exports = { discover, parseBindingResponse, bindingRequest };
