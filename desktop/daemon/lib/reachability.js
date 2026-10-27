// Is the carrier answering on this network, right now?
//
// A user agent behind a broken SIP ALG fails in the worst possible way: the INVITE leaves, nothing
// comes back, RFC 3261 retransmits until Timer B (64 * T1 = 32 s), and the operator watches
// "Calling…" for half a minute before being told "timeout". Nothing in that is diagnosable.
//
// One OPTIONS settles it. It needs no credentials, has no side effects (FlyNumber answers
// 200 OK), and ANY SIP response — 200, 401, 403 — proves the path is being carried, which is the
// only question worth asking before dialling. A 401 is a healthy answer here: the carrier is
// talking, the credentials are a separate problem.
'use strict';

const crypto = require('crypto');
const dgram = require('dgram');
const dns = require('dns');

const DEFAULT_TIMEOUT_MS = 1500;
const MAX_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 100;

const isIPv4 = (host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

function resolveHost(host) {
  if (isIPv4(host)) return Promise.resolve(host);
  return new Promise((ok, fail) => {
    dns.lookup(host, { family: 4 }, (err, address) => (err ? fail(err) : ok(address)));
  });
}

function optionsRequest({ host, branch, callId, from }) {
  return Buffer.from(
    `OPTIONS sip:${host} SIP/2.0\r\n`
    + `Via: SIP/2.0/UDP ${from};branch=${branch};rport\r\n`
    + 'Max-Forwards: 70\r\n'
    + `To: <sip:${host}>\r\n`
    + `From: <sip:probe@${host}>;tag=${branch}\r\n`
    + `Call-ID: ${callId}\r\n`
    + 'CSeq: 1 OPTIONS\r\n'
    + 'Content-Length: 0\r\n\r\n',
    'utf8',
  );
}

/**
 * Send one OPTIONS and wait, at most `timeoutMs`, for any SIP response.
 *
 * @returns {Promise<{ok:boolean, reason?:string, status?:string, ms:number, host?:string, port?:number, error?:string}>}
 *   `ok` means "a SIP response came back", not "the carrier accepted us".
 */
async function probeCarrier({ host, port = 5060, timeoutMs = DEFAULT_TIMEOUT_MS, localAddress = '0.0.0.0' } = {}) {
  const started = Date.now();
  if (!host) return { ok: false, reason: 'no-host', ms: 0, error: 'No carrier host is configured.' };
  const budget = Math.max(MIN_TIMEOUT_MS, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const target = Number(port) || 5060;

  let ip;
  try {
    ip = await resolveHost(host);
  } catch (e) {
    return { ok: false, reason: 'dns', ms: Date.now() - started, host, port: target,
      error: `Could not resolve ${host}: ${e?.message || e}` };
  }

  const socket = dgram.createSocket('udp4');
  return new Promise((finish) => {
    let settled = false;
    let timer = null;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { socket.close(); } catch { /* already gone */ }
      finish({ ms: Date.now() - started, host, port: target, ...result });
    };

    timer = setTimeout(() => settle({ ok: false, reason: 'timeout' }), budget);
    socket.once('error', (err) => settle({ ok: false, reason: 'socket', error: String(err?.message || err) }));
    socket.on('message', (buf) => {
      const line = String(buf).split('\r\n')[0] || '';
      // Anything that parses as a SIP status line means the path carries SIP. A malformed or
      // unrelated datagram is ignored: it is not evidence either way.
      if (!/^SIP\/2\.0\s+\d{3}/.test(line.trim())) return;
      settle({ ok: true, status: line.trim() });
    });

    socket.bind(0, localAddress, () => {
      if (settled) return;
      const from = `${socket.address().address === '0.0.0.0' ? '0.0.0.0' : socket.address().address}:${socket.address().port}`;
      const branch = `z9hG4bK${crypto.randomBytes(6).toString('hex')}`;
      const callId = `${crypto.randomBytes(6).toString('hex')}@pulse-probe`;
      try {
        socket.send(optionsRequest({ host, branch, callId, from }), target, ip);
      } catch (e) {
        settle({ ok: false, reason: 'send', error: String(e?.message || e) });
      }
    });
  });
}

module.exports = { probeCarrier, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS };
