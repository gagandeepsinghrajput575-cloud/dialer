// The audio path of the native SIP daemon, and the badge that reports it.
//
// Why this file exists separately: the reported fault was "the call shows connected, there is
// total silence in both directions, and the far end drops it a few seconds later". The existing
// suite could not see it, because that suite boots the daemon with `--audio=null` — and `null` is
// precisely the one backend that tolerates never being opened. Every check here drives the real
// UserAgent and the real media layer against a backend shaped like the CoreAudio addon, whose
// `start()` refuses to run before `open()`. That single unsatisfied precondition was the bug:
// nothing in the daemon ever called `open()`, so `startPump` threw out of `onCallConfirmed` before
// it could emit `connected`, and both directions were silent on a call that was genuinely up.
//
//   node test/unit/native-audio.test.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const M = require('../helpers/telephony-mocks');
const { UserAgent } = require('../../desktop/daemon/lib/ua');
const rtp = require('../../desktop/daemon/lib/rtp');
const nullAudio = require('../../desktop/daemon/lib/audio/null');
const { boot, teardown } = require('../helpers/daemon-harness');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (v, m) => assert.ok(v, m);
const ck = (a, b, m) => assert.deepStrictEqual(a, b, m);

// ---- fixtures ------------------------------------------------------------------------------

/** The transport is irrelevant to the media path; it only has to exist and accept listeners. */
function fakeTransport() {
  const t = new EventEmitter();
  t.host = '203.0.113.7'; t.port = 5060; t.localAddress = '0.0.0.0';
  t.sent = [];
  t.send = async (msg) => { t.sent.push(String(msg)); return t; };
  return t;
}

/**
 * A backend with the CoreAudio addon's exact contract: `start()` throws unless `open()` already
 * ran, because there is no AudioUnit to drive. `calls` records the order so a check can assert on
 * it rather than on a side effect.
 */
function coreAudioLike({ failOpen = false, failStart = false, frameMs = 4 } = {}) {
  const calls = [];
  let opened = false;
  let timer = null;
  return {
    name: 'coreaudio', calls,
    available: () => true,
    reason: '',
    describe: () => ({ name: 'coreaudio', ready: opened }),
    async open() {
      calls.push('open');
      if (failOpen) throw new Error('AudioUnitInitialize: device busy');
      opened = true;
      return this.describe();
    },
    start(onInput) {
      calls.push('start');
      if (!opened) throw new Error('coreaudio: open() first');   // the real addon's guard
      if (failStart) throw new Error('AudioUnitStart: -50');
      timer = setInterval(() => { try { onInput(new Int16Array(160)); } catch { /* never stop */ } }, frameMs);
    },
    write() { calls.push('write'); return true; },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    close() { this.stop(); opened = false; },
    devices: () => ({ inputs: [], outputs: [] }),
  };
}

/** A media leg without a socket: `send` records instead of transmitting, which is all the pump needs. */
function fakeMedia() {
  return {
    muted: false, codec: 0, remotePt: 0, remoteDtmfPt: 0,   // PCMU
    session: rtp.createSession({ payloadType: 0 }),
    target: { host: '138.197.42.26', port: 20000 },
    stats: { sent: 0, received: 0, dtmf: 0 },
    packets: [],
    send(buf) { this.packets.push(buf); this.stats.sent += 1; return true; },
    setMuted(m) { this.muted = !!m; },
    close() {},
  };
}

/** A real UserAgent with the events a check reads already collected (an unlistened 'error' throws). */
function uaWith(audio) {
  const ua = new UserAgent({
    transport: fakeTransport(),
    audio,
    account: { domain: 'sip.flynumber.com', user: '15551234567', password: 'pw', callerId: '+15551234567' },
    log: () => {},
  });
  ua.events = [];
  for (const ev of ['connected', 'error', 'media_timeout', 'ended']) ua.on(ev, (d) => ua.events.push([ev, d]));
  ua.only = (name) => ua.events.filter((e) => e[0] === name);
  return ua;
}

const dialogStub = (media = null) => ({
  id: 'c-1', callId: 'c-1', direction: 'outbound', state: 'confirmed',
  remoteSdp: null, media, codec: 'PCMU', timers: new Set(),
  ended: [],
  // onCallConfirmed ends a call that a second one replaces, so the stub needs the real signature.
  end(reason = 'normal', info = {}) { this.ended.push([reason, info]); },
});

const checks = [
  [1, 'the pump opens the sound card before starting it, and audio actually leaves', async () => {
    const audio = coreAudioLike();
    const ua = uaWith(audio);
    const media = fakeMedia();
    const d = dialogStub(media);
    ua.onCallConfirmed(d);
    ck(ua.only('connected').length, 1, 'connected is emitted on the 200 OK');
    await sleep(40);
    ck(audio.calls.slice(0, 2), ['open', 'start'], 'open() must precede start() — the addon has no unit otherwise');
    ok(media.packets.length > 0, `the pump produced no RTP at all (calls: ${audio.calls.join(',')})`);
    ok(rtp.parse(media.packets[0]), 'what it produced is a parseable RTP packet');
    ck(media.packets.length, media.stats.sent, 'every packet the pump built went out');
    ck(ua.only('error').length, 0, 'a healthy device reports nothing');
    ua.stopPump();
  }],

  [2, 'a device that will not start still reports the call as connected — the reported bug', async () => {
    const audio = coreAudioLike({ failStart: true });
    const ua = uaWith(audio);
    // Before the fix this threw 'coreaudio: open() first' out of onCallConfirmed, so `connected`
    // was never emitted and the UI never started its timer on a call that was genuinely up.
    let threw = null;
    try { ua.onCallConfirmed(dialogStub(fakeMedia())); } catch (e) { threw = e; }
    ck(threw, null, `the media fault must not escape into the dialog layer: ${threw && threw.message}`);
    ck(ua.only('connected').length, 1, 'the call is connected even though it has no sound');
    await sleep(20);
    const errs = ua.only('error');
    ck(errs.length, 1, 'exactly one media fault is reported');
    ck(errs[0][1].scope, 'media');
    ok(/would not start/.test(errs[0][1].message), errs[0][1].message);
    ua.stopPump();
  }],

  [3, 'a device that will not open is reported, and start() is never attempted', async () => {
    const audio = coreAudioLike({ failOpen: true });
    const ua = uaWith(audio);
    ua.onCallConfirmed(dialogStub(fakeMedia()));
    await sleep(20);
    ck(ua.only('connected').length, 1);
    ck(audio.calls, ['open'], 'a failed open must not be followed by a start');
    const errs = ua.only('error');
    ck(errs.length, 1);
    ck(errs[0][1].scope, 'media');
    ok(/would not open/.test(errs[0][1].message), errs[0][1].message);
    ua.stopPump();
  }],

  [4, 'a failed device is retried on the next call instead of being given up on', async () => {
    const audio = coreAudioLike({ failStart: true });
    const ua = uaWith(audio);
    ua.onCallConfirmed(dialogStub(fakeMedia()));
    await sleep(20);
    ck(ua.audioOpened, false, 'a device that failed to start must be treated as not open');
    ua.stopPump();
    audio.calls.length = 0;
    ua.onCallConfirmed(dialogStub(fakeMedia()));
    await sleep(20);
    ok(audio.calls.includes('open'), `the next call must try the device again (calls: ${audio.calls.join(',')})`);
    ua.stopPump();
  }],

  [5, 'a call with no audio coming back says so, instead of looking healthy forever', async () => {
    const audio = coreAudioLike();
    const ua = uaWith(audio);
    ua.mediaWatchdogMs = 25;
    const media = fakeMedia();
    ua.onCallConfirmed(dialogStub(media));
    await sleep(70);
    const t = ua.only('media_timeout');
    ck(t.length, 1, 'one watchdog report for a silent call');
    ck(t[0][1].received, 0);
    ok(t[0][1].sent > 0, `this end was sending, so the fault is on the way back (sent ${t[0][1].sent})`);
    ok(/one-way|blocked/i.test(t[0][1].reason), t[0][1].reason);
    ua.stopPump();
  }],

  [6, 'a call with audio coming back is left alone', async () => {
    const audio = coreAudioLike();
    const ua = uaWith(audio);
    ua.mediaWatchdogMs = 25;
    const media = fakeMedia();
    media.stats.received = 12;                 // the carrier is sending us RTP
    ua.onCallConfirmed(dialogStub(media));
    await sleep(70);
    ck(ua.only('media_timeout').length, 0, 'a working call must never be told it is silent');
    ua.stopPump();
  }],

  [7, 'a call that ends before the deadline is never reported as silent', async () => {
    const audio = coreAudioLike();
    const ua = uaWith(audio);
    ua.mediaWatchdogMs = 40;
    ua.onCallConfirmed(dialogStub(fakeMedia()));
    await sleep(10);
    ua.stopPump();                             // hung up after 10 ms, deadline was 40 ms
    await sleep(80);
    ck(ua.only('media_timeout').length, 0, 'a short call is not a silent call');
  }],

  [8, 'the silent backend the CI suite runs on still pumps RTP unchanged', async () => {
    const audio = nullAudio.create();
    const ua = uaWith(audio);
    const media = fakeMedia();
    ua.onCallConfirmed(dialogStub(media));
    await sleep(60);
    ck(audio.describe().name, 'null');
    ok(media.packets.length > 0, 'the null backend is silent audio, not absent audio');
    ck(ua.only('error').length, 0, 'no backend is not a fault — it is the documented CI path');
    ck(ua.only('media_timeout').length, 0);
    ua.stopPump();
  }],

  [9, 'the daemon\'s own diagnosis of its sound card becomes one honest sentence', async () => {
    const { native } = await M.withNative();
    const f = await import('../../src/utils/plain.js');
    const issue = f.audioIssueMessage;
    ck(issue({ audio: { name: 'coreaudio' }, audioErrors: [] }), '', 'a real device needs no warning');
    ck(issue({ audio: { name: 'portaudio' } }), '');
    const mac = issue({ audio: { name: 'null' }, audioErrors: ['coreaudio: addon not built'] });
    ok(/no audio device/.test(mac), mac);
    ok(/build-daemon\.sh/.test(mac), `on macOS the fix is the build script: ${mac}`);
    ok(/addon not built/.test(mac), 'and it carries the daemon\'s own reason');
    const linux = issue({ audio: { name: 'null' }, audioErrors: ['coreaudio: this is linux, not darwin'] });
    ok(/portaudio/.test(linux), `off macOS the fix is PortAudio, not the addon: ${linux}`);
    ok(!/build-daemon\.sh/.test(linux), linux);
    ok(/no audio device/.test(issue({ audio: { name: 'null' } })), 'no detail still warns');
    ok(/no audio device/.test(issue(undefined)), 'and a malformed event does not throw');
    ck(native.nativeAvailable(), false, 'this file left no bridge behind');
  }],

  [10, 'a daemon with no sound card puts the badge on unavailable before the first dial', async () => {
    const { engine, st, drop } = await M.withNative(() => ({ ok: true }));
    engine.onEvent({ event: 'ready', audio: { name: 'null' }, audioErrors: ['coreaudio: addon not built'] });
    ck(st.standby, undefined, 'ready alone does not paint the badge — registration does');
    engine.onEvent({ event: 'registered', audio: { input: 'MacBook Pro Microphone' } });
    await M.tick();
    ck(st.standby.state, 'unavailable', 'a green badge over a silent daemon is the lie this fixes');
    ok(/no audio device/.test(st.standby.reason), st.standby.reason);
    ck(st.state, 'standby', 'it still registers, so an inbound call still rings');
    engine.dispose(); drop();
  }],

  [11, 'a daemon with a real sound card still gets the green badge', async () => {
    const { engine, st, drop } = await M.withNative(() => ({ ok: true }));
    engine.onEvent({ event: 'ready', audio: { name: 'coreaudio' }, audioErrors: [] });
    engine.onEvent({ event: 'registered', audio: { input: 'MacBook Pro Microphone' } });
    await M.tick();
    ck(st.standby, { state: 'ready', reason: '' });
    ck(st.mic, 'MacBook Pro Microphone');
    engine.dispose(); drop();
  }],

  [12, 'a media fault during a live call reaches the screen instead of being swallowed', async () => {
    const { engine, st, drop } = await M.withNative((a) => (a === 'dial' ? { ok: true, callId: 'c-1' } : { ok: true }));
    engine.onEvent({ event: 'ready', audio: { name: 'coreaudio' }, audioErrors: [] });
    await engine.dial('+4520123456');
    engine.onEvent({ event: 'connected', callId: 'c-1' });
    await M.tick();
    ok(engine.live, 'the call is up');
    ck(st.state, 'active'); ck(engine.live.direction, 'outbound');
    engine.onEvent({ event: 'media_timeout', reason: 'No audio has come back from the carrier.' });
    ck(st.error, 'No audio has come back from the carrier.', 'the old guard hid anything reported mid-call');
    engine.onEvent({ event: 'error', scope: 'media', message: 'The audio device would not start.' });
    ck(st.error, 'The audio device would not start.');
    engine.dispose(); drop();
  }],

  [13, 'the real daemon publishes its audio backend and every reason it rejected one', async () => {
    const t = await boot({ behaviour: 'answer' });
    try {
      const ready = await t.waitFor((e) => e.event === 'ready', 4000, 'the ready event');
      ok(['null', 'coreaudio'].includes(ready.audio.name), 'booted with available audio backend');
      ok(Array.isArray(ready.audioErrors), 'audioErrors must always be an array, never undefined');
      if (ready.audio.name === 'null') {
        ok(ready.audioErrors.some((e) => /not darwin|coreaudio/i.test(e)),
          `the renderer needs a reason to show, got: ${JSON.stringify(ready.audioErrors)}`);
      }
      ok(t.events.length > 0 && t.events[0].event === 'ready',
        `ready is the first thing the daemon says, got: ${t.events.map((e) => e.event).join(',')}`);
    } finally { await teardown(t); }
  }],
];

async function main() {
  console.log('--- Unit: native SIP daemon audio path (the "connected but silent" bug) ---');
  const r = await M.runChecks(checks, '[unit:native-audio]');
  if (r.failed) { console.log(`\n💥 ${r.failed} check(s) failed`); process.exitCode = 1; }
  return r;
}

if (require.main === module) {
  main().then((r) => { if (!r.failed) console.log('\n🎉 [unit:native-audio] all checks passed'); process.exit(r.failed ? 1 : 0); })
    .catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { checks, main };
