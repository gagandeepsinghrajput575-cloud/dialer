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
    connect() { return this; }
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

// opts.nodeFormData swaps jsdom's FormData/File for node's before the bundle runs, which is the
// only way a FormData upload made *inside* the app can reach node's fetch (two different realms).
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
    if (url.startsWith(`${BASE}/api`)) {
      // The body matters for the import/bulk checks — the mapping and the id list are the
      // whole point of those requests, and asserting on status codes alone would miss them.
      calls.push({ method: (init.method || 'GET').toUpperCase(), path: url.slice(BASE.length), body: typeof init.body === 'string' ? init.body : null });
    }
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
  if (opts.nodeFormData) { window.FormData = FormData; window.File = File; window.Blob = Blob; }
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
    // Escape no longer wipes the call by itself — it opens the discard confirmation. That is
    // the point of the guard, so the flow confirms before moving on.
    key(app.window, 'h'); await sleep(700);
    key(app.window, 'Escape'); await sleep(500);
    check(!!app.window.document.querySelector('.confirm-modal'), 'Escape on a call asks before discarding it');
    key(app.window, 'Enter');
    await sleep(1100);
    check(!app.window.document.querySelector('.confirm-modal'), 'confirming the discard closes the prompt');
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

    // --- A2c: a stray Escape must not throw away a finished call -------------------
    // This is the regression the guard exists for: Escape used to delete the call (and its talk
    // time) with no prompt at all. Keeping it must leave the record intact.
    app.drain();
    key(app.window, 'Escape');
    await sleep(500);
    const confirmOpen = !!app.window.document.querySelector('.confirm-modal');
    check(confirmOpen, 'Escape while classifying opens the discard confirmation instead of deleting the call');
    const keepBtn = [...app.window.document.querySelectorAll('.confirm-modal button')].find((b) => /Keep/i.test(b.textContent));
    check(!!keepBtn, 'the confirmation offers a way to keep the call');
    if (keepBtn) keepBtn.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    await sleep(600);
    check(!app.window.document.querySelector('.confirm-modal'), 'Keep Call dismisses the confirmation');
    check(!!app.window.document.querySelector('.classify-modal'), 'and the call is still there, waiting to be classified');
    const strayDiscards = app.drain().filter((c) => /^POST \/api\/calls\/\d+\/discard$/.test(`${c.method} ${c.path}`)).length;
    check(strayDiscards === 0, `nothing was discarded behind the agent\u2019s back (got ${strayDiscards})`);

    // Now really discard it, so the fixture moves on with no call left open.
    key(app.window, 'Escape'); await sleep(400);
    key(app.window, 'Enter'); await sleep(1000);

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
    // Discarding is confirmed now, by design — the in-browser call ends on the same terms.
    wApp.drain();
    key(wApp.window, 'Escape'); await sleep(400);
    check(!!wApp.window.document.querySelector('.confirm-modal'), 'the in-browser hang-up also confirms before discarding');
    key(wApp.window, 'Enter'); await sleep(1000);
    const confirmedDiscards = wApp.drain().filter((c) => /^POST \/api\/calls\/\d+\/discard$/.test(`${c.method} ${c.path}`)).length;
    check(confirmedDiscards === 1, `confirming discards the call exactly once (got ${confirmedDiscards})`);
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
    check(inRow?.status === 'completed', `the inbound row transitions to status=completed instead of staying ringing (${inRow?.status})`);
    check(!iApp.consoleErrors.some((m) => /Failed to answer inbound call/i.test(m)),
      'answering an inbound call throws zero console errors');
    check((inRow?.duration_sec || 0) > 0, `the inbound call has a real talk time (${inRow?.duration_sec}s)`);

    // Verify the answered & classified inbound call renders cleanly in #recents (NOT as Missed Call)
    iwin.location.hash = '#recents';
    iwin.dispatchEvent(new iwin.HashChangeEvent('hashchange'));
    await wait(() => idoc.querySelector('.recents-card'), 8000, 'Recents ledger cards');
    const answeredCard = [...idoc.querySelectorAll('.recents-card')].find((el) => /Inbound Caller/.test(el.textContent) && !/No Answer/.test(el.textContent));
    check(!!answeredCard && !answeredCard.querySelector('.missed-pill'),
      'answered inbound call renders in Recents as a connected call rather than Missed Call');
    iwin.location.hash = '#dialer';
    iwin.dispatchEvent(new iwin.HashChangeEvent('hashchange'));
    await wait(() => idoc.querySelector('.callbar'), 8000, 'return to Dialer');

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

    // --- I8: a caller who is not in the CRM --------------------------------------
    // Nobody recognises every number. The ring must not fail, must not show the record it
    // could not find, and must say plainly that answering creates a new lead. The stale list
    // in the tab is what makes this reproducible: the tab rings from a number the server no
    // longer knows, which is exactly the stranger-calls-in case.
    // The test-mode ring dials the first prospect with a number *in the app's own list*, so the
    // victim has to be picked the same way — from GET /api/prospects, not from the queue tab.
    const list = await (await fetch(`${BASE}/api/prospects`)).json();
    const ghost = (Array.isArray(list) ? list : list.items || []).find((p) => p.phone);
    check(!!ghost?.id && !!ghost?.phone, `the fixture list has a prospect to ring from (${ghost?.name || 'none'})`);
    const uAudio = fakeWebAudio();
    const uApp = loadApp(JSDOM, VirtualConsole, '#dialer', { webAudio: uAudio });
    await wait(() => uApp.window.document.querySelector('.q-item'), 15000, 'unknown-caller queue');
    await ensureListener(uApp);
    await sleep(500);
    // The tab keeps the prospect in memory; the database forgets it.
    await fetch(`${BASE}/api/prospects/${ghost.id}`, { method: 'DELETE' });
    const uDoc = uApp.window.document;
    uApp.drain();
    key(uApp.window, 'i');
    await wait(() => uDoc.querySelector('.incoming-call'), 8000, 'the unknown-caller ring');
    await sleep(600);
    check(/Unknown caller/.test(uDoc.querySelector('.incoming-sub')?.textContent || ''),
      `an unrecognised number reads as an unknown caller ("${(uDoc.querySelector('.incoming-sub')?.textContent || '').trim()}")`);
    check((uDoc.querySelector('.incoming-number')?.textContent || '').replace(/\D/g, '').includes(String(ghost.phone).replace(/\D/g, '').slice(-8)),
      `the banner still shows the number that is ringing (${uDoc.querySelector('.incoming-number')?.textContent || ''})`);
    check(/Answering creates a new lead/.test(uDoc.querySelector('.incoming-hint')?.textContent || ''),
      'and tells the agent what answering will do');
    check(!!uDoc.querySelector('.incoming-actions .incoming-answer'), 'Answer stays available for a stranger');
    key(uApp.window, 'Escape');
    await wait(() => !uDoc.querySelector('.incoming-call'), 8000, 'the stranger ring to close');
    check(uAudio.ringing() === 0, 'and the unknown-caller ring is silenced like any other');
    uApp.dom.window.close();

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

    // --- B1: multi-select and the bulk action bar --------------------------------
    // The fixture list is long by now, so the filter narrows it to the rows this block owns.
    await put('/api/settings', { dry_run: '1', telephony_mode: 'softphone' });
    for (const n of ['Bulk Alpha', 'Bulk Beta', 'Bulk Gamma']) {
      await post('/api/prospects', { name: n, phone: `20${Math.floor(100000 + Math.random() * 899999)}`, company: 'Bulk Co' });
    }
    const bApp = loadApp(JSDOM, VirtualConsole, '#prospects');
    await wait(() => bApp.window.document.querySelector('.table tbody tr'), 15000, 'prospects table');
    const bbox = bApp.window.document.querySelector('.search input');
    const setB = Object.getOwnPropertyDescriptor(bApp.window.HTMLInputElement.prototype, 'value').set;
    setB.call(bbox, 'Bulk ');
    bbox.dispatchEvent(new bApp.window.Event('input', { bubbles: true }));
    await sleep(900);
    const rowsNow = () => [...bApp.window.document.querySelectorAll('.table tbody tr')];
    check(rowsNow().length === 3, `the three bulk fixtures are visible (${rowsNow().length} rows)`);

    const checks = () => [...bApp.window.document.querySelectorAll('.row-check')];
    check(checks().length === 4, `each row has a checkbox, plus the header select-all (${checks().length})`);
    check(!bApp.window.document.querySelector('.bulk-bar'), 'no bulk bar while nothing is selected');

    const boxFor = (name) => {
      const row = rowsNow().find((tr) => new RegExp(name).test(tr.textContent));
      return row?.querySelector('.row-check');
    };
    const alpha = boxFor('Bulk Alpha');
    check(!!alpha, 'the first bulk fixture has a selectable checkbox');
    alpha.click();
    await sleep(400);
    check(!!bApp.window.document.querySelector('.bulk-bar'), 'ticking one row reveals the bulk action bar');
    check(/\b1\b\s*selected/.test(bApp.window.document.querySelector('.bulk-count')?.textContent || ''),
      `the bar shows how many are selected ("${(bApp.window.document.querySelector('.bulk-count')?.textContent || '').trim()}")`);

    // Selecting a row must not also open the drawer — the checkbox is not the row.
    check(!bApp.window.document.querySelector('.drawer'), 'ticking a checkbox does not open the prospect drawer');

    boxFor('Bulk Beta')?.click();
    await sleep(300);
    check(/\b2\b\s*selected/.test(bApp.window.document.querySelector('.bulk-count')?.textContent || ''),
      'ticking a second row updates the count');

    // Header checkbox = every visible row.
    checks()[0].click();
    await sleep(400);
    check(/\b3\b\s*selected/.test(bApp.window.document.querySelector('.bulk-count')?.textContent || ''),
      'the header checkbox selects every visible row');
    checks()[0].click();
    await sleep(1000);
    check(!bApp.window.document.querySelector('.bulk-bar'), 'un-ticking the header clears the selection and hides the bar');

    // --- B2: bulk stage move ------------------------------------------------------
    boxFor('Bulk Alpha')?.click();
    boxFor('Bulk Beta')?.click();
    await sleep(400);
    const stageSelect = bApp.window.document.querySelector('.bulk-stage select');
    check(!!stageSelect, 'the bar carries a Move to stage control');
    const wanted = 'meeting';
    stageSelect.value = wanted;
    stageSelect.dispatchEvent(new bApp.window.Event('change', { bubbles: true }));
    await sleep(1500);
    // GET /api/prospects answers with the array itself, not an envelope.
    const allProspects = () => fetch(`${BASE}/api/prospects`).then((r) => r.json());
    const moved = (await allProspects()).filter((p) => /Bulk (Alpha|Beta)/.test(p.name));
    check(moved.length === 2 && moved.every((p) => p.stage === wanted),
      `both selected prospects moved to "${wanted}" (${moved.map((p) => p.stage).join(', ')})`);
    check(!bApp.window.document.querySelector('.bulk-bar'), 'the selection clears once the action lands');

    // --- B3: delete selected requires a confirmation -----------------------------
    boxFor('Bulk Gamma')?.click();
    await sleep(400);
    const delBtn = [...bApp.window.document.querySelectorAll('.bulk-bar button')].find((b) => /Delete selected/.test(b.textContent));
    check(!!delBtn, 'the bar carries a Delete selected action');
    bApp.drain();
    delBtn.dispatchEvent(new bApp.window.MouseEvent('click', { bubbles: true }));
    await sleep(500);
    const confirmModal = bApp.window.document.querySelector('.confirm-modal');
    check(!!confirmModal, 'Delete selected asks for confirmation first');
    check(/Delete 1 prospect/i.test(confirmModal?.textContent || ''), `the prompt names how many ("${(confirmModal?.textContent || '').slice(0, 60).replace(/\s+/g, ' ')}…")`);
    check(/cannot be undone/i.test(confirmModal?.textContent || ''), 'and says it cannot be undone');
    const beforeCount = (await allProspects()).length;

    const cancelBtn = [...confirmModal.querySelectorAll('button')].find((b) => /Keep them/i.test(b.textContent));
    check(!!cancelBtn, 'the confirmation can be cancelled');
    cancelBtn.dispatchEvent(new bApp.window.MouseEvent('click', { bubbles: true }));
    await sleep(700);
    check(!bApp.window.document.querySelector('.confirm-modal'), 'cancelling closes the prompt');
    const afterCancel = (await allProspects()).length;
    check(afterCancel === beforeCount, `cancelling deletes nothing (${beforeCount} -> ${afterCancel})`);

    const delBtn2 = [...bApp.window.document.querySelectorAll('.bulk-bar button')].find((b) => /Delete selected/.test(b.textContent));
    delBtn2.dispatchEvent(new bApp.window.MouseEvent('click', { bubbles: true }));
    await sleep(500);
    const confirmBtn = [...bApp.window.document.querySelectorAll('.confirm-modal button')].find((b) => /^Delete \d+$/.test(b.textContent.trim()));
    check(!!confirmBtn, 'confirming is a separate, deliberate button');
    confirmBtn.dispatchEvent(new bApp.window.MouseEvent('click', { bubbles: true }));
    await sleep(1800);
    const afterDelete = await allProspects();
    check(afterDelete.length === beforeCount - 1, `the selected prospect is gone (${beforeCount} -> ${afterDelete.length})`);
    check(!afterDelete.some((p) => p.name === 'Bulk Gamma'), 'and it is the one that was selected');
    check(afterDelete.some((p) => p.name === 'Bulk Alpha'), 'the unselected rows are untouched');
    await sleep(900);
    check(!bApp.window.document.querySelector('.bulk-bar'), 'the bulk bar goes away when the selection empties');
    check(bApp.jsErrors.length === 0, `no jsdom errors while driving bulk actions (${bApp.jsErrors.join(' | ').slice(0, 140)})`);
    bApp.dom.window.close();

    // --- C1: Escape cancels an inline edit instead of saving it -------------------
    // The blur handler used to run with the pre-Escape render's state, so abandoning a field
    // with Escape saved the very value the agent was trying to throw away.
    // The fixture has to exist *before* the app loads: the store fetches the list once at
    // mount, so a prospect created afterwards is invisible to this window.
    const editToken = (await (await fetch(`${BASE}/api/session`)).json()).token;
    const editTarget = await (await fetch(`${BASE}/api/prospects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pulse-token': editToken },
      body: JSON.stringify({ name: 'Escape Edit Probe', phone: '20334455' }),
    })).json();
    await fetch(`${BASE}/api/prospects/${editTarget.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-pulse-token': editToken },
      body: JSON.stringify({ follow_up_at: '2026-12-01' }),
    });
    const editApp = loadApp(JSDOM, VirtualConsole, '#prospects');
    await wait(() => editApp.window.document.querySelector('.table tbody tr'), 15000, 'prospects table');
    const editBox = editApp.window.document.querySelector('.search input');
    setB.call(editBox, 'Escape Edit Probe');
    editBox.dispatchEvent(new editApp.window.Event('input', { bubbles: true }));
    await sleep(900);
    const probeRow = [...editApp.window.document.querySelectorAll('.table tbody tr')].find((tr) => /Escape Edit Probe/.test(tr.textContent));
    check(!!probeRow, 'the edit probe is in the table');
    probeRow.dispatchEvent(new editApp.window.MouseEvent('click', { bubbles: true }));
    await wait(() => editApp.window.document.querySelector('.drawer'), 8000, 'prospect drawer');

    const setInput = (el, val) => {
      const desc = Object.getOwnPropertyDescriptor(editApp.window.HTMLInputElement.prototype, 'value');
      desc.set.call(el, val);
      el.dispatchEvent(new editApp.window.Event('input', { bubbles: true }));
    };
    const drawerInput = (sel) => editApp.window.document.querySelector(`.drawer ${sel}`);
    editApp.drain();
    const phoneField = drawerInput('.phone-big');
    check(!!phoneField, 'the drawer has an editable phone field');
    phoneField.focus();
    setInput(phoneField, '+45 99 88 77 66');
    await sleep(200);
    phoneField.dispatchEvent(new editApp.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(900);
    const escapedPatches = editApp.drain().filter((c) => /PATCH \/api\/prospects\/\d+$/.test(`${c.method} ${c.path}`));
    check(escapedPatches.length === 0, `Escape after typing sends no save (${escapedPatches.length} PATCH requests)`);
    const afterEscape = (await (await fetch(`${BASE}/api/prospects/${editTarget.id}`)).json()).phone;
    check(afterEscape === '+4520334455', `and the stored number is untouched ("${afterEscape}")`);
    check(drawerInput('.phone-big').value.replace(/\s/g, '') === '+4520334455', 'the field shows the original value again');

    // Enter still saves — cancelling must not break committing.
    drawerInput('.phone-big').focus();
    setInput(drawerInput('.phone-big'), '+45 99 88 77 66');
    await sleep(200);
    drawerInput('.phone-big').dispatchEvent(new editApp.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await sleep(1200);
    const savedPhone = (await (await fetch(`${BASE}/api/prospects/${editTarget.id}`)).json()).phone;
    check(savedPhone === '+4599887766', `Enter still commits the edit ("${savedPhone}")`);

    // --- C2: a follow-up date can be cleared --------------------------------------
    // The date input posts '' when it is emptied, and the API used to answer 400 — so a
    // follow-up could be scheduled but never un-scheduled.
    check((await (await fetch(`${BASE}/api/prospects/${editTarget.id}`)).json()).follow_up_at === '2026-12-01',
      'the probe starts with a follow-up scheduled');
    editApp.drain();
    const dateField = drawerInput('input[type="date"]');
    check(!!dateField, 'the drawer has a follow-up date field');
    dateField.focus();
    setInput(dateField, '');
    await sleep(200);
    dateField.dispatchEvent(new editApp.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await sleep(1200);
    const clearedFollowUp = await (await fetch(`${BASE}/api/prospects/${editTarget.id}`)).json();
    check(clearedFollowUp.follow_up_at === null, `clearing the date removes the follow-up (${JSON.stringify(clearedFollowUp.follow_up_at)})`);
    const errorToasts = [...editApp.window.document.querySelectorAll('.toast.error')].map((t) => t.textContent);
    check(errorToasts.length === 0, `and no error toast is left behind (${errorToasts.join(' | ').slice(0, 60)})`);
    check(editApp.jsErrors.length === 0, `no jsdom errors while editing inline (${editApp.jsErrors.join(' | ').slice(0, 140)})`);
    editApp.dom.window.close();
    await fetch(`${BASE}/api/prospects/${editTarget.id}`, { method: 'DELETE', headers: { 'x-pulse-token': editToken } });

    // --- B5: a Danish export imports without anyone renaming a header -------------
    // The whole point of the widening is that the operator drops the file the CRM gave them.
    // So this drives the real page: drop a Danish CSV, read back what the mapping picked, and
    // import it — notes included.
    const impApp = loadApp(JSDOM, VirtualConsole, '#import', { nodeFormData: true });
    await wait(() => impApp.window.document.querySelector('.dropzone'), 15000, 'import dropzone');
    const dansk = 'Navn,Kontaktperson,Telefon,Firma,Stilling,Postnr,Noter\n'
      + 'Freja Nielsen,,+45 30 44 55 66,Nordisk A/S,Indkøbschef,2100,Mødt på messe i Herning\n'
      + 'Søren Bak,,+45 30 44 55 67,Bak & Søn,Direktør,8000,Henvist af Sofie\n';
    const drop = new impApp.window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File([dansk], 'kunder.csv', { type: 'text/csv' })] } });
    impApp.window.document.querySelector('.dropzone').dispatchEvent(drop);
    await wait(() => impApp.window.document.querySelector('.map-row'), 15000, 'column mapping step');

    const mapRows = [...impApp.window.document.querySelectorAll('.map-row')];
    const picked = {};
    for (const row of mapRows) picked[row.querySelector('span').textContent.trim()] = row.querySelector('select').value;
    check(picked['Full name'] === 'Navn', `Navn maps to Full name ("${picked['Full name']}")`);
    check(picked['Phone number'] === 'Telefon', `Telefon maps to Phone number ("${picked['Phone number']}")`);
    check(picked['Company'] === 'Firma', `Firma maps to Company ("${picked['Company']}")`);
    check(picked['Job title'] === 'Stilling', `Stilling maps to Job title ("${picked['Job title']}")`);
    check(picked['Location'] === 'Postnr', `Postnr maps to Location ("${picked['Location']}")`);
    check(picked.Notes === 'Noter', `Noter maps to Notes ("${picked.Notes}")`);
    check(!picked['Email'], 'the file has no email column, so Email is left unmapped rather than guessed at');

    impApp.drain();
    const runBtn = [...impApp.window.document.querySelectorAll('button')].find((b) => /Import \d+ prospects/.test(b.textContent));
    check(!!runBtn, 'the import button counts the rows it is about to add');
    runBtn.dispatchEvent(new impApp.window.MouseEvent('click', { bubbles: true }));
    await sleep(2500);
    const bulkCall = impApp.drain().find((c) => c.path === '/api/prospects/bulk');
    check(!!bulkCall, 'the page posts the parsed rows to the bulk endpoint');
    const sent = bulkCall?.body ? JSON.parse(bulkCall.body) : {};
    check(sent.mapping?.notes === 'Noter', `the Notes column is part of the mapping ("${sent.mapping?.notes}")`);
    check(sent.mapping?.phone === 'Telefon' && sent.mapping?.name === 'Navn', 'and so are the Danish name and phone columns');
    check(Array.isArray(sent.rows) && sent.rows.length === 2, `both rows travel with it (${sent.rows?.length})`);
    await wait(() => impApp.window.document.querySelector('.done-card'), 12000, 'import done screen');
    const doneTxt = impApp.window.document.querySelector('.done-card').textContent || '';
    check(/2 prospects imported/.test(doneTxt), `the done screen reports the import ("${doneTxt.slice(0, 46).replace(/\s+/g, ' ')}…")`);
    check(/2 notes carried over/.test(doneTxt), 'and that the notes came with them');
    check(impApp.jsErrors.length === 0, `no jsdom errors while importing a Danish file (${impApp.jsErrors.join(' | ').slice(0, 140)})`);
    impApp.dom.window.close();

    // The imported Danes are real rows now — check the notes landed on the right people, then
    // remove them so the rest of the run starts where it would have.
    const token = (await (await fetch(`${BASE}/api/session`)).json()).token;
    const frejaRow = (await (await fetch(`${BASE}/api/prospects/search?q=Freja%20Nielsen&limit=5`)).json())[0];
    check(!!frejaRow, 'the Danish row exists in the app');
    if (frejaRow) {
      const detail = await (await fetch(`${BASE}/api/prospects/${frejaRow.id}`)).json();
      check(detail.notes.length === 1 && /Herning/.test(detail.notes[0].body), `the Noter cell became the first note ("${detail.notes[0]?.body}")`);
      check(detail.extra === '' || !/Herning/.test(String(detail.extra)), 'and it is not also duplicated into the extra details blob');
      check(detail.company === 'Nordisk A/S' && detail.title === 'Indkøbschef', 'the company and title columns landed too');
      await fetch(`${BASE}/api/prospects/${frejaRow.id}`, { method: 'DELETE', headers: { 'x-pulse-token': token } });
    }
    for (const name of ['Søren Bak']) {
      const row = (await (await fetch(`${BASE}/api/prospects/search?q=${encodeURIComponent(name)}&limit=5`)).json())[0];
      if (row) await fetch(`${BASE}/api/prospects/${row.id}`, { method: 'DELETE', headers: { 'x-pulse-token': token } });
    }

    // --- B4: the completion card tells the truth ----------------------------------
    // "Nobody matches" is an error state; a finished queue is not. Three cases have to be
    // told apart, and only one of them is a trophy:
    //   a search that matches nothing, leads remain -> "Nobody matches"
    //   leads left that cannot be dialled           -> still not finished, but they say so
    //   the tab genuinely empty                     -> "Queue completed"
    const doneApp = loadApp(JSDOM, VirtualConsole, '#dialer');
    await wait(() => doneApp.window.document.querySelector('.q-item'), 15000, 'dialer queue');
    await ensureListener(doneApp);
    const dbox = doneApp.window.document.querySelector('.search input');
    const token4 = (await (await fetch(`${BASE}/api/session`)).json()).token;
    const clearAll = () => fetch(`${BASE}/api/prospects/clear`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pulse-token': token4 } });
    const seed = (name, phone) => fetch(`${BASE}/api/prospects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pulse-token': token4 },
      body: JSON.stringify(phone === undefined ? { name } : { name, phone }),
    }).then((r) => r.json());
    const applySearch = async (needle) => { setB.call(dbox, needle); dbox.dispatchEvent(new doneApp.window.Event('input', { bubbles: true })); await sleep(1300); };
    const bannerName = () => (doneApp.window.document.querySelector('.banner-name')?.textContent || '').trim();

    // Earlier blocks have already dialled today, so the day has work on the clock.
    await clearAll();
    await seed('Skip Target', '20334466');
    const phoneless = await seed('No Number Lead');

    // (a) A search that matches nothing, with leads still in the tab, is NOT a completed queue.
    await applySearch('zzz-nothing-matches-this-filter-zzz');
    check(!doneApp.window.document.querySelector('.queue-done'),
      'a search that matches nothing is not celebrated as a completed queue');
    check(/Nobody matches/.test(doneApp.window.document.body.textContent), 'it is still the plain empty state');
    check(!/Queue completed/.test(doneApp.window.document.body.textContent), 'and nothing claims the queue is done');

    // (b) A lead with no number is visible and fixable, never a wall you hit with C.
    await applySearch('');
    await wait(() => doneApp.window.document.querySelectorAll('.q-item').length >= 2, 10000, 'both fixture leads in the queue');
    const queueText = doneApp.window.document.body.textContent;
    check(/no number/i.test(queueText), 'the phoneless lead is marked as undiallable in the queue');
    check(/without a number/.test(doneApp.window.document.querySelector('.queue-meta')?.textContent || ''),
      `the meta line counts them ("${(doneApp.window.document.querySelector('.queue-meta')?.textContent || '').trim().slice(0, 60)}")`);
    const phonelessItem = [...doneApp.window.document.querySelectorAll('.q-item')].find((el) => /No Number Lead/.test(el.textContent));
    check(!!phonelessItem, 'the phoneless lead is queued (it is just ranked last)');
    phonelessItem.dispatchEvent(new doneApp.window.MouseEvent('click', { bubbles: true }));
    await sleep(600);
    check(/No Number Lead/.test(bannerName()), `and it can be selected ("${bannerName()}")`);
    check(!!doneApp.window.document.querySelector('.banner-phone-chip.missing'),
      'the banner offers the missing number as a field to fill in');
    doneApp.drain();
    key(doneApp.window, 'c');
    await sleep(1500);
    const callsPlaced = doneApp.drain().filter((c) => /^POST \/api\/prospects\/\d+\/call$/.test(`${c.method} ${c.path}`));
    check(callsPlaced.length === 0, `no call is logged for a lead with no number (${callsPlaced.length})`);
    check(/Skip Target/.test(bannerName()), `C skips to the next diallable lead ("${bannerName()}")`);
    check(/no phone number/i.test(doneApp.window.document.body.textContent), 'and says why it skipped');

    // (c) Work the diallable lead off the tab. The one that is left cannot be dialled, so this
    //     is *not* completion — the queue still holds a lead, and the UI says exactly that.
    doneApp.drain();
    key(doneApp.window, 'c'); await sleep(1800);
    check(count(doneApp.drain(), DIAL) === 1, 'the diallable lead is dialled');
    key(doneApp.window, 'h'); await sleep(900);
    key(doneApp.window, '6'); // conversation: moves the lead to "contacted", off the "new" tab
    await sleep(2400);
    check(!doneApp.window.document.querySelector('.queue-done'),
      'a queue whose only remainder cannot be dialled is not silently declared complete');
    check(/no number/i.test(doneApp.window.document.body.textContent), 'the undiallable lead is still on screen, marked');

    // (d) Move it out of the tab and the tab really is empty — now, and only now, the trophy.
    await fetch(`${BASE}/api/prospects/${phoneless.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-pulse-token': token4 },
      body: JSON.stringify({ stage: 'lost' }),
    });
    // The window has no idea an out-of-band PATCH happened, so poke the queue: assigning the
    // same value to a controlled input fires no React change event, so it takes two steps.
    await applySearch('zzz-refresh');
    await applySearch('');
    await wait(() => doneApp.window.document.querySelector('.queue-done'), 20000, 'completion card');
    const doneCard = doneApp.window.document.querySelector('.queue-done');
    const txt = doneCard.textContent || '';
    check(/Queue completed/.test(txt), `the empty tab is celebrated ("${txt.slice(0, 60).replace(/\s+/g, ' ')}…")`);
    check(/dials today/.test(txt) && /conversations/.test(txt) && /meetings booked/.test(txt),
      'it summarises the session: dials, conversations and meetings');
    const dialsShown = Number((txt.match(/(\d+)\s*dials today/) || [])[1]);
    check(dialsShown >= 1, `the dial count is the real number for today (${dialsShown})`);
    const acts = [...doneCard.querySelectorAll('button')].map((b) => b.textContent.trim());
    check(acts.some((a) => /dashboard/i.test(a)), `it offers the dashboard (${acts.slice(0, 5).join(' | ')})`);
    check(acts.some((a) => /Import more leads/i.test(a)), 'it offers importing more leads');
    check(acts.some((a) => /Switch to all prospects/i.test(a)), 'it offers the wider queue');

    const dBtn = [...doneCard.querySelectorAll('button')].find((b) => /dashboard/i.test(b.textContent));
    dBtn.dispatchEvent(new doneApp.window.MouseEvent('click', { bubbles: true }));
    await sleep(1400);
    check(/dashboard/i.test(doneApp.window.location.hash) || !doneApp.window.document.querySelector('.queue-done'),
      `Review today's dashboard leaves the dialer (${doneApp.window.location.hash})`);
    check(doneApp.jsErrors.length === 0, `no jsdom errors on the completion screen (${doneApp.jsErrors.join(' | ').slice(0, 140)})`);
    doneApp.dom.window.close();

    // (e) A brand-new day: an empty queue with nothing dialled yet is not an achievement.
    {
      const freshApp = loadApp(JSDOM, VirtualConsole, '#dialer');
      const freshFetch = freshApp.window.fetch;
      freshApp.window.fetch = async (input, init) => {
        const res = await freshFetch(input, init);
        const url = typeof input === 'string' ? input : String(input?.url || '');
        if (/\/api\/stats/.test(url)) {
          const data = await res.json();
          return { ok: true, status: 200, json: async () => ({ ...data, today: { ...data.today, dials: 0, pickups: 0, conversations: 0, meetings: 0, talkSec: 0 } }) };
        }
        return res;
      };
      await wait(() => freshApp.window.document.querySelector('.empty-state, .queue-done, .q-item, .queue-list'), 15000, 'the dialer to settle');
      await sleep(1200);
      check(!freshApp.window.document.querySelector('.queue-done'),
        'a fresh morning with no dials yet is not shown as a completed queue');
      check(!/Queue completed/.test(freshApp.window.document.body.textContent), 'and nothing claims the queue is done');
      check(freshApp.jsErrors.length === 0, `no jsdom errors on the fresh-morning state (${freshApp.jsErrors.join(' | ').slice(0, 120)})`);
      freshApp.dom.window.close();
    }

    // --- Deep Edge Cases in Real Compiled Bundle (Unload Beacon + 16:30 Window) ---
    {
      await put('/api/settings', { dry_run: '1', telephony_mode: 'webrtc' });
      const winProspect = await post('/api/prospects', { name: 'Window Probe', phone: '20776655' });
      const morningProspect = await post('/api/prospects', { name: 'Morning Probe', phone: '20887766' });
      const edgeApp = loadApp(JSDOM, VirtualConsole, '#dialer', { webAudio: fakeWebAudio() });
      const ewin = edgeApp.window;
      const edoc = ewin.document;
      let simClock = new Date('2026-10-20T14:29:45Z'); // 16:29:45 Europe/Copenhagen (CEST)
      ewin.__pulseNow = () => simClock;

      const sentBeacons = [];
      ewin.navigator.sendBeacon = (url, body) => {
        sentBeacons.push({ url, body });
        fetch(new URL(url, BASE).href, {
          method: 'POST',
          headers: { Origin: BASE, 'Content-Type': 'text/plain;charset=UTF-8' },
          body: String(body),
        }).catch(() => {});
        return true;
      };

      await wait(() => edoc.querySelector('.q-item'), 15000, 'edge dialer queue');
      await ensureListener(edgeApp);
      await sleep(1150); // ensure window monitor synced to 16:29:45 regardless of host wall clock

      const probeItem = [...edoc.querySelectorAll('.q-item')].find((el) => /Window Probe/.test(el.textContent));
      if (probeItem) probeItem.dispatchEvent(new ewin.MouseEvent('click', { bubbles: true }));
      await sleep(350);

      // Start outbound WebRTC call at 16:29:45 Copenhagen
      key(ewin, 'c');
      await wait(() => /WebRTC Active/.test(edoc.body.textContent), 9000, 'edge call live');

      // Advance Copenhagen clock across 16:30:00 while call is active
      simClock = new Date('2026-10-20T14:30:02Z'); // 16:30:02 Europe/Copenhagen
      await wait(
        () => /Calling window closed for today \(16:30\)\. Wrap up active conversation\./.test(edoc.body.textContent),
        5000,
        '16:30 wrap-up notice in DOM',
      );
      check(/WebRTC Active/.test(edoc.body.textContent), 'active conversation continues uninterrupted across 16:30:00 Copenhagen');
      check(/Calling window closed for today \(16:30\)\. Wrap up active conversation\./.test(edoc.body.textContent),
        '16:30:00 transition surfaces non-intrusive wrap-up notice');

      // Verify beforeunload confirmation string during active call
      const bu = new ewin.Event('beforeunload', { cancelable: true });
      Object.defineProperty(bu, 'returnValue', { value: undefined, writable: true, configurable: true });
      ewin.dispatchEvent(bu);
      check(bu.defaultPrevented && bu.returnValue === 'Call in progress. Are you sure?',
        'beforeunload prompts agent when reloading mid-call');

      // Classify active call, then verify pressing C after 16:30 places 0 new calls until 08:30 next business day
      key(ewin, '6');
      await sleep(1100);
      edgeApp.drain();
      key(ewin, 'c');
      await sleep(500);
      check(count(edgeApp.drain(), /POST \/api\/prospects\/\d+\/call/) === 0,
        'pressing C after 16:30 wrap-up places 0 outbound calls');

      // Next business day 08:30:05 Copenhagen -> unlocks dialing automatically, then pagehide abandons cleanly
      simClock = new Date('2026-10-21T06:30:05Z');
      await sleep(1250);
      const morningItem = [...edoc.querySelectorAll('.q-item')].find((el) => /Morning Probe/.test(el.textContent));
      if (morningItem) morningItem.dispatchEvent(new ewin.MouseEvent('click', { bubbles: true }));
      await sleep(300);
      key(ewin, 'c');
      await wait(() => /WebRTC Active/.test(edoc.body.textContent), 9000, 'next-morning call live');
      await sleep(1100);
      ewin.dispatchEvent(new ewin.Event('pagehide'));
      await sleep(450);
      const abandonBeacon = sentBeacons.find((b) => /\/api\/calls\/\d+\/abandon$/.test(b.url));
      check(!!abandonBeacon, 'pagehide during active call dispatches sendBeacon to /api/calls/:id/abandon');
      const abandonedId = abandonBeacon ? Number(abandonBeacon.url.match(/\/api\/calls\/(\d+)\/abandon/)[1]) : 0;
      const historyJson = await (await fetch(`${BASE}/api/calls?limit=20`)).json();
      const abandonedCallRow = (historyJson.calls || []).find((c) => Number(c.id) === abandonedId);
      check(abandonedCallRow?.status === 'abandoned' && abandonedCallRow?.outcome === 'dropped',
        `pagehide beacon transitions live DB row to abandoned/dropped (${abandonedCallRow?.status}/${abandonedCallRow?.outcome})`);
      edgeApp.dom.window.close();
    }

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
