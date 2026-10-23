// The renderer's native call controls: do they report what the daemon actually did?
//
// This suite renders the REAL `src/useWebRtc.js` hook in jsdom with the REAL `src/nativeSip.js`
// engine behind it, wired to a bridge whose replies the test controls. Nothing here is a double of
// the code under test: the hook, the engine, the React state and the setters are the production
// modules, loaded through test/helpers/esm-resolver.mjs. Only the daemon is simulated, because the
// refusal cases below are things a real daemon does not produce on demand.
//
// Why it exists. Three defects made the operator-facing controls lie:
//   BUG 20  nativeSip.toggleMute() returned the INTENDED state, not the applied one, and
//           useWebRtc.toggleMute() flipped its own ref unconditionally and dropped the result with
//           `.catch(() => {})`. The return value feeds the toast at Dialer.jsx:1627/1881, so a
//           refused mute announced "Microphone muted" while the customer still heard everything.
//   BUG 21  useWebRtc.sendDtmf() returned an unconditional `true` for the native branch, discarding
//           nativeSip.sendDtmf()'s truthful answer, so a refused digit was logged as sent.
//   BUG 22  useWebRtc.hangUp() fired `nativeRef.current.hangUp().catch(() => {})`; on failure no
//           `ended` event arrives, so the call stayed up on the daemon and the UI showed nothing.
//
// The decisive checks are written to fail against that behaviour and pass only when the reported
// state matches what the daemon applied. The success paths are checked too, so "fix it by always
// reporting failure" cannot pass.
'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPO = path.join(__dirname, '..', '..');

// The real descriptor GET /api/telephony/webrtc-session returns while a daemon holds the phone,
// captured from a live server. `engine: 'native'` is what src/nativeSip.js isNativeSession() tests.
const NATIVE_SESSION = {
  mode: 'webrtc', engine: 'native', active: true, provider: 'telnyx', configured: true,
  missing: [], transport: 'udp', domain: 'sip.telnyx.com', port: 5060,
  wsUrl: 'sip:sip.telnyx.com:5060', wsUrlSource: 'native_daemon', webrtcWsUrl: 'wss://rtc.telnyx.com',
  username: '15551234567', callerId: '+15551234567', password: '', hasPassword: false,
};

let checks = 0;
const ok = (m) => { checks += 1; console.log('  ✓', m); };

/**
 * Render the real hook against a bridge whose replies come from `reply(action, payload)`.
 * Returns the live hook result plus the bridge transcript, and drives the engine to a connected
 * call so the native branches in useWebRtc are the ones under test.
 */
async function renderHook(reply, ctx = {}) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost:3001/', pretendToBeVisual: true,
  });
  const win = dom.window;
  globalThis.window = win;
  globalThis.document = win.document;
  Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true });
  for (const k of ['HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'KeyboardEvent',
    'getComputedStyle', 'DOMException', 'MutationObserver']) {
    if (win[k] !== undefined) globalThis[k] = win[k];
  }
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  // The server hands the renderer a token first; both calls are stubbed so no network is involved.
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    requests.push([u, init?.method || 'GET']);
    let body = {};
    if (u.includes('/api/session')) body = { token: 'a'.repeat(40) };
    else if (u.includes('/api/telephony/webrtc-session')) body = NATIVE_SESSION;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };

  // The bridge the preload script normally installs. `onEvent` is captured so the test can fire
  // daemon events into the real engine exactly as the supervisor's stdout would.
  const sent = [];
  const handlers = [];
  win.pulseNativeSip = {
    available: true,
    command: async (action, payload) => {
      sent.push([action, payload]);
      if (action === 'answer' && ctx.connectedOnAnswer === 'event-first') fire({ event: 'connected', callId: payload.callId });
      const result = await reply(action, payload);
      if (action === 'answer' && ctx.connectedOnAnswer === 'reply-first') {
        setTimeout(() => fire({ event: 'connected', callId: payload.callId }), 0);
      }
      return result;
    },
    onEvent: (h) => { handlers.push(h); return () => {}; },
  };
  const fire = (msg) => handlers.forEach((h) => h(msg));

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const mod = await import(pathToFileURL(path.join(REPO, 'src', 'useWebRtc.js')).href);

  const container = win.document.getElementById('root');
  const root = createRoot(container);
  let api = null;
  const Probe = () => { api = mod.default({ enabled: true, dryRun: false, softphone: 'Dialer', countryCode: 'US', onActive: ctx.onActive }); return null; };

  await act(async () => { root.render(React.createElement(Probe)); });
  await act(async () => { await sleep(30); });

  // Reach a connected call through the real event path, so `nativeRef.current.live` is set and the
  // native branches of toggleMute/sendDtmf/hangUp are the code being exercised.
  await act(async () => { fire({ event: 'registered' }); });
  if (ctx.connect !== false) await act(async () => { fire({ event: 'connected', callId: 'call-1' }); });
  await act(async () => { await sleep(10); });

  const cleanup = async () => {
    await act(async () => { root.unmount(); });
    delete globalThis.window;
    dom.window.close();
  };
  return { api: () => api, sent, fire, act, sleep: async (ms) => { await act(async () => { await sleep(ms); }); }, cleanup, requests };
}

const DEFAULT_REPLY = (action) => {
  if (action === 'register') return { ok: true };
  if (action === 'mute') return { ok: true };
  if (action === 'dtmf') return { ok: true, digit: '5', packets: 1 };
  if (action === 'hangup') return { ok: true };
  return { ok: true };
};

const sentActions = (sent) => sent.map(([a]) => a);
const lastPayload = (sent, action) => {
  const hit = [...sent].reverse().find(([a]) => a === action);
  return hit ? hit[1] : undefined;
};

let failed = 0;
async function check(n, title, fn) {
  try {
    await fn();
    checks += 1;
    console.log(`  \u2713 ${n}. ${title}`);
  } catch (e) {
    failed += 1;
    const msg = String(e && e.message ? e.message : e).split('\n').filter(Boolean).slice(0, 4).join('\n      ');
    console.log(`  \u2717 ${n}. ${title}\n      ${msg}`);
  }
}

async function main() {
  // The resolver hook must be registered before any src/ module is imported. It is what lets plain
  // node resolve the renderer's extensionless imports the way Vite does.
  const { register } = require('node:module');
  register(pathToFileURL(path.join(REPO, 'test', 'helpers', 'esm-resolver.mjs')).href, pathToFileURL(__filename).href);

  console.log('--- Unit: Native Call Controls Report Only What The Daemon Applied ---');

  // 0. The harness really is on the native path. Without this every check below could pass
  //    vacuously by exercising the browser branch instead of the native one.
  await check(0, 'real hook reaches an active native call through the real bridge', async () => {
    const h = await renderHook(DEFAULT_REPLY);
    try {
      assert.ok(h.sent.length > 0, 'the engine must have spoken to the bridge');
      assert.ok(sentActions(h.sent).includes('register'), `expected a register command, saw ${sentActions(h.sent)}`);
      assert.strictEqual(h.api().state, 'active', `hook must be in an active native call, got ${h.api().state}`);
      ok(`state="${h.api().state}" sent=[${sentActions(h.sent).join(',')}]`);
    } finally { await h.cleanup(); }
  });

  // 1. BUG 20 — a REFUSED mute must not be reported as applied. Decisive: toggleMute()'s return
  //    value drives the operator toast at Dialer.jsx:1627 and :1881.
  await check(1, 'a refused mute is reported as NOT applied and surfaces an error', async () => {
    const reply = (a) => (a === 'mute' ? { ok: false, error: 'The daemon refused the mute.' } : DEFAULT_REPLY(a));
    const h = await renderHook(reply);
    try {
      let reported;
      await h.act(async () => { reported = h.api().toggleMute(); });
      await h.sleep(30);
      assert.deepStrictEqual(lastPayload(h.sent, 'mute'), { enabled: true }, 'the mute command must have been sent');
      assert.strictEqual(reported, undefined,
        'the native branch must not predict the outcome — undefined means "the daemon decides"');
      assert.strictEqual(h.api().muted, false, 'React mute state must not show muted after a refusal');
      assert.ok(h.api().error, 'a refused mute must surface an error the operator can see');
      ok(`reported=${reported} muted=${h.api().muted} error="${h.api().error}"`);
    } finally { await h.cleanup(); }
  });

  // 2. An ACCEPTED mute must still flip exactly once, and unmute again. Guards against "fixing"
  //    the lie by always reporting failure.
  await check(2, 'an accepted mute still flips exactly once and toggles back', async () => {
    const h = await renderHook(DEFAULT_REPLY);
    try {
      await h.act(async () => { h.api().toggleMute(); });
      await h.sleep(30);
      assert.strictEqual(h.api().muted, true, 'an accepted mute must flip the confirmed state exactly once');
      assert.strictEqual(h.api().error, '', 'an accepted mute must not raise an error');
      assert.deepStrictEqual(lastPayload(h.sent, 'mute'), { enabled: true }, 'and send enabled:true');
      await h.act(async () => { h.api().toggleMute(); });
      await h.sleep(30);
      assert.strictEqual(h.api().muted, false, 'the confirmed state must follow the second toggle');
      assert.deepStrictEqual(lastPayload(h.sent, 'mute'), { enabled: false }, 'and send enabled:false');
      ok('accepted mute: muted=true payload={enabled:true}; unmute: muted=false payload={enabled:false}');
    } finally { await h.cleanup(); }
  });

  // 3. BUG 21 — a REFUSED DTMF digit must not be silently logged as sent.
  await check(3, 'a refused DTMF digit surfaces an error instead of being logged as sent', async () => {
    const reply = (a) => (a === 'dtmf' ? { ok: false, error: 'No live call to send tones on.' } : DEFAULT_REPLY(a));
    const h = await renderHook(reply);
    try {
      let sent;
      await h.act(async () => { sent = await h.api().sendDtmf('5'); });
      await h.sleep(30);
      assert.ok(sentActions(h.sent).includes('dtmf'), 'the digit must have been sent to the daemon');
      assert.deepStrictEqual(h.api().dtmfLog, [], 'a refused digit must not appear in the sent-tones log');
      assert.strictEqual(sent, false, 'a refused digit must not report itself as sent');
      assert.ok(h.api().error, `a refused digit must surface an error, got "${h.api().error}"`);
      ok(`error="${h.api().error}"`);
    } finally { await h.cleanup(); }
  });

  // 4. An ACCEPTED digit must still be logged and must not raise an error.
  await check(4, 'an accepted DTMF digit is logged and raises no error', async () => {
    const h = await renderHook(DEFAULT_REPLY);
    try {
      let returned;
      await h.act(async () => { returned = await h.api().sendDtmf('5'); });
      await h.sleep(30);
      assert.strictEqual(returned, true, 'an accepted digit reports sent');
      assert.deepStrictEqual(h.api().dtmfLog.slice(-1), ['5'], 'the keypad log still records the digit');
      assert.strictEqual(h.api().error, '', 'an accepted digit must not raise an error');
      ok(`returned=${returned} log=${JSON.stringify(h.api().dtmfLog)}`);
    } finally { await h.cleanup(); }
  });

  // 5. BUG 22 — a FAILED hang-up must be surfaced, not swallowed by `.catch(() => {})`.
  await check(5, 'a failed hang-up surfaces an error', async () => {
    const reply = (a) => (a === 'hangup' ? { ok: false, error: 'No call in progress.' } : DEFAULT_REPLY(a));
    const h = await renderHook(reply);
    try {
      await h.act(async () => { h.api().hangUp(); });
      await h.sleep(40);
      assert.ok(sentActions(h.sent).includes('hangup'), 'the hang-up must have been sent to the daemon');
      assert.ok(h.api().error, `a failed hang-up must surface an error, got "${h.api().error}"`);
      ok(`error="${h.api().error}"`);
    } finally { await h.cleanup(); }
  });

  // 6. An ACCEPTED hang-up must still tear down through the `ended` event, exactly as before.
  await check(6, 'an accepted hang-up raises no error and `ended` still tears the call down', async () => {
    const h = await renderHook(DEFAULT_REPLY);
    try {
      await h.act(async () => { h.api().hangUp(); });
      await h.sleep(20);
      assert.ok(sentActions(h.sent).includes('hangup'), 'hang-up sent');
      assert.strictEqual(h.api().error, '', 'an accepted hang-up must not raise an error');
      await h.act(async () => { h.fire({ event: 'ended', callId: 'call-1', reason: 'normal' }); });
      await h.sleep(20);
      assert.notStrictEqual(h.api().state, 'active', `the ended event must leave the active call, state=${h.api().state}`);
      ok(`no error; \`ended\` moved state to "${h.api().state}"`);
    } finally { await h.cleanup(); }
  });

  // 7. A transport failure (the bridge REJECTS) must be surfaced for all three controls.
  //    `.catch(() => {})` used to swallow these entirely.
  for (const [label, invoke, action] of [
    ['mute', (api) => api.toggleMute(), 'mute'],
    ['dtmf', (api) => api.sendDtmf('5'), 'dtmf'],
    ['hangup', (api) => api.hangUp(), 'hangup'],
  ]) {
    await check(`7.${action}`, `a transport failure on ${label} surfaces an error`, async () => {
      const reply = (a) => { if (a === action) throw new Error('bridge gone'); return DEFAULT_REPLY(a); };
      const h = await renderHook(reply);
      try {
        await h.act(async () => { invoke(h.api()); });
        await h.sleep(40);
        assert.ok(h.api().error, `a transport failure on ${label} must surface an error, got "${h.api().error}"`);
        ok(`error="${h.api().error}"`);
      } finally { await h.cleanup(); }
    });
  }

  // 8. The primary user path: starting an outbound native call from standby must reach the
  //    daemon's dial command. In particular, it must not fall through to the browser/WebRTC path.
  await check(8, 'an outbound native call is handed to the daemon from standby', async () => {
    const h = await renderHook(DEFAULT_REPLY, { connect: false });
    try {
      let result;
      await h.act(async () => { result = await h.api().start('+12025550123', { callId: 42 }); });
      assert.strictEqual(result?.ok, true, 'the native dial should be accepted');
      assert.ok(sentActions(h.sent).includes('dial'), `expected a native dial command, saw ${sentActions(h.sent)}`);
      assert.deepStrictEqual(lastPayload(h.sent, 'dial'), { number: '+12025550123', callId: 42 });
      ok('native outbound dial reached the daemon with the CRM call id');
    } finally { await h.cleanup(); }
  });

  // 9. Declining an inbound call is also a remote control command. A refusal must leave the
  //    ring visible; locally clearing it would log a missed call while the carrier keeps ringing.
  await check(9, 'a refused inbound decline leaves the ring visible and reports the error', async () => {
    const reply = (action) => action === 'reject'
      ? { ok: false, error: 'The daemon could not reject the INVITE.' }
      : DEFAULT_REPLY(action);
    const h = await renderHook(reply, { connect: false });
    try {
      await h.act(async () => { h.fire({ event: 'incoming', callId: 'ring-2', callerPhone: '+12025550123' }); });
      await h.sleep(20);
      assert.strictEqual(h.api().state, 'incoming', 'the incoming ring must be visible first');
      await h.act(async () => { h.api().hangUp(); });
      await h.sleep(30);
      assert.strictEqual(h.api().state, 'incoming', 'a refused reject must not clear the ring locally');
      assert.strictEqual(h.api().incomingCall?.callId, 'ring-2');
      assert.match(h.api().error, /could not reject/i);
      ok('the ring remains actionable until the daemon confirms the decline');
    } finally { await h.cleanup(); }
  });

  // CRM replaces `entry.callId`; the daemon's dialog id and the connected callback must remain stable.
  await check(10, 'inbound CRM attachment preserves SIP control and a single active transition', async () => {
    for (const order of ['event-first', 'reply-first']) {
      let activations = 0;
      const h = await renderHook(DEFAULT_REPLY, { connect: false, connectedOnAnswer: order, onActive: () => { activations += 1; } });
      try {
        await h.act(async () => { h.fire({ event: 'incoming', callId: 'dialog-7', callerPhone: '+12025550123' }); });
        await h.sleep(20);
        const entry = h.api().incomingCall;
        assert.ok(entry, `${order}: the inbound ring is visible`);
        await h.act(async () => { entry.attachCrm({ callId: 99, prospect: { id: 4 } }); });
        let answer;
        await h.act(async () => { answer = await entry.answer(); });
        await h.sleep(20);
        assert.strictEqual(answer?.ok, true, `${order}: answer completes without resurrecting a cleared entry`);
        assert.deepStrictEqual(lastPayload(h.sent, 'answer'), { callId: 'dialog-7' }, `${order}: SIP uses its own dialog id`);
        assert.strictEqual(activations, 1, `${order}: connected is reported exactly once`);
      } finally { await h.cleanup(); }
    }
    ok('CRM id stays separate from SIP id; either event/reply order activates once');
  });
  const total = checks + failed;
  if (failed) {
    console.log(`\n\u{1F4A5} Native call controls: ${checks}/${total} passed, ${failed} FAILED`);
    process.exitCode = 1;
  } else {
    console.log(`\n\u{1F389} Native call controls: all ${total} checks passed`);
  }
}

main().then(() => { setTimeout(() => process.exit(process.exitCode || 0), 50); }, (e) => {
  console.error('\n\u{1F4A5} harness failure:', e && e.message ? e.message : e);
  if (e && e.stack) console.error(e.stack.split('\n').slice(1, 5).join('\n'));
  process.exit(1);
});
