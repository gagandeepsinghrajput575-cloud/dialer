import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const assert = require('assert');
const { ROOT, section, summarize, test, sleep } = require('./support.js');

// --------------------------------------------------------------- jsdom setup
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/#dialer',
  pretendToBeVisual: true,
});
const { window } = dom;

class MockIntersectionObserver {
  static instances = [];
  constructor(cb, opts) {
    this.cb = cb;
    this.opts = opts;
    this.elements = new Set();
    MockIntersectionObserver.instances.push(this);
  }
  observe(el) { this.elements.add(el); }
  unobserve(el) { this.elements.delete(el); }
  disconnect() { this.elements.clear(); }
  takeRecords() { return []; }
  /** Pretend the sentinel scrolled into view. */
  trigger(isIntersecting = true) {
    this.cb([{ isIntersecting, target: [...this.elements][0] || null }], this);
  }
  static reset() { MockIntersectionObserver.instances = []; }
  static last() { return MockIntersectionObserver.instances[MockIntersectionObserver.instances.length - 1]; }
}

window.matchMedia = window.matchMedia || ((query) => ({
  matches: false, media: query, onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
}));
window.IntersectionObserver = MockIntersectionObserver;
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.Element.prototype.scrollIntoView = function scrollIntoView() {};
window.HTMLElement.prototype.scrollTo = function scrollTo() {};

const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
define('window', window);
define('document', window.document);
define('navigator', window.navigator);
define('location', window.location);
define('history', window.history);
define('HTMLElement', window.HTMLElement);
define('HTMLInputElement', window.HTMLInputElement);
define('Element', window.Element);
define('Node', window.Node);
define('Event', window.Event);
define('CustomEvent', window.CustomEvent);
define('MouseEvent', window.MouseEvent);
define('KeyboardEvent', window.KeyboardEvent);
define('getComputedStyle', window.getComputedStyle.bind(window));
define('requestAnimationFrame', window.requestAnimationFrame.bind(window));
define('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
define('IntersectionObserver', MockIntersectionObserver);
define('ResizeObserver', window.ResizeObserver);
define('matchMedia', window.matchMedia);
define('IS_REACT_ACT_ENVIRONMENT', true);

// ------------------------------------------------------------- fake backend
const PICKUP = ['gatekeeper', 'hung_up', 'conversation', 'meeting_booked'];
const FOLLOW = ['contacted', 'interested', 'followup'];
const hasPhone = (p) => (p.phone && String(p.phone).trim() ? 1 : 0);

/**
 * In-memory stand-in for server/index.js. The queue semantics (DNC filter, tab
 * filter, search, has-phone-first ordering, keyset cursor) deliberately mirror
 * the real endpoint so the browser-side code is exercised against a faithful
 * contract without needing a server or a database.
 */
function createBackend(rows) {
  const prospects = rows.map((r) => ({
    stage: 'new', dnc: false, extra: {}, call_count: 0, last_outcome: null,
    last_called_at: null, notes: [], calls: [], ...r,
  }));
  const log = [];
  const aborted = [];
  let nextCallId = 1;
  let failNextQueue = false;

  const strip = (p) => {
    const { notes, calls, ...rest } = p;
    return { ...rest, dnc: !!rest.dnc };
  };
  const matches = (p, q) =>
    !q || `${p.name} ${p.company} ${p.phone} ${p.email} ${p.title}`.toLowerCase().includes(q.toLowerCase());

  const poolFor = (tab, q) =>
    prospects
      .filter((p) => !p.dnc && matches(p, q) && (tab === 'all' || (tab === 'new' ? p.stage === 'new' : FOLLOW.includes(p.stage))))
      .sort((a, b) => hasPhone(b) - hasPhone(a) || a.id - b.id);

  function handleQueue(u) {
    if (failNextQueue) {
      failNextQueue = false;
      return { status: 500, body: { error: 'Boom (fake)' } };
    }
    const tab = u.searchParams.get('tab') || 'all';
    if (!['new', 'follow', 'all'].includes(tab)) return { status: 400, body: { error: `Unknown tab "${tab}"` } };
    const q = (u.searchParams.get('q') || '').trim();
    const rawLimit = u.searchParams.get('limit');
    const limit = rawLimit ? Math.min(500, Math.max(1, parseInt(rawLimit, 10) || 50)) : 50;
    const cursor = u.searchParams.get('cursor');

    const counted = prospects.filter((p) => !p.dnc && matches(p, q));
    const counts = { new: 0, follow: 0, all: counted.length };
    for (const p of counted) {
      if (p.stage === 'new') counts.new += 1;
      else if (FOLLOW.includes(p.stage)) counts.follow += 1;
    }
    const pool = poolFor(tab, q);
    const total = tab === 'new' ? counts.new : tab === 'follow' ? counts.follow : counts.all;

    let start = 0;
    if (cursor) {
      const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      const exact = pool.findIndex((p) => hasPhone(p) === c.p && p.id === c.i);
      if (exact === -1) {
        const after = pool.findIndex((p) => hasPhone(p) < c.p || (hasPhone(p) === c.p && p.id > c.i));
        start = after === -1 ? pool.length : after;
      } else {
        start = exact + 1;
      }
    }
    const page = pool.slice(start, start + limit);
    const hasMore = start + limit < pool.length;
    const last = page[page.length - 1];
    return {
      status: 200,
      body: {
        items: page.map(strip),
        total,
        counts,
        hasMore,
        limit,
        tab,
        q,
        nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ p: hasPhone(last), i: last.id })).toString('base64url') : null,
      },
    };
  }

  const backend = {
    prospects,
    log,
    aborted,
    get requests() { return log.map((l) => l.split(' ')[1]); },
    paths() { return log.map((l) => l.split(' ')[1].split('?')[0]); },
    queueRequests() { return log.filter((l) => l.includes('/api/queue')); },
    lastQueueRequest() { return [...log].reverse().find((l) => l.includes('/api/queue')) || null; },
    failNextQueue() { failNextQueue = true; },
    resetLog() { log.length = 0; aborted.length = 0; },
  };

  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const u = new URL(url, 'http://test.local');
    const entry = `${method} ${u.pathname}${u.search}`;
    if (opts.signal?.aborted) { aborted.push(entry); throw Object.assign(new Error('Aborted'), { name: 'AbortError' }); }
    await sleep(2); // a little latency so races are real
    if (opts.signal?.aborted) { aborted.push(entry); throw Object.assign(new Error('Aborted'), { name: 'AbortError' }); }
    log.push(entry);

    const path = u.pathname;
    let status = 200;
    let body = { ok: true };

    if (method === 'GET' && path === '/api/queue') {
      const r = handleQueue(u);
      status = r.status; body = r.body;
    } else if (method === 'GET' && path === '/api/prospects') {
      body = prospects.map(strip);
    } else if (method === 'GET' && path.match(/^\/api\/prospects\/\d+$/)) {
      const id = Number(path.split('/').pop());
      const p = prospects.find((x) => x.id === id);
      if (!p) { status = 404; body = { error: 'Not found' }; } else body = { ...strip(p), notes: p.notes, calls: p.calls };
    } else if (method === 'GET' && path === '/api/stats') {
      body = {
        today: { dials: prospects.reduce((a, p) => a + (p.call_count || 0), 0), pickups: 0, conversations: 0, meetings: 0, voicemails: 0, talkSec: 0, pickupRate: 0, conversationRate: 0, meetingRate: 0, avgTalkSec: 0 },
        week: Array.from({ length: 7 }, (_, i) => ({ date: new Date(Date.now() - i * 86400000).toISOString(), dials: 0, pickups: 0, conversations: 0, meetings: 0, voicemails: 0, talkSec: 0, pickupRate: 0, conversationRate: 0, meetingRate: 0, avgTalkSec: 0 })),
        goal: 80, cap: 150,
        stageCounts: { new: 0, contacted: 0, interested: 0, followup: 0, meeting: 0, won: 0, lost: 0 },
        total: prospects.length, dncCount: prospects.filter((p) => p.dnc).length, recent: [],
      };
    } else if (method === 'GET' && path === '/api/settings') {
      body = { sonetel_username: '', my_number: '', caller_id: 'automatic', default_country_code: '91', dry_run: '1', daily_goal: '80', daily_cap: '150', has_password: false, env_credentials: false };
    } else if (method === 'POST' && path.match(/^\/api\/prospects\/\d+\/call$/)) {
      const id = Number(path.split('/')[3]);
      const p = prospects.find((x) => x.id === id);
      if (!p) { status = 404; body = { error: 'Prospect not found' }; }
      else {
        const callId = nextCallId++;
        p.call_count = (p.call_count || 0) + 1;
        p.calls.unshift({ id: callId, prospect_id: id, outcome: null, duration_sec: 0, status: 'dry_run', dry_run: 1, started_at: '2026-01-01 10:00:00' });
        body = { callId, dryRun: true, sessionId: null };
      }
    } else if (method === 'PATCH' && path.match(/^\/api\/calls\/\d+$/)) {
      const callId = Number(path.split('/').pop());
      const payload = JSON.parse(opts.body || '{}');
      const p = prospects.flatMap((x) => x.calls).find((c) => c.id === callId);
      const owner = prospects.find((x) => x.calls.some((c) => c.id === callId));
      if (!p || !owner) { status = 404; body = { error: 'Call not found' }; }
      else {
        p.outcome = payload.outcome ?? null;
        p.duration_sec = payload.duration_sec ?? 0;
        if (payload.outcome) {
          owner.last_outcome = payload.outcome;
          // same stage machine as the server
          if (PICKUP.includes(payload.outcome) && owner.stage === 'new') owner.stage = 'contacted';
          if (payload.outcome === 'meeting_booked') owner.stage = 'meeting';
          if (payload.outcome === 'wrong_number') owner.stage = 'lost';
          if (payload.outcome === 'dnc') { owner.dnc = 1; owner.stage = 'lost'; }
        }
        body = { ok: true, prospect: strip(owner) };
      }
    } else if (method === 'POST' && path.match(/^\/api\/prospects\/\d+\/notes$/)) {
      const id = Number(path.split('/')[3]);
      const p = prospects.find((x) => x.id === id);
      const payload = JSON.parse(opts.body || '{}');
      const note = { id: (p?.notes.length || 0) + 1, prospect_id: id, body: payload.body, created_at: '2026-01-01 10:00:00' };
      if (p) p.notes.unshift(note);
      body = note;
    } else if (method === 'PATCH' && path.match(/^\/api\/prospects\/\d+$/)) {
      const id = Number(path.split('/').pop());
      const p = prospects.find((x) => x.id === id);
      const payload = JSON.parse(opts.body || '{}');
      if (!p) { status = 404; body = { error: 'Not found' }; }
      else { Object.assign(p, payload); body = strip(p); }
    } else if (method === 'DELETE' && path.match(/^\/api\/prospects\/\d+$/)) {
      const id = Number(path.split('/').pop());
      const at = prospects.findIndex((x) => x.id === id);
      if (at === -1) { status = 404; body = { error: 'Not found' }; }
      else { prospects.splice(at, 1); body = { ok: true }; }
    } else if (method === 'POST' && path.match(/^\/api\/calls\/\d+\/discard$/)) {
      body = { ok: true };
    }

    return {
      ok: status < 400,
      status,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };

  return backend;
}

function makeRows(n, { startId = 1, stage = 'new' } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: startId + i,
    name: `Prospect ${String(startId + i).padStart(3, '0')}`,
    company: i % 3 === 0 ? 'Acme Ltd' : `Company ${i}`,
    phone: `+9198100${String(10000 + i)}`,
    email: `p${startId + i}@example.com`,
    title: 'Buyer',
    stage,
  }));
}

// ------------------------------------------------------------- mount helpers
const React = require('react');
const { createRoot } = require('react-dom/client');
const act = React.act;
assert.strictEqual(typeof act, 'function', 'React.act is required (React 19 exports it from "react")');

// React tracks input values; assigning .value directly is invisible to onChange,
// so go through the prototype setter to simulate real typing.
const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

let vite = null;
let mods = null;

async function loadModules() {
  vite = await createServer({ root: ROOT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  const [store, dialer, toasts] = await Promise.all([
    vite.ssrLoadModule('/src/store.jsx'),
    vite.ssrLoadModule('/src/pages/Dialer.jsx'),
    vite.ssrLoadModule('/src/components/Toasts.jsx'),
  ]);
  mods = { store, dialer, toasts };
  return mods;
}

/**
 * Mount <StoreProvider><Probe/><Dialer/></StoreProvider> and hand back the
 * document plus a probe into the store, so tests can drive `activeId` the way
 * another page (Prospects → Call) would.
 */
async function mountDialer(rows) {
  const backend = createBackend(rows);
  MockIntersectionObserver.reset();
  // A fresh container per mount: reusing one across createRoot calls makes
  // React complain, and it keeps failures in one test from leaking into the next.
  const container = window.document.createElement('div');
  container.className = 'test-root';
  window.document.body.appendChild(container);
  const root = createRoot(container);

  let storeApi = null;
  function Probe() {
    storeApi = mods.store.useStore();
    return null;
  }

  await act(async () => {
    root.render(
      React.createElement(mods.store.StoreProvider, null,
        React.createElement(Probe),
        React.createElement(mods.dialer.default),
        React.createElement(mods.toasts.default))
    );
  });
  await act(async () => { await sleep(30); });

  const api = {
    backend,
    root,
    container,
    store: () => storeApi,
    q: (sel) => container.querySelector(sel),
    qa: (sel) => [...container.querySelectorAll(sel)],
    rows: () => [...container.querySelectorAll('.q-item')],
    rowNames: () => [...container.querySelectorAll('.q-item .q-txt b')].map((b) => b.textContent),
    bannerName: () => container.querySelector('.banner-name')?.textContent || null,
    text: () => container.textContent,
    click: async (el) => {
      assert(el, 'nothing to click');
      await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); });
      await act(async () => { await sleep(20); });
      await act(async () => { await sleep(20); });
    },
    type: async (el, value) => {
      assert(el, 'nothing to type into');
      await act(async () => {
        nativeValueSetter.call(el, value);
        el.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    },
    /**
     * Let timers fire and chained async work land. React's act() queues updates
     * raised by external timers and flushes them when the awaited scope ends, so
     * one window is not enough for timer -> render -> fetch -> setState chains;
     * the extra scopes give each link somewhere to commit.
     */
    settle: async (ms = 60, extra = 3) => {
      await act(async () => { await sleep(ms); });
      for (let i = 0; i < extra; i++) await act(async () => { await sleep(25); });
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
  return api;
}

async function main() {
  console.log('Pulse Dialer — DOM tests (real Dialer mounted in jsdom)');
  await loadModules();

  try {
    section('Dialer queue: server-backed paging in a real DOM');

    await test('the dialer pages via /api/queue and never downloads the full list', async () => {
      const d = await mountDialer(makeRows(120));
      const paths = d.backend.paths();
      assert(paths.includes('/api/queue'), `no queue request: ${paths.join(', ')}`);
      assert(!paths.includes('/api/prospects'), `dialer pulled the whole list: ${paths.join(', ')}`);
      assert(d.backend.lastQueueRequest().includes('tab=new'), 'should start on the To call tab');
      assert(d.backend.lastQueueRequest().includes('limit=50'), 'should request a bounded page');
      const rendered = d.rows().length;
      assert.strictEqual(rendered, 50, 'only one page of rows should be in the DOM');
      await d.unmount();
      return `${rendered} rows rendered from 120 prospects`;
    });

    await test('the queue header shows the server total and per-tab counts', async () => {
      const d = await mountDialer(makeRows(120));
      assert(d.text().includes('120 in queue'), `header says: ${d.q('.queue-meta')?.textContent}`);
      const badges = d.qa('.seg-count').map((e) => e.textContent);
      assert(badges.includes('120'), `tab badges: ${badges.join(',')}`);
      await d.unmount();
      return `badges ${badges.join(' / ')}`;
    });

    await test('"Load more" appends the next page using the cursor', async () => {
      const d = await mountDialer(makeRows(120));
      assert.strictEqual(d.rows().length, 50);
      const btn = d.q('.load-more');
      assert(btn, 'load-more button missing');
      assert(btn.textContent.includes('50/120'), `progress chip says ${btn.textContent}`);
      await d.click(btn);
      assert.strictEqual(d.rows().length, 100, 'second page was not appended');
      const reqs = d.backend.queueRequests();
      assert(reqs.some((r) => r.includes('cursor=')), 'page 2 must be fetched with a cursor');
      const names = d.rowNames();
      assert.strictEqual(new Set(names).size, names.length, 'duplicate rows after appending');
      await d.unmount();
      return `${names.length} rows, no duplicates`;
    });

    await test('scrolling the sentinel auto-loads the next page', async () => {
      const d = await mountDialer(makeRows(120));
      const io = MockIntersectionObserver.last();
      assert(io, 'QueueList never registered an IntersectionObserver');
      assert.strictEqual(d.rows().length, 50);
      await act(async () => { io.trigger(true); });
      await d.settle(40);
      assert.strictEqual(d.rows().length, 100, 'sentinel did not trigger a page load');
      await d.unmount();
    });

    await test('typing in the search box debounces into one server request', async () => {
      const d = await mountDialer(makeRows(120));
      d.backend.resetLog();
      const input = d.q('.queue .search input');
      assert(input, 'search input missing');
      for (const partial of ['a', 'ac', 'acm', 'acme']) await d.type(input, partial);
      assert.strictEqual(d.backend.queueRequests().length, 0, 'search fired before the debounce elapsed');
      await d.settle(340);
      const reqs = d.backend.queueRequests();
      assert.strictEqual(reqs.length, 1, `expected exactly 1 debounced request, got ${reqs.length}: ${reqs.join(' | ')}`);
      assert(reqs[0].includes('q=acme'), `request was ${reqs[0]}`);
      const hits = d.rows().length;
      assert(hits > 0, 'search returned nothing');
      assert(hits < 120, 'search did not narrow the result set');
      assert(d.rows().every((r) => /Acme/i.test(r.textContent)), 'results are not filtered');
      await d.unmount();
      return `${hits} filtered rows from exactly one request`;
    });

    await test('switching tabs starts over at page 1 with no cursor', async () => {
      const d = await mountDialer([...makeRows(60), ...makeRows(8, { startId: 200, stage: 'followup' })]);
      await d.click(d.q('.load-more'));
      assert.strictEqual(d.rows().length, 60);
      d.backend.resetLog();
      const tabs = d.qa('.seg button');
      await d.click(tabs.find((b) => b.textContent.includes('Follow-ups')));
      const reqs = d.backend.queueRequests();
      assert.strictEqual(reqs.length, 1, `expected one request, got ${reqs.join(' | ')}`);
      assert(reqs[0].includes('tab=follow'), reqs[0]);
      assert(!reqs[0].includes('cursor='), 'a tab switch must not reuse a cursor');
      assert.strictEqual(d.rows().length, 8, 'tab switch should replace, not append');
      await d.unmount();
    });

    await test('clicking a row selects that prospect on the stage', async () => {
      const d = await mountDialer(makeRows(20));
      assert.strictEqual(d.bannerName(), 'Prospect 001', `stage opened on ${d.bannerName()}`);
      await d.click(d.rows()[4]);
      assert.strictEqual(d.bannerName(), 'Prospect 005');
      assert.strictEqual(d.qa('.q-item[aria-current="true"]').length, 1);
      assert(d.rows()[4].getAttribute('aria-current') === 'true', 'aria-current did not move');
      await d.unmount();
    });

    await test('a prospect outside the loaded page is fetched and pinned', async () => {
      const rows = makeRows(120);
      const d = await mountDialer(rows);
      assert.strictEqual(d.rows().length, 50);
      d.backend.resetLog();
      await act(async () => { d.store().setActiveId(119); }); // last row: page 3 territory
      await d.settle(60);
      assert(d.backend.paths().includes('/api/prospects/119'), `pin fetch missing: ${d.backend.paths().join(', ')}`);
      assert.strictEqual(d.bannerName(), 'Prospect 119', 'stage should show the pinned prospect');
      assert.strictEqual(d.rows().length, 50, 'the loaded window must not change because of a pin');
      await d.unmount();
    });

    await test('a pin target that no longer exists falls back to the top', async () => {
      const rows = makeRows(120);
      const d = await mountDialer(rows);
      const at = d.backend.prospects.findIndex((p) => p.id === 118);
      assert.notStrictEqual(at, -1, 'fixture should contain prospect 118');
      d.backend.prospects.splice(at, 1); // simulate deleting it behind the dialer's back
      await act(async () => { d.store().setActiveId(118); });
      await d.settle(80);
      assert.strictEqual(d.store().activeId, null, 'a dead selection should be released');
      assert.strictEqual(d.bannerName(), 'Prospect 001', 'stage should fall back to the queue top');
      assert(d.text().includes('no longer available'), 'the user should be told why');
      await d.unmount();
    });

    await test('queue failures show an inline error with a working retry', async () => {
      const d = await mountDialer(makeRows(20));
      assert.strictEqual(d.rows().length, 20);
      d.backend.failNextQueue();
      await d.click(d.qa('.seg button').find((b) => b.textContent.includes('All')));
      await d.settle(40);
      assert(d.q('.queue-error'), 'no error banner after a failed request');
      assert(d.text().includes('Boom (fake)'));
      await d.click(d.q('.queue-error button'));
      await d.settle(60);
      assert(!d.q('.queue-error'), 'error banner should clear after a successful retry');
      assert.strictEqual(d.rows().length, 20, 'retry did not restore the rows');
      await d.unmount();
    });

    section('Dialer queue: call flow across page boundaries');

    await test('starting a call locks the rest of the queue', async () => {
      const d = await mountDialer(makeRows(12));
      await d.click(d.q('.call-btn'));
      assert(d.backend.log.some((l) => l.includes('/call')), 'no call request');
      const disabled = d.rows().filter((r) => r.disabled);
      assert.strictEqual(disabled.length, 11, `${disabled.length} rows should be locked during a call`);
      assert(d.q('.callbar.active'), 'call bar should switch to the active state');
      await d.unmount();
    });

    await test('auto-next walks onto the next page when the window runs out', async () => {
      const e = await mountDialer(makeRows(60));
      assert.strictEqual(e.rows().length, 50);
      await e.click(e.rows()[49]);                       // last row of page 1
      assert.strictEqual(e.bannerName(), 'Prospect 050');
      await e.click(e.q('.call-btn'));
      const before = e.backend.queueRequests().length;
      await e.click(e.qa('.outcomes .outcome')[0]);      // "No answer": stage stays 'new'
      await e.settle(1100);                              // auto-next fires after ~750ms
      assert(e.backend.queueRequests().length > before, 'the next page was never fetched');
      assert.strictEqual(e.bannerName(), 'Prospect 051', `auto-next landed on ${e.bannerName()}`);
      assert(e.rows().length > 50, 'the window should have grown to include the next prospect');
      await e.unmount();
    });

    await test('auto-next resumes in place when the logged prospect leaves the tab', async () => {
      const d = await mountDialer(makeRows(60));
      await d.click(d.rows()[49]);
      assert.strictEqual(d.bannerName(), 'Prospect 050');
      await d.click(d.q('.call-btn'));
      await d.click(d.qa('.outcomes .outcome')[5]);      // "Conversation": new -> contacted
      await d.settle(1100);
      const owner = d.backend.prospects.find((p) => p.id === 50);
      assert.strictEqual(owner.stage, 'contacted', 'the fake backend did not move the stage');
      assert(!d.rowNames().includes('Prospect 050'), 'a contacted prospect must leave the To call tab');
      assert.strictEqual(d.bannerName(), 'Prospect 051', `should resume in place, landed on ${d.bannerName()}`);
      await d.unmount();
    });

    await test('logging an outcome refreshes the whole loaded window, not just page 1', async () => {
      const d = await mountDialer(makeRows(120));
      await d.click(d.q('.load-more'));
      assert.strictEqual(d.rows().length, 100);
      d.backend.resetLog();
      await d.click(d.q('.call-btn'));
      await d.click(d.qa('.outcomes .outcome')[1]);      // voicemail: no stage change
      await d.settle(400);
      const last = d.backend.lastQueueRequest();
      assert(last, 'no refresh request after logging');
      assert(last.includes('limit=100'), `refresh should keep the 100-row window, got ${last}`);
      assert.strictEqual(d.rows().length, 100, 'the window collapsed after logging');
      assert(d.rows().some((r) => r.classList.contains('done')), 'the logged prospect should be marked done');
      await d.unmount();
    });

    await test('an edit saved elsewhere updates the loaded window', async () => {
      const d = await mountDialer(makeRows(20));
      assert.strictEqual(d.rowNames()[0], 'Prospect 001');
      await act(async () => { await d.store().updateProspect(1, { name: 'Renamed Elsewhere' }); });
      await d.settle(40);
      assert.strictEqual(d.rowNames()[0], 'Renamed Elsewhere', 'the queue row kept the pre-edit name');
      assert.strictEqual(d.rows().length, 20, 'an edit must not drop or duplicate rows');
      await d.unmount();
    });

    await test('a delete from another view removes the row from the window', async () => {
      const d = await mountDialer(makeRows(20));
      assert.strictEqual(d.rows().length, 20);
      await act(async () => { await d.store().deleteProspect(2); });
      await d.settle(40);
      assert.strictEqual(d.rows().length, 19, 'the deleted prospect is still listed');
      assert(!d.rowNames().includes('Prospect 002'), 'deleted row still rendered');
      assert.strictEqual(d.bannerName(), 'Prospect 001', 'the active prospect should be untouched');
      await d.unmount();
    });

    await test('unmounting stops the queue from firing more requests', async () => {
      const d = await mountDialer(makeRows(120));
      d.backend.resetLog();
      await act(async () => { d.store().setActiveId(119); });
      await d.unmount();
      const atUnmount = d.backend.log.length;
      await sleep(80);
      assert.strictEqual(d.backend.log.length, atUnmount, 'requests kept firing after unmount');
      assert.strictEqual(d.container.isConnected, false, 'the test root should be detached');
    });
  } finally {
    if (vite) await vite.close();
  }

  process.exit(summarize('DOM tests') ? 1 : 0);
}

main().catch((e) => {
  console.error('\nHarness failure:', e);
  process.exit(1);
});
