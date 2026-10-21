// Outbound calls that fail, and outbound calls that the agent cancels before they connect.
//
// Three things used to be true and must never be true again:
//   1. A rejected INVITE (486 busy, 404 unknown, 503 no route) reached the app as a bare
//      `Terminated` state. Nothing released the microphone, nothing told the cockpit the call
//      was over, and no reason was ever shown — because sip.js's Inviter discards the status
//      code its own `onReject` receives.
//   2. An ICE `disconnected` (a two-second Wi-Fi hiccup) was treated as a dead call.
//   3. Hanging up during dialing did nothing, so the only way out was to reload the tab.
//
// `describeReject` and `createOutboundPeer` are pure, so all of the above is tested without a
// network, a browser or a carrier.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

console.log('--- Unit: Outbound failures (rejection mapping, ICE grace, teardown wiring) ---');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// Source assertions must not be satisfiable by a comment that merely describes the intent.
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const importEsm = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

(async () => {
  const { describeReject, rejectionDelegate, isRestingState } = await importEsm('src/outboundFailure.mjs');

  // ---- what the carrier actually said -----------------------------------------------------
  {
    assert.match(describeReject({ statusCode: 486 }).message, /busy/i, '486 is "busy", not a mystery');
    assert.match(describeReject({ statusCode: 600 }).message, /busy/i, '600 (everywhere busy) reads the same way');
    assert.match(describeReject({ statusCode: 404, number: '+4520123456' }).message, /\+4520123456/, '404 names the number');
    assert.match(describeReject({ statusCode: 503 }).message, /route/i, '503 is a routing failure');
    assert.match(describeReject({ statusCode: 408 }).message, /answer|time/i, '408 is a timeout');
    assert.match(describeReject({ statusCode: 401 }).message, /credential/i, '401 points at the credentials');
    assert.match(describeReject({ statusCode: 403 }).message, /credential/i, '403 points at the credentials');
    assert.match(describeReject({ statusCode: 491 }).message, /already/i, '491 is glare, and says so');
    assert.match(describeReject({ statusCode: 488 }).message, /audio/i, '488 is a media negotiation failure');
    assert.match(describeReject({ statusCode: 603 }).message, /declined/i, '603 is a refusal');
    assert.match(describeReject({ statusCode: 604 }).message, /does not exist/i, '604 is a dead number');
    const odd = describeReject({ statusCode: 512, reasonPhrase: 'Server Failure' });
    assert.match(odd.message, /512/, 'an unmapped code still shows the code');
    assert.strictEqual(odd.code, 512);
    assert.ok(describeReject({}).message.length > 20, 'a rejection with no code still says something useful');
    console.log('  ✓ every rejection code the carrier can send maps to an actionable sentence');
  }

  // ---- the delegate that gets the response before sip.js drops it --------------------------
  {
    const rings = [];
    const rejects = [];
    const delegate = rejectionDelegate({
      remoteNumber: '+4520123456',
      onRinging: () => rings.push(1),
      onReject: (message, code) => rejects.push({ message, code }),
    });
    delegate.onProgress({ statusCode: 100 });
    assert.strictEqual(rings.length, 0, '100 Trying is not ringing');
    delegate.onProgress({ statusCode: 180 });
    assert.strictEqual(rings.length, 1, '180 rings');
    delegate.onProgress({ statusCode: 183, reasonPhrase: 'Session Progress' });
    assert.strictEqual(rings.length, 2, '183 early media also rings');
    delegate.onReject({ statusCode: 486, reasonPhrase: 'Busy Here' });
    assert.strictEqual(rejects.length, 1);
    assert.match(rejects[0].message, /busy/i);
    assert.strictEqual(rejects[0].code, 486);
    delegate.onReject({ statusCode: 404, reasonPhrase: 'Not Found' });
    assert.match(rejects[1].message, /\+4520123456/, 'the rejected number is named');

    // The shape sip.js actually passes: `{ message, session }`, with the code inside `message`.
    // Reading `response.statusCode` alone leaves every response looking empty — which is how a
    // ringing call stays on "Dialing" forever and a 486 reads as "the call failed".
    const coreStyle = rejectionDelegate({
      remoteNumber: '+4520123456',
      onRinging: (c) => rings.push(c),
      onReject: (message, code) => rejects.push({ message, code }),
    });
    const before = rings.length;
    coreStyle.onProgress({ message: { statusCode: 180, reasonPhrase: 'Ringing' }, session: {} });
    assert.strictEqual(rings.length, before + 1, 'a core-style 180 rings');
    assert.strictEqual(rings[rings.length - 1], 180, 'and reports its code');
    coreStyle.onReject({ message: { statusCode: 486, reasonPhrase: 'Busy Here' } });
    assert.strictEqual(rejects[rejects.length - 1].code, 486, 'a core-style rejection keeps its code');
    assert.match(rejects[rejects.length - 1].message, /busy/i, 'and its meaning');
    console.log('  ✓ the delegate turns 180 into ringing and 4xx/5xx into a reason with a code');
  }

  // ---- resting states do not need (or survive) a second teardown ---------------------------
  {
    assert.strictEqual(isRestingState('idle'), true);
    assert.strictEqual(isRestingState('standby'), true);
    assert.strictEqual(isRestingState('ended'), true);
    assert.strictEqual(isRestingState('error'), true);
    for (const live of ['registering', 'dialing', 'ringing', 'active', 'incoming']) {
      assert.strictEqual(isRestingState(live), false, `${live} is a live state`);
    }
    console.log('  ✓ only a live call is torn down when the engine reports "ended"');
  }

  // ---- ICE: a hiccup is not a hang-up, and it must be the carrier's peer we watch ---------
  const { watchIceConnection, ICE_GRACE_MS, attachRemoteAudio } = await importEsm('src/outboundPeer.mjs');
  {
    // A stand-in for the RTCPeerConnection that sip.js's session description handler owns.
    class FakePC {
      constructor(state = 'new') {
        this.signalingState = 'stable';
        this.connectionState = 'new';
        this.iceConnectionState = state;
        this.listeners = new Set();
      }
      addEventListener(type, fn) { if (type === 'iceconnectionstatechange') this.listeners.add(fn); }
      removeEventListener(type, fn) { this.listeners.delete(fn); }
      close() { this.signalingState = 'closed'; this.connectionState = 'closed'; }
      ice(state) { this.iceConnectionState = state; for (const fn of [...this.listeners]) fn(); }
    }
    const fakeTimers = () => {
      const pending = new Map();
      let id = 0;
      return {
        pending,
        set: (fn, ms) => { id += 1; pending.set(id, { fn, ms }); return id; },
        clear: (handle) => pending.delete(handle),
        runAll: () => { const all = [...pending.values()]; pending.clear(); for (const t of all) t.fn(); },
      };
    };

    // the exact regression: sip.js owns `oniceconnectionstatechange`, so we must not overwrite it
    {
      const pc = new FakePC();
      const sipJsHandler = () => {};
      pc.oniceconnectionstatechange = sipJsHandler;
      const stop = watchIceConnection(pc, { onFatal: () => {} });
      assert.strictEqual(pc.oniceconnectionstatechange, sipJsHandler,
        'watching ICE must not clobber sip.js\'s own handler');
      assert.strictEqual(pc.listeners.size, 1, 'the watcher attaches a listener instead');
      stop();
      assert.strictEqual(pc.listeners.size, 0, 'and can be detached on teardown');
    }

    // disconnected: grace, then fatal — unless it reconnects first
    {
      const timers = fakeTimers();
      const pc = new FakePC();
      const fatal = [];
      watchIceConnection(pc, { onFatal: (m) => fatal.push(m), timers });
      pc.ice('disconnected');
      assert.strictEqual(fatal.length, 0, 'a disconnected transport is not a dead call yet');
      assert.strictEqual(timers.pending.size, 1, 'a grace timer is armed');
      pc.ice('connected');
      assert.strictEqual(timers.pending.size, 0, 'reconnecting cancels the grace timer');
      pc.ice('completed');
      assert.deepStrictEqual(fatal, [], 'a two-second hiccup never becomes a dropped call');
    }

    {
      const timers = fakeTimers();
      const pc = new FakePC();
      const fatal = [];
      watchIceConnection(pc, { onFatal: (m) => fatal.push(m), timers });
      pc.ice('disconnected');
      timers.runAll();
      assert.strictEqual(fatal.length, 1, 'disconnected past the grace window does end the call');
      assert.match(fatal[0], /audio/i);
      assert.ok(ICE_GRACE_MS >= 3000, 'the grace window is long enough to survive a Wi-Fi roam');
      pc.ice('failed');
      assert.strictEqual(fatal.length, 1, 'a call is only ended once');
    }

    {
      const fatal = [];
      const pc = new FakePC('failed');
      watchIceConnection(pc, { onFatal: (m) => fatal.push(m), timers: fakeTimers() });
      assert.strictEqual(fatal.length, 1, 'a peer that is already failed when we attach reports at once');
    }

    {
      const timers = fakeTimers();
      const fatal = [];
      const pc = new FakePC();
      const stop = watchIceConnection(pc, { onFatal: (m) => fatal.push(m), timers });
      pc.ice('disconnected');
      stop();
      timers.runAll();
      assert.deepStrictEqual(fatal, [], 'a detached watcher reports nothing after teardown');
      assert.doesNotThrow(() => watchIceConnection(null)(), 'no peer, no crash');
    }

    console.log('  ✓ ICE is watched on the carrier peer without stealing sip.js\'s handler');
  }

  // ---- remote audio: sip.js's stream first, receiver tracks as the fallback ----------------
  {
    const played = [];
    const audioRef = { current: { set srcObject(v) { played.push(v); }, play: () => Promise.resolve() } };
    const sdhStream = { getAudioTracks: () => ['t'] };
    attachRemoteAudio({ sessionDescriptionHandler: { remoteMediaStream: sdhStream }, audioRef });
    assert.strictEqual(played[0], sdhStream, 'the session description handler stream is played as-is');

    class FakeStream {
      constructor() { this.tracks = []; }
      addTrack(t) { this.tracks.push(t); }
      getAudioTracks() { return this.tracks; }
    }
    const realMediaStream = globalThis.MediaStream;
    globalThis.MediaStream = FakeStream;
    try {
      const sipPc = { getReceivers: () => [{ track: { kind: 'audio' } }, { track: { kind: 'video' } }] };
      attachRemoteAudio({ sipPc, audioRef });
      assert.strictEqual(played[1].tracks.length, 1, 'only audio receivers become the remote stream');
    } finally {
      globalThis.MediaStream = realMediaStream;
    }

    attachRemoteAudio({ sessionDescriptionHandler: {}, sipPc: null, audioRef: { current: null } });
    assert.strictEqual(played.length, 2, 'no audio element means no playback and no crash');
    console.log('  ✓ remote audio prefers the sip.js stream and falls back to audio receivers');
  }

  // ---- caller ID: the header that makes the ledger's CLI true ------------------------------
  {
    const { callerIdHeaders } = await importEsm('src/callerNumber.mjs');
    assert.deepStrictEqual(callerIdHeaders('+4532331610', 'sip.telnyx.com'),
      ['P-Asserted-Identity: <sip:+4532331610@sip.telnyx.com>']);
    assert.deepStrictEqual(callerIdHeaders('', 'sip.telnyx.com'), [], 'no caller ID, no header');
    assert.deepStrictEqual(callerIdHeaders('+4532331610', ''), [], 'no server, no header');
    assert.deepStrictEqual(callerIdHeaders('+45 32 33 16 10', 'sip.telnyx.com'), [],
      'a malformed CLI is not put on the wire');
    assert.deepStrictEqual(callerIdHeaders('+4532331610\r\nX-Injected: 1', 'sip.telnyx.com'), [],
      'header injection is refused');
    console.log('  ✓ the caller ID becomes one well-formed P-Asserted-Identity header');
  }

  // ---- anxiety-free dialing: a blip out, a chime on pickup, silence in between -------------
  {
    const { createChime, DIAL_BLIP, CONNECT_CHIME } = await importEsm('src/utils/chime.js');
    const events = [];
    class FakeParam {
      constructor(value) { this.value = value; }
      setValueAtTime(v) { events.push(['set', v]); }
      linearRampToValueAtTime(v) { events.push(['ramp', v]); }
    }
    class FakeGain {
      constructor() { this.gain = new FakeParam(1); }
      connect(node) { events.push(['gain->', node?.kind]); }
    }
    class FakeOsc {
      constructor() { this.frequency = { value: 0 }; this.type = ''; }
      connect() { events.push(['osc->']); }
      start(t) { events.push(['start', this.frequency.value, t]); }
      stop(t) { events.push(['stop', t]); }
    }
    class FakeCtx {
      constructor() { this.state = 'running'; this.currentTime = 1; this.destination = { kind: 'destination' }; this.closed = false; }
      createOscillator() { return new FakeOsc(); }
      createGain() { return new FakeGain(); }
      close() { this.closed = true; this.state = 'closed'; }
    }
    const ctx = new FakeCtx();
    const chime = createChime({ AudioContext: function () { return ctx; } });

    assert.strictEqual(chime.blip(), true);
    assert.deepStrictEqual(events.filter((e) => e[0] === 'start').map((e) => e[1]), [DIAL_BLIP.frequency],
      'one blip at dial dispatch');
    assert.ok(events.filter((e) => e[0] === 'gain->').every((e) => e[1] === 'destination'),
      'the cue is wired to the local output only');
    assert.ok(DIAL_BLIP.gain <= 0.06, 'the blip is a cue, not a ringtone');

    events.length = 0;
    chime.connected();
    const started = events.filter((e) => e[0] === 'start');
    assert.deepStrictEqual(started.map((e) => e[1]), [520, 660], 'the pickup cue is 520 → 660 Hz');
    assert.ok(started[1][2] > started[0][2], 'and it ascends rather than sounding together');
    assert.ok(Math.max(...events.filter((e) => e[0] === 'ramp').map((e) => e[1])) <= 0.06,
      'low gain: it must not startle');
    chime.stop();
    assert.strictEqual(ctx.closed, true, 'the cue context is closed on teardown');

    const noAudio = createChime({});
    assert.strictEqual(noAudio.blip(), false, 'no Web Audio: silence, never a crash');
    assert.doesNotThrow(() => noAudio.connected());
    console.log('  ✓ dial blip and 520→660 pickup chime are local-only, quiet, and land on the right beats');
  }

  // ---- early media: carrier audio before the answer, ducked, never "active" ----------------
  {
    const { playEarlyMedia, EARLY_MEDIA_VOLUME } = await importEsm('src/outboundPeer.mjs');
    const stream = { getAudioTracks: () => ['t'] };
    const element = { volume: 1, srcObject: null, play: () => Promise.resolve() };
    playEarlyMedia({ sessionDescriptionHandler: { remoteMediaStream: stream }, audioRef: { current: element } });
    assert.strictEqual(element.srcObject, stream, '183 audio plays through the one audio element');
    assert.strictEqual(element.volume, EARLY_MEDIA_VOLUME, 'network ringback is ducked, not screamed');
    assert.ok(EARLY_MEDIA_VOLUME > 0.3 && EARLY_MEDIA_VOLUME < 1, 'still loud enough for an announcement');

    const signalling = code(read('src/webrtcSignalling.js'));
    const dialStart = signalling.indexOf('export async function dialOutbound');
    const dial = signalling.slice(dialStart, signalling.indexOf('export async function startSignalling'));
    assert.ok(/earlyMedia: true/.test(dial), 'sip.js is told to keep the 183 body');
    assert.ok(/onSessionDescriptionHandler/.test(dial), 'the provisional SDH is handed to the engine');
    assert.ok(/callerIdHeaders\(callerId, server\)/.test(dial), 'the CLI header is attached');
    assert.ok(!/transport=ws/.test(signalling), 'the Request-URI carries no next-hop transport');

    const hook = code(read('src/useWebRtc.js'));
    assert.ok(/playEarlyMedia/.test(hook), 'the hook plays early media');
    assert.ok(/chime\.blip\(\)/.test(hook) && /chime\.connected\(\)/.test(hook),
      'a blip on dispatch, a chime on pickup');
    assert.ok(/volume = 1/.test(hook), 'the duck is undone when the call is established');
    console.log('  ✓ 183 audio is played softly, the CLI is sent, and the Request-URI stays canonical');
  }

  // ---- the delegate has to ride on invite(), not on the constructor -----------------------
  // Regression: `new Inviter(ua, target, { requestDelegate })` looks right and is silently
  // ignored. sip.js 0.21.2 reads `options.requestDelegate` inside sendInvite, which only ever
  // sees the object passed to `invite()`. With the delegate in the wrong bucket, a call rings
  // forever while the cockpit says "Dialing", and a 486 never becomes a message.
  {
    const { inviteWithDelegate } = await importEsm('src/outboundFailure.mjs');
    const seen = [];
    const fakeInviter = { invite: (opts) => { seen.push(opts); return Promise.resolve('sent'); } };
    const delegate = { onProgress() {}, onReject() {} };
    assert.strictEqual(await inviteWithDelegate(fakeInviter, delegate), 'sent', 'the INVITE result is passed through');
    assert.strictEqual(seen.length, 1, 'the INVITE is sent exactly once');
    assert.strictEqual(seen[0].requestDelegate, delegate,
      'the delegate must be handed to invite(), because that is the only place sip.js reads it');
    assert.throws(() => inviteWithDelegate({}, delegate), /invitation/i, 'a session without invite() is refused');

    const signalling = code(read('src/webrtcSignalling.js'));
    const ctorStart = signalling.indexOf('new Inviter(self.ua, target, {');
    const ctor = signalling.slice(ctorStart, signalling.indexOf('inviter.delegate = {'));
    assert.ok(ctorStart > 0, 'the Inviter is constructed where the test can see it');
    assert.ok(!/requestDelegate/.test(ctor), 'requestDelegate must not be in the constructor bucket');
    assert.ok(/inviteWithDelegate\(inviter, requestDelegate\)/.test(signalling),
      'the delegate is passed to the call that sends the INVITE');
    assert.ok(!/inviter\.invite\(\)/.test(signalling), 'a bare invite() would drop the delegate again');
    console.log('  ✓ the request delegate reaches sip.js through invite(), never the constructor');
  }

  // ---- early media is decided by the session, not by sip.js's inconsistent flag ------------
  {
    const { isEarlyMedia } = await importEsm('src/outboundPeer.mjs');
    assert.strictEqual(isEarlyMedia(false, false), true,
      'a 183 SDH arrives with provisional=false (sip.js builds it from setupSessionDescriptionHandler)');
    assert.strictEqual(isEarlyMedia(true, false), true, 'a reliable provisional is early media too');
    assert.strictEqual(isEarlyMedia(false, true), false, 'after Established the handler is the call itself');
    console.log('  ✓ carrier audio is recognised even when sip.js reports provisional=false');
  }

  // ---- the ring heartbeat: quiet, slow, and stoppable --------------------------------------
  {
    const { createChime, RING_PULSE, RING_PULSE_EVERY_MS, CONNECT_CHIME } = await importEsm('src/utils/chime.js');
    const realSet = global.setInterval;
    const realClear = global.clearInterval;
    const timers = [];
    let cleared = 0;
    global.setInterval = (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; };
    global.clearInterval = () => { cleared += 1; };
    const tones = [];
    class Osc {
      constructor() { this.frequency = { value: 0 }; }
      connect() {}
      start() { tones.push(this.frequency.value); }
      stop() {}
    }
    class Gain { constructor() { this.gain = { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} }; } connect() {} }
    class Ctx {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
      createOscillator() { return new Osc(); }
      createGain() { return new Gain(); }
      close() { this.state = 'closed'; }
    }
    try {
      const chime = createChime({ AudioContext: function () { return new Ctx(); } });
      assert.strictEqual(chime.ringing(), true, 'the heartbeat starts');
      assert.deepStrictEqual(tones, [RING_PULSE.frequency], 'the first beat lands immediately');
      assert.strictEqual(timers.length, 1, 'one tempo, not one per 180');
      assert.strictEqual(timers[0].ms, RING_PULSE_EVERY_MS, `a beat every ${RING_PULSE_EVERY_MS} ms`);
      chime.ringing();
      assert.strictEqual(timers.length, 1, 'a second 180 does not stack a second tempo');
      timers[0].fn();
      assert.strictEqual(tones.length, 2, 'each tick is one pulse');
      chime.stopRinging();
      assert.strictEqual(cleared, 1, 'the tempo is cleared when the ring ends');
      chime.ringing();
      chime.stop();
      assert.strictEqual(cleared, 2, 'teardown clears the tempo as well as the context');

      assert.ok(RING_PULSE.frequency < 200, 'the heartbeat sits well below the 425 Hz ringback');
      assert.ok(RING_PULSE.ms <= 100, 'and is a pulse, not a tone');
      assert.ok(RING_PULSE.gain < CONNECT_CHIME[0].gain, 'quieter than the pickup chime');
      assert.ok(RING_PULSE.gain <= 0.03, 'quiet enough to ignore');
    } finally {
      global.setInterval = realSet;
      global.clearInterval = realClear;
    }
    console.log('  ✓ ringing is a 180 Hz heartbeat every 3 s, never a ringback loop');
  }

  // ---- SDP policy: accept a non-muxed answer instead of failing the call -------------------
  {
    const { WEBRTC_PEER_CONFIGURATION } = await importEsm('src/webrtcConfig.mjs');
    assert.strictEqual(WEBRTC_PEER_CONFIGURATION.rtcpMuxPolicy, 'negotiate',
      'a carrier answer without a=rtcp-mux must not fail setRemoteDescription');
    assert.ok(/telnyx/.test(WEBRTC_PEER_CONFIGURATION.iceServers[0].urls), 'the carrier STUN is first');
    const signalling = code(read('src/webrtcSignalling.js'));
    assert.strictEqual((signalling.match(/peerConnectionConfiguration: WEBRTC_PEER_CONFIGURATION/g) || []).length, 2,
      'both the standby UA and the inbound accept path share the policy');
    assert.ok(!/ensureRtcpMux/i.test(signalling), 'no SDP rewrite pretends the far end muxes');
    console.log('  ✓ RTCP mux is negotiated, not required, and the policy is shared by both paths');
  }

  // ---- wiring: the engine, the hook and the cockpit ---------------------------------------
  {
    const signalling = code(read('src/webrtcSignalling.js'));
    const dialStart = signalling.indexOf('export async function dialOutbound');
    const dial = signalling.slice(dialStart, signalling.indexOf('export async function startSignalling'));
    assert.ok(/requestDelegate/.test(dial), 'dialOutbound registers a requestDelegate');
    assert.ok(/onReject/.test(dial), 'the rejection response is read, not discarded');
    assert.ok(/onRinging:\s*\(code\)\s*=>/.test(dial) && /onState\?\.\('ringing'\)/.test(dial),
      'a 180/183 turns into the Ringing state (see rejectionDelegate)');
    assert.ok(/onRinging:\s*\(\)\s*=>\s*\{\s*if \(!cancelRef\.current\) chime\.ringing\(\)/.test(code(read('src/useWebRtc.js'))),
      'and the ringing state is also audible as the quiet heartbeat');
    assert.ok(/inviteWithDelegate\(inviter, requestDelegate\)/.test(dial),
      'the delegate is passed to the call that sends the INVITE');
    assert.ok(/rejectionDelegate/.test(dial), 'the rejection delegate is attached to the Inviter');

    const startSignalling = signalling.slice(signalling.indexOf('export async function startSignalling'));
    assert.ok(!/s !== 'ready'\s*\)\s*onError/.test(startSignalling),
      'a healthy registration handshake is not reported as a lost registration');
    assert.ok(!/onState:\s*\(s, detail\)\s*=>\s*\{\s*if\s*\(s !== 'ready'\)/.test(startSignalling),
      'registering/retrying do not become a fatal dial error');
    assert.ok(/unavailable/.test(startSignalling), 'only a genuine standby failure is surfaced');

    const hook = code(read('src/useWebRtc.js'));
    assert.ok(/isRestingState/.test(hook), 'the hook distinguishes a live call from a resting state');
    const startBody = hook.slice(hook.indexOf('const start = useCallback'), hook.indexOf('const hangUp = useCallback'));
    assert.ok(/'ended'/.test(startBody), 'the hook handles the engine\'s "ended" state');
    assert.ok(/finishActiveCall/.test(startBody),
      'a terminated outbound session runs the same teardown as a hang-up');
    assert.ok(/cancelRef/.test(startBody), 'a hang-up before the INVITE exists is remembered, not lost');
    assert.ok(/watchIceConnection/.test(startBody), 'ICE is watched on the peer that negotiated');
    assert.ok(!/new PC\(|createOutboundPeer/.test(startBody),
      'no second peer is created: a peer without a remote description never negotiates');
    assert.ok(/sessionDescriptionHandler\?\.peerConnection/.test(startBody),
      'the watched peer is the one sip.js created');
    assert.ok(/onEnded\?\.\(dir, reason\)/.test(hook), 'the engine hands the failure reason to the cockpit');

    const cockpit = code(read('src/pages/Dialer.jsx'));
    const ledger = code(read('src/outboundLedger.mjs'));
    assert.ok(/recordUnconnected\(api, callId, dir, reason\)/.test(cockpit),
      'a dial that never connected is recorded, not silently dropped');
    assert.ok(/status: 'failed'/.test(ledger) && /status: 'canceled'/.test(ledger),
      'and it is recorded as failed or canceled, never as a conversation');
    assert.ok(/api\.abandonCall\(r\.callId, res\.cancelled\)/.test(cockpit),
      'a cancelled attempt keeps its row; only a phantom is discarded');
    const hangUpStart = cockpit.indexOf('const hangUp = useCallback');
    const hangUpBody = cockpit.slice(hangUpStart, cockpit.indexOf('\n  }, [', hangUpStart));
    assert.ok(/'dialing'/.test(hangUpBody), 'the agent can hang up while the call is still dialing');
    assert.ok(!/!callId \|\| !active\) return;\n\s*\/\/ In-browser/.test(hangUpBody),
      'the engine is reached without waiting for a loaded prospect');
    assert.ok(hangUpBody.indexOf('isWebrtcRef') < hangUpBody.indexOf('!callId'),
      'cancelling is handed to the engine before the classification-only gate');
    const hangUpHook = hook.slice(hook.indexOf('const hangUp = useCallback'));
    assert.ok(/isRestingState\(stateRef\.current\)/.test(hangUpHook.slice(0, 400)),
      'a resting state is not torn down twice');
    const endedStart = cockpit.indexOf('const engineEnded = useCallback');
    const endedBody = cockpit.slice(endedStart, cockpit.indexOf('\n  }, [', endedStart));
    assert.ok(/webrtcLiveRef\.current/.test(endedBody) && /phase/i.test(endedBody),
      'a dial that never connected settles the cockpit without opening a disposition');
    console.log('  ✓ signalling reads the rejection code, the hook tears down, the cockpit can cancel');
  }

  console.log('\n🎉 [unit:outbound-failure] all checks passed\n');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
