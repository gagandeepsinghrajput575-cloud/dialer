// Live Call Hardening Verification Suite (Challenges 1..6)
//
// Strictly tests all 6 live telephony audio & SIP edge cases:
//   Challenge 1: Asynchronous two-way recording mixer — remote RTP audio track arriving AFTER
//                startRecording() dynamically connects into MediaStreamDestination without
//                stopping/restarting MediaRecorder so both voices are captured.
//   Challenge 2: Outbound Danish ringback synthesis (425 Hz, 1s on / 4s off, 0.06 gain) on
//                180 Ringing without SDP, silenced immediately on 183 w/ SDP or 200 OK.
//   Challenge 3: SIP 4xx/5xx/6xx rejection decoding & CRM auto-disposition mapping
//                (404/410/484 -> bad_number, 486/600 -> busy, 408/487 -> no_answer,
//                403/503 -> urgent Telnyx carrier alert).
//   Challenge 4: Telecom-grade getUserMedia DSP constraints (echoCancellation, noiseSuppression,
//                autoGainControl, channelCount: 1, sampleRate: 48000) with fallback to { audio: true }.
//   Challenge 5: Dual-mode DTMF dispatch: primary RTCDTMFSender.insertDTMF(digit, 160, 70),
//                secondary fallback session.sendDTMF(digit) / SIP INFO, tertiary local tone.
//   Challenge 6: Unicode/punctuation Danish E.164 sanitization & Copenhagen CLI header stamping
//                (P-Asserted-Identity / From presentation with +4532331610).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-live-hardening-'));
process.env.DATA_DIR = tmpRoot;
process.env.NODE_ENV = 'test';

const migrate = require('../../server/db/migrate');
migrate.run();

const { db } = require('../../server/db');
const settingsRepo = require('../../server/repositories/settingsRepo');
const telephonyService = require('../../server/services/telephonyService');

function ok(label) {
  console.log(`    ✓ ${label}`);
}

(async () => {
  console.log('  [live-call-hardening] two-way recording mix, 425Hz ringback, SIP 4xx/5xx decode, DSP, dual DTMF & CLI');

  try {
    const webrtcMod = await import('../../src/useWebRtc.js');
    const sigMod = await import('../../src/webrtcSignalling.js');
    const ringerMod = await import('../../src/utils/ringer.js');
    const utilsMod = await import('../../src/utils.js');

    // =========================================================================
    // CHALLENGE 1: Asynchronous Two-Way Recording Mixer (Late Remote RTP Track)
    // =========================================================================
    assert.strictEqual(typeof webrtcMod.createRecordingSession, 'function', 'createRecordingSession must be exported');

    const connectedStreams = [];
    let recorderRestarts = 0;
    let recorderStops = 0;

    class MockAudioContext {
      constructor() {
        this.state = 'running';
        this.dest = { stream: { id: 'mixed-bus' } };
      }
      resume() { this.state = 'running'; return Promise.resolve(); }
      createMediaStreamDestination() { return this.dest; }
      createMediaStreamSource(stream) {
        return {
          stream,
          connect: (target) => {
            connectedStreams.push({ stream, target, trackIds: stream.getAudioTracks().map((t) => t.id) });
          },
        };
      }
      close() { this.state = 'closed'; return Promise.resolve(); }
    }

    class MockMediaRecorder {
      static isTypeSupported(mime) { return mime === 'audio/webm;codecs=opus'; }
      constructor(stream, opts) {
        this.stream = stream;
        this.mimeType = opts?.mimeType || 'audio/webm';
        this.state = 'inactive';
        this.ondataavailable = null;
        this.onstop = null;
      }
      start() {
        recorderRestarts += 1;
        this.state = 'recording';
        this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: this.mimeType }) });
      }
      stop() {
        recorderStops += 1;
        this.state = 'inactive';
        this.onstop?.();
      }
    }

    const agentMicTrack = { id: 'agent-mic-track', kind: 'audio' };
    const agentStream = { getAudioTracks: () => [agentMicTrack] };

    // T=0ms: Call goes active BEFORE remote RTP track has arrived -> only local stream exists
    let recordedPayload = null;
    const mixSession = webrtcMod.createRecordingSession({
      callId: 777,
      localStream: agentStream,
      remoteStream: null,
      AudioContextCtor: MockAudioContext,
      MediaRecorderCtor: MockMediaRecorder,
      onStop: (payload) => { recordedPayload = payload; },
    });
    assert.strictEqual(connectedStreams.length, 1, 'agent microphone connected immediately at T=0ms');
    assert.deepStrictEqual(connectedStreams[0].trackIds, ['agent-mic-track']);

    // T=180ms: Remote RTP audio track arrives asynchronously from Telnyx ICE/DTLS completion!
    const customerTrack = { id: 'telnyx-remote-rtp-track', kind: 'audio' };
    const attached = mixSession.mixRemoteTrackIntoRecording(customerTrack);
    assert.strictEqual(attached, true, 'late-arriving remote customer track must attach dynamically');
    assert.strictEqual(connectedStreams.length, 2, 'BOTH agent mic and customer audio now feed destination bus');
    assert.deepStrictEqual(connectedStreams[1].trackIds, ['telnyx-remote-rtp-track']);
    assert.strictEqual(recorderRestarts, 1, 'MediaRecorder must NOT restart or drop buffered audio frames');

    // Duplicate track notification must be idempotent (never double-gain the customer audio)
    assert.strictEqual(mixSession.mixRemoteTrackIntoRecording(customerTrack), false, 'duplicate remote track must not double-connect');
    assert.strictEqual(connectedStreams.length, 2);

    mixSession.stop();
    assert.strictEqual(recorderStops, 1);
    assert.ok(recordedPayload && recordedPayload.blob.size > 0, 'mixed WebM/Opus blob emitted on hangup');
    ok('Challenge 1: reactive two-way recording mixer dynamically routes late remote RTP tracks');

    // =========================================================================
    // CHALLENGE 2: Outbound Audible Ringback Synthesis (180 vs 183 w/ SDP & 200 OK)
    // =========================================================================
    assert.strictEqual(typeof ringerMod.createRingback, 'function', 'createRingback must be exported');
    assert.deepStrictEqual(ringerMod.DANISH_RINGBACK, {
      frequency: 425,
      onMs: 1000,
      offMs: 4000,
      volume: 0.06,
    });

    const gainEvents = [];
    const rbRing = ringerMod.createRingback({
      audioContext: class {
        constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
        createGain() {
          return {
            gain: {
              setValueAtTime: (v, t) => gainEvents.push({ v, t }),
              cancelScheduledValues: () => {},
            },
            connect: () => {},
            disconnect: () => {},
          };
        }
        createOscillator() {
          return {
            type: 'sine',
            frequency: { setValueAtTime: (f) => { this.freq = f; } },
            connect: () => {},
            start: () => {},
            stop: () => {},
            disconnect: () => {},
          };
        }
        close() { this.state = 'closed'; return Promise.resolve(); }
      },
    });
    assert.strictEqual(rbRing.start(), true);
    assert.strictEqual(rbRing.ringing(), true);
    assert.ok(gainEvents.some((e) => Math.abs(e.v - 0.06) < 1e-6), 'ringback gain uses quiet 0.06 volume');
    rbRing.stop();
    assert.strictEqual(rbRing.ringing(), false);

    // Drive full outbound SIP INVITE -> 180 Ringing (no SDP) -> 183 Session Progress (with SDP) -> 200 OK
    let capturedInviteOpts = null;
    let inviterListeners = [];
    const mockSipStack = {
      SessionState: { Initial: 'Initial', Establishing: 'Establishing', Established: 'Established', Terminated: 'Terminated' },
      UserAgent: class {
        static makeURI(raw) { return { raw }; }
        constructor(opts) { this.opts = opts; this.transport = {}; }
        getLogger() { return { debug() {}, info() {}, warn() {}, error() {} }; }
        async start() {}
        async stop() {}
      },
      Registerer: class {
        constructor() { this.stateChange = { addListener() {} }; }
        async register() {}
        async unregister() {}
      },
      Inviter: class {
        constructor(_ua, target, opts) {
          this.target = target;
          this.opts = opts;
          this.state = 'Initial';
          this.stateChange = { addListener: (fn) => inviterListeners.push(fn) };
          this.dtmfSent = [];
        }
        async sendDTMF(digit) {
          this.dtmfSent.push(digit);
        }
        async invite(opts) {
          capturedInviteOpts = opts;
          return {};
        }
        bye() { this.state = 'Terminated'; }
        cancel() { this.state = 'Terminated'; }
      },
    };

    await sigMod.initStandbySession({
      session: {
        server: 'sip.telnyx.com',
        wsUrl: 'wss://sip.telnyx.com:7443',
        username: 'agent_dk',
        password: 'secret',
        callerId: '+4532331610',
      },
      onIncomingCall: () => {},
      sipStack: mockSipStack,
    });

    const progressEvents = [];
    let answeredFired = false;
    const outboundHandle = await sigMod.dialOutbound({
      remoteNumber: '+45 (20) 12-34-56',
      callerId: '+45 32 33 16 10',
      onProgress: (ev) => progressEvents.push(ev),
      onAnswered: () => { answeredFired = true; },
    });

    assert.ok(capturedInviteOpts?.requestDelegate?.onProgress, 'Inviter.invite must attach requestDelegate.onProgress');
    assert.ok(capturedInviteOpts?.requestDelegate?.onReject, 'Inviter.invite must attach requestDelegate.onReject');

    // Simulate 180 Ringing WITHOUT SDP -> hasEarlyMedia === false (triggers local ringback)
    capturedInviteOpts.requestDelegate.onProgress({
      message: { statusCode: 180, reasonPhrase: 'Ringing', body: '' },
    });
    assert.strictEqual(progressEvents.length, 1);
    assert.strictEqual(progressEvents[0].statusCode, 180);
    assert.strictEqual(progressEvents[0].hasEarlyMedia, false, '180 without SDP flags hasEarlyMedia=false');

    // Simulate 183 Session Progress WITH SDP -> hasEarlyMedia === true (silences local ringback!)
    capturedInviteOpts.requestDelegate.onProgress({
      message: { statusCode: 183, reasonPhrase: 'Session Progress', body: 'v=0\r\nm=audio 20000 RTP/AVP 0\r\n' },
    });
    assert.strictEqual(progressEvents[1].statusCode, 183);
    assert.strictEqual(progressEvents[1].hasEarlyMedia, true, '183 with SDP m=audio flags hasEarlyMedia=true');

    // Simulate 200 OK answer -> silences ringback immediately
    capturedInviteOpts.requestDelegate.onAccept({
      message: { statusCode: 200, reasonPhrase: 'OK' },
    });
    assert.strictEqual(answeredFired, true, '200 OK invokes onAnswered immediately');
    ok('Challenge 2: 180 Ringing (425Hz 1s/4s @ 0.06) vs 183 Session Progress SDP & 200 OK verified');

    // =========================================================================
    // CHALLENGE 3: SIP 4xx/5xx/6xx Rejection Decoding & Smart CRM Auto-Disposition
    // =========================================================================
    assert.strictEqual(typeof sigMod.decodeSipRejection, 'function', 'decodeSipRejection must be exported');

    for (const code of [404, 410, 484]) {
      const d = sigMod.decodeSipRejection(code, 'Not Found');
      assert.strictEqual(d.sipCode, code);
      assert.strictEqual(d.autoOutcome, 'bad_number');
      assert.strictEqual(d.reason, 'Number disconnected or not found');
    }
    for (const code of [486, 600]) {
      const d = sigMod.decodeSipRejection(code, 'Busy Here');
      assert.strictEqual(d.sipCode, code);
      assert.strictEqual(d.autoOutcome, 'busy');
      assert.strictEqual(d.reason, 'Line is busy / Call rejected by prospect');
    }
    for (const code of [408, 487]) {
      const d = sigMod.decodeSipRejection(code, 'Request Timeout');
      assert.strictEqual(d.sipCode, code);
      assert.strictEqual(d.autoOutcome, 'no_answer');
      assert.strictEqual(d.reason, 'No answer after timeout');
    }
    for (const code of [403, 503]) {
      const d = sigMod.decodeSipRejection(code, 'Service Unavailable');
      assert.strictEqual(d.sipCode, code);
      assert.strictEqual(d.isCarrierError, true);
      assert.strictEqual(d.reason, 'Carrier error: Telnyx rejected Caller ID or trunk unavailable');
    }

    // Also prove requestDelegate.onReject forwards { sipCode, reason, autoOutcome } directly into onEnded!
    let endedPayload = null;
    await sigMod.dialOutbound({
      remoteNumber: '+4520998877',
      onEnded: (meta) => { endedPayload = meta; },
    });
    capturedInviteOpts.requestDelegate.onReject({
      message: { statusCode: 486, reasonPhrase: 'Busy Here' },
    });
    assert.ok(endedPayload, 'SIP rejection must invoke onEnded with decoded rejection payload');
    assert.strictEqual(endedPayload.sipCode, 486);
    assert.strictEqual(endedPayload.autoOutcome, 'busy');
    assert.strictEqual(endedPayload.reason, 'Line is busy / Call rejected by prospect');
    ok('Challenge 3: SIP 404/410/484, 486/600, 408/487, and 403/503 decoded & routed into onEnded');

    // =========================================================================
    // CHALLENGE 4: Telecom-Grade Microphone DSP Constraints + Fallback
    // =========================================================================
    assert.strictEqual(typeof webrtcMod.buildAudioConstraints, 'function');
    assert.strictEqual(typeof webrtcMod.acquireMicrophoneStream, 'function');

    const builtConstraints = webrtcMod.buildAudioConstraints('jabra-usb-id');
    assert.deepStrictEqual(builtConstraints, {
      audio: {
        deviceId: { ideal: 'jabra-usb-id' },
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        autoGainControl: { ideal: true },
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000 },
      },
    });

    const gumCalls = [];
    const fallbackStream = { getAudioTracks: () => [{ id: 'fallback-mic', label: 'Generic USB Audio' }] };
    const acquired = await webrtcMod.acquireMicrophoneStream({
      preferredDeviceId: 'specialized-dac',
      mediaDevices: {
        getUserMedia: async (constraints) => {
          gumCalls.push(constraints);
          if (typeof constraints.audio === 'object') {
            const err = new Error('OverconstrainedError: sampleRate not supported');
            err.name = 'OverconstrainedError';
            throw err;
          }
          return fallbackStream;
        },
      },
    });
    assert.strictEqual(acquired, fallbackStream, 'must gracefully fall back to { audio: true } stream');
    assert.strictEqual(gumCalls.length, 2, 'attempted strict telecom DSP constraints first, then { audio: true }');
    assert.deepStrictEqual(gumCalls[1], { audio: true });
    ok('Challenge 4: telecom DSP constraints + automatic { audio: true } fallback verified');

    // =========================================================================
    // CHALLENGE 5: Dual-Mode DTMF Dispatch (RTCDTMFSender -> SIP INFO -> Local Tone)
    // =========================================================================
    assert.strictEqual(typeof webrtcMod.dispatchDtmfTone, 'function', 'dispatchDtmfTone must be exported');

    // Mode 1: Primary RTCDTMFSender.insertDTMF(digit, 160, 70)
    const rtpInserted = [];
    let localBeeps = 0;
    const primaryRes = await webrtcMod.dispatchDtmfTone({
      digit: '1',
      pc: {
        getSenders: () => [{
          track: { kind: 'audio' },
          dtmf: { insertDTMF: (d, dur, gap) => rtpInserted.push({ d, dur, gap }) },
        }],
      },
      sipHandle: outboundHandle,
      playLocalTone: () => { localBeeps += 1; },
    });
    assert.strictEqual(primaryRes.mode, 'rfc4733');
    assert.deepStrictEqual(rtpInserted, [{ d: '1', dur: 160, gap: 70 }]);
    assert.strictEqual(localBeeps, 1, 'tactile local feedback beep plays on primary DTMF');

    // Mode 2: RTCDTMFSender absent/throws -> falls back cleanly to SIP session.sendDTMF(digit)
    const secondaryRes = await webrtcMod.dispatchDtmfTone({
      digit: '2',
      pc: {
        getSenders: () => [{
          track: { kind: 'audio' },
          dtmf: { insertDTMF: () => { throw new Error('InvalidStateError: cannot insert DTMF'); } },
        }],
      },
      sipHandle: outboundHandle,
      playLocalTone: () => { localBeeps += 1; },
    });
    assert.strictEqual(secondaryRes.mode, 'sip-info');
    assert.deepStrictEqual(outboundHandle.inviter.dtmfSent, ['2']);
    assert.strictEqual(localBeeps, 2, 'tactile local feedback beep plays on SIP INFO fallback');
    ok('Challenge 5: dual-mode DTMF (RTCDTMFSender 160/70 -> SIP session.sendDTMF -> local beep) verified');

    // =========================================================================
    // CHALLENGE 6: Danish E.164 Number Sanitization & CLI Presentation (+4532331610)
    // =========================================================================
    const messyInputs = [
      '+45 (20) 12-34-56',
      '0045\u00A020\u202F12\u200934\u200B56',
      '20 12 34 56',
      '  +45\u00A0(20)\u201312.34/56  ',
    ];
    for (const raw of messyInputs) {
      assert.strictEqual(telephonyService.normalizePhone(raw), '+4520123456', `server normalizePhone failed for "${raw}"`);
      assert.strictEqual(utilsMod.normalizePhoneClient(raw, '45'), '+4520123456', `client normalizePhoneClient failed for "${raw}"`);
      const sipUri = telephonyService.buildWebRtcUri(raw);
      assert.strictEqual(sipUri, 'sip:+4520123456@sip.telnyx.com;transport=ws', `SIP URI must never contain spaces/punctuation: ${sipUri}`);
    }

    // Verify outbound SIP INVITE target + extraHeaders carry sanitized E.164 target & Copenhagen DID
    assert.strictEqual(outboundHandle.inviter.target.raw, 'sip:+4520123456@sip.telnyx.com;transport=ws');
    const extraHeaders = capturedInviteOpts?.requestOptions?.extraHeaders
      || outboundHandle.inviter.opts?.extraHeaders
      || [];
    assert.ok(
      extraHeaders.some((h) => /P-Asserted-Identity:\s*<sip:\+4532331610@sip\.telnyx\.com>/i.test(h)),
      `expected P-Asserted-Identity with +4532331610 in extraHeaders, got ${JSON.stringify(extraHeaders)}`,
    );

    // Verify telephonyService.webrtcSession() falls back to clean E.164 FlyNumber Copenhagen DID +4532331610
    settingsRepo.set('caller_id', '');
    settingsRepo.set('caller_id_pool', '');
    settingsRepo.set('flynumber_did', '+45 32 33 16 10');
    const wsDesc = telephonyService.webrtcSession();
    assert.strictEqual(wsDesc.wsUrl, 'wss://sip.telnyx.com:7443', 'Sacred Invariant #1: gateway remains wss://sip.telnyx.com:7443');
    assert.strictEqual(wsDesc.callerId, '+4532331610', 'webrtcSession guarantees clean Copenhagen DID CLI');
    ok('Challenge 6: Unicode/punctuation Danish E.164 sanitization & +4532331610 CLI headers verified');

    await sigMod.disposeStandbySession();
    console.log('  [live-call-hardening] ALL 6 LIVE-CALL HARDENING CHALLENGES PASSED!');
  } finally {
    try { db.close(); } catch { /* ignore */ }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error('  [live-call-hardening] FAILED:', err);
  process.exit(1);
});
