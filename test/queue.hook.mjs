import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const assert = require('assert');
const { ROOT, section, summarize, test, sleep } = require('./support.js');

/**
 * Hook-level tests for useServerQueue.
 *
 * The Dialer DOM suite covers the component; this file covers the state machine
 * underneath it. Mounting the hook alone means a failure here can only be the
 * hook's own doing — no store, no Dialer, no IntersectionObserver in the way.
 * Both original tests here were red probes first: a refresh() that raced the
 * initial load wedged `loading` forever (skeleton never cleared even though the
 * rows had arrived), and a refresh() of a window deeper than the server's
 * 500-row page cap silently dropped everything past the cap.
 */
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;

const define = (n, v) => Object.defineProperty(globalThis, n, { value: v, configurable: true, writable: true });
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
define('getComputedStyle', window.getComputedStyle.bind(window));
define('requestAnimationFrame', window.requestAnimationFrame.bind(window));
define('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
define('IS_REACT_ACT_ENVIRONMENT', true);

const React = require('react');
const { createRoot } = require('react-dom/client');
const act = React.act;
assert.strictEqual(typeof act, 'function', 'React.act is required (React 19 exports it from "react")');

const row = (id, stage = 'new') => ({
  id, name: `Lead ${id}`, phone: `+9198100${id}`, email: '', company: '', title: '',
  location: '', website: '', extra: {}, stage, dnc: false, call_count: 0,
  last_outcome: null, follow_up_at: null,
});

/**
 * In-memory GET /api/queue with keyset pagination on id, mirroring the real
 * endpoint closely enough to exercise the hook's paging logic. `slowFirst()`
 * lets a test make one request take long enough to race.
 */
function fakeQueue(rows, { delay = 2 } = {}) {
  const log = [];
  let nextDelay = delay;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url, 'http://test.local');
    if (u.pathname !== '/api/queue') return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    const wait = nextDelay;
    nextDelay = delay;
    await sleep(wait);
    if (opts?.signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    log.push(u.search);

    const limit = Number(u.searchParams.get('limit') || 50);
    const tab = u.searchParams.get('tab') || 'all';
    const cursor = u.searchParams.get('cursor');
    const all = rows.filter((r) => (tab === 'all' ? true : tab === 'new' ? r.stage === 'new' : r.stage !== 'new'));
    const pool = cursor ? all.filter((r) => r.id > Number(cursor)) : all;
    const page = pool.slice(0, limit);
    return new Response(JSON.stringify({
      items: page,
      total: all.length,
      hasMore: pool.length > limit,
      limit,
      tab,
      q: '',
      counts: {
        new: rows.filter((r) => r.stage === 'new').length,
        follow: rows.filter((r) => r.stage !== 'new').length,
        all: rows.length,
      },
      nextCursor: pool.length > limit ? String(page[page.length - 1].id) : null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return {
    log,
    requests: () => log.length,
    slowFirst: (ms) => { nextDelay = ms; },
  };
}

let vite = null;
let useServerQueue = null;

async function mountHook(initialOpts) {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  let ref = null;
  let setOptsExternal = null;

  function Probe() {
    const [opts, setOpts] = React.useState(initialOpts);
    setOptsExternal = setOpts;
    ref = useServerQueue(opts);
    return React.createElement('span', { className: 'probe' }, `${ref.loading ? 'loading' : 'ready'}:${ref.items.length}`);
  }

  await act(async () => { root.render(React.createElement(Probe)); });
  return {
    state: () => ref,
    label: () => container.querySelector('.probe').textContent,
    setOpts: async (next) => { await act(async () => { setOptsExternal(next); }); },
    act,
    unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

/** One act window per pending timer, then a few more to let promises settle. */
async function settle(ms = 40) {
  await act(async () => { await sleep(ms); });
  for (let i = 0; i < 3; i++) await act(async () => { await sleep(25); });
}

async function main() {
  vite = await createServer({ root: ROOT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  useServerQueue = (await vite.ssrLoadModule('/src/useServerQueue.js')).default;

  section('useServerQueue: refresh() must never wedge or shrink the window');

  await test('refresh() during the initial load clears the loading state', async () => {
    const backend = fakeQueue(Array.from({ length: 30 }, (_, i) => row(i + 1)));
    backend.slowFirst(200); // page 1 is still in flight on a slow connection
    const h = await mountHook({ tab: 'all', limit: 50 });
    assert.strictEqual(h.state().loading, true, 'precondition: the initial load should be in flight');

    await act(async () => { await h.state().refresh(); }); // races page 1
    await settle();
    const label = h.label();
    await h.unmount();

    assert.match(label, /^ready:/, `hook wedged in the loading state forever: "${label}"`);
    assert.ok(Number(label.split(':')[1]) > 0, `loading cleared but no rows arrived: "${label}"`);
    return label;
  });

  await test('refresh() keeps a window deeper than the 500-row page cap', async () => {
    fakeQueue(Array.from({ length: 900 }, (_, i) => row(i + 1)), { delay: 1 });
    const h = await mountHook({ tab: 'all', limit: 500 });
    await settle();
    assert.strictEqual(h.state().items.length, 500, 'precondition: page 1 should hold 500 rows');

    await act(async () => { await h.state().loadMore(); });
    await settle();
    const loaded = h.state().items.length;
    assert.strictEqual(loaded, 900, `precondition: expected 900 loaded rows, got ${loaded}`);

    await act(async () => { await h.state().refresh(); });
    await settle();
    const after = h.state().items.length;
    const ids = new Set(h.state().items.map((p) => p.id));
    await h.unmount();

    assert.strictEqual(after, loaded, `refresh() truncated the window from ${loaded} rows to ${after}`);
    assert.strictEqual(ids.size, after, 'refresh() produced duplicate rows');
    return `${after} rows survive refresh, no duplicates`;
  });

  await test('refresh() of a normal window is still a single request', async () => {
    const backend = fakeQueue(Array.from({ length: 120 }, (_, i) => row(i + 1)));
    const h = await mountHook({ tab: 'all', limit: 50 });
    await settle();
    await act(async () => { await h.state().loadMore(); }); // window is now 100
    await settle();
    assert.strictEqual(h.state().items.length, 100);

    backend.log.length = 0;
    await act(async () => { await h.state().refresh(); });
    await settle();
    const label = h.label();
    await h.unmount();

    assert.strictEqual(backend.log.length, 1, `a 100-row refresh should be one request, made ${backend.log.length}: ${backend.log.join(' | ')}`);
    assert.match(backend.log[0], /limit=100/, `the refresh should ask for the loaded size: ${backend.log[0]}`);
    assert.strictEqual(label, 'ready:100');
    return `${backend.log[0]} -> ${label}`;
  });

  section('useServerQueue: superseded requests must not corrupt state');

  await test('a tab change while page 1 is loading leaves the hook usable', async () => {
    const backend = fakeQueue([
      ...Array.from({ length: 20 }, (_, i) => row(i + 1, 'new')),
      ...Array.from({ length: 12 }, (_, i) => row(i + 100, 'contacted')),
    ]);
    backend.slowFirst(200);
    const h = await mountHook({ tab: 'new', limit: 50 });
    assert.strictEqual(h.state().loading, true);

    await h.setOpts({ tab: 'follow', limit: 50 }); // supersedes the slow request
    await settle(220);
    const s = h.state();
    const label = h.label();
    await h.unmount();

    assert.match(label, /^ready:/, `hook wedged after a tab change: "${label}"`);
    assert.strictEqual(s.items.length, 12, `expected the 12 follow-up rows, got ${s.items.length}`);
    assert.ok(s.items.every((p) => p.stage === 'contacted'), 'the superseded "new" page leaked into the follow tab');
    return label;
  });

  await test('two concurrent loadMore() calls append one page, not two', async () => {
    const backend = fakeQueue(Array.from({ length: 150 }, (_, i) => row(i + 1)), { delay: 20 });
    const h = await mountHook({ tab: 'all', limit: 50 });
    await settle();
    assert.strictEqual(h.state().items.length, 50);

    backend.log.length = 0;
    const [a, b] = await act(async () => Promise.all([h.state().loadMore(), h.state().loadMore()]));
    await settle();
    const items = h.state().items;
    const ids = new Set(items.map((p) => p.id));
    await h.unmount();

    assert.strictEqual(backend.log.length, 1, `expected one request, saw ${backend.log.length}: ${backend.log.join(' | ')}`);
    assert.deepStrictEqual([a, b], [true, false], 'the second call should report that it added nothing');
    assert.strictEqual(items.length, 100, `expected 100 rows, got ${items.length}`);
    assert.strictEqual(ids.size, items.length, 'concurrent loadMore duplicated rows');
    return 'one request, 100 rows, second call short-circuited';
  });

  await vite.close();
  process.exit(summarize('Queue hook tests') ? 1 : 0);
}

main().catch(async (e) => {
  console.error('\nHarness failure:', e);
  try { await vite.close(); } catch { /* ignore */ }
  process.exit(1);
});
