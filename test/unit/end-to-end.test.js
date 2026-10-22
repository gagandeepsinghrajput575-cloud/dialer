// End to end: the real daemon process, a real carrier on a real UDP socket, and the real renderer
// engine consuming the daemon's *actual* output.
//
// Every other suite tests one half of this system. `sip-daemon.test.js` proves the daemon speaks
// SIP correctly and throws its events away. The chaos suite proves the renderer handles events and
// invents their shape itself. Neither can see the seam — and the seam is where a call silently
// fails to be placed, because a field the daemon calls `callerPhone` and the renderer calls
// `caller` does not throw. It just rings with "Unknown", or does not ring at all.
//
// So this suite captures the bytes the daemon really emitted and replays them into the real
// renderer, then asserts on what the operator would have seen. Check 9 is the structural one: it
// compares every event name the daemon produced against every `case` the renderer has, so an event
// added to one side and not the other fails here instead of in front of a customer.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON test/unit/end-to-end.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../helpers/telephony-mocks');
const g711 = require('../../desktop/daemon/lib/g711');
const { boot, bootRegistered, teardown, dial, toneFrames } = require('../helpers/daemon-harness');

const ok = (v, m) => assert.ok(v, m);
const ck = (a, b, m) => assert.deepStrictEqual(a, b, m);

/** Every event name the renderer's onEvent switch actually handles, read from its source. */
function rendererCases() {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'nativeSip.js'), 'utf8');
  const body = src.slice(src.indexOf('const onEvent = (msg)'));
  const handled = new Set();
  for (const m of body.matchAll(/case '([a-z_]+)':/g)) handled.add(m[1]);
  return handled;
}

/**
 * The carrier sends audio back to the address our RTP actually arrived from, which it only learns
 * once the daemon's pump has sent a packet. Sending before that returns false and silently delivers
 * nothing — which is how a check can pass while proving nothing. Returns true once the path exists.
 */
async function waitForRtpPath(t, ms = 3000) {
  const started = Date.now();
  while (!t.carrier.daemonRtp && Date.now() - started < ms) await new Promise((r) => setTimeout(r, 20));
  return !!t.carrier.daemonRtp;
}

/**
 * The events the renderer's `default:` case says it ignores on purpose, parsed out of its own
 * comment. Deriving this rather than hardcoding it is the whole point: an event the daemon emits
 * that the renderer neither handles nor has written down is a silent drop, and check 9 fails on it.
 */
function documentedIgnores() {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'nativeSip.js'), 'utf8');
  const m = /default: break;\s*\/\/([^\n]*)/.exec(src);
  const names = new Set();
  if (m) for (const q of m[1].matchAll(/'([a-z_]+)'/g)) names.add(q[1]);
  return names;
}

/** Replay real daemon events into a real renderer engine, returning what the UI would have shown. */
async function replay(events, reply) {
  const built = await M.withNative(reply || (() => ({ ok: true })));
  for (const e of events) {
    if (e && e.event) built.engine.onEvent(e);
    await M.tick();
  }
  return built;
}

const eventsOf = (t, ...names) => t.events.filter((e) => names.includes(e.event));

const checks = [
  [1, 'the daemon registers with a real carrier over real UDP, surviving the 401 challenge', async () => {
    const t = await bootRegistered();
    try {
      ok(t.carrier.method('REGISTER').length >= 2, 'a challenged REGISTER is retried with the digest');
      const ok200 = t.carrier.responses(200).filter((m) => /REGISTER/.test(String(m.cseq || '')));
      ok(t.events.some((e) => e.event === 'registered'), 'the daemon reports registered');
      const reg = t.events.find((e) => e.event === 'registered');
      ok(typeof reg.account === 'string' && reg.account.length > 0, `registered carries the account: ${JSON.stringify(reg)}`);
      ok(Number.isFinite(reg.expires), `registered carries a numeric expires: ${JSON.stringify(reg)}`);
      ok(ok200.length >= 1 || t.carrier.responses(200).length >= 1, 'the carrier answered 200 OK');
    } finally { await teardown(t); }
  }],

  [2, 'an outbound dial puts a real INVITE on the wire and the carrier answers it', async () => {
    const t = await bootRegistered({ behaviour: 'answer' });
    try {
      const { callId, connected } = await dial(t);
      ok(callId !== undefined && callId !== null, `dial returned a callId: ${JSON.stringify(callId)}`);
      const invites = t.carrier.method('INVITE');
      ok(invites.length >= 1, 'the INVITE reached the carrier');
      ok(/INVITE sip:\+4520123456@/.test(invites[0].startLine), invites[0].startLine);
      ok(t.carrier.method('ACK').length >= 1, 'the 200 OK was acknowledged — without it the carrier drops the call');
      ck(connected.event, 'connected');
      ok(Number.isFinite(connected.callId), `connected carries the callId the renderer hangs up with: ${JSON.stringify(connected)}`);
      ck(connected.direction, 'outbound');
    } finally { await teardown(t); }
  }],

  [3, 'audio actually flows outbound: the carrier receives decodable RTP from the daemon', async () => {
    const t = await bootRegistered({ behaviour: 'answer' });
    try {
      await dial(t);
      await M.tick();
      await new Promise((r) => setTimeout(r, 400));       // ~20 frames of 20 ms
      const audio = t.audioPackets();
      ok(audio.length > 0, `the carrier received no audio RTP at all (total packets ${t.countRtp()})`);
      ok(audio.every((p) => p.payloadType === 0), 'every audio packet uses the negotiated payload type');
      const seqs = audio.map((p) => p.seq);
      ck(new Set(seqs).size, seqs.length, 'sequence numbers are unique — no packet is sent twice');
      ok(seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1 || s === 0), `sequence numbers increment: ${seqs.slice(0, 8)}`);
    } finally { await teardown(t); }
  }],

  [4, 'audio flows inbound too: the daemon counts RTP the carrier sends it', async () => {
    const t = await bootRegistered({ behaviour: 'answer' });
    try {
      await dial(t);
      ok(await waitForRtpPath(t), 'the carrier never learned where to send our audio back');
      const sent = [];
      for (const frame of toneFrames(6)) sent.push(await t.carrier.sendRtp(g711.encode(frame, 0)));
      ok(sent.every(Boolean), `RTP was not actually delivered to the daemon: ${JSON.stringify(sent)}`);
      await new Promise((r) => setTimeout(r, 300));
      const levels = eventsOf(t, 'audio_level');
      ok(levels.length > 0, 'no audio_level events during a live call');
      const peak = Math.max(...levels.map((l) => l.output));
      ok(peak > 0,
        `a 440 Hz tone arrived and the daemon's receive meter stayed at ${peak} — `
        + 'the decode path is dead, so the operator would hear nothing');
      ok(levels.every((l) => Number.isFinite(l.input) && Number.isFinite(l.output)),
        `audio_level must carry numbers the renderer can meter: ${JSON.stringify(levels[levels.length - 1])}`);
    } finally { await teardown(t); }
  }],

  [5, 'hang-up sends a BYE the carrier actually receives', async () => {
    const t = await bootRegistered({ behaviour: 'answer' });
    try {
      const { callId } = await dial(t);
      ck(t.carrier.method('BYE').length, 0, 'nothing is torn down while the call is up');
      const res = await t.command('hangup', { callId });
      ck(res.ok, true, `hangup refused: ${JSON.stringify(res)}`);
      await new Promise((r) => setTimeout(r, 200));
      ok(t.carrier.method('BYE').length >= 1, 'the carrier never saw a BYE — it would keep the leg open');
      const ended = t.events.filter((e) => e.event === 'ended');
      ck(ended.length, 1, 'exactly one ended event, or the call is logged twice');
      ck(ended[0].reason, 'normal');
    } finally { await teardown(t); }
  }],

  [6, 'a real inbound call rings the renderer with the caller\'s number, not "Unknown"', async () => {
    const t = await boot({ behaviour: 'answer' });
    try {
      await t.waitFor((e) => e.event === 'registered', 5000, 'registration');
      await t.carrier.callIn({ from: '+4520123456' });
      const incoming = await t.waitFor((e) => e.event === 'incoming', 5000, 'the incoming event');
      ok(incoming.callerPhone, `incoming carries no callerPhone: ${JSON.stringify(incoming)}`);
      ok(Number.isFinite(incoming.callId) || typeof incoming.callId === 'string',
        `incoming carries the callId the renderer answers with: ${JSON.stringify(incoming)}`);

      const { engine, st, drop } = await replay(eventsOf(t, 'ready', 'registered', 'incoming'));
      ok(st.incoming, 'the renderer did not raise an incoming call');
      ck(st.incoming.native, true);
      ok(/\d/.test(st.incoming.callerNumber), `the ring shows a number, got "${st.incoming.callerNumber}"`);
      ok(st.incoming.callerNumber !== 'Unknown',
        `the caller's number did not survive the trip: daemon said "${incoming.callerPhone}", UI shows "${st.incoming.callerNumber}"`);
      engine.dispose(); drop();
    } finally { await teardown(t); }
  }],

  [7, 'answering a real inbound call produces a 200 OK the carrier accepts, with media both ways', async () => {
    const t = await boot({ behaviour: 'answer' });
    try {
      await t.waitFor((e) => e.event === 'registered', 5000, 'registration');
      await t.carrier.callIn({ from: '+4520999999' });
      const incoming = await t.waitFor((e) => e.event === 'incoming', 5000, 'incoming');
      const res = await t.command('answer', { callId: incoming.callId });
      ck(res.ok, true, `answer refused: ${JSON.stringify(res)}`);
      const connected = await t.waitFor((e) => e.event === 'connected', 5000, 'connected');
      ck(connected.direction, 'inbound');
      ok(t.carrier.responses(200).length >= 1, 'the carrier got a 200 OK');
      const acks = t.carrier.method('ACK');
      ok(acks.length >= 1, 'and the carrier acknowledged it');
      await new Promise((r) => setTimeout(r, 300));
      ok(t.audioPackets().length > 0, `no audio reached the carrier on an answered inbound call (${t.countRtp()} packets total)`);
    } finally { await teardown(t); }
  }],

  [8, 'the renderer drives a real call: dial, connect, hang up — through the daemon\'s own events', async () => {
    const t = await bootRegistered({ behaviour: 'answer' });
    try {
      const { callId } = await dial(t);
      await new Promise((r) => setTimeout(r, 200));
      const live = eventsOf(t, 'ready', 'registered', 'dialing', 'ringing', 'connected');
      const { engine, st, fired, drop } = await replay(live);
      ck(st.state, 'active', `the renderer never went active; events were ${live.map((e) => e.event).join(',')}`);
      ck(st.direction, 'outbound');
      ok(engine.live && engine.live.callId === callId,
        `the renderer holds the callId it must hang up with: ${JSON.stringify(engine.live)} vs ${callId}`);
      ok(fired.some((f) => f[0] === 'active'), 'onActive fired, which is what starts the agent\'s call timer');

      await t.command('hangup', { callId });
      await new Promise((r) => setTimeout(r, 200));
      const { engine: e2, st: st2, drop: drop2 } = await replay(eventsOf(t, 'ready', 'registered', 'dialing', 'connected', 'ended'));
      ck(st2.state, 'ended', 'the renderer did not report the call ending');
      ck(e2.live, null, 'and it let go of the call');
      engine.dispose(); drop(); e2.dispose(); drop2();
    } finally { await teardown(t); }
  }],

  [9, 'every event the daemon really emits is one the renderer handles — nothing falls through', async () => {
    const t = await bootRegistered({ behaviour: 'answer' });
    let produced;
    try {
      await dial(t);
      ok(await waitForRtpPath(t), 'no RTP path for the lifecycle under test');
      await t.carrier.sendRtp(g711.encode(toneFrames(2)[0], 0));
      await new Promise((r) => setTimeout(r, 300));
      await t.command('hangup', {});
      await new Promise((r) => setTimeout(r, 200));
      produced = [...new Set(t.events.map((e) => e.event).filter(Boolean))];
    } finally { await teardown(t); }

    const handled = rendererCases();
    ok(handled.size > 10, `the renderer's switch was not read correctly (${handled.size} cases)`);
    const ignorable = documentedIgnores();
    ok(ignorable.size >= 2, `the renderer's default case no longer documents what it ignores: ${[...ignorable]}`);
    const dropped = produced.filter((e) => !handled.has(e) && !ignorable.has(e));
    ck(dropped, [], `the daemon emitted events the renderer neither handles nor documents: ${dropped.join(', ')}`);
    ok(produced.includes('connected') && produced.includes('ended'),
      `the lifecycle under test was incomplete: ${produced.join(',')}`);
  }],

  [10, 'the real audio_level event moves the renderer\'s meter — the field names must agree', async () => {
    const t = await bootRegistered({ behaviour: 'answer' });
    try {
      await dial(t);
      ok(await waitForRtpPath(t), 'the carrier never learned where to send our audio back');
      for (const frame of toneFrames(8)) await t.carrier.sendRtp(g711.encode(frame, 0));
      await new Promise((r) => setTimeout(r, 300));
      const levels = eventsOf(t, 'audio_level');
      ok(levels.length > 0, 'the daemon emitted no audio_level events during a live call');
      ok(Math.max(...levels.map((l) => l.output)) > 0,
        `no audio was received to meter: ${JSON.stringify(levels.slice(-2))}`);

      const { engine, st, drop } = await replay([
        { event: 'ready', audio: { name: 'null' }, audioErrors: [] },
        ...eventsOf(t, 'registered', 'connected'),
        ...levels,
      ]);
      ok(typeof st.level === 'number', `the meter never moved: level is ${JSON.stringify(st.level)}`);
      ok(st.level > 0,
        `the daemon reported audio (input=${levels[levels.length - 1].input}, output=${levels[levels.length - 1].output}) `
        + `but the renderer's meter read ${st.level} — the field names disagree, so the operator has no visual proof of audio`);
      ok(st.level <= 1, `the level is clamped to 0..1, got ${st.level}`);
      engine.dispose(); drop();
    } finally { await teardown(t); }
  }],

  [11, 'the daemon\'s command answers carry the id the supervisor matches them on', async () => {
    const t = await bootRegistered();
    try {
      const st = await t.command('status');
      ck(st.ok, true, `status refused: ${JSON.stringify(st)}`);
      ok(st.registration && st.registration.state === 'registered', `status reports the registration: ${JSON.stringify(st.registration)}`);
      ok(st.audio && typeof st.audio.name === 'string', `status reports the audio backend: ${JSON.stringify(st.audio)}`);
      ck(st.call, null, 'no call is live');
      const bad = await t.command('no-such-action');
      ck(bad.ok, false, 'an unknown action is refused, not ignored');
      ok(bad.error || bad.reason, `and it says why: ${JSON.stringify(bad)}`);
    } finally { await teardown(t); }
  }],
  [12, 'the renderer\'s register command cannot wipe credentials it was never given', async () => {
    // The browser is deliberately never handed the SIP password, so start() sends domain, port,
    // user and callerId only. Spreading that over the account used to erase the password the
    // daemon loaded from the API: the live registration survived, so calls still worked, but the
    // refresh could no longer authenticate and inbound calls stopped minutes into a shift.
    const t = await bootRegistered({ behaviour: 'answer', password: 's3cret' });
    try {
      const asRendererSends = {
        domain: '127.0.0.1', port: t.carrier.sipPort, user: 'alice',
        callerId: '+4532331610', transport: 'udp',
      };
      ok(!('password' in asRendererSends), 'the renderer must never send the secret');
      const res = await t.command('register', asRendererSends);
      ck(res.ok, true, `register without a password was refused: ${JSON.stringify(res)}`);
      ck(eventsOf(t, 'registration_failed').map((e) => e.reason), [],
        'a command from the renderer must not put the phone into a failed state');

      // The real consequence: it can still authenticate afterwards, i.e. the secret survived.
      const again = await t.command('register', asRendererSends);
      ck(again.ok, true, `the password was wiped by the first register: ${JSON.stringify(again)}`);
      const st = await t.command('status');
      ck(st.registration.state, 'registered', `state after re-register: ${JSON.stringify(st.registration)}`);

      // And a call still goes through on that registration.
      const { callId } = await dial(t);
      ok(callId !== undefined && callId !== null, 'the phone still places calls');
      await t.command('hangup', { callId });
    } finally { await teardown(t); }
  }],
];

async function main() {
  console.log('--- End to end: real daemon + real carrier on real UDP + the real renderer ---');
  const r = await M.runChecks(checks, '[e2e:call]');
  if (r.failed) console.log(`\n💥 ${r.failed} check(s) failed`);
  return r;
}

if (require.main === module) {
  main().then((r) => {
    if (!r.failed) console.log('\n🎉 [e2e:call] the whole chain works: a call is placed, audio flows, it comes through, it ends');
    process.exit(r.failed ? 1 : 0);
  }).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { checks, main, rendererCases };
