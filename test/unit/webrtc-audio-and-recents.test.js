// Reproduction & verification suite for WebRTC audio unlock, pre-SDP ontrack attachment,
// SIP.js sendrecv glare prevention, and Recents inbound/outbound ledger transitions.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-webrtc-recents-'));
process.env.DATA_DIR = tmp;
process.env.PULSE_TEST = '1';

const REPO = path.join(__dirname, '..', '..');
const { db } = require('../../server/db');
const migrate = require('../../server/db/migrate');
const settingsRepo = require('../../server/repositories/settingsRepo');
const prospectRepo = require('../../server/repositories/prospectRepo');
const callRepo = require('../../server/repositories/callRepo');
const noteRepo = require('../../server/repositories/noteRepo');
const telephony = require('../../server/services/telephonyService');
const callService = require('../../server/services/callService');
const { createApp } = require('../../server/app');

function httpReq(base, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, base);
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const reqHeaders = {
      Origin: base,
      ...headers,
    };
    if (payload !== null) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: reqHeaders,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* binary/plain */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json, raw });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function run() {
  console.log('  [webrtc-audio-recents] WebRTC gateway, audio unlock, SDP glare & Recents ledger');
  migrate.run();

  // ---------------------------------------------------------------------------
  // 1. Sacred Invariant #1: Telnyx SIP over WSS gateway must ALWAYS be
  //    wss://sip.telnyx.com:7443 and NEVER wss://rtc.telnyx.com.
  // ---------------------------------------------------------------------------
  settingsRepo.set('webrtc_ws_url', '');
  assert.strictEqual(
    telephony.webrtcWsUrl(),
    'wss://sip.telnyx.com:7443',
    'default WebRTC SIP WebSocket gateway must be wss://sip.telnyx.com:7443',
  );

  // Legacy/forbidden wss://rtc.telnyx.com values must be rewritten cleanly to wss://sip.telnyx.com:7443
  settingsRepo.set('webrtc_ws_url', 'wss://rtc.telnyx.com');
  assert.strictEqual(
    telephony.webrtcWsUrl(),
    'wss://sip.telnyx.com:7443',
    'forbidden wss://rtc.telnyx.com setting must resolve to wss://sip.telnyx.com:7443',
  );
  settingsRepo.set('webrtc_ws_url', 'wss://rtc.telnyx.com/');
  assert.strictEqual(
    telephony.webrtcWsUrl(),
    'wss://sip.telnyx.com:7443',
    'trailing-slash wss://rtc.telnyx.com/ setting must resolve to wss://sip.telnyx.com:7443',
  );

  // Explicit custom / regional SIP WSS gateways remain honoured
  settingsRepo.set('webrtc_ws_url', 'wss://rtc.eu.telnyx.com');
  assert.strictEqual(telephony.webrtcWsUrl(), 'wss://rtc.eu.telnyx.com');
  settingsRepo.set('webrtc_ws_url', '');

  // Migration 14 cleans up any persisted wss://rtc.telnyx.com row in SQLite settings
  assert.ok(
    migrate.MIGRATIONS.some((m) => m.version === 14),
    'migration 14 must exist to scrub persisted wss://rtc.telnyx.com settings',
  );
  console.log('    ✓ Sacred Invariant #1: wss://sip.telnyx.com:7443 enforced + migration 14 present');

  // ---------------------------------------------------------------------------
  // 2. Defect 1: Suspended AudioContext recovery + global user-gesture unlock
  // ---------------------------------------------------------------------------
  const ringerMod = await import('../../src/utils/ringer.js');
  assert.strictEqual(typeof ringerMod.unlockAudio, 'function', 'ringer.js must export unlockAudio');
  assert.strictEqual(typeof ringerMod.installGlobalAudioUnlock, 'function', 'ringer.js must export installGlobalAudioUnlock');

  {
    let resumeResolver = null;
    const pulsesWhileRunning = [];
    const mockCtx = {
      state: 'suspended',
      currentTime: 0,
      destination: {},
      createGain() {
        return {
          gain: {
            setValueAtTime(val) {
              if (val > 0 && mockCtx.state === 'running') pulsesWhileRunning.push(val);
            },
            cancelScheduledValues() {},
          },
          connect() { return this; },
          disconnect() {},
        };
      },
      createOscillator() {
        const osc = {
          type: 'sine',
          frequency: { setValueAtTime() {} },
          connect() { return this; },
          start() {},
          stop() {},
          disconnect() {},
        };
        return osc;
      },
      resume() {
        return new Promise((res) => { resumeResolver = res; });
      },
      close() {
        mockCtx.state = 'closed';
        return Promise.resolve();
      },
    };

    const ringer = ringerMod.createRinger({ audioContext: mockCtx });
    ringer.start();
    assert.strictEqual(pulsesWhileRunning.length, 0, 'while AudioContext is suspended, oscillators have not run on an unlocked clock');
    mockCtx.state = 'running';
    resumeResolver();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(pulsesWhileRunning.length >= 1, `resuming a suspended AudioContext immediately triggers audible ring pulse (got ${pulsesWhileRunning.length})`);
    ringer.stop();
  }
  console.log('    ✓ Defect 1: suspended AudioContext recovery + audio unlocker helpers verified');

  // ---------------------------------------------------------------------------
  // 3. Defect 2: W3C-strict RTCPeerConnection ontrack pre-SDP binding &
  //    zero duplicate addTrack / post-INVITE defineProperty glare
  // ---------------------------------------------------------------------------
  const signalling = await import('../../src/webrtcSignalling.js');
  {
    const prevRTC = global.RTCPeerConnection;
    const prevMS = global.MediaStream;
    const prevMSTE = global.MediaStreamTrackEvent;

    class MockMediaStreamTrackEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.track = init.track || null;
      }
    }

    class MockMediaStream {
      constructor(tracks = []) {
        this._tracks = [...tracks];
      }
      getTracks() { return [...this._tracks]; }
      getAudioTracks() { return this._tracks.filter((t) => t.kind === 'audio'); }
      getVideoTracks() { return this._tracks.filter((t) => t.kind === 'video'); }
      getTrackById(id) { return this._tracks.find((t) => t.id === id) || null; }
      addTrack(t) { if (!this._tracks.includes(t)) this._tracks.push(t); }
      removeTrack(t) { this._tracks = this._tracks.filter((x) => x !== t); }
      dispatchEvent() { return true; }
    }

    // W3C-strict PeerConnection: throws InvalidAccessError if addTrack() is called
    // twice for the same track (exact browser crash previously triggered in accept()),
    // and fires ontrack DURING setRemoteDescription BEFORE accept()/invite() resolves!
    class StrictPeerConnection {
      constructor(config) {
        this.config = config;
        this.signalingState = 'stable';
        this.iceGatheringState = 'complete';
        this.connectionState = 'connected';
        this.iceConnectionState = 'connected';
        this.localDescription = null;
        this.remoteDescription = null;
        this._senders = [];
        this._receivers = [];
        this._transceivers = [];
        this._listeners = {};
        this.ontrack = null;
      }
      addEventListener(type, fn) {
        (this._listeners[type] ||= []).push(fn);
      }
      removeEventListener(type, fn) {
        this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn);
      }
      getSenders() { return [...this._senders]; }
      getReceivers() { return [...this._receivers]; }
      getTransceivers() { return [...this._transceivers]; }
      addTrack(track) {
        if (this._senders.some((s) => s.track === track)) {
          const err = new Error("Failed to execute 'addTrack' on 'RTCPeerConnection': A sender already exists for the track.");
          err.name = 'InvalidAccessError';
          throw err;
        }
        const sender = {
          track,
          dtmf: { insertDTMF() {} },
          replaceTrack: async (next) => { sender.track = next; },
        };
        this._senders.push(sender);
        this._transceivers.push({ sender, direction: 'sendrecv', mid: String(this._transceivers.length) });
        return sender;
      }
      removeTrack(sender) {
        this._senders = this._senders.filter((s) => s !== sender);
      }
      async setRemoteDescription(desc) {
        this.remoteDescription = desc;
        this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
        // Fire remote audio track DURING setRemoteDescription (before accept/invite finishes!)
        const remoteTrack = { id: `remote-audio-${desc.type}`, kind: 'audio', enabled: true, stop() {} };
        this._receivers.push({ track: remoteTrack });
        const evt = { track: remoteTrack, streams: [new MockMediaStream([remoteTrack])] };
        if (typeof this.ontrack === 'function') this.ontrack(evt);
        for (const fn of (this._listeners.track || [])) fn(evt);
      }
      async createOffer() {
        return { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n' };
      }
      async createAnswer() {
        return { type: 'answer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n' };
      }
      async setLocalDescription(desc) {
        this.localDescription = desc;
        this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
      }
      close() { this.signalingState = 'closed'; }
    }

    global.MediaStream = MockMediaStream;
    global.MediaStreamTrackEvent = MockMediaStreamTrackEvent;
    global.RTCPeerConnection = StrictPeerConnection;

    try {
      const { SessionDescriptionHandler } = await import('sip.js/lib/platform/web/index.js');
      const localTrack = { id: 'local-mic-1', kind: 'audio', enabled: true, stop() {} };
      const localStream = new MockMediaStream([localTrack]);

      let capturedUaConfig = null;
      let uaRef = null;
      class FakeUA {
        constructor(cfg) {
          this.configuration = cfg;
          this.delegate = cfg.delegate || {};
          this.transport = { isConnected: () => true, onConnect: null, onDisconnect: null };
          capturedUaConfig = cfg;
          uaRef = this;
        }
        getLogger() { return { debug() {}, log() {}, warn() {}, error() {} }; }
        async start() {}
        async stop() {}
        static makeURI(s) { return { user: 'agent', raw: s }; }
      }
      class FakeRegisterer {
        constructor() { this.stateChange = { addListener() {} }; }
        async register() {}
        async unregister() {}
      }

      let outboundSdh = null;
      let outboundTrackBeforeInviteResolved = false;
      const outboundTracks = [];
      class FakeInviter {
        constructor(ua, target, options) {
          this.userAgent = ua;
          this.target = target;
          this.options = options;
          this.state = 'Initial';
          this.stateChange = { addListener() {} };
        }
        get sessionDescriptionHandlerFactory() {
          return this.userAgent.configuration.sessionDescriptionHandlerFactory;
        }
        get sessionDescriptionHandler() { return outboundSdh; }
        async invite() {
          outboundSdh = this.sessionDescriptionHandlerFactory(
            this,
            this.userAgent.configuration.sessionDescriptionHandlerFactoryOptions || {},
          );
          const offer = await outboundSdh.getDescription(this.options?.sessionDescriptionHandlerOptions || {});
          assert.match(offer.body, /a=sendrecv/, 'outbound SDP offer carries sendrecv direction');
          await outboundSdh.setDescription('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n', {});
          outboundTrackBeforeInviteResolved = outboundTracks.length === 1;
          this.state = 'Established';
        }
        async bye() {}
        async cancel() {}
      }

      const incomingEvents = [];
      await signalling.initStandbySession({
        sipStack: {
          UserAgent: FakeUA,
          Registerer: FakeRegisterer,
          Inviter: FakeInviter,
          SessionState: { Initial: 'Initial', Establishing: 'Establishing', Established: 'Established', Terminated: 'Terminated' },
          RegistererState: { Registered: 'Registered', Unregistered: 'Unregistered', Terminated: 'Terminated' },
          SessionDescriptionHandler,
        },
        session: {
          wsUrl: 'wss://sip.telnyx.com:7443',
          server: 'sip.telnyx.com',
          username: 'agent1',
          password: 'secret',
        },
        onState: () => {},
        onIncomingCall: (entry) => incomingEvents.push(entry),
      });

      assert.strictEqual(
        typeof capturedUaConfig.sessionDescriptionHandlerFactory,
        'function',
        'UserAgent must configure sessionDescriptionHandlerFactory up front (no post-INVITE getter crash or glare)',
      );

      // Reproduce real SIP.js Session.prototype getter-only property!
      let sdhInstance = null;
      let trackDeliveredBeforeAcceptResolved = false;
      const deliveredTracks = [];

      const sessionProto = {};
      Object.defineProperty(sessionProto, 'sessionDescriptionHandlerFactory', {
        get() { return this.userAgent.configuration.sessionDescriptionHandlerFactory; },
        enumerable: true,
        configurable: false,
      });

      const fakeInvitation = Object.assign(Object.create(sessionProto), {
        state: 'Initial',
        userAgent: uaRef,
        remoteIdentity: { uri: { user: '+4520123477' }, displayName: 'Lars Jensen' },
        stateChange: { addListener() {} },
        async accept(acceptOpts = {}) {
          sdhInstance = this.sessionDescriptionHandlerFactory(
            this,
            this.userAgent.configuration.sessionDescriptionHandlerFactoryOptions || {},
          );
          await sdhInstance.setDescription('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n', acceptOpts.sessionDescriptionHandlerOptions || {});
          trackDeliveredBeforeAcceptResolved = deliveredTracks.length === 1;
          const answer = await sdhInstance.getDescription(acceptOpts.sessionDescriptionHandlerOptions || {});
          assert.match(answer.body, /a=sendrecv/, 'SDP answer carries bidirectional sendrecv media');
          this.state = 'Established';
        },
        async reject() {},
        async bye() {},
      });
      Object.defineProperty(fakeInvitation, 'sessionDescriptionHandler', {
        get: () => sdhInstance,
      });

      await uaRef.delegate.onInvite(fakeInvitation);
      assert.strictEqual(incomingEvents.length, 1, 'onInvite surfaced incoming call entry');

      await incomingEvents[0].accept(localStream, {
        onTrack: (track) => deliveredTracks.push(track),
      });

      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(fakeInvitation, 'sessionDescriptionHandlerFactory'),
        false,
        'invitation must not be mutated with own sessionDescriptionHandlerFactory property',
      );
      assert.strictEqual(
        trackDeliveredBeforeAcceptResolved,
        true,
        'inbound remote audio track must be captured during SDP negotiation before accept() resolves',
      );
      assert.strictEqual(deliveredTracks[0]?.id, 'remote-audio-offer', 'inbound remote caller audio track received');
      assert.strictEqual(sdhInstance.peerConnection.getSenders().length, 1, 'inbound has exactly 1 audio sender attached (zero duplicate addTrack glare)');

      // Also verify outbound dialOutbound with real SessionDescriptionHandler (previously threw logger.debug TypeError!)
      await signalling.dialOutbound({
        remoteNumber: '+4520887766',
        localStream,
        onState: () => {},
        onTrack: (track) => outboundTracks.push(track),
      });
      assert.strictEqual(outboundTrackBeforeInviteResolved, true, 'outbound remote audio track captured before invite() resolves');
      assert.strictEqual(outboundTracks[0]?.id, 'remote-audio-answer', 'outbound remote audio track received');
      assert.strictEqual(outboundSdh.peerConnection.getSenders().length, 1, 'outbound has 1 audio sender with sendrecv');

      await signalling.disposeStandbySession();
    } finally {
      global.RTCPeerConnection = prevRTC;
      global.MediaStream = prevMS;
      global.MediaStreamTrackEvent = prevMSTE;
    }
  }
  console.log('    ✓ Defect 2: strict WebRTC pre-SDP ontrack attachment & zero duplicate addTrack glare verified');

  // ---------------------------------------------------------------------------
  // 4. Defect 3: api.patchCall + /api/calls/inbound -> PATCH connected ->
  //    PATCH classified -> /api/calls/history + /api/calls/:id/miss + HTTP 206
  // ---------------------------------------------------------------------------
  const apiSource = fs.readFileSync(path.join(REPO, 'src', 'api.js'), 'utf8');
  assert.match(apiSource, /\bpatchCall\s*:/, 'src/api.js must export patchCall so SoftphoneProvider.onActive never throws TypeError');

  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const sess = await httpReq(base, 'GET', '/api/session');
    assert.strictEqual(sess.status, 200);
    const token = sess.json.token;
    const auth = { 'x-pulse-token': token };

    // Seed a known CRM caller with existing notes (must never be overwritten on concurrent INVITEs)
    const knownProspect = prospectRepo.insert({ name: 'Mette Lind', phone: '+4520887766', company: 'Lind Byg ApS' });
    noteRepo.insert(knownProspect.id, 'Important existing discovery note');

    // G-9: Concurrent forked INVITE burst hits /api/calls/inbound simultaneously
    const [forkA, forkB] = await Promise.all([
      httpReq(base, 'POST', '/api/calls/inbound', { headers: auth, body: { callerPhone: '+45 20 88 77 66' } }),
      httpReq(base, 'POST', '/api/calls/inbound', { headers: auth, body: { callerPhone: '20887766' } }),
    ]);
    assert.strictEqual(forkA.status, 200);
    assert.strictEqual(forkB.status, 200);
    assert.strictEqual(forkA.json.callId, forkB.json.callId, 'concurrent forked INVITEs deduplicate to the same ringing call row');
    assert.strictEqual(noteRepo.listByProspect(knownProspect.id)[0].body, 'Important existing discovery note', 'existing prospect notes untouched');

    const inboundCallId = forkA.json.callId;

    // Answering the call transitions status 'ringing' -> 'connected' via PATCH /api/calls/:id
    const connectedPatch = await httpReq(base, 'PATCH', `/api/calls/${inboundCallId}`, {
      headers: auth,
      body: { status: 'connected' },
    });
    assert.strictEqual(connectedPatch.status, 200, `PATCH { status: "connected" } must succeed (got ${connectedPatch.status}: ${connectedPatch.text})`);
    assert.strictEqual(connectedPatch.json.status, 'connected', 'answered inbound call immediately transitions out of ringing to connected');

    // A late racing SIP CANCEL hitting /api/calls/:id/miss AFTER answer must NEVER mark it missed
    const lateCancel = await httpReq(base, 'POST', `/api/calls/${inboundCallId}/miss`, {
      headers: auth,
      body: { reason: 'missed' },
    });
    assert.strictEqual(lateCancel.status, 200);
    assert.strictEqual(lateCancel.json.alreadyResolved, true, 'late CANCEL after answer is ignored cleanly');

    // Hang up & classify the inbound call
    const classifiedPatch = await httpReq(base, 'PATCH', `/api/calls/${inboundCallId}`, {
      headers: auth,
      body: { duration_sec: 52, outcome: 'conversation', summary: 'Discussed Q4 roofing tender' },
    });
    assert.strictEqual(classifiedPatch.status, 200);
    assert.strictEqual(classifiedPatch.json.status, 'completed', 'classified inbound call transitions to status=completed (never left at ringing)');

    // GET /api/calls/history reflects the answered inbound call as NOT missed
    const historyRes = await httpReq(base, 'GET', '/api/calls/history?direction=inbound', { headers: auth });
    assert.strictEqual(historyRes.status, 200, 'GET /api/calls/history endpoint responds 200');
    const histCall = historyRes.json.calls.find((c) => c.id === inboundCallId);
    assert.ok(histCall, 'answered inbound call appears in /api/calls/history');
    assert.strictEqual(histCall.status, 'completed', 'history call status is completed');
    assert.strictEqual(historyRes.json.summary.missedCalls, 0, 'answered inbound call is NOT counted as a Missed Call');

    // G-10: Unknown stranger rings -> simultaneous CANCEL + Decline on /api/calls/:id/miss
    const strangerRing = await httpReq(base, 'POST', '/api/calls/inbound', {
      headers: auth,
      body: { callerPhone: '+4599112233' },
    });
    assert.strictEqual(strangerRing.status, 200);
    assert.strictEqual(strangerRing.json.provisional, true);

    const [missA, missB] = await Promise.all([
      httpReq(base, 'POST', `/api/calls/${strangerRing.json.callId}/miss`, { headers: auth, body: { reason: 'declined' } }),
      httpReq(base, 'POST', `/api/calls/${strangerRing.json.callId}/miss`, { headers: auth, body: { reason: 'missed' } }),
    ]);
    assert.strictEqual(missA.status, 200);
    assert.strictEqual(missB.status, 200);
    assert.strictEqual(prospectRepo.get(strangerRing.json.prospect.id), undefined, 'provisional stranger prospect cleaned up with zero orphans');

    // Verify HTTP 206 Partial Content byte-range streaming for Recents InlineAudioPlayer scrubbing
    const { recordingsDir } = require('../../server/config/env');
    const recordingRepo = require('../../server/repositories/recordingRepo');
    const sampleBytes = Buffer.from('WEBM_OPUS_AUDIO_STREAM_BYTES_0123456789ABCDEF');
    const recFilename = `call_${inboundCallId}_test.webm`;
    fs.writeFileSync(path.join(recordingsDir, recFilename), sampleBytes);
    recordingRepo.insert({
      callId: inboundCallId,
      prospectId: knownProspect.id,
      filename: recFilename,
      mimeType: 'audio/webm',
      sizeBytes: sampleBytes.length,
      durationSec: 52,
    });
    const rangeStream = await httpReq(base, 'GET', `/api/recordings/${inboundCallId}/audio`, {
      headers: { ...auth, Range: 'bytes=5-15' },
    });
    assert.strictEqual(rangeStream.status, 206, 'recording audio endpoint supports HTTP 206 Partial Content range scrubbing');
    assert.strictEqual(rangeStream.headers['content-range'], `bytes 5-15/${sampleBytes.length}`);
    assert.strictEqual(rangeStream.raw.length, 11);
    console.log('    ✓ Defect 3: Recents inbound/outbound ledger transitions, concurrency & HTTP 206 streaming verified');
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('  [webrtc-audio-recents] ALL CHECKS PASSED\n');
}

run().catch((err) => {
  console.error('  ❌ [webrtc-audio-recents] FAILED:', err.message);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
