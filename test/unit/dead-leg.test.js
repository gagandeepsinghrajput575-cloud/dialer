// A call the far end has abandoned without a BYE.
//
// The normal path — a BYE arrives, the daemon answers 200 and ends the dialog — is covered elsewhere.
// This is the case that leaves the operator talking into a dead line: the carrier's BYE went to a
// Contact the router's ALG had rewritten, or the far end vanished, so nothing tells us the call is over.
//
// The rule has to be conservative. Audio silence is *not* evidence: the other person thinking is not a
// reason to hang up on them. Only "no RTP packets at all" counts, because a live call carries RTP
// continuously (comfort noise fills the pauses).
const assert = require('assert');

const { deadLegReason, DEAD_AIR_MS } = require('../../desktop/daemon/lib/media');

let passed = 0;
let failed = 0;
const ok = (m) => { passed++; console.log(`  \u2713 ${m}`); };
const bad = (m) => { failed++; console.log(`  \u2717 ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

const NOW = 1_700_000_000_000;
const live = (idleMs, received = 50) => ({ stats: { received }, lastRxAt: NOW - idleMs });

console.log('\n=== VAL-MEDIA-018: dead-leg detection (the caller hung up and no BYE arrived) ===\n');

// 1. Nothing to judge.
{
  check(deadLegReason(null, NOW) === null, 'no media yet means no verdict');
  check(deadLegReason({ stats: { received: 0 }, lastRxAt: NOW }, NOW) === null,
    'a call that never received RTP is the one-way-media watchdog case, not a dead leg');
  check(deadLegReason({ stats: { received: 9 } }, NOW) === null,
    'no timestamp means nothing to measure from');
}

// 2. A live call is left alone, however long the other person is quiet.
{
  check(deadLegReason(live(0), NOW) === null, 'RTP arriving right now: keep the call');
  check(deadLegReason(live(5000), NOW) === null, '5 s of quiet: keep the call');
  check(deadLegReason(live(DEAD_AIR_MS - 1), NOW) === null, 'one millisecond short of the threshold: keep it');
}

// 3. Packets stopped altogether: the leg is gone.
{
  const reason = deadLegReason(live(DEAD_AIR_MS + 1200), NOW);
  console.log(`  verdict after ${(DEAD_AIR_MS + 1200) / 1000}s: ${reason}`);
  check(!!reason, 'a call that has received nothing for longer than the threshold is ended');
  check(/no RTP for \d+ s/.test(reason || ''), 'and says how long it has been, for the log');
  check(/16 s/.test(reason || ''), 'in whole seconds a human can read');
}

// 4. The threshold is a real knob (tests drive it in milliseconds), and it stays sane by default.
{
  const stale = live(3000);
  check(deadLegReason(stale, NOW, 2000) !== null, 'an overridden threshold is honoured');
  check(deadLegReason(stale, NOW, 5000) === null, 'and a longer one keeps the call');
  console.log(`  default threshold: ${DEAD_AIR_MS / 1000}s`);
  check(DEAD_AIR_MS >= 10000 && DEAD_AIR_MS <= 20000,
    'the default is long enough for a pause and short enough not to strand the operator (10-20 s)');
}

// 5. The reason this is safe to wire to a hang-up: it maps to a normal end for the UI, so the operator
//    gets the usual chime and the classification step rather than an error dialog.
{
  const { reasonForStatus } = require('../../desktop/daemon/lib/dialog');
  check(reasonForStatus(200) === 'normal', 'a remote hang-up is a normal ending, and so is this one');
}

// 6. And the wiring itself: a confirmed call whose RTP has dried up must actually end, and tell the
//    carrier too — a dialog the trunk still believes is up keeps billing minutes.
(async () => {
  const { EventEmitter } = require('events');
  const { UserAgent } = require('../../desktop/daemon/lib/ua');

  const transport = new EventEmitter();
  transport.host = '203.0.113.7';
  transport.port = 5060;
  transport.localAddress = '0.0.0.0';
  transport.sent = [];
  transport.send = async (buf, target) => { transport.sent.push({ text: String(buf), target }); return target; };
  transport.replyTo = async () => ({});
  transport.peerFor = (_id, fallback) => fallback;
  transport.noteAck = () => {};
  transport.request = () => ({ key: 'k', stop() {}, stopRetransmit() {} });
  transport.close = () => {};

  const audio = {
    name: 'stub', available: () => true, describe: () => ({ name: 'stub' }),
    async open() { return true; }, start() {}, stop() {},
  };
  const ua = new UserAgent({
    transport, audio,
    account: { domain: 'sip.example.test', port: 5060, user: 'agent', password: 'x', callerId: '+4532331610' },
  });
  ua.deadAirMs = 150;                          // drive it in 150 ms, not 15 s

  const ended = [];
  let byeSent = false;
  const media = {
    socket: {}, port: 40000, muted: false, codec: 0,
    session: { packet: () => Buffer.alloc(0), payloadType: 0 },
    stats: { sent: 40, received: 200, dtmf: 0, writeFailures: 0 },
    lastRxAt: Date.now() - 2000,               // it was flowing, then stopped
    send() {}, close() {},
  };
  const dialog = {
    id: 'dead-1', callId: 'dead-1', state: 'confirmed', ended: false, media,
    externalId: null, direction: 'outbound',
    end(reason, info) { this.ended = true; ended.push([reason, info && info.detail]); },
    bye() { byeSent = true; return Promise.resolve(); },
    later() {},
  };

  ua.startPump(dialog);
  await new Promise((r) => setTimeout(r, 400));
  console.log(`  after 400 ms: ended ${JSON.stringify(ended[0] || null)}, BYE sent: ${byeSent}`);
  check(ended.length === 1, 'the call is ended without the operator touching anything');
  check(ended[0] && ended[0][0] === 'remote-ended', 'and ends as a normal remote hang-up, not an error');
  check(/no RTP for \d+ s/.test((ended[0] && ended[0][1]) || ''), 'with the reason in the log detail');
  check(byeSent === true, 'a BYE is sent to the carrier so the trunk stops billing');

  // A call still receiving audio must be left alone.
  const liveEnded = [];
  const liveDialog = {
    id: 'live-1', callId: 'live-1', state: 'confirmed', ended: false,
    media: { ...media, stats: { sent: 40, received: 200, dtmf: 0, writeFailures: 0 }, lastRxAt: Date.now() },
    externalId: null, direction: 'outbound',
    end(reason) { this.ended = true; liveEnded.push(reason); },
    bye() { return Promise.resolve(); },
    later() {},
  };
  ua.startPump(liveDialog);
  const tick = setInterval(() => { liveDialog.media.lastRxAt = Date.now(); }, 30);
  await new Promise((r) => setTimeout(r, 400));
  clearInterval(tick);
  check(liveEnded.length === 0, 'a call whose RTP is still arriving is never ended by this watchdog');

  clearInterval(dialog.deadAirTimer);
  clearInterval(liveDialog.deadAirTimer);
  clearTimeout(dialog.mediaWatchdog);
  clearTimeout(liveDialog.mediaWatchdog);
  ua.close();

  assert.strictEqual(failed, 0, `${failed} dead-leg check(s) failed`);
  console.log(`\n${failed ? '\u{1F4A5}' : '\u{1F389}'} ${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
