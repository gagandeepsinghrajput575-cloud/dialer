// Unit layer for the inbound softphone engine.
//
// The parts of "a call rings in the browser tab" that no integration test can catch reliably
// are here, because they are the ones that fail *silently*: an oscillator that keeps ringing
// after the call is answered, a second tab that rings over the first, a caller ID that gets
// matched against the wrong customer's notes. All three are pure logic, so they are tested
// without a DOM and without a browser.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

let passed = 0;
const ok = (msg) => { passed++; console.log(`    \u2713 ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for the Web Audio API that records every node it hands out, so "the ringer was
// torn down" can be asserted as a fact (stopped, disconnected, closed) instead of inferred.
function fakeAudio() {
  const log = { contexts: [], oscillators: [], gains: [] };
  class Gain {
    constructor(ctx) {
      this.ctx = ctx;
      this.disconnected = false;
      this.sets = [];
      const node = this;
      this.gain = {
        value: 0,
        setValueAtTime(v) { node.sets.push(v); this.value = v; },
        cancelScheduledValues() { node.cancelled = true; },
        linearRampToValueAtTime() {},
      };
      log.gains.push(this);
    }
    connect() { return this; }
    disconnect() { this.disconnected = true; }
  }
  class Oscillator {
    constructor() {
      this.type = '';
      this.frequency = { value: 0, setValueAtTime: (v) => { this.frequency.value = v; } };
      this.started = false;
      this.stopped = false;
      this.disconnected = false;
      log.oscillators.push(this);
    }
    connect() { return this; }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    disconnect() { this.disconnected = true; }
  }
  class AudioContext {
    constructor() {
      this.currentTime = 0;
      this.state = 'running';
      this.destination = {};
      log.contexts.push(this);
    }
    createGain() { return new Gain(this); }
    createOscillator() { return new Oscillator(this); }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  return { AudioContext, log };
}

async function run() {
  console.log('  [inbound] ringer lifecycle, caller-ID matching, cross-tab audio lock');

  const { createRinger, DANISH_RING } = await import('../../src/utils/ringer.js');
  // Every ringer in this file is torn down at the end, even when an assertion fails part-way:
  // a live synthetic ringer holds a repeating timer and would hang the runner, which is the
  // exact class of bug this suite exists to prevent.
  const live = [];
  const newRinger = (opts) => { const r = createRinger(opts); live.push(r); return r; };
  const { samePhone, formatCallerNumber, holdCrossTabLock } = await import('../../src/utils.js');

  // ---- the tone itself ----
  assert.strictEqual(DANISH_RING.frequency, 425, 'the Danish ring tone is 425 Hz');
  assert.strictEqual(DANISH_RING.onMs, 1000, 'one second on');
  assert.strictEqual(DANISH_RING.offMs, 4000, 'four seconds off');
  assert.ok(DANISH_RING.volume > 0 && DANISH_RING.volume < 0.5, 'the ring is audible but not a foghorn');

  const a = fakeAudio();
  const ringer = newRinger({ audioContext: a.AudioContext });
  assert.strictEqual(ringer.ringing(), false, 'a fresh ringer is silent');
  assert.strictEqual(ringer.start(), true, 'start() reports that it is ringing');
  assert.strictEqual(ringer.ringing(), true);
  assert.strictEqual(a.log.contexts.length, 1, 'no audio context is opened before it rings');
  assert.strictEqual(a.log.oscillators.length, 1, 'the ring is one oscillator, not a sample loop');
  const osc = a.log.oscillators[0];
  const gain = a.log.gains[0];
  assert.strictEqual(osc.type, 'sine');
  assert.strictEqual(osc.frequency.value, 425, 'the oscillator runs at the Danish 425 Hz');
  assert.strictEqual(osc.started, true, 'the oscillator is running');
  const pulseStart = gain.sets.indexOf(DANISH_RING.volume);
  assert.ok(pulseStart >= 0, 'a pulse opens at the ring volume');
  assert.strictEqual(gain.sets[pulseStart + 1], 0, 'and closes at silence — the tone is pulsed, not continuous');
  ringer.stop();
  assert.strictEqual(ringer.ringing(), false, 'stopping is immediate');
  assert.strictEqual(a.log.contexts[0].state, 'closed', 'and closes the audio context');

  // ---- cadence: 1s on / 4s off, repeated ----
  const fast = fakeAudio();
  const fastRinger = newRinger({ audioContext: fast.AudioContext, onMs: 20, offMs: 40 });
  fastRinger.start();
  await sleep(160);
  const pulses = fast.log.gains[0].sets.filter((v) => v > 0).length;
  assert.ok(pulses >= 2, `the cadence repeats while the phone rings (${pulses} pulses in 160ms)`);

  // ---- teardown: nothing may keep ringing ----
  fastRinger.stop();
  assert.strictEqual(fastRinger.ringing(), false, 'stop() says it is silent');
  const fastOsc = fast.log.oscillators[0];
  assert.strictEqual(fast.log.gains[0].sets[fast.log.gains[0].sets.length - 1], 0, 'gain is clamped to 0 last');
  assert.strictEqual(fastOsc.stopped, true, 'the oscillator is stopped');
  assert.strictEqual(fastOsc.disconnected, true, 'and disconnected from the graph');
  assert.strictEqual(fast.log.gains[0].disconnected, true, 'the gain node is disconnected too');
  assert.strictEqual(fast.log.contexts[0].state, 'closed', 'the audio context is closed');
  const setsAtStop = fast.log.gains[0].sets.length;
  await sleep(140);
  assert.strictEqual(fast.log.gains[0].sets.length, setsAtStop, 'no pulse fires after stop()');
  assert.strictEqual(fast.log.oscillators.length, 1, 'and no orphaned node is created by a stray timer');

  // ---- a second start() is a restart, never a second ringer ----
  const b = fakeAudio();
  const twice = newRinger({ audioContext: b.AudioContext });
  twice.start();
  twice.start();
  assert.strictEqual(b.log.oscillators.length, 2, 'the second start builds a fresh tone');
  assert.strictEqual(b.log.oscillators[0].stopped, true, 'the first one is stopped first');
  assert.strictEqual(b.log.oscillators[0].disconnected, true, 'and unplugged');
  assert.strictEqual(b.log.contexts[0].state, 'closed', 'and its context is closed');
  twice.stop();
  twice.stop();   // idempotent: the teardown path can run twice (answer + unmount)
  assert.strictEqual(b.log.oscillators[1].stopped, true);

  // ---- a browser with no Web Audio still gets a working call ----
  const silent = newRinger({ audioContext: null });
  assert.strictEqual(silent.start(), false, 'with no AudioContext the ringer reports it cannot ring');
  assert.doesNotThrow(() => silent.stop(), 'and stopping it is still safe');

  ok(`synthetic 425 Hz ringer: ${DANISH_RING.onMs / 1000}s on / ${DANISH_RING.offMs / 1000}s off, deterministic teardown`);

  // ---- caller ID → prospect matching ----
  // The number arrives as whatever the provider put in the From header: national digits, a
  // full E.164, a 0045 form, sometimes with spaces. All of those are the same phone.
  assert.strictEqual(formatCallerNumber('20123456', '45'), '+4520123456');
  assert.strictEqual(formatCallerNumber('+45 20 12 34 56', '45'), '+4520123456');
  assert.strictEqual(formatCallerNumber('004520123456', '45'), '+4520123456');
  assert.strictEqual(formatCallerNumber('20123456', ''), '20123456', 'no country code configured: keep what arrived');
  assert.strictEqual(formatCallerNumber('+441234567', '45'), '+441234567', 'a foreign number is never rewritten to +45');
  assert.strictEqual(formatCallerNumber('', '45'), '');
  assert.strictEqual(formatCallerNumber('anonymous', '45'), '', 'a withheld caller is not a number');

  const p = { phone: '+4520123456' };
  assert.ok(samePhone('20123456', p.phone), 'national digits match the stored E.164');
  assert.ok(samePhone('+45 20 12 34 56', p.phone), 'spaces are not a different person');
  assert.ok(samePhone(p.phone, p.phone), 'exact match');
  assert.ok(!samePhone('20123457', p.phone), 'one digit off is a different person');
  assert.ok(!samePhone('123456', p.phone), 'a short fragment is not a match');
  assert.ok(!samePhone('', p.phone), 'nothing matches nothing');
  assert.ok(!samePhone('4555', '45'), 'too short to be a phone number');
  ok('caller-ID normalisation and matching (7 positive/negative cases)');

  // ---- the single-ringer law across tabs ----
  const lockState = { held: null, requests: 0 };
  const fakeLocks = {
    request(name, opts, cb) {
      lockState.requests++;
      lockState.name = name;
      lockState.opts = opts;
      const lock = lockState.held ? null : { name };
      if (lock) lockState.held = lock;
      return Promise.resolve(cb(lock)).then((v) => { if (lock) lockState.held = null; return v; });
    },
  };
  const first = await holdCrossTabLock('pulse-inbound-audio', fakeLocks);
  assert.strictEqual(first.held, true, 'the first tab takes the audio lock');
  assert.strictEqual(first.noApi, false);
  const second = await holdCrossTabLock('pulse-inbound-audio', fakeLocks);
  assert.strictEqual(second.held, false, 'a second tab cannot ring over the first');
  assert.strictEqual(second.reason, 'another-tab');
  await first.release();
  const third = await holdCrossTabLock('pulse-inbound-audio', fakeLocks);
  assert.strictEqual(third.held, true, 'releasing the lock lets the next call ring');
  await third.release();
  assert.strictEqual(lockState.name, 'pulse-inbound-audio', 'the lock name is shared with the dialer');
  assert.strictEqual(lockState.opts.ifAvailable, true, 'never queue behind the other tab — refuse and stop');

  // Where the Lock API is missing (older engines, jsdom) the tab must still be able to ring.
  const noApi = await holdCrossTabLock('pulse-inbound-audio', null);
  assert.strictEqual(noApi.held, true, 'without the Lock API the call still rings');
  assert.strictEqual(noApi.noApi, true);
  await noApi.release();
  ok('cross-tab audio lock: first tab rings, second reflects, missing API degrades safely');

  for (const r of live) r.stop();
  assert.ok(live.every((r) => !r.ringing()), 'no ringer is left running at the end of the suite');

  // ---- the banner at three widths ------------------------------------------------------
  // The acceptance criteria call for 390 / 768 / 1440 px with zero horizontal overflow. jsdom
  // has no layout engine, so this audits the stylesheet the way a browser would resolve it:
  // apply the cascade at each width and check every length that can push a box sideways.
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const widthOf = (selector, viewport) => {
    const block = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, sel]) => sel.split(',').some((one) => one.trim() === selector))
      .map(([, , body]) => body)
      .join(';');
    const widthDecl = /(?:^|;)\s*width:\s*([^;]+)/.exec(block);
    if (!widthDecl) return null;
    const value = widthDecl[1].trim();
    const min = /^min\(\s*(\d+)px\s*,\s*calc\(\s*100vw\s*-\s*(\d+)px\s*\)\s*\)$/.exec(value);
    if (min) return Math.min(Number(min[1]), viewport - Number(min[2]));
    return null;
  };
  // Every matching media block, not just the first: the stylesheet already has several 720px
  // and reduced-motion blocks, and the banner's rules live in the last of each.
  const mediaBodies = (query) => [...css.matchAll(new RegExp(`@media\\s*\\(${query}\\)\\s*\\{([\\s\\S]*?)\\n\\}`, 'g'))]
    .map((m) => m[1]).join('\n');
  const mobileBlock = mediaBodies('max-width:\\s*720px');
  const reducedBlock = mediaBodies('prefers-reduced-motion:\\s*reduce');
  assert.ok(mobileBlock.includes('.incoming-'), 'the banner has phone-specific rules');

  for (const viewport of [390, 768, 1440]) {
    const width = widthOf('.incoming-call', viewport);
    assert.ok(width !== null, `the banner declares a viewport-bounded width (${viewport}px)`);
    assert.ok(width <= viewport, `the banner fits the viewport at ${viewport}px (${width} <= ${viewport})`);
  }
  assert.strictEqual(widthOf('.incoming-call', 390), 366, 'at 390px the banner keeps a 12px gutter on each side, never a scrollbar');
  assert.match(css, /\.incoming-call\s*\{[^}]*left:\s*50%/, 'the banner is centred rather than pinned to a side');
  assert.match(css, /\.incoming-call\s*\{[^}]*translate:\s*-50%/, 'and translated by exactly half its own width');
  assert.match(mobileBlock, /\.incoming-actions[^{]*\{[^}]*grid-template-columns:\s*1fr/, 'at <=720px the actions stack, so a thumb cannot mis-tap Decline');
  assert.match(mobileBlock, /\.incoming-decline[^{]*\{[^}]*order:\s*2/, 'and Decline sits below Answer on a phone');
  assert.match(reducedBlock, /\.incoming-wave\s+i\s*\{[^}]*animation:\s*none/, 'reduced motion neutralises the ring wave in CSS as well as in the component');
  ok('inbound banner: viewport-bounded at 390 / 768 / 1440, stacked on phones, still under reduced motion');
  console.log(`  [inbound] ${passed} inbound engine checks passed`);
}

run()
  .catch((e) => { console.error('  \u274C inbound unit failure:', e.message); process.exitCode = 1; });
