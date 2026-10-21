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

  // ---- ICE: a hiccup is not a hang-up ------------------------------------------------------
  const { createOutboundPeer, ICE_GRACE_MS, ICE_SERVERS } = await importEsm('src/outboundPeer.mjs');
  {
    class FakePC {
      constructor(cfg) {
        this.cfg = cfg;
        this.signalingState = 'stable';
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
        this.tracks = [];
        this.closed = false;
      }
      addTrack(track, stream) { this.tracks.push({ track, stream }); }
      close() { this.closed = true; this.signalingState = 'closed'; this.connectionState = 'closed'; }
      // the test drives the browser's event surface
      ice(state) { this.iceConnectionState = state; this.oniceconnectionstatechange?.(); }
      track(stream) { this.ontrack?.({ streams: [stream] }); }
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

    // construction: carrier STUN first, one track per microphone track
    {
      const timers = fakeTimers();
      const pc = new FakePC();
      const stream = { getTracks: () => ['a', 'b'] };
      const live = [];
      createOutboundPeer({
        RTCPeerConnection: function (cfg) { Object.assign(pc, { cfg }); return pc; },
        stream, audioRef: { current: null }, onLive: () => live.push(1), timers,
      });
      assert.ok(pc.cfg.iceServers.some((s) => /telnyx/.test(s.urls)), 'the carrier STUN server is offered first');
      assert.deepStrictEqual(ICE_SERVERS.map((s) => s.urls), pc.cfg.iceServers.map((s) => s.urls));
      assert.strictEqual(pc.tracks.length, 2, 'every microphone track is attached');

      // onLive fires once, even if the browser reports connected then completed
      pc.ice('connected');
      pc.ice('completed');
      assert.strictEqual(live.length, 1, 'audio is announced exactly once');
    }

    // disconnected: grace, then fatal — unless it reconnects first
    {
      const timers = fakeTimers();
      const pc = new FakePC();
      const live = [];
      const fatal = [];
      createOutboundPeer({
        RTCPeerConnection: function () { return pc; }, stream: { getTracks: () => [] }, audioRef: { current: null },
        onLive: () => live.push(1), onFatal: (m) => fatal.push(m), timers,
      });
      pc.ice('disconnected');
      assert.strictEqual(fatal.length, 0, 'a disconnected transport is not a dead call yet');
      assert.strictEqual(timers.pending.size, 1, 'a grace timer is armed');
      pc.ice('connected');
      assert.strictEqual(timers.pending.size, 0, 'reconnecting cancels the grace timer');
      assert.strictEqual(live.length, 1, 'and the call is still live');
      assert.deepStrictEqual(fatal, [], 'a two-second hiccup never becomes a dropped call');
    }

    {
      const timers = fakeTimers();
      const pc = new FakePC();
      const fatal = [];
      createOutboundPeer({
        RTCPeerConnection: function () { return pc; }, stream: { getTracks: () => [] }, audioRef: { current: null },
        onFatal: (m) => fatal.push(m), timers,
      });
      pc.ice('disconnected');
      timers.runAll();
      assert.strictEqual(fatal.length, 1, 'disconnected for longer than the grace window does end the call');
      assert.match(fatal[0], /audio/i);
      assert.ok(ICE_GRACE_MS >= 3000, 'the grace window is long enough to survive a Wi-Fi roam');
    }

    // failed is fatal immediately
    {
      const fatal = [];
      const pc = new FakePC();
      createOutboundPeer({
        RTCPeerConnection: function () { return pc; }, stream: { getTracks: () => [] }, audioRef: { current: null },
        onFatal: (m) => fatal.push(m), timers: fakeTimers(),
      });
      pc.ice('failed');
      assert.strictEqual(fatal.length, 1, 'ICE failure ends the call at once');
    }

    // no callbacks after the peer is closed (hang-up must not be followed by a phantom error)
    {
      const timers = fakeTimers();
      const fatal = [];
      const pc = new FakePC();
      const peer = createOutboundPeer({
        RTCPeerConnection: function () { return pc; }, stream: { getTracks: () => [] }, audioRef: { current: null },
        onFatal: (m) => fatal.push(m), timers,
      });
      pc.ice('disconnected');
      peer.close();
      timers.runAll();
      assert.deepStrictEqual(fatal, [], 'a closed peer connection reports nothing');
    }

    // a browser without RTCPeerConnection simply gets no peer, never a crash
    assert.strictEqual(createOutboundPeer({ RTCPeerConnection: null, stream: { getTracks: () => [] } }), null);
    console.log('  ✓ ICE "disconnected" gets a grace window; "failed" is fatal; closed peers are silent');

    // ---- remote audio: sip.js's stream first, receiver tracks as the fallback --------------
    const { attachRemoteAudio } = await importEsm('src/outboundPeer.mjs');
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
  }

  // ---- wiring: the engine, the hook and the cockpit ---------------------------------------
  {
    const signalling = code(read('src/webrtcSignalling.js'));
    const dialStart = signalling.indexOf('export async function dialOutbound');
    const dial = signalling.slice(dialStart, signalling.indexOf('export async function startSignalling'));
    assert.ok(/requestDelegate/.test(dial), 'dialOutbound registers a requestDelegate');
    assert.ok(/onReject/.test(dial), 'the rejection response is read, not discarded');
    assert.ok(/onRinging:\s*\(\)\s*=>\s*onState\?\.\('ringing'\)/.test(dial),
      'a 180/183 turns into the Ringing state (see rejectionDelegate)');
    assert.ok(/requestDelegate,/.test(dial), 'the delegate is passed to the Inviter');
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
    assert.ok(/onEnded\?\.\(dir, reason\)/.test(hook), 'the engine hands the failure reason to the cockpit');

    const cockpit = code(read('src/pages/Dialer.jsx'));
    const hangUpStart = cockpit.indexOf('const hangUp = useCallback');
    const hangUpBody = cockpit.slice(hangUpStart, cockpit.indexOf('\n  }, [', hangUpStart));
    assert.ok(/'dialing'/.test(hangUpBody), 'the agent can hang up while the call is still dialing');
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
