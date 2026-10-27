// SIP over TLS: the transport that a SIP ALG cannot rewrite.
//
// Plaintext SIP on this network comes back with the Via sent-by replaced by a CGNAT address whose
// port does not match the real mapping (see current.md §14), which breaks dialog routing and leaves
// the caller waiting until Timer B. TLS is opaque to that ALG, so the only thing left to prove is
// that our own transport is correct: framing, Via/Contact, keep-alives, reconnect and certificate
// checking. That is what this suite does, against a real `tls.createServer`.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');

const { Transport } = require('../../desktop/daemon/lib/transport');
const { serialize } = require('../../desktop/daemon/lib/sipMessage');

let passed = 0;
let failed = 0;
const ok = (m) => { passed++; console.log(`  \u2713 ${m}`); };
const bad = (m) => { failed++; console.log(`  \u2717 ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeCert(dir) {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    '-subj', '/CN=localhost',
  ], { stdio: 'ignore' });
  return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
}

// Same framing rule as the client: headers + Content-Length; bare CRLFs are keep-alives.
function framer(onMessage) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString('utf8');
    const pings = buffer.match(/^(?:\r\n)+/);
    if (pings) buffer = buffer.slice(pings[0].length);
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const lines = buffer.slice(0, end).split('\r\n');
      let len = 0;
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i > 0 && line.slice(0, i).trim().toLowerCase() === 'content-length') {
          len = Number.parseInt(line.slice(i + 1).trim(), 10) || 0;
        }
      }
      const total = end + 4 + len;
      if (buffer.length < total) return;
      const raw = buffer.slice(0, total);
      buffer = buffer.slice(total);
      onMessage(raw);
    }
  };
}

function header(msg, name) {
  const line = String(msg).split('\r\n').find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line ? line.slice(line.indexOf(':') + 1).trim() : '';
}

(async () => {
  console.log('\n=== VAL-NET-011: SIP over TLS transport ===\n');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-tls-'));
  let creds;
  try {
    creds = makeCert(dir);
  } catch (e) {
    console.log(`  SKIPPED: openssl is unavailable (${e.message})`);
    process.exit(0);
  }

  const requests = [];
  const sockets = new Set();
  let connections = 0;
  const dbg = (...a) => { if (process.env.TLS_DEBUG) console.log('   [dbg]', ...a); };
  const server = tls.createServer({ key: creds.key, cert: creds.cert }, (socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', framer((raw) => {
      requests.push(raw);
      const first = raw.split('\r\n')[0];
      const status = first.startsWith('REGISTER') ? '401 Unauthorized' : '200 OK';
      const reply = `SIP/2.0 ${status}\r\n`
        + `Via: ${header(raw, 'via')}\r\n`
        + `From: ${header(raw, 'from')}\r\n`
        + `To: ${header(raw, 'to')};tag=server\r\n`
        + `Call-ID: ${header(raw, 'call-id')}\r\n`
        + `CSeq: ${header(raw, 'cseq')}\r\n`
        + 'Content-Length: 0\r\n\r\n';
      // Deliberately split: proves the client reassembles a message that arrives in pieces.
      dbg('server sees via =', JSON.stringify(header(raw, 'via')));
      dbg('server replies', JSON.stringify(reply.split('\r\n')[0]));
      socket.write(reply.slice(0, 12));
      setTimeout(() => socket.write(reply.slice(12)), 15);
    }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const transport = new Transport({ mode: 'tls', tls: { rejectUnauthorized: false } });
  await transport.open();
  check(transport.viaPrefix === 'SIP/2.0/TLS', 'the transport reports the TLS Via prefix');
  check(transport.via('z9hG4bKabc').startsWith('SIP/2.0/TLS '), 'Via is built as SIP/2.0/TLS');
  check(/;alias$/.test(transport.via('z9hG4bKabc')), 'Via carries alias so the proxy reuses the connection');
  const contact = transport.contactUri({ user: 'alice', domain: 'localhost', port });
  check(/;transport=tls/.test(contact) && !/192\.168|127\.0\.0\.1/.test(contact),
    'Contact advertises the trunk domain with transport=tls, never a private address');

  const register = (callId) => {
    const branch = `z9hG4bK${callId}`;
    const msg = serialize({
      startLine: 'REGISTER sip:localhost SIP/2.0',
      headers: {
        Via: transport.via(branch),
        'Max-Forwards': '70',
        From: '<sip:alice@localhost>;tag=t1',
        To: '<sip:alice@localhost>',
        'Call-ID': `${callId}@pulse`,
        CSeq: '1 REGISTER',
        Contact: `<${transport.contactUri({ user: 'alice', domain: 'localhost', port })}>${transport.contactParams}`,
        Expires: '60',
      },
    });
    return new Promise((resolve) => {
      transport.request({
        msg, branch, method: 'REGISTER', target: { host: '127.0.0.1', port }, invite: false,
        onFinal: resolve,
        onTimeout: () => resolve({ status: 0, timeout: true }),
      });
    });
  };

  // 1. A REGISTER round-trip over TLS, with the response split across writes.
  const first = await register('c1');
  console.log(`  register   : status=${first.status} across ${connections} connection(s)`);
  check(first.status === 401, 'a REGISTER over TLS gets its 401 back (response reassembled)');
  check(connections === 1, 'one connection carries the exchange');
  check(/^Via: SIP\/2\.0\/TLS /m.test(requests[0] || ''), 'the carrier received a TLS Via');
  check(/^Contact: .*;transport=tls>;alias/m.test(requests[0] || ''),
    'the carrier received the TLS Contact with alias');

  // 2. A CRLF keep-alive must not disturb the stream, and the next request still works.
  await transport.send(Buffer.from('\r\n\r\n'), { host: '127.0.0.1', port });
  await sleep(40);
  const second = await register('c2');
  check(second.status === 401, 'a CRLF keep-alive does not corrupt the following message');
  check(connections === 1, 'the keep-alive reused the open connection');

  // 3. Connection loss: the next send dials again (registration's own ladder re-registers).
  for (const socket of sockets) socket.destroy();
  await sleep(80);
  const third = await register('c3');
  console.log(`  reconnect  : status=${third.status} across ${connections} connections`);
  check(third.status === 401, 'a request after the connection drops still completes');
  check(connections === 2, 'the transport reconnected instead of staying dead');

  transport.close();
  for (const socket of sockets) socket.destroy();
  server.close();

  // 4. Certificate checking is on by default: a self-signed cert must be refused.
  const strictServer = tls.createServer({ key: creds.key, cert: creds.cert }, (socket) => socket.on('error', () => {}));
  await new Promise((r) => strictServer.listen(0, '127.0.0.1', r));
  const strict = new Transport({ mode: 'tls' });          // rejectUnauthorized defaults to true
  let refused = null;
  try {
    await strict.send(Buffer.from('\r\n\r\n'), { host: '127.0.0.1', port: strictServer.address().port });
  } catch (e) {
    refused = e;
  }
  console.log(`  strict tls : ${refused ? String(refused.message).split('\n')[0] : 'CONNECTED (bad)'}`);
  check(!!refused, 'a self-signed certificate is refused unless the caller opts out');
  strict.close();
  strictServer.close();
  fs.rmSync(dir, { recursive: true, force: true });

  // 5. UDP is untouched by any of this.
  const udp = new Transport({});
  check(udp.viaPrefix === 'SIP/2.0/UDP', 'UDP remains the default mode');
  udp.close();

  assert.strictEqual(failed, 0, `${failed} TLS transport check(s) failed`);
  console.log(`\n${failed ? '\u{1F4A5}' : '\u{1F389}'} ${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

