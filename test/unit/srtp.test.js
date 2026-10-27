// SRTP, checked against an independent implementation rather than against itself.
//
// FlyNumber answered a TLS INVITE that offered plain RTP/AVP with 488 / Q.850 cause=88, and the
// same INVITE offering RTP/SAVP + SDES proceeded to 200 OK. So secure media is mandatory on this
// trunk, and a bug here is silent: the call connects and nobody hears anything.
//
// The AES-CM keystream is cross-checked with `openssl enc -aes-128-ctr`, so the crypto is verified
// by something other than the code under test.
const assert = require('assert');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SrtpContext, parseCrypto } = require('../../desktop/daemon/lib/srtp');

let passed = 0;
let failed = 0;
const ok = (m) => { passed++; console.log(`  \u2713 ${m}`); };
const bad = (m) => { failed++; console.log(`  \u2717 ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

const key = crypto.randomBytes(30);

function rtpPacket({ seq, ssrc, payload = Buffer.from([0xd5, 0x00, 0x11, 0x22]), pt = 0 }) {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = pt;
  header.writeUInt16BE(seq, 2);
  header.writeUInt32BE(0x11223344, 4);
  header.writeUInt32BE(ssrc, 8);
  return Buffer.concat([header, payload]);
}

console.log('\n=== VAL-NET-013: SRTP (AES_CM_128_HMAC_SHA1_80) ===\n');

// 1. Key derivation, cross-checked with openssl.
{
  const ctx = new SrtpContext({ key });
  check(ctx.sessionKey.length === 16 && ctx.sessionAuth.length === 20 && ctx.sessionSalt.length === 14,
    'the three session secrets have the lengths RFC 3711 requires');

  let openssl = true;
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { openssl = false; }
  if (openssl) {
    const ssrc = 0xdeadbeef;
    const index = 0x00012345;
    const iv = ctx.ivFor(ssrc, index);
    const zeros = Buffer.alloc(32, 0);
    const mine = ctx.crypt(zeros, ssrc, index);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srtp-'));
    fs.writeFileSync(path.join(tmp, 'zeros'), zeros);
    const theirs = execFileSync('openssl', ['enc', '-aes-128-ctr', '-nopad',
      '-K', ctx.sessionKey.toString('hex'), '-iv', iv.toString('hex'),
      '-in', path.join(tmp, 'zeros')]);
    fs.rmSync(tmp, { recursive: true, force: true });
    check(mine.equals(theirs), 'the AES-CM keystream matches openssl enc -aes-128-ctr');
  } else {
    console.log('  SKIPPED: openssl unavailable, keystream not cross-checked');
  }
}

// 2. Protect / unprotect round-trip.
{
  const sender = new SrtpContext({ key });
  const receiver = new SrtpContext({ key });
  const plain = rtpPacket({ seq: 1000, ssrc: 0x0badcafe });
  const sealed = sender.protect(plain);
  console.log(`  packet ${plain.length} bytes -> ${sealed.length} bytes`);
  check(sealed.length === plain.length + 10, 'a 10-byte authentication tag is appended');
  check(sealed.slice(0, 12).equals(plain.slice(0, 12)), 'the RTP header stays in the clear');
  check(!sealed.slice(12, -10).equals(plain.slice(12)), 'the payload is encrypted');
  const opened = receiver.unprotect(sealed);
  check(opened && opened.equals(plain), 'the receiver recovers the original packet');
}

// 3. Tampering and wrong keys are dropped, never decoded.
{
  const sender = new SrtpContext({ key });
  const receiver = new SrtpContext({ key });
  const sealed = sender.protect(rtpPacket({ seq: 7, ssrc: 42 }));
  const tampered = Buffer.from(sealed);
  tampered[14] ^= 0xff;
  check(receiver.unprotect(tampered) === null, 'a corrupted packet fails authentication and is dropped');

  const stranger = new SrtpContext({ key: crypto.randomBytes(30) });
  check(stranger.unprotect(sender.protect(rtpPacket({ seq: 8, ssrc: 42 }))) === null,
    'a packet from a different key is rejected');
}

// 4. Sequence rollover keeps the 48-bit index correct.
{
  const sender = new SrtpContext({ key });
  const receiver = new SrtpContext({ key });
  const before = sender.protect(rtpPacket({ seq: 0xfffe, ssrc: 9 }));
  const after = sender.protect(rtpPacket({ seq: 0x0001, ssrc: 9 }));
  console.log(`  rollover roc=${sender.roc}`);
  check(sender.roc === 1, 'a sequence wrap advances the rollover counter');
  check(receiver.unprotect(before) && receiver.unprotect(after),
    'packets either side of the wrap still authenticate and decrypt');
}

// 5. SDES parsing.
{
  const line = `1 AES_CM_128_HMAC_SHA1_80 inline:${key.toString('base64')}`;
  const parsed = parseCrypto(line);
  check(parsed && parsed.tag === 1 && parsed.suite === 'AES_CM_128_HMAC_SHA1_80',
    'a carrier crypto line is parsed');
  check(parseCrypto('1 FOO_BAR inline:AAAA') === null, 'an unsupported suite is refused, not guessed');
  check(parseCrypto('') === null, 'an absent crypto line parses to null');
}

assert.strictEqual(failed, 0, `${failed} SRTP check(s) failed`);
console.log(`\n${failed ? '\u{1F4A5}' : '\u{1F389}'} ${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
