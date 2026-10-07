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

function loadApp(JSDOM, VirtualConsole, hash) {
  const assets = path.join(REPO, 'dist', 'assets');
  const html = fs.readFileSync(path.join(REPO, 'dist', 'index.html'), 'utf8')
    .replace(/<script type="module"[^>]*><\/script>/, '');
  const bundle = fs.readFileSync(path.join(assets, fs.readdirSync(assets).find((f) => f.endsWith('.js'))), 'utf8');

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
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  window.Element.prototype.scrollIntoView = function () {};
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
