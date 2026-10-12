// Dialer race-condition regression suite.
//
// Loads the real production bundle (dist/) in jsdom against a live API instance and drives
// the keyboard shortcuts the way a fast agent does: mashing C, holding a key down, hitting
// an outcome key three times, pressing H and then the arrows in the same tick, and typing in
// the notes box. Every fetch the page makes is recorded, so a duplicated request is a failure.
//
// Requires `npm run build` first (it skips cleanly if dist/ is missing) and jsdom.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ui-'));
const PORT = 3000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failures = 0;
const ok = (msg) => { passed++; console.log(`    \u2713 ${msg}`); };
const bad = (msg) => { failures++; console.log(`    \u274C ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : bad(msg));

// A recording stand-in for the Web Audio API. The ringer is the only thing in the app that
// makes a noise on its own, and "did the phone stop ringing?" has to be provable in a test.
function fakeWebAudio() {
  const live = [];
  const closed = [];
  class Param {
    constructor() { this.value = 0; this.events = []; }
    setValueAtTime(v) { this.events.push(v); this.value = v; return this; }
    cancelScheduledValues() { return this; }
  }
  class Osc {
    constructor(ctx) { this.ctx = ctx; this.frequency = new Param(); this.type = 'sine'; this.on = false; }
    connect() { return this; }
    start() { this.on = true; live.push(this); }
    stop() { this.on = false; }
    disconnect() { this.on = false; }
  }
  class Gain {
    constructor(ctx) { this.ctx = ctx; this.gain = new Param(); this.connected = false; }
    connect() { this.connected = true; return this; }
    disconnect() { this.connected = false; }
  }
  class Ctx {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; this.closed = false; closed.push(this); }
    createGain() { return new Gain(this); }
    createOscillator() { return new Osc(this); }
    createAnalyser() { return { fftSize: 0, frequencyBinCount: 8, getByteTimeDomainData() {}, connect() {} }; }
    createMediaStreamSource() { return { connect() {} }; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; this.closed = true; return Promise.resolve(); }
  }
  return {
    AudioContext: Ctx, Ctor: Ctx,
    ringing: () => live.filter((o) => o.on).length,
    contexts: () => closed.length,
    closedContexts: () => closed.filter((c) => c.closed).length,
    reset: () => { live.length = 0; closed.length = 0; },
  };
}

function loadApp(JSDOM, VirtualConsole, hash, opts = {}) {
  const assets = path.join(REPO, 'dist', 'assets');
  const html = fs.readFileSync(path.join(REPO, 'dist', 'index.html'), 'utf8')
    .replace(/<script type="module"[^>]*><\/script>/, '');
  // The app is code-split now (the SIP adapter is its own chunk), so the entry must be read
  // from index.html rather than guessed as "the first .js file in the directory".
  const entry = (html.match(/<script[^>]*src="\/assets\/([^"]+\.js)"/) || [])[1]
    || fs.readdirSync(assets).filter((f) => f.endsWith('.js')).sort((a, b) => fs.statSync(path.join(assets, b)).size - fs.statSync(path.join(assets, a)).size)[0];
  // jsdom evaluates the bundle as a classic script, so the one `import.meta` Vite leaves in the
  // dynamic-import preload helper has to become a plain object first.
  const bundle = fs.readFileSync(path.join(assets, entry), 'utf8')
    .replace(/import\.meta/g, '__pulseImportMeta')
    .replace(/export\{[^}]*\};?/g, '');   // the entry re-exports one shared symbol; jsdom runs classic scripts

  const vc = new VirtualConsole();
  const consoleErrors = [];
  const jsErrors = [];
  vc.on('jsdomError', (e) => {
    const m = String(e && e.message ? e.message : e);
    if (/navigation|Not implemented|sip:|tel:/i.test(m)) return; // protocol dispatch is expected
    jsErrors.push(m);
  });
  vc.on('error', (...a) => consoleErrors.push('error: ' + a.map(String).join(' ')));
  vc.on('warn', (...a) => consoleErrors.push('warn: ' + a.map(String).join(' ')));

  const dom = new JSDOM(html, { url: `${BASE}/${hash}`, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const calls = [];
  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? new URL(input, BASE).href : String(input);
    if (url.startsWith(`${BASE}/api`)) calls.push({ method: (init.method || 'GET').toUpperCase(), path: url.slice(BASE.length) });
    return fetch(url, init);
  };
  window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
  if (opts.webAudio) { window.AudioContext = opts.webAudio.Ctor; }
  if (opts.reducedMotion) {
    // jsdom's matchMedia always says "no"; a reduced-motion user is a real client and the
    // banner has to behave for them too, so it can be requested explicitly.
    window.matchMedia = (q) => ({ matches: /prefers-reduced-motion/.test(q), media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  }
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  window.Element.prototype.scrollIntoView = function () {};
  window.__pulseImportMeta = { url: `${BASE}/assets/${entry}`, resolve: () => '' };
  window.confirm = () => true;
  window.eval(bundle);
  return { dom, window, jsErrors, consoleErrors, drain: () => calls.splice(0) };
}

const key = (window, k, opts = {}, target) => {
  (target || window).dispatchEvent(new window.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, opts)));
};
const count = (calls, re) => calls.filter((c) => re.test(`${c.method} ${c.path}`)).length;
const DIAL = /POST \/api\/prospects\/\d+\/call/;
const PATCH = /PATCH \/api\/calls\/\d+$/;
const NOTE = /POST \/api\/prospects\/\d+\/notes/;

async function wait(fn, ms = 15000, label = '') {
  const dl = Date.now() + ms;
  while (Date.now() < dl) { try { if (await fn()) return true; } catch { /* retry */ } await sleep(80); }
  throw new Error(`timed out waiting for ${label}`);
}

// React attaches the window keydown listener a tick after the DOM paints; N focuses the
// notes box and has no side effects, so it is a safe liveness probe.
async function ensureListener(app) {
  const box = () => app.window.document.getElementById('top-quick-note');
  for (let i = 0; i < 25; i++) {
    if (app.window.document.activeElement === box()) break;
    key(app.window, 'n');
    await sleep(80);
  }
  // Blur so the following presses behave like a user who clicked back onto the page.
  if (app.window.document.activeElement?.blur) app.window.document.activeElement.blur();
  return app.window.document.activeElement !== box();
}

async function run() {
  let JSDOM, VirtualConsole;
  try { ({ JSDOM, VirtualConsole } = require('jsdom')); } catch {
    console.log('    \u2013 jsdom is not installed; skipping the dialer race suite');
    return { skipped: true };
  }
  if (!fs.existsSync(path.join(REPO, 'dist', 'index.html'))) {
    console.log('    \u2013 dist/ is missing (run `npm run build`); skipping the dialer race suite');
    return { skipped: true };
  }

  console.log('  [ui] dialer keyboard race conditions (real bundle in jsdom)');
  const server = spawn(process.execPath, [path.join(REPO, 'server', 'index.js')], {
    cwd: REPO,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, PULSE_TEST: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let srvErr = '';
  server.stderr.on('data', (d) => { srvErr += d; });

  try {
    await wait(async () => (await fetch(`${BASE}/api/settings`)).status === 200, 20000, 'API boot');
    const put = (u, b) => fetch(`${BASE}${u}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    const post = (u, b) => fetch(`${BASE}${u}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    await put('/api/settings', { dry_run: '1', telephony_mode: 'softphone' });
    for (let i = 0; i < 5; i++) await post('/api/prospects', { name: `Race ${i}`, phone: `2012345${i}` });

    // --- A1: mashing C must not double-dial --------------------------------------
    let app = loadApp(JSDOM, VirtualConsole, '#dialer');
    await wait(() => app.window.document.querySelector('.q-item'), 15000, 'queue to render');
    await ensureListener(app);
    app.drain();
    key(app.window, 'c'); key(app.window, 'c'); key(app.window, 'c'); // one tick, three presses
    await sleep(1500);
    const mashed = count(app.drain(), DIAL);
    check(mashed === 1, `three C presses in one tick place exactly 1 call (got ${mashed})`);

    // --- A1b: a held key (OS auto-repeat) must not stack calls --------------------
    key(app.window, 'h'); await sleep(700); key(app.window, 'Escape'); await sleep(900);
    app.drain();
    key(app.window, 'c'); key(app.window, 'c', { repeat: true }); key(app.window, 'c', { repeat: true });
    await sleep(1500);
    const held = count(app.drain(), DIAL);
    check(held === 1, `holding C down (auto-repeat) places exactly 1 call (got ${held})`);

    // --- A2: mashing an outcome key logs the call and the note once ---------------
    const box = app.window.document.getElementById('top-quick-note');
    const setter = Object.getOwnPropertyDescriptor(app.window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(box, 'Race test note');
    box.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await sleep(300);
    app.drain();
    key(app.window, '6'); key(app.window, '6'); key(app.window, '6');
    await sleep(1800);
    const logged = app.drain();
    check(count(logged, PATCH) === 1, `mashing 6 classifies the call once (got ${count(logged, PATCH)})`);
    check(count(logged, NOTE) === 1, `mashing 6 saves the note once (got ${count(logged, NOTE)})`);

    // --- A3: Shift / CapsLock must not disable the shortcuts ----------------------
    await wait(() => !!app.window.document.querySelector('.callbar.idle'), 10000, 'idle call bar');
    app.drain();
    key(app.window, 'C', { shiftKey: true });
    await sleep(1200);
    const shifted = count(app.drain(), DIAL);
    check(shifted === 1, `Shift+C still dials (got ${shifted})`);

    // --- A4: test mode must never hand a dial URI to the OS -----------------------
    await wait(() => !!app.window.document.querySelector('.inflight'), 10000, 'in-flight badge');
    const dispatched = () => app.window.document.querySelectorAll('iframe[src^="sip:"], iframe[src^="tel:"]').length;
    const beforeR = dispatched();
    key(app.window, 'r');
    await sleep(600);
    check(dispatched() === 0 && beforeR === 0, `R in test mode dispatches no sip:/tel: URI (got ${beforeR} -> ${dispatched()})`);

    // --- A2b: H then arrows in the same tick must not move the queue --------------
    const who = () => app.window.document.querySelector('.banner-name')?.textContent || '';
    const nameBefore = who();
    key(app.window, 'h'); key(app.window, 'ArrowRight'); key(app.window, 'ArrowRight');
    await sleep(1200);
    check(!!app.window.document.querySelector('.classify-modal'), 'H opens the classification modal');
    check(who() === nameBefore, `arrows pressed with H do not skip the prospect while classifying ("${nameBefore}" -> "${who()}")`);
    key(app.window, 'Escape');
    await sleep(900);

    // --- A3b: typing in a field must never trigger a shortcut ---------------------
    const search = app.window.document.querySelector('.search input');
    search.focus();
    app.drain();
    for (const ch of ['c', '1', '6', 'r', 'n']) key(app.window, ch, {}, search);
    await sleep(900);
    const inSearch = app.drain();
    const notesBox = app.window.document.getElementById('top-quick-note');
    notesBox.focus();
    app.drain();
    for (const ch of ['c', '2', 'h', 'r', '7']) key(app.window, ch, {}, notesBox);
    await sleep(900);
    const inNotes = app.drain();
    const typed = count(inSearch, DIAL) + count(inNotes, DIAL);
    const classified = count(inSearch, PATCH) + count(inNotes, PATCH);
    check(typed === 0, `typing in the search box and notes box triggers no calls (got ${typed})`);
    check(classified === 0, `typing digits in a field classifies nothing (got ${classified})`);
    check(app.jsErrors.length === 0, `no jsdom errors while driving the dialer (${app.jsErrors.join(' | ').slice(0, 160)})`);
    app.dom.window.close();

    // --- E2: a burst of toasts must not pile up ----------------------------------
    app = loadApp(JSDOM, VirtualConsole, '#dialer');
    await wait(() => app.window.document.querySelector('.q-item'), 15000, 'queue');
    await ensureListener(app);
    await post('/api/prospects', { name: 'No Phone Prospect' });
    await wait(async () => { await app.window.document.querySelector('.queue-list'); return true; }, 3000, 'list');
    for (let i = 0; i < 30; i++) { key(app.window, 'c'); if (i % 5 === 0) await sleep(40); }
    await sleep(1500);
    const toasts = app.window.document.querySelectorAll('.toast').length;
    check(toasts <= 4, `30 rapid failures leave at most 4 toasts on screen (got ${toasts})`);
    app.dom.window.close();

    // --- E3: no React key / controlled-input warnings on any route ---------------
    const warnings = [];
    for (const route of ['#dashboard', '#dialer', '#prospects', '#pipeline', '#import', '#settings']) {
      const a = loadApp(JSDOM, VirtualConsole, route);
      await wait(() => a.window.document.body.textContent.length > 40, 10000, route);
      await sleep(600);
      warnings.push(...a.consoleErrors.filter((m) => /unique "key"|Each child in a list|controlled|uncontrolled|validateDOMNesting|findDOMNode/i.test(m)));
      a.dom.window.close();
    }
    check(warnings.length === 0, `no React key/controlled-input warnings across 6 routes (${warnings.length})`);
    if (warnings.length) warnings.slice(0, 3).forEach((w) => console.log(`        ${w.slice(0, 200)}`));

    // --- E4: a hostile URL fragment must not blank the app ----------------------
    // PAGES["#constructor"] resolves through the prototype chain to a truthy
    // non-component; the lookup uses Object.hasOwn now, so these fall back to Dashboard.
    for (const route of ['#constructor', '#__proto__', '#toString', '#hasOwnProperty']) {
      const a = loadApp(JSDOM, VirtualConsole, route);
      await sleep(1100);
      const nodes = a.window.document.getElementById('root').querySelectorAll('*').length;
      const blanked = nodes < 10;
      check(!blanked, `route ${route} still renders (${nodes} nodes)`);
      if (blanked) console.log(`        ${route} blanked the app: ${(a.jsErrors[0] || a.consoleErrors[0] || '').slice(0, 140)}`);
      a.dom.window.close();
    }

    // --- E5: a rejected "Add prospect" must tell the user why -------------------
    // AddModal.save had no try/catch, so the server's 400 escaped to the console and the
    // modal just sat there with no message.
    const addApp = loadApp(JSDOM, VirtualConsole, '#prospects');
    await wait(() => addApp.window.document.body.textContent.length > 40, 10000, '#prospects');
    await sleep(700);
    const addDoc = addApp.window.document;
    const addBtn = [...addDoc.querySelectorAll('button')].find((b) => /Add prospect/i.test(b.textContent));
    check(!!addBtn, 'the Add prospect button is reachable');
    if (addBtn) {
      addBtn.dispatchEvent(new addApp.window.MouseEvent('click', { bubbles: true }));
      await sleep(500);
      const inputs = [...addDoc.querySelectorAll('.modal input')];
      const setVal = (el, v) => {
        const d = Object.getOwnPropertyDescriptor(addApp.window.HTMLInputElement.prototype, 'value').set;
        d.call(el, v);
        el.dispatchEvent(new addApp.window.Event('input', { bubbles: true }));
      };
      setVal(inputs[0], 'N'.repeat(250));   // server rejects names over 200 chars
      setVal(inputs[1], '20123456');
      await sleep(200);
      const submit = [...addDoc.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === 'Add prospect');
      submit.dispatchEvent(new addApp.window.MouseEvent('click', { bubbles: true }));
      await sleep(1500);
      const toastText = [...addDoc.querySelectorAll('.toast')].map((t) => t.textContent).join(' ');
      check(toastText.length > 0, `a rejected save shows an error toast ("${toastText.slice(0, 46)}")`);
      check(/Too big|200 characters|error/i.test(toastText), 'the toast carries the server\u2019s reason');
      check(!!addDoc.querySelector('.modal'), 'the modal stays open so the agent can correct it');
    }
    addApp.dom.window.close();

    // --- E5: email is in-app, not a mailto: hand-off -----------------------------
    // The banner chip, the prospect card and the table row all used to hand the agent off to
    // whatever the OS had registered for mailto:. E must open the composer inside the cockpit,
    // stay out of the way while the agent is typing, and never let a keystroke reach a call.
    await post('/api/prospects', { name: 'Mail Target', phone: '20999999', email: 'mailtest@gmail.com' });
    let mailApp = loadApp(JSDOM, VirtualConsole, '#dialer');
    await wait(() => mailApp.window.document.querySelector('.q-item'), 15000, 'queue to render');
    await ensureListener(mailApp);
    {
      const d = mailApp.window.document;
      const item = [...d.querySelectorAll('.q-item')].find((el) => /Mail Target/.test(el.textContent));
      check(!!item, 'the email fixture prospect is in the queue');
      if (item) item.dispatchEvent(new mailApp.window.MouseEvent('click', { bubbles: true }));
      await wait(() => /mailtest@gmail\.com/.test(d.body.textContent), 12000, 'the banner email chip');
      await sleep(400);

      check(d.querySelectorAll('a[href^="mailto:"]').length === 0,
        `no mailto: anchors left anywhere in the dialer (got ${d.querySelectorAll('a[href^="mailto:"]').length})`);
      check(!!d.querySelector('button.banner-email-chip'), 'the banner chip is an in-app button');

      // Typing E somewhere the agent writes must be a keystroke, never a shortcut.
      const sbox = d.querySelector('.search input');
      if (sbox) {
        key(mailApp.window, 'e', {}, sbox);
        await sleep(500);
        check(!d.querySelector('.email-modal'), 'E typed into the search box opens nothing');
      }

      mailApp.drain();
      key(mailApp.window, 'e');
      const opened = await (async () => { try { await wait(() => d.querySelector('.email-modal'), 12000, 'composer'); return true; } catch { return false; } })();
      check(opened, 'E opens the in-app email composer for the active prospect');
      if (opened) {
        check(/mailtest@gmail\.com/.test(d.body.textContent), 'the composer arrives pre-filled with the prospect address');
        const drafts = count(mailApp.drain(), /POST \/api\/email\/prospects\/\d+\/draft/);
        check(drafts >= 1, `the composer asks the server for a template-filled draft (got ${drafts})`);
        check(/Opf|Hej|Mødelink|@/.test(d.querySelector('.email-modal')?.textContent || ''), 'the draft carries rendered template text');

        // A modal owns the keyboard: C must not dial the prospect behind the dialog.
        mailApp.drain();
        key(mailApp.window, 'c');
        await sleep(900);
        check(count(mailApp.drain(), DIAL) === 0, 'C with the composer open places no call behind it');

        // ...and closing it gives the keyboard back.
        const closeBtn = d.querySelector('.email-modal .modal-head .icon-btn');
        check(!!closeBtn, 'the composer has a close control');
        if (closeBtn) closeBtn.dispatchEvent(new mailApp.window.MouseEvent('click', { bubbles: true }));
        await sleep(700);
        check(!d.querySelector('.email-modal'), 'closing the composer dismisses it');
      }

      // A call that ends well should offer the follow-up in one click, without the agent
      // hunting for the prospect again.
      mailApp.drain();
      key(mailApp.window, 'c');
      await sleep(1200);
      const placed = count(mailApp.drain(), DIAL);
      check(placed === 1, `the email prospect can be dialled (got ${placed} call)`);
      key(mailApp.window, '6');                       // conversation — a follow-up-worthy outcome
      const prompted = await (async () => { try { await wait(() => d.querySelector('.followup-prompt'), 12000, 'follow-up prompt'); return true; } catch { return false; } })();
      check(prompted, 'a positive outcome offers the follow-up email in one click');
      if (prompted) {
        check(/Mail Target/.test(d.querySelector('.followup-prompt').textContent), 'the prompt names the prospect just spoken to');
        mailApp.drain();
        const sendBtn = [...d.querySelectorAll('.followup-prompt button')].find((b) => /follow-up email/i.test(b.textContent));
        check(!!sendBtn, 'the prompt carries a send action');
        if (sendBtn) sendBtn.dispatchEvent(new mailApp.window.MouseEvent('click', { bubbles: true }));
        const reopened = await (async () => { try { await wait(() => d.querySelector('.email-modal'), 12000, 'composer from the prompt'); return true; } catch { return false; } })();
        check(reopened, 'the prompt opens the composer for that prospect');
        if (reopened) {
          check(/mailtest@gmail\.com/.test(d.body.textContent), 'the re-opened composer targets the right prospect');
        }
      }
    }
    mailApp.dom.window.close();

    // --- E6: a dial the cross-tab mutex refuses must not place a call ------------
    // jsdom has no navigator.locks, so install one with the real contract: with
    // ifAvailable, a lock already held elsewhere yields cb(null). Whatever prospect this
    // tab has active, its dial must be refused and explained rather than double-logged.
    const lockApp = loadApp(JSDOM, VirtualConsole, '#dialer');
    const lwin = lockApp.window;
    Object.defineProperty(lwin.navigator, 'locks', {
      configurable: true,
      value: {
        request: async (name, opts, cb) => {
          if (String(name).startsWith('pulse-dial-')) return cb(null);  // held by another tab
          return cb({ name });
        },
      },
    });
    await wait(() => lwin.document.body.textContent.length > 40, 10000, '#dialer');
    await sleep(900);
    lockApp.drain();
    {
      const ldoc = lwin.document;
      ldoc.dispatchEvent(new lwin.KeyboardEvent('keydown', { key: 'c', bubbles: true }));
      await sleep(1500);
      const dialCalls = lockApp.drain().filter((c) => /\/call$/.test(c.path) && c.method === 'POST');
      check(dialCalls.length === 0, `a dial blocked by another tab places no call (got ${dialCalls.length})`);
      const lockToast = [...ldoc.querySelectorAll('.toast')].map((t) => t.textContent).join(' ');
      check(/Another tab/.test(lockToast), `the agent is told why ("${lockToast.slice(0, 44)}")`);
    }
    lockApp.dom.window.close();
    // --- W1: the in-browser softphone (telephony_mode = webrtc) -------------------
    // The point of this mode is that the call never leaves the tab. Test mode is on, so the
    // engine runs its dry-run simulator — the same component code and the same state machine,
    // just with no audio hardware to talk to.
    await put('/api/settings', { telephony_mode: 'webrtc', dry_run: '1' });
    await post('/api/prospects', { name: 'WebRTC Target', phone: '+4520334455' });

    const wApp = loadApp(JSDOM, VirtualConsole, '#dialer');
    await wait(() => wApp.window.document.querySelector('.q-item'), 15000, 'webrtc queue');
    await ensureListener(wApp);
    const wItem = [...wApp.window.document.querySelectorAll('.q-item')].find((el) => /WebRTC Target/.test(el.textContent));
    check(!!wItem, 'the in-browser fixture prospect is in the queue');
    if (wItem) wItem.dispatchEvent(new wApp.window.MouseEvent('click', { bubbles: true }));
    await sleep(700);
    wApp.drain();
    key(wApp.window, 'c');

    // A call bar that says "active" before any audio path exists is the defect this mode
    // exists to remove: the timer must not run on a silent call.
    await wait(() => !!wApp.window.document.querySelector('.inflight'), 8000, 'in-browser strip');
    await sleep(350);
    const earlyClass = wApp.window.document.querySelector('.callbar')?.className || '';
    check(!/active/.test(earlyClass) && !wApp.window.document.querySelector('.webrtc-badge'),
      'the call bar stays out of "active" until the audio path is real');
    check(/transport=ws/.test(wApp.window.document.querySelector('.inflight-uri')?.textContent || ''),
      `the dial URI is a SIP-over-WebSocket route (${(wApp.window.document.querySelector('.inflight-uri')?.textContent || '').slice(0, 46)})`);
    check(!wApp.window.document.querySelector('.softphone-link'),
      'the "launch your softphone" affordance is gone in this mode');

    // ...and then the engine reports the audio path, and only then does the call go live.
    await wait(() => wApp.window.document.querySelector('.webrtc-badge'), 12000, 'WebRTC active badge');
    check(/WebRTC Active \u00b7 Mic Live/.test(wApp.window.document.querySelector('.webrtc-badge').textContent),
      'the badge reads "WebRTC Active \u00b7 Mic Live"');
    check(wApp.window.document.querySelectorAll('iframe[src^="sip:"], iframe[src^="tel:"]').length === 0,
      'no dial URI is handed to the operating system in this mode');
    const t0 = wApp.window.document.querySelector('.timer')?.textContent;
    await sleep(1400);
    const t1 = wApp.window.document.querySelector('.timer')?.textContent;
    check(t0 !== t1 && /^\d+:\d\d$/.test(t1 || ''), `the talk timer counts real time (${t0} -> ${t1})`);

    key(wApp.window, 'm');
    await sleep(300);
    check(/Muted/.test(wApp.window.document.querySelector('.webrtc-badge')?.textContent || ''),
      'M mutes the microphone and the badge says so');
    key(wApp.window, 'm');
    await sleep(300);
    check(/Mic Live/.test(wApp.window.document.querySelector('.webrtc-badge')?.textContent || ''),
      'M again brings the microphone back');

    // The touch-tone pad is a modal: its digits are tones for an IVR, not call results.
    wApp.drain();
    key(wApp.window, 'd');
    await sleep(350);
    const pad = wApp.window.document.querySelector('.dtmf-pad');
    check(!!pad, 'D opens the touch-tone pad');
    check((pad?.querySelectorAll('.dtmf-key') || []).length === 12, `the pad offers 12 tones (${(pad?.querySelectorAll('.dtmf-key') || []).length})`);
    for (const d of ['1', '2', '#']) key(wApp.window, d);
    await sleep(400);
    const log = wApp.window.document.querySelector('.dtmf-log')?.textContent || '';
    check(/1 2 #/.test(log), `keys pressed in the pad are sent as tones (${log.slice(0, 24)})`);
    check(count(wApp.drain(), PATCH) === 0, 'the pad swallows the outcome keys instead of classifying the call');
    key(wApp.window, 'Escape');
    await sleep(700);   // AnimatePresence removes the node after the exit animation
    check(!wApp.window.document.querySelector('.dtmf-pad'), 'Escape closes the pad');

    // Hang up: the mic goes cold first, then classification opens — same rhythm as an OS call.
    key(wApp.window, 'h');
    await wait(() => wApp.window.document.querySelector('.classify-modal'), 8000, 'classification after hang-up');
    check(!!wApp.window.document.querySelector('.classify-modal'), 'H hangs up the in-browser call and opens classification');
    await sleep(700);
    check(!wApp.window.document.querySelector('.webrtc-badge'), 'hanging up clears the live badge (the microphone is released)');
    key(wApp.window, 'Escape');
    await sleep(900);
    check(wApp.jsErrors.length === 0, `no jsdom errors driving the in-browser softphone (${wApp.jsErrors.join(' | ').slice(0, 150)})`);
    wApp.dom.window.close();

    // The adapter destructures an exact export surface out of the SIP stack. Pin it: an
    // upstream rename would otherwise only show up as a failed call in front of a customer.
    const sipCore = await import('sip.js').catch(() => null);
    const sipWeb = await import('sip.js/lib/platform/web/index.js').catch(() => null);
    check(!!sipCore?.UserAgent && !!sipCore?.Registerer && !!sipCore?.Inviter && !!sipCore?.SessionState?.Established,
      'the SIP stack exports the classes the signalling adapter drives');
    check(!!(sipCore?.SessionDescriptionHandler || sipWeb?.SessionDescriptionHandler),
      'a session-description handler is available for the microphone hand-off');

    // --- W2: Settings must reach for audio hardware without throwing when there is none ---
    const sApp = loadApp(JSDOM, VirtualConsole, '#settings');
    await wait(() => sApp.window.document.querySelector('.mic-test'), 12000, 'WebRTC settings panel');
    check(!!sApp.window.document.querySelector('.mic-test'), 'Settings carries the in-browser softphone panel and a microphone test');
    const startTest = [...sApp.window.document.querySelectorAll('.mic-test button')].find((b) => /Start test/.test(b.textContent));
    check(!!startTest, 'the microphone test has a start control');
    if (startTest) startTest.dispatchEvent(new sApp.window.MouseEvent('click', { bubbles: true }));
    await sleep(600);
    const micText = sApp.window.document.querySelector('.mic-test')?.textContent || '';
    check(/no microphone API|Could not open/.test(micText),
      'with no microphone API the test explains itself instead of throwing');
    check(sApp.jsErrors.length === 0, `no jsdom errors on the WebRTC settings panel (${sApp.jsErrors.join(' | ').slice(0, 140)})`);
    sApp.dom.window.close();
    await put('/api/settings', { telephony_mode: 'softphone' });

    // --- I1: a call that arrives in the browser ---------------------------------
    // The inbound half of the softphone. `i` in test mode rings through exactly the code path
    // a real INVITE takes (SIP delegate -> engine -> store -> banner), so the checks below are
    // made against the shipping state machine, not a stub. Web Audio is instrumented so
    // "the phone stopped ringing" is an assertion and not a hope.
    await put('/api/settings', { telephony_mode: 'webrtc', dry_run: '1' });
    const inCaller = await (await post('/api/prospects', {
      name: 'Inbound Caller', phone: '20123477', company: 'Ringsted ApS', title: 'Driftschef',
    })).json();

    const audio = fakeWebAudio();
    const iApp = loadApp(JSDOM, VirtualConsole, '#dialer', { webAudio: audio });
    const iwin = iApp.window;
    const idoc = iwin.document;
    await wait(() => idoc.querySelector('.q-item'), 15000, 'inbound queue');
    await ensureListener(iApp);
    await sleep(500);
    iApp.drain();
    audio.reset();

    const banner = () => idoc.querySelector('.incoming-call');
    const inToasts = () => [...idoc.querySelectorAll('.toast')].map((t) => t.textContent).join(' ');
    key(iwin, 'i');
    await wait(() => banner(), 8000, 'the incoming call banner');
    await sleep(500);

    check(banner()?.getAttribute('role') === 'alertdialog' && banner()?.getAttribute('aria-modal') === 'true',
      'the incoming call is an alertdialog');
    check(/Incoming call from Inbound Caller/.test(banner()?.querySelector('.sr-only')?.textContent || ''),
      `the caller is announced to screen readers ("${(banner()?.querySelector('.sr-only')?.textContent || '').slice(0, 44)}")`);
    check(/Inbound Caller/.test(idoc.querySelector('.incoming-name')?.textContent || ''),
      'the banner names the caller from the CRM');
    check(/Ringsted ApS/.test(idoc.querySelector('.incoming-sub')?.textContent || ''),
      'the banner carries the company so two "John"s are never confused');
    check((idoc.querySelector('.incoming-number')?.textContent || '').replace(/\D/g, '').length >= 8,
      `the caller's number is on screen (${idoc.querySelector('.incoming-number')?.textContent || ''})`);
    check(/Answer/.test(idoc.activeElement?.textContent || ''),
      `focus lands on Answer so Enter accepts it natively ("${(idoc.activeElement?.textContent || '').trim().slice(0, 20)}")`);
    check(audio.ringing() >= 1, `the tab is audibly ringing (${audio.ringing()} tone(s) live)`);
    check(count(iApp.drain(), /POST \/api\/calls\/inbound/) === 1,
      'the ring opens exactly one ledger row for the caller');

    // --- I2: every dialer shortcut is inert while the phone rings ---------------
    key(iwin, 'c'); key(iwin, '1'); key(iwin, '6'); key(iwin, 'r'); key(iwin, 'h');
    await sleep(900);
    const duringRing = iApp.drain();
    check(count(duringRing, DIAL) === 0, `C behind a ringing phone places no call (got ${count(duringRing, DIAL)})`);
    check(count(duringRing, PATCH) === 0, `outcome keys behind a ringing phone classify nothing (got ${count(duringRing, PATCH)})`);
    check(idoc.querySelectorAll('iframe[src^="sip:"], iframe[src^="tel:"]').length === 0,
      'no dial URI reaches the operating system while the phone rings');
    check(!!banner(), 'the banner survives the keystrokes (nothing raced it off screen)');

    // --- I3: Escape declines, and the ring stops ---------------------------------
    key(iwin, 'Escape');
    await wait(() => !banner(), 8000, 'the banner to close on decline');
    await sleep(700);   // AnimatePresence exit
    const declined = iApp.drain();
    check(count(declined, /POST \/api\/calls\/\d+\/missed/) === 1,
      `declining logs the miss exactly once (got ${count(declined, /missed/)})`);
    check(audio.ringing() === 0, `the ringer is silent the instant the call is declined (${audio.ringing()} live)`);
    check(audio.closedContexts() >= 1, 'declining closes the audio context instead of leaking it');
    check(/Declined call from/.test(inToasts()), `the agent is told what they did ("${inToasts().slice(0, 40)}")`);
    check(!/active/.test(idoc.querySelector('.callbar')?.className || ''), 'a declined call never goes "active"');
    check(!idoc.querySelector('.webrtc-badge'), 'declining opens no microphone (no live badge)');

    // --- I4: Enter answers, the cockpit follows ----------------------------------
    iApp.drain(); audio.reset();
    key(iwin, 'i');
    await wait(() => banner(), 8000, 'a second ring');
    key(iwin, 'Enter');
    await wait(() => idoc.querySelector('.webrtc-badge'), 12000, 'the live badge after answering');
    const answered = iApp.drain();
    const bannerGone = await (async () => { try { await wait(() => !banner(), 6000, 'banner exit'); return true; } catch { return false; } })();
    check(bannerGone, 'answering takes the banner down');
    check(/WebRTC Active \u00b7 Mic Live/.test(idoc.querySelector('.webrtc-badge')?.textContent || ''),
      'answering goes live with the microphone badge');
    check(audio.ringing() === 0, `answering stops the ringer (${audio.ringing()} live)`);
    check(count(answered, /POST \/api\/calls\/inbound/) === 1,
      `a second ring reuses/opens one inbound row (got ${count(answered, /inbound/)})`);
    check(count(answered, /missed/) === 0, 'answering never logs the call as missed');
    check(/Inbound call with Inbound Caller/.test(idoc.querySelector('.inflight-txt')?.textContent || ''),
      `the in-flight strip says who is on the line ("${(idoc.querySelector('.inflight-txt')?.textContent || '').slice(0, 46)}")`);
    const it0 = idoc.querySelector('.timer')?.textContent;
    await sleep(1300);
    const it1 = idoc.querySelector('.timer')?.textContent;
    check(it0 !== it1 && /^\d+:\d\d$/.test(it1 || ''), `the inbound talk timer counts real time (${it0} -> ${it1})`);

    // --- I5: hanging up classifies an inbound call like any other ---------------
    iApp.drain();
    key(iwin, 'h');
    await wait(() => idoc.querySelector('.classify-modal'), 9000, 'classification after an inbound hang-up');
    check(true, 'hanging up an inbound call opens the same 1-8 classification');
    await sleep(700);
    check(!idoc.querySelector('.webrtc-badge'), 'hanging up releases the microphone');
    const inNote = idoc.getElementById('top-quick-note');
    if (inNote) {
      const setVal = Object.getOwnPropertyDescriptor(iwin.HTMLTextAreaElement.prototype, 'value').set;
      setVal.call(inNote, 'Inbound fixture note');
      inNote.dispatchEvent(new iwin.Event('input', { bubbles: true }));
      await sleep(200);
    }
    key(iwin, '6');
    await sleep(2000);
    const inLogged = iApp.drain();
    check(count(inLogged, PATCH) === 1, `mashing 6 on an inbound call patches it once (got ${count(inLogged, PATCH)})`);
    const patchedId = (inLogged.find((c) => PATCH.test(`${c.method} ${c.path}`))?.path || '').match(/\d+$/)?.[0];
    const inDetail = await (await fetch(`${BASE}/api/prospects/${inCaller.id}`)).json();
    const inRow = inDetail.calls[0];
    check(!!inRow && inRow.direction === 'inbound',
      `the ledger row is an inbound call (direction=${inRow?.direction})`);
    check(String(inRow?.id) === String(patchedId),
      `the classification landed on the row the ring opened (${patchedId} vs ${inRow?.id})`);
    check(inRow?.outcome === 'conversation', `the outcome is saved on the inbound row (${inRow?.outcome})`);
    check((inRow?.duration_sec || 0) > 0, `the inbound call has a real talk time (${inRow?.duration_sec}s)`);

    // --- I6: a second tab must not ring, and says why ----------------------------
    // jsdom has no navigator.locks. Install one that refuses the inbound audio lock, the way
    // a real "another tab owns the speakers" refusal arrives.
    const tabs = { requested: [], refused: [] };
    Object.defineProperty(iwin.navigator, 'locks', {
      configurable: true,
      value: {
        request: async (name, opts, cb) => {
          tabs.requested.push(String(name));
          if (String(name) === 'pulse-inbound-audio') { tabs.refused.push(String(name)); return cb(null); }
          return cb({ name });
        },
      },
    });
    await wait(() => !idoc.querySelector('.classify-modal'), 9000, 'the classification modal to close');
    await sleep(400);
    iApp.drain();
    key(iwin, 'i');
    await sleep(1600);
    check(tabs.requested.includes('pulse-inbound-audio'), `the ring asks for the audio lock (${tabs.requested.join(',') || 'none'})`);
    check(!banner(), 'a tab that loses the audio lock does not ring at all');
    check(count(iApp.drain(), /POST \/api\/calls\/inbound/) === 0, 'the losing tab does not open a second ledger row');
    check(/Call in progress on another tab/.test(idoc.querySelector('.standby-strip.busy')?.textContent || ''),
      `the losing tab explains itself ("${(idoc.querySelector('.standby-strip.busy')?.textContent || '').trim().slice(0, 40)}")`);
    check(/Standby/.test(idoc.querySelector('.standby-strip')?.textContent || ''),
      'the registration state is visible in the cockpit instead of buried in Settings');
    check(iApp.jsErrors.length === 0, `no jsdom errors driving an inbound call (${iApp.jsErrors.join(' | ').slice(0, 170)})`);
    iApp.dom.window.close();

    // --- I7: a reduced-motion user still gets the call --------------------------
    // The ring cadence is drawn, so "no animation" must not mean "no banner": the bars go
    // static and the keyboard/audio path is unchanged.
    const rApp = loadApp(JSDOM, VirtualConsole, '#dialer', { webAudio: fakeWebAudio(), reducedMotion: true });
    await wait(() => rApp.window.document.querySelector('.q-item'), 15000, 'reduced-motion queue');
    await ensureListener(rApp);
    await sleep(400);
    key(rApp.window, 'i');
    await wait(() => rApp.window.document.querySelector('.incoming-call'), 8000, 'the reduced-motion ring');
    await sleep(400);
    const bars = [...rApp.window.document.querySelectorAll('.incoming-wave i')];
    check(bars.length === 5, `the ringing banner still renders with reduced motion (${bars.length} bars)`);
    check(bars.every((b) => !b.style.transform || /^none$|^scaleY\(0?\.?[0-9]+\)$/.test(b.style.transform)),
      'reduced motion leaves the ring bars still instead of animating them');
    check(/Answer/.test(rApp.window.document.activeElement?.textContent || ''),
      'answering is still one Enter away for a reduced-motion user');
    key(rApp.window, 'Escape');
    await wait(() => !rApp.window.document.querySelector('.incoming-call'), 8000, 'the reduced-motion teardown');
    check(true, 'and Escape still declines');
    rApp.dom.window.close();

    await put('/api/settings', { telephony_mode: 'softphone' });

    // --- O1: the local mail sink — email works with no credentials at all ---------
    // Point SMTP at the sink, then capture a message straight through the API so this check
    // does not depend on DNS or a live mail server. The agent-facing half (preset button,
    // previewer, composer feedback) is driven through the real bundle below.
    await put('/api/settings', { smtp_host: 'local', smtp_port: '1025', smtp_user: 'agent@firma.dk', smtp_secure: '0' });
    const sinkStatus = await (await fetch(`${BASE}/api/email/status`)).json();
    check(sinkStatus.configured === true && sinkStatus.localSink === true,
      'the sink is configured and reports itself as local');

    const fileForm = new FormData();
    fileForm.append('file', new Blob([new Uint8Array(2048)], { type: 'application/pdf' }), 'Sink-Tilbud.pdf');
    const stagedUp = await (await fetch(`${BASE}/api/email/attachments`, { method: 'POST', body: fileForm })).json();
    const captured = await (await post('/api/email/send', {
      to: 'lead@gmail.com',
      subject: 'Captured fixture mail',
      body: 'Plain text body of the capture',
      html: '<h2>Rendered body of the capture</h2>',
      attachments: [stagedUp.id],
      force: true,          // skip the MX probe: this fixture is about capture, not verification
    })).json();
    check(captured.local === true && typeof captured.outboxId === 'number' && /^local-/.test(captured.messageId),
      `a send is captured into the outbox instead of transmitted (${String(captured.messageId).slice(0, 22)}…)`);

    // --- O2: Settings offers the one-click preset and the outbox ------------------
    const oApp = loadApp(JSDOM, VirtualConsole, '#settings');
    // The page root, not .mic-test: that panel only exists in WebRTC mode and the fixture is
    // back on the desktop softphone here.
    await wait(() => oApp.window.document.querySelector('.settings'), 12000, 'settings page');
    await sleep(600);   // let the email section and its outbox count settle
    const buttons = () => [...oApp.window.document.querySelectorAll('button')];
    const presetBtn = buttons().find((b) => /Use Local Mail Sink/.test(b.textContent));
    check(!!presetBtn, 'Settings offers the one-click "Use Local Mail Sink" preset');

    const outboxBtn = buttons().find((b) => /View Outbox/.test(b.textContent));
    check(!!outboxBtn && /View Outbox \(1\)/.test(outboxBtn.textContent),
      `the outbox button advertises how much is captured (${(outboxBtn?.textContent || '').trim()})`);

    if (presetBtn) {
      oApp.drain();
      presetBtn.dispatchEvent(new oApp.window.MouseEvent('click', { bubbles: true }));
      await sleep(900);
      const saved = await (await fetch(`${BASE}/api/settings`)).json();
      // Settings are stored as text (they are edited as text in the form), so compare coerced.
      check(saved.smtp_host === 'local' && String(saved.smtp_port) === '1025' && saved.smtp_user === 'agent@firma.dk',
        `the preset writes a working sink configuration (host=${saved.smtp_host}, port=${saved.smtp_port}, user=${saved.smtp_user})`);
      check(count(oApp.drain(), /PUT \/api\/settings/) >= 1, 'the preset saves immediately — one click, not click-then-save');
      check(/Local Mail Sink is on/.test(oApp.window.document.body.textContent), 'the agent is told the sink is on');
    }

    // --- O3: the outbox inspector renders the captured mail ----------------------
    if (outboxBtn) {
      outboxBtn.dispatchEvent(new oApp.window.MouseEvent('click', { bubbles: true }));
      await wait(() => oApp.window.document.querySelector('.outbox-modal'), 8000, 'outbox modal');
      check(!!oApp.window.document.querySelector('.outbox-modal'), 'View Outbox opens the inspector');
      await wait(() => oApp.window.document.querySelector('.outbox-row'), 8000, 'captured row');
      const rows = [...oApp.window.document.querySelectorAll('.outbox-row')];
      check(rows.length === 1 && /Captured fixture mail/.test(rows[0].textContent),
        `the capture is listed with its subject (${rows.length} row)`);
      check(/lead@gmail\.com/.test(rows[0].textContent) && /local/.test(rows[0].textContent),
        'the row names the recipient and marks the message as captured locally');

      await wait(() => oApp.window.document.querySelector('.outbox-frame'), 8000, 'rendered preview');
      const frame = oApp.window.document.querySelector('.outbox-frame');
      const sandbox = frame.getAttribute('sandbox') || '';
      check(sandbox.includes('allow-same-origin'), 'the preview iframe is sandboxed with allow-same-origin');
      check(!sandbox.includes('allow-scripts'),
        'and WITHOUT allow-scripts, so a captured payload can never run code in the dialer');
      check(/Rendered body of the capture/.test(frame.getAttribute('srcdoc') || ''),
        'the rendered tab holds the captured HTML');

      const tabs = [...oApp.window.document.querySelectorAll('.outbox-tabs button')];
      check(tabs.length === 3, `the previewer offers three views (${tabs.length})`);
      const textTab = tabs.find((t) => /Plain text/.test(t.textContent));
      if (textTab) {
        textTab.dispatchEvent(new oApp.window.MouseEvent('click', { bubbles: true }));
        await sleep(400);
        check(/Plain text body of the capture/.test(oApp.window.document.querySelector('.outbox-text')?.textContent || ''),
          'the plain-text tab shows the text part verbatim');
      }
      const headTab = tabs.find((t) => /Headers/.test(t.textContent));
      if (headTab) {
        headTab.dispatchEvent(new oApp.window.MouseEvent('click', { bubbles: true }));
        await sleep(400);
        const headTxt = oApp.window.document.querySelector('.outbox-headers')?.textContent || '';
        check(/Message-ID/.test(headTxt) && /local-\d+/.test(headTxt) && /local-sink/.test(headTxt),
          'the headers tab exposes the Message-ID and the local-sink transport marker');
      }

      const badge = oApp.window.document.querySelector('.attach-badge');
      const dlLink = badge?.querySelector('a.attach-dl');
      check(!!badge && /Sink-Tilbud\.pdf/.test(badge.textContent), 'the attachment is listed by name');
      check(!!dlLink && /\/api\/email\/outbox\/\d+\/attachments\/0$/.test(dlLink.getAttribute('href') || ''),
        'and carries a one-click download link to the stored bytes');
      check(oApp.jsErrors.length === 0, `no jsdom errors while driving the outbox (${oApp.jsErrors.join(' | ').slice(0, 140)})`);
      oApp.dom.window.close();
    }

    // --- O4: the composer says "captured", not "sent" -----------------------------
    // A dedicated prospect, filtered for in the queue: by this point the fixture list is long
    // enough that "find the row by text" is not a safe assumption.
    await post('/api/prospects', { name: 'Sink Composer', phone: '20999998', email: 'sinktarget@gmail.com' });
    const cApp = loadApp(JSDOM, VirtualConsole, '#dialer');
    await wait(() => cApp.window.document.querySelector('.q-item'), 15000, 'dialer queue');
    await ensureListener(cApp);
    const sbox = cApp.window.document.querySelector('.search input');
    if (sbox) {
      const setInput = Object.getOwnPropertyDescriptor(cApp.window.HTMLInputElement.prototype, 'value').set;
      setInput.call(sbox, 'Sink Composer');
      sbox.dispatchEvent(new cApp.window.Event('input', { bubbles: true }));
      await sleep(900);
      sbox.blur();   // focus must leave the field or E is a keystroke, not a shortcut
    }
    const mailItem = [...cApp.window.document.querySelectorAll('.q-item')].find((el) => /Sink Composer/.test(el.textContent));
    check(!!mailItem, 'the sink composer fixture prospect is in the queue');
    if (mailItem) mailItem.dispatchEvent(new cApp.window.MouseEvent('click', { bubbles: true }));
    await wait(() => /sinktarget@gmail\.com/.test(cApp.window.document.body.textContent), 12000, 'the banner email chip');
    await sleep(400);
    key(cApp.window, 'e');
    await wait(() => cApp.window.document.querySelector('.email-modal'), 12000, 'composer');
    await sleep(700);
    const localPill = cApp.window.document.querySelector('.banner.local-sink');
    check(!!localPill && /Local Outbox Mode/.test(localPill.textContent) && /no external email sent/.test(localPill.textContent),
      'the composer warns that mail is captured locally, not sent');

    const sendBtn = [...cApp.window.document.querySelectorAll('.email-modal button')].find((b) => /Send email/.test(b.textContent));
    cApp.drain();
    sendBtn?.dispatchEvent(new cApp.window.MouseEvent('click', { bubbles: true }));
    await wait(() => [...cApp.window.document.querySelectorAll('.toast')].some((t) => /Captured in Local Outbox/.test(t.textContent)),
      12000, 'captured toast');
    const toastNode = [...cApp.window.document.querySelectorAll('.toast')].find((t) => /Captured in Local Outbox/.test(t.textContent));
    check(!!toastNode, 'sending in sink mode says "Captured in Local Outbox", not "Sent to"');
    const viewAction = toastNode?.querySelector('.toast-action');
    check(!!viewAction && /View/.test(viewAction.textContent), 'and the toast carries a one-click way to go look at it');
    check(count(cApp.drain(), DIAL) === 0, 'a captured send places no call and leaves the dialer alone');

    if (viewAction) {
      viewAction.dispatchEvent(new cApp.window.MouseEvent('click', { bubbles: true }));
      await wait(() => cApp.window.document.querySelector('.outbox-modal'), 8000, 'outbox from the toast action');
      check(!!cApp.window.document.querySelector('.outbox-modal'), 'the toast action opens the outbox');
      await sleep(700);   // the composer's exit animation, and the action's own dismissal
      check(!cApp.window.document.querySelector('.toast-action'), 'the toast dismisses itself once its action has been used');
      check(!cApp.window.document.querySelector('.email-modal'), 'and the composer is gone behind the outbox');
    }
    check(cApp.jsErrors.length === 0, `no jsdom errors in the composer's captured flow (${cApp.jsErrors.join(' | ').slice(0, 140)})`);
    cApp.dom.window.close();

    // Leave the fixture as it was found: no sink, no captured mail, no stale setting.
    await fetch(`${BASE}/api/email/outbox`, { method: 'DELETE' });
    await put('/api/settings', { smtp_host: '', smtp_user: '', smtp_port: '587', smtp_from: '' });
    const cleaned = await (await fetch(`${BASE}/api/email/status`)).json();
    check(cleaned.configured === false && cleaned.localSink === false && cleaned.outboxCount === 0,
      'clearing the host after the sink leaves SMTP unconfigured and the outbox empty');

  } catch (e) {
    bad(`dialer race suite aborted: ${e.message}`);
    if (srvErr) console.log(`        server stderr: ${srvErr.slice(-300)}`);
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  return { passed, failures, skipped: false };
}

if (require.main === module) {
  run()
    .then((r) => {
      if (r.skipped) { console.log('  [ui] skipped'); return; }
      console.log(`  [ui] ${r.passed} UI race checks passed, ${r.failures} failed`);
      if (r.failures) process.exitCode = 1;
    })
    .catch((e) => { console.error('  \u274C ui suite error:', e.stack || e.message); process.exitCode = 1; })
    .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
}

module.exports = { run };
