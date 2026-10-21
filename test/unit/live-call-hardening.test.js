// Live-call hardening — the eight failure modes that killed the browser leg, each pinned.
// Challenge 8 is the project's line ceiling: new code may never exceed 350 lines, and the
// pre-existing oversized modules are a frozen ratchet that may only shrink.
require('../helpers/unit-db');

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parse, serialize, header, buildResponse } = require('../../desktop/sip/message');
const { SipTransport } = require('../../desktop/sip/transport');
const { SipUserAgent } = require('../../desktop/sip/ua');
const { TransactionTable } = require('../../desktop/sip/transaction');

console.log('--- Unit: Live-call hardening (challenges 1–8) ---');

const USER = 'usertanishkarajput43011498';
const DOMAIN = 'sip.telnyx.com';
const CALLER = '+4532331610';
let NOW = Date.UTC(2026, 9, 20, 9, 0, 0);

const invite = (callId = 'h1@telnyx') => [
  'INVITE sip:usertanishkarajput43011498@sip.telnyx.com SIP/2.0',
  'Via: SIP/2.0/UDP 203.0.113.9:5060;branch=z9hG4bK-h1',
  `From: "FlyNumber CPH" <sip:${CALLER}@sip.telnyx.com>;tag=caller-tag`,
  `To: <sip:${USER}@sip.telnyx.com>`,
  `Call-ID: ${callId}`,
  'CSeq: 1 INVITE',
  'Contact: <sip:+4532331610@203.0.113.9:5060>',
  'Content-Length: 0',
  '',
  '',
].join('\r\n');

const reply = (request, status, reason, extra = {}) => {
  const req = typeof request === 'string' ? parse(request) : request;
  const { body = '', ...rest } = extra;
  const to = header(req, 'to');
  return serialize({
    startLine: `SIP/2.0 ${status} ${reason}`,
    headers: {
      via: header(req, 'via'), from: header(req, 'from'),
      to: /;tag=/.test(to) ? to : `${to};tag=server-tag`,
      'call-id': header(req, 'call-id'), cseq: header(req, 'cseq'), ...rest,
    },
    body,
  });
};

function harness({ password = 's3cret', expires = 300, t1 = 500 } = {}) {
  const sent = [];
  const events = [];
  const transport = { start() {}, stop() {}, send(text) { sent.push(text); }, localPort: 5062 };
  const ua = new SipUserAgent({
    config: { user: USER, password, domain: DOMAIN, transport: 'udp', contactHost: '192.0.2.5' },
    transport, now: () => NOW, expires, t1, onEvent: (e) => events.push(e),
  });
  return { ua, sent, events, transport };
}

const lastRequest = (sent, method) => [...sent].reverse().find((m) => m.startsWith(`${method} `)) || '';
const responses = (sent, status) => sent.filter((m) => m.startsWith(`SIP/2.0 ${status} `));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  // ---- Challenge 1: the Telnyx SBC kills an INVITE at 10 s. Both provisional responses must
  // leave the process in the same tick the INVITE is handled — not after a render, not after
  // getUserMedia, not after ICE.
  {
    const { ua, sent } = harness();
    ua.start();
    sent.length = 0;
    const startedAt = Date.now();
    ua.handle(invite());
    const elapsed = Date.now() - startedAt;
    assert.strictEqual(responses(sent, 100).length, 1, '100 Trying is sent first');
    assert.strictEqual(responses(sent, 180).length, 1, '180 Ringing is sent in the same tick');
    assert.ok(elapsed < 1000, `provisional responses took ${elapsed}ms (SBC budget is 10000ms)`);
    assert.ok(responses(sent, 180)[0].indexOf('100') === -1);
    ua.stop();
    console.log('  ✓ Challenge 1 — 100 + 180 Ringing are synchronous, far inside the 10 s SBC window');
  }

  // ---- Challenge 2: answer is explicit about media and can only happen once.
  {
    const { ua, sent } = harness();
    ua.start();
    sent.length = 0;
    ua.handle(invite('h2@telnyx'));
    assert.strictEqual(ua.answer(), true);
    const ok = responses(sent, 200)[0];
    assert.match(ok, /Content-Type: application\/sdp/i);
    assert.match(ok, /m=audio 0 RTP\/AVP 0 8 101/);
    assert.match(ok, /a=inactive/);
    assert.strictEqual(ua.answer(), false);
    assert.strictEqual(responses(sent, 200).length, 1, 'exactly one 200 OK exists');
    ua.stop();
    console.log('  ✓ Challenge 2 — one answer, one 200 OK, media declared as an explicit hold');
  }

  // ---- Challenge 3: every teardown path is idempotent.
  {
    const { ua, sent, events } = harness();
    ua.start();
    sent.length = 0;
    ua.handle(invite('h3@telnyx'));
    ua.answer();
    const bye = serialize({
      startLine: 'BYE sip:pulse@192.0.2.5:5062 SIP/2.0',
      headers: {
        via: 'SIP/2.0/UDP 203.0.113.9:5060;branch=z9hG4bK-bye',
        from: `<sip:${CALLER}@${DOMAIN}>;tag=caller-tag`,
        to: `<sip:${USER}@${DOMAIN}>;tag=local-tag`,
        'call-id': 'h3@telnyx', cseq: '2 BYE',
      },
    });
    ua.handle(bye);
    ua.handle(bye);
    assert.strictEqual(events.filter((e) => e.type === 'ended').length, 1, 'a retried BYE cannot double-log');
    assert.strictEqual(responses(sent, 200).length, 2, 'INVITE + first BYE, never a third');
    assert.strictEqual(ua.handle(bye) !== undefined, true, 'the stray BYE is answered, not thrown');
    ua.stop();
    console.log('  ✓ Challenge 3 — duplicate BYE acknowledged 481/200 without a second ended event');
  }

  // ---- Challenge 4: duration is measured from answer, not from ring.
  {
    const { ua, events } = harness();
    ua.start();
    ua.handle(invite('h4@telnyx'));
    NOW += 12_000;                      // the phone rang for 12 seconds
    ua.answer();
    NOW += 61_400;                      // the conversation
    ua.hangup();
    const ended = events.find((e) => e.type === 'ended');
    assert.strictEqual(ended.durationSec, 61, 'ring time is not billed as talk time');
    assert.strictEqual(ended.reason, 'local');
    ua.stop();
    console.log('  ✓ Challenge 4 — duration excludes ring time and rounds honestly');
  }

  // ---- Challenge 5: DTMF cannot inject SIP syntax or reach a dead dialog.
  {
    const { ua, sent } = harness();
    ua.start();
    sent.length = 0;
    assert.strictEqual(ua.dtmf('5'), false, 'no tone before a dialog exists');
    ua.handle(invite('h5@telnyx'));
    assert.strictEqual(ua.dtmf('5'), false, 'no tone while ringing');
    ua.answer();
    assert.strictEqual(ua.dtmf('5'), true);
    assert.strictEqual(ua.dtmf('X'), false);
    assert.strictEqual(ua.dtmf('\r\nBYE sip:evil SIP/2.0'), false);
    const info = lastRequest(sent, 'INFO');
    assert.match(info, /Content-Type: application\/dtmf-relay/i);
    assert.match(info, /Signal=5\r?\nDuration=160/);
    assert.strictEqual(sent.filter((m) => m.startsWith('INFO ')).length, 1, 'rejected digits never transmit');
    ua.stop();
    console.log('  ✓ Challenge 5 — DTMF validated, CRLF injection refused, exactly one INFO sent');
  }

  // ---- Challenge 6: registration refreshes before expiry and fails closed.
  {
    const { ua, sent, events } = harness({ expires: 300 });
    ua.start();
    ua.handle(reply(sent[0], 401, 'Unauthorized', { 'www-authenticate': 'Digest realm="sip.telnyx.com", nonce="n1", qop="auth"' }));
    ua.handle(reply(lastRequest(sent, 'REGISTER'), 200, 'OK', { contact: `<sip:${USER}@192.0.2.5:5062>;expires=300` }));
    const margin = ua.refreshAt - NOW;
    assert.ok(ua.registered);
    assert.ok(margin > 150_000 && margin <= 300_000, `refresh at ${margin}ms must precede the 300s expiry`);
    assert.ok(events.some((e) => e.type === 'registration' && e.state === 'registered'));

    const rejected = harness();
    rejected.ua.start();
    rejected.ua.handle(reply(rejected.sent[0], 403, 'Forbidden'));
    assert.strictEqual(rejected.ua.registered, false);
    assert.strictEqual(rejected.sent.filter((m) => m.startsWith('REGISTER ')).length, 1);
    rejected.ua.stop();
    ua.stop();
    console.log('  ✓ Challenge 6 — 401 → digest retry → 200 with a pre-expiry refresh; 403 stops dead');
  }

  // ---- Challenge 7: transport framing + T1 retransmission.
  {
    const socket = {
      handlers: {},
      on(event, fn) { (this.handlers[event] = this.handlers[event] || []).push(fn); return this; },
      emit(event, ...args) { (this.handlers[event] || []).forEach((fn) => fn(...args)); },
      bind() { this.emit('listening'); },
      send() {}, close() {}, address() { return { port: 5062 }; },
    };
    const seen = [];
    const transport = new SipTransport({ host: DOMAIN, port: 5060, createSocket: () => socket, onMessage: (m) => seen.push(m) });
    transport.start();
    const full = 'SIP/2.0 200 OK\r\nCall-ID: split\r\nCSeq: 1 REGISTER\r\nContent-Length: 4\r\n\r\nv=0\n';
    socket.emit('data', Buffer.from(full.slice(0, 30)));
    assert.strictEqual(seen.length, 0, 'half a message is not a message');
    socket.emit('data', Buffer.from(full.slice(30)));
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].status, 200);
    assert.strictEqual(seen[0].body, 'v=0\n');
    transport.stop();

    const sent = [];
    const table = new TransactionTable({ send: (text) => sent.push(text), t1: 5 });
    table.add('t1', 1, 'INVITE', 'INVITE sip:x SIP/2.0\r\n\r\n');
    await wait(45);
    assert.ok(sent.length >= 3, `expected T1 backoff retransmits, got ${sent.length}`);
    table.resolve(parse('SIP/2.0 180 Ringing\r\nCall-ID: t1\r\nCSeq: 1 INVITE\r\n\r\n'));
    const settled = sent.length;
    await wait(35);
    assert.strictEqual(sent.length, settled, 'a response stops the retransmission chain');
    table.stop();
    console.log('  ✓ Challenge 7 — split TCP reads reframe; T1 doubling stops on the first response');
  }

  // ---- Challenge 8: the 350-line ceiling. New code is hard-failed; pre-existing debt is a
  // ratchet that may shrink but never grow (see docs/PLAN-NATIVE-DESKTOP.md §5).
  {
    const ROOTS = ['shared', 'src', 'server', 'desktop'];
    const EXT = new Set(['.js', '.jsx', '.mjs', '.ts']);
    const GRANDFATHERED = {
      'src/pages/Dialer.jsx': 2040,
      'src/pages/Recordings.jsx': 1087,
      'src/useWebRtc.js': 971,
      'src/pages/Settings.jsx': 852,
      'src/pages/Recents.jsx': 509,
      'src/webrtcSignalling.js': 418,
      'server/services/emailService.js': 481,
      'server/services/telephonyService.js': 480,
      'server/services/callService.js': 424,
      'server/services/prospectService.js': 417,
    };
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);
        return EXT.has(path.extname(entry.name)) ? [full] : [];
      });
    };
    const root = path.join(__dirname, '..', '..');
    const files = ROOTS.flatMap((dir) => walk(path.join(root, dir)));
    const lines = (file) => {
      const text = fs.readFileSync(file, 'utf8');
      return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    };
    const violations = [];
    const grew = [];
    for (const file of files) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      const count = lines(file);
      const ceiling = GRANDFATHERED[rel];
      if (ceiling === undefined && count > 350) violations.push(`${rel} (${count})`);
      if (ceiling !== undefined && count > ceiling) grew.push(`${rel} (${count} > ${ceiling})`);
    }
    assert.deepStrictEqual(violations, [], `files over 350 lines: ${violations.join(', ')}`);
    assert.deepStrictEqual(grew, [], `grandfathered files grew: ${grew.join(', ')}`);
    const desktop = files.filter((f) => path.relative(root, f).startsWith(`desktop${path.sep}`));
    assert.ok(desktop.length >= 12, 'the desktop layer is present');
    console.log(`  ✓ Challenge 8 — ${files.length} modules checked: every new file ≤350 lines, ${Object.keys(GRANDFATHERED).length} legacy files frozen at their baseline size`);
  }

  console.log('\n🎉 [unit:hardening] challenges 1–8 passed\n');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
