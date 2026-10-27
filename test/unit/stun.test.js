// STUN, verified against a server that lies in a controlled way.
//
// The reason this exists at all: a TLS call connected and `wire: 0` — the carrier sent media to the
// address in our SDP, and behind CGNAT that has to be the mapping STUN reports, not our local port.
// A wrong XOR decode here is a silent black hole, so the parse is tested against hand-built bytes.
const assert = require('assert');
const dgram = require('dgram');

const { discover, parseBindingResponse, bindingRequest } = require('../../desktop/daemon/lib/stun');

let passed = 0;
let failed = 0;
const ok = (m) => { passed++; console.log(`  \u2713 ${m}`); };
const bad = (m) => { failed++; console.log(`  \u2717 ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

const MAGIC = 0x2112a442;

function xorMapped(ip, port, { legacy = false } = {}) {
  const value = Buffer.alloc(8);
  value[1] = 0x01;                                   // IPv4
  value.writeUInt16BE(legacy ? port : port ^ (MAGIC >>> 16), 2);
  const octets = ip.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    value[4 + i] = legacy ? octets[i] : octets[i] ^ ((MAGIC >>> (24 - 8 * i)) & 0xff);
  }
  const attr = Buffer.alloc(4);
  attr.writeUInt16BE(legacy ? 0x0001 : 0x0020, 0);
  attr.writeUInt16BE(8, 2);
  return Buffer.concat([attr, value]);
}

function response(attrs, type = 0x0101) {
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(attrs.length, 2);
  header.writeUInt32BE(MAGIC, 4);
  return Buffer.concat([header, attrs]);
}

console.log('\n=== VAL-NET-014: STUN binding discovery ===\n');

// 1. The request is a well-formed Binding Request.
{
  const req = bindingRequest();
  check(req.length === 20 && req.readUInt16BE(0) === 0x0001 && req.readUInt16BE(2) === 0,
    'a 20-byte Binding Request with no attributes');
  check(req.readUInt32BE(4) === MAGIC, 'it carries the magic cookie');
}

// 2. XOR-MAPPED-ADDRESS decoding (RFC 5389 §15.2).
{
  const parsed = parseBindingResponse(response(xorMapped('203.0.113.7', 51234)));
  console.log(`  xor-mapped : ${parsed?.ip}:${parsed?.port}`);
  check(parsed && parsed.ip === '203.0.113.7' && parsed.port === 51234,
    'the XOR-mapped address decodes to the real ip:port');
  const legacy = parseBindingResponse(response(xorMapped('198.51.100.9', 40000, { legacy: true })));
  check(legacy && legacy.ip === '198.51.100.9' && legacy.port === 40000,
    'a legacy MAPPED-ADDRESS is accepted too');
  check(parseBindingResponse(Buffer.from([1, 2, 3])) === null, 'a short datagram is not mistaken for a response');
  check(parseBindingResponse(response(Buffer.alloc(0), 0x0111)) === null,
    'an error response yields nothing rather than a bogus mapping');
}

// 3. Against a real UDP server: the mapping comes back through the same socket it was asked from.
(async () => {
  const server = dgram.createSocket('udp4');
  let seenFrom = null;
  server.on('message', (buf, rinfo) => {
    seenFrom = rinfo.port;
    server.send(response(xorMapped('192.0.2.55', 60001)), rinfo.port, rinfo.address);
  });
  await new Promise((r) => server.bind(0, '127.0.0.1', r));
  const socket = dgram.createSocket('udp4');
  await new Promise((r) => socket.bind(0, '0.0.0.0', r));
  const mapped = await discover(socket, { server: '127.0.0.1', port: server.address().port, timeoutMs: 800 });
  console.log(`  discovered : ${mapped?.ip}:${mapped?.port}`);
  check(mapped && mapped.ip === '192.0.2.55' && mapped.port === 60001, 'discover() returns the mapping');
  check(seenFrom === socket.address().port, 'the request came from the caller\'s own socket');

  // 4. Silence is a null, never a hang or a guess.
  const started = Date.now();
  const none = await discover(socket, { server: '127.0.0.1', port: server.address().port + 1, timeoutMs: 300 });
  check(none === null && Date.now() - started < 1500, 'no answer means null, bounded by the timeout');
  socket.close();
  server.close();

  assert.strictEqual(failed, 0, `${failed} STUN check(s) failed`);
  console.log(`\n${failed ? '\u{1F4A5}' : '\u{1F389}'} ${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
})();
