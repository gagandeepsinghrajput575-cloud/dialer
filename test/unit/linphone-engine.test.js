// The in-app telephony engine: a headless Linphone daemon supervised by the desktop shell.
//
// Nothing here needs Electron or a real Linphone build: the command protocol, the output
// parser, process supervision and the "never decline on answer" invariant are all exercised
// against an injected fake child process, so a regression fails on CI rather than on a call.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');

const {
  buildRegistration, buildCall, buildAnswer, buildTerminate, buildDtmf, buildMute, parseDaemonLine, redact,
} = require('../../desktop/telephony/daemonProtocol');
const { LinphoneDaemon, resolveBinary, BINARY_CANDIDATES } = require('../../desktop/telephony/linphoneDaemon');

console.log('--- Unit: In-app Linphone engine (protocol, supervisor, no-decline) ---');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// Strip comments: these are source assertions about behaviour, and prose must not satisfy them.
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// The exact body of a class method, brace-matched, so a neighbouring method can never satisfy
// (or violate) an assertion about this one.
function methodBody(source, name) {
  const start = source.indexOf(`\n  ${name}(`);
  if (start === -1) throw new Error(`method ${name}() not found`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

// ---- protocol: commands -------------------------------------------------------------------
{
  const register = buildRegistration({ user: 'usertanishkarajput43011498', domain: 'sip.telnyx.com', password: 's3cret' });
  assert.deepStrictEqual(register, ['register sip:usertanishkarajput43011498@sip.telnyx.com sip:sip.telnyx.com s3cret']);
  assert.strictEqual(buildCall('+4520123456', 'sip.telnyx.com'), 'call sip:+4520123456@sip.telnyx.com');
  assert.strictEqual(buildCall('sip:+4520123456@sip.telnyx.com'), 'call sip:+4520123456@sip.telnyx.com', 'a full URI is not double-wrapped');
  assert.strictEqual(buildAnswer(7), 'answer 7');
  assert.strictEqual(buildTerminate(7), 'terminate 7');
  assert.strictEqual(buildDtmf('5'), 'dtmf 5');
  assert.strictEqual(buildDtmf('X'), null, 'only RFC 4733 digits are sent');
  assert.strictEqual(buildMute(true), 'mute');
  assert.strictEqual(buildMute(false), 'unmute');
  assert.strictEqual(redact(register[0]).includes('s3cret'), false, 'logs never carry the SIP secret');
  assert.match(redact(register[0]), /register sip:/);
  console.log('  ✓ command builders match the linphonec/linphone-daemon dialect, secrets redacted');
}

// ---- protocol: output parser ---------------------------------------------------------------
{
  const cases = [
    ['Receiving new incoming call from "sip:+18164653119@sip.telnyx.com", assigned id 1',
      { type: 'incoming', callId: 1, peer: '+18164653119' }],
    ['Call 1 with "sip:+18164653119@sip.telnyx.com" is ringing',
      { type: 'ringing', callId: 1, peer: '+18164653119' }],
    ['Call 1 with "sip:+18164653119@sip.telnyx.com" connected.',
      { type: 'answered', callId: 1 }],
    ['Call 1: state changed to Connected',
      { type: 'answered', callId: 1 }],
    ['Call 1 with "sip:+18164653119@sip.telnyx.com" ended (Call terminated).',
      { type: 'ended', callId: 1 }],
    ['Call 1: state changed to End',
      { type: 'ended', callId: 1 }],
    ['Registration on proxy sip:sip.telnyx.com successful.',
      { type: 'registration', state: 'registered' }],
    ['Registration on proxy sip:sip.telnyx.com failed: 403',
      { type: 'registration', state: 'failed' }],
    ['linphonec>', { type: 'prompt' }],
  ];
  for (const [line, expected] of cases) {
    const parsed = parseDaemonLine(line);
    assert.ok(parsed, `line was not recognised: ${line}`);
    for (const [key, value] of Object.entries(expected)) {
      assert.strictEqual(parsed[key], value, `${line} -> ${key}`);
    }
  }
  assert.strictEqual(parseDaemonLine(''), null);
  assert.strictEqual(parseDaemonLine('Media streams initialized'), null, 'chatter is ignored, not guessed at');
  console.log('  ✓ daemon output maps to incoming/ringing/answered/ended/registration events');
}

// ---- supervisor ----------------------------------------------------------------------------
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.written = [];
  child.stdin = { writable: true, write: (text) => { child.written.push(text); return true; } };
  child.kill = () => { child.killed = true; };
  child.exitCode = null;
  child.say = (line) => child.stdout.emit('data', Buffer.from(`${line}\n`));
  return child;
}

(async () => {
  // A missing binary must be reported, never faked.
  assert.strictEqual(resolveBinary({ exists: () => false, platform: 'darwin' }), null);
  assert.ok(BINARY_CANDIDATES.length >= 3, 'the search covers the bundle, /opt/homebrew and PATH');
  const found = resolveBinary({ exists: (p) => p === '/opt/homebrew/bin/linphone-daemon', platform: 'darwin' });
  assert.strictEqual(found, '/opt/homebrew/bin/linphone-daemon');

  {
    const child = fakeChild();
    const events = [];
    const spawned = [];
    const daemon = new LinphoneDaemon({
      config: { user: 'usertanishkarajput43011498', domain: 'sip.telnyx.com', password: 's3cret' },
      binary: '/fake/linphone-daemon',
      spawn: (bin, args, opts) => { spawned.push({ bin, args, opts }); return child; },
      onEvent: (e) => events.push(e),
    });
    assert.strictEqual(daemon.available, true);
    daemon.start();

    assert.strictEqual(spawned.length, 1);
    assert.deepStrictEqual(spawned[0].opts.stdio, ['pipe', 'pipe', 'pipe'], 'the daemon is a hidden pipe child');
    assert.strictEqual(spawned[0].opts.windowsHide, undefined, 'no window flags leak onto macOS');
    assert.ok(child.written.join('').includes('register sip:usertanishkarajput43011498@sip.telnyx.com'));
    assert.strictEqual(child.written.join('').includes('s3cret'), true, 'the secret reaches the daemon stdin…');
    assert.strictEqual(JSON.stringify(events).includes('s3cret'), false, '…but never an event payload');

    child.say('Registration on proxy sip:sip.telnyx.com successful.');
    assert.ok(events.some((e) => e.type === 'registration' && e.state === 'registered'));

    child.say('Receiving new incoming call from "sip:+18164653119@sip.telnyx.com", assigned id 1');
    const incoming = events.find((e) => e.type === 'incoming');
    assert.strictEqual(incoming.callerPhone, '+18164653119');
    assert.strictEqual(incoming.callId, 1);
    console.log('  ✓ daemon boots as a hidden child, registers, and reports the caller');

    // THE invariant: answering must never terminate or reject the call.
    child.written.length = 0;
    const answered = daemon.answer(1);
    assert.strictEqual(answered, true);
    assert.deepStrictEqual(child.written.map((l) => l.trim()), ['answer 1']);
    assert.strictEqual(child.written.join('').match(/terminate|decline|reject/), null, 'answer() has no teardown inside it');
    console.log('  ✓ answer(1) writes exactly "answer 1" — no terminate, no decline');

    child.say('Call 1 with "sip:+18164653119@sip.telnyx.com" connected.');
    assert.ok(events.some((e) => e.type === 'answered' && e.callId === 1));

    child.written.length = 0;
    assert.strictEqual(daemon.dtmf('5'), true);
    assert.strictEqual(daemon.dtmf('X'), false);
    assert.deepStrictEqual(child.written.map((l) => l.trim()), ['dtmf 5']);
    assert.strictEqual(daemon.status().callId, 1);
    assert.strictEqual(daemon.status().state, 'connected');

    child.written.length = 0;
    assert.strictEqual(daemon.hangup(1), true);
    assert.deepStrictEqual(child.written.map((l) => l.trim()), ['terminate 1']);

    child.say('Call 1 with "sip:+18164653119@sip.telnyx.com" ended (Call terminated).');
    assert.ok(events.some((e) => e.type === 'ended' && e.callId === 1));
    assert.strictEqual(daemon.status().state, 'idle');
    console.log('  ✓ DTMF, hang-up and end-of-call are one command each and reported once');

    daemon.stop();
    assert.strictEqual(child.killed, true);
  }

  // An outbound dial is one command, and a URI that Linphone cannot parse is refused locally.
  {
    const child = fakeChild();
    const daemon = new LinphoneDaemon({
      config: { user: 'u', domain: 'sip.telnyx.com', password: 'p' },
      binary: '/fake/linphone-daemon', spawn: () => child, onEvent: () => {},
    });
    daemon.start();
    child.written.length = 0;
    assert.strictEqual(daemon.dial('+4520123456'), true);
    assert.deepStrictEqual(child.written.map((l) => l.trim()), ['call sip:+4520123456@sip.telnyx.com']);
    assert.strictEqual(daemon.dial(''), false);
    console.log('  ✓ dial() sends one call command to the carrier URI');
  }

  // A crashed daemon is restarted once, and a second crash stops the retry loop.
  {
    const children = [];
    const events = [];
    const daemon = new LinphoneDaemon({
      config: { user: 'u', domain: 'd', password: 'p' },
      binary: '/fake/linphone-daemon',
      spawn: () => { const c = fakeChild(); children.push(c); return c; },
      onEvent: (e) => events.push(e),
      restartDelayMs: 1,
    });
    daemon.start();
    children[0].exitCode = 1;
    children[0].emit('exit', 1, null);
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(children.length, 2, 'the daemon is restarted after a crash');
    children[1].exitCode = 1;
    children[1].emit('exit', 1, null);
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(children.length, 2, 'the restart budget is bounded');
    assert.ok(events.some((e) => e.type === 'engine' && e.state === 'failed'));
    daemon.stop();
    console.log('  ✓ a crashed daemon is respawned once, then reported failed instead of looping');
  }

  // ---- invariants across the whole shell -------------------------------------------------
  {
    const bridge = code(read('desktop/bridge.js'));
    const answerBody = methodBody(bridge, 'answer');
    assert.strictEqual(/\.decline\(|\.terminate\(|reject\(/.test(answerBody), false,
      'bridge.answer() must never decline or terminate a ringing call');
    assert.match(bridge, /reason: 'no-media-engine'/, 'a signalling-only engine says so instead of faking an answer');

    const daemonSource = code(read('desktop/telephony/linphoneDaemon.js'));
    const daemonAnswer = methodBody(daemonSource, 'answer');
    assert.strictEqual(/terminate|decline|reject/i.test(daemonAnswer), false, 'the daemon adapter never tears down on answer');

    // The browser half: sip.js exposes sessionDescriptionHandlerFactory as a getter with no
    // setter. Assigning to it threw the TypeError that killed every answered call.
    const signalling = read('src/webrtcSignalling.js');
    assert.strictEqual(/invitation\.sessionDescriptionHandlerFactory\s*=/.test(signalling), false,
      'never assign to the read-only session factory');

    const { acceptInvitation } = await import(pathToFileURL(path.join(ROOT, 'src', 'webrtcSignalling.js')).href);
    let captured = null;
    const invitation = {
      state: 'Initial',
      get sessionDescriptionHandlerFactory() { return 'ua-config'; },
      accept: async (options) => { captured = options; },
    };
    const stream = { getAudioTracks: () => [{ readyState: 'live' }] };
    await acceptInvitation(invitation, stream);
    assert.ok(captured, 'accept() is reached');
    assert.strictEqual(captured.sessionDescriptionHandlerOptions.iceGatheringTimeout, 3000);
    assert.deepStrictEqual(captured.sessionDescriptionHandlerOptions.constraints, { audio: true, video: false });
    assert.strictEqual(invitation.sessionDescriptionHandlerFactory, 'ua-config', 'the accessor is untouched');

    await assert.rejects(() => acceptInvitation({ state: 'Terminated', accept: async () => {} }, stream), /terminated/i);
    console.log('  ✓ getter-only sip.js invitation is accepted without a TypeError (answer regression pinned)');
  }

  // ---- renderer wiring -------------------------------------------------------------------
  {
    const { subscribeNative } = await import(pathToFileURL(path.join(ROOT, 'src', 'desktop', 'nativeInbound.mjs')).href);
    const seen = [];
    let handler = null;
    const bridge = { onEvent: (fn) => { handler = fn; return () => { handler = null; }; } };
    const off = subscribeNative(bridge, {
      onRinging: (e) => seen.push(['ringing', e.callerPhone]),
      onLedger: (e) => seen.push(['ledger', e.callId]),
      onAnswered: (e) => seen.push(['answered', e.callId]),
      onEnded: (e) => seen.push(['ended', e.reason]),
    });
    assert.strictEqual(typeof handler, 'function', 'the renderer subscribes to native events');
    handler({ type: 'incoming_call', callerPhone: '+18164653119' });
    handler({ type: 'ledger', callId: 161 });
    handler({ type: 'answered', callId: 161 });
    handler({ type: 'ended', callId: 161, reason: 'remote' });
    handler({ type: 'prompt' });
    handler(null);
    assert.deepStrictEqual(seen, [
      ['ringing', '+18164653119'], ['ledger', 161], ['answered', 161], ['ended', 'remote'],
    ], 'each native event reaches exactly one handler; chatter is ignored');
    off();
    assert.strictEqual(handler, null, 'unsubscribing releases the IPC listener');
    assert.strictEqual(typeof subscribeNative(null, {}), 'function', 'no shell means an inert no-op');

    const provider = read('src/softphone.jsx');
    assert.match(provider, /useNativeInbound\(/, 'the cockpit consumes native calls');
    assert.match(provider, /answerInbound = nativeRinging \? native\.answer/, 'a native ring answers through IPC');
    assert.match(provider, /incomingCall: ringingCall/, 'the modal renders the native ring');
    console.log('  ✓ native events ring the modal, adopt the ledger row and answer through IPC');
  }

  console.log('\n🎉 [unit:linphone] all in-app engine checks passed\n');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
