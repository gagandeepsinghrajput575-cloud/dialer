import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const assert = require('assert');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { ROOT, section, summarize, test } = require('./support.js');

const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const count = (html, needle) => html.split(needle).length - 1;

// ---------------------------------------------------------------- CSS parsing
const cssPath = path.join(ROOT, 'src', 'styles.css');
// Comments are stripped before parsing: otherwise a comment glues itself onto
// the selector that follows it and both selector matching and value extraction
// start lying.
const css = fs.readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function mediaBlock(source, query) {
  const start = source.indexOf(query);
  assert.notStrictEqual(start, -1, `styles.css has no "${query}" block`);
  const open = source.indexOf('{', start);
  assert.notStrictEqual(open, -1, `malformed "${query}" block`);
  let depth = 0;
  for (let j = open; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') {
      depth--;
      if (depth === 0) return { body: source.slice(open + 1, j), start, end: j + 1 };
    }
  }
  throw new Error(`unbalanced braces in "${query}"`);
}

function rulesOf(block) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    out.push({ selectors: m[1].split(',').map((s) => s.trim()).filter(Boolean), body: m[2] });
  }
  return out;
}

function pxValues(rulesList, selectorFragment, prop) {
  const found = [];
  const re = new RegExp(`(?:^|[;{\\s])${prop.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+)`, 'i');
  for (const r of rulesList) {
    if (!r.selectors.some((s) => s.includes(selectorFragment))) continue;
    const m = r.body.match(re);
    if (m && /px/.test(m[1])) {
      const n = parseFloat(m[1]);
      if (Number.isFinite(n)) found.push(n);
    }
  }
  return found;
}

function assertMinPx(rulesList, selectorFragment, prop, min) {
  const vals = pxValues(rulesList, selectorFragment, prop);
  assert(vals.length, `no ${prop} in px found for "${selectorFragment}"`);
  const best = Math.max(...vals);
  assert(best >= min, `"${selectorFragment}" ${prop} is ${best}px, needs >= ${min}px`);
  return best;
}

/** Remove every balanced @media block, leaving only always-on declarations. */
function stripMedia(source) {
  let out = source;
  for (let i = out.indexOf('@media'); i !== -1; i = out.indexOf('@media')) {
    const open = out.indexOf('{', i);
    if (open === -1) break;
    let depth = 0;
    let end = -1;
    for (let j = open; j < out.length; j++) {
      if (out[j] === '{') depth++;
      else if (out[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    if (end === -1) break;
    out = out.slice(0, i) + out.slice(end);
  }
  return out;
}

const coarseBlock = mediaBlock(css, '@media (pointer: coarse)');
const coarseRules = rulesOf(coarseBlock.body);
const desktopCss = stripMedia(css);
const desktopRules = rulesOf(desktopCss);

// ------------------------------------------------------------------- fixtures
const item = (over = {}) => ({
  id: 1, name: 'Aarav Mehta', company: 'Northwind Logistics', phone: '+919810012345',
  email: 'aarav@northwind.in', title: 'Ops Head', stage: 'new', dnc: false, extra: {}, call_count: 0,
  ...over,
});
const ITEMS = [
  item(),
  item({ id: 2, name: 'Priya Sharma', company: '', phone: '+919811123456', stage: 'contacted' }),
  item({ id: 3, name: '', company: 'BrightLabs', phone: '', stage: 'interested' }),
];

async function main() {
  console.log('Pulse Dialer — UI tests (server-rendered components + CSS contract)');
  const vite = await createServer({ root: ROOT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });

  try {
    const q = await vite.ssrLoadModule('/src/queue.js');
    const QueueList = (await vite.ssrLoadModule('/src/components/QueueList.jsx')).default;
    const { QueueSkeleton } = await vite.ssrLoadModule('/src/components/QueueList.jsx');

    // ------------------------------------------------------- pure queue logic
    section('Queue helpers (pure logic)');

    await test('buildQueueQuery trims the search and drops empty params', () => {
      const qs = new URLSearchParams(q.buildQueueQuery({ tab: 'new', q: '   acme  ', limit: 25 }));
      assert.strictEqual(qs.get('tab'), 'new');
      assert.strictEqual(qs.get('q'), 'acme');
      assert.strictEqual(qs.get('limit'), '25');
      assert.strictEqual(qs.get('cursor'), null, 'no cursor param when there is no cursor');
      const bare = new URLSearchParams(q.buildQueueQuery({}));
      assert.strictEqual(bare.get('tab'), 'all');
      assert.strictEqual(bare.get('q'), null, 'blank search must not be sent');
      assert.strictEqual(bare.get('limit'), String(q.QUEUE_LIMIT));
    });

    await test('buildQueueQuery clamps the limit into the server range', () => {
      assert.strictEqual(new URLSearchParams(q.buildQueueQuery({ limit: 0 })).get('limit'), '1');
      assert.strictEqual(new URLSearchParams(q.buildQueueQuery({ limit: 99999 })).get('limit'), String(q.QUEUE_MAX_LIMIT));
      assert.strictEqual(new URLSearchParams(q.buildQueueQuery({ limit: 'abc' })).get('limit'), String(q.QUEUE_LIMIT));
      assert.strictEqual(new URLSearchParams(q.buildQueueQuery({ limit: 7.9 })).get('limit'), '7');
    });

    await test('pickNextId walks forward and skips prospects already dialed', () => {
      const list = ITEMS;
      assert.strictEqual(q.pickNextId(list, 1, new Set()).id, 2);
      assert.strictEqual(q.pickNextId(list, 1, new Set([2])).id, 3);
      assert.strictEqual(q.pickNextId(list, 1, new Set([2, 3])).id, null);
      assert.strictEqual(q.pickNextId(list, 3, new Set()).id, null);
      assert.strictEqual(q.pickNextId(list, 2, new Set([1])).id, 3);
    });

    await test('pickNextId flags hitEnd only when the window ran out', () => {
      assert.strictEqual(q.pickNextId(ITEMS, 1, new Set([2, 3])).hitEnd, true, 'ran off the end');
      assert.strictEqual(q.pickNextId(ITEMS, 1, new Set([2])).hitEnd, false, 'found id 3');
      assert.strictEqual(q.pickNextId(ITEMS, 999, new Set()).hitEnd, false, 'unknown id does not mean "end"');
      assert.deepStrictEqual(q.pickNextId([], 1, new Set()), { id: null, hitEnd: false });
    });

    await test('pickNextId falls back to the first fresh row for an id outside the window', () => {
      assert.strictEqual(q.pickNextId(ITEMS, 4242, new Set()).id, 1);
      assert.strictEqual(q.pickNextId(ITEMS, 4242, new Set([1])).id, 2);
      assert.strictEqual(q.pickNextId(ITEMS, null, new Set([1])).id, 2);
      assert.strictEqual(q.pickNextId(ITEMS, 4242, new Set([1, 2, 3])).id, null);
    });

    await test('pickNextId accepts a plain array as the done collection', () => {
      assert.strictEqual(q.pickNextId(ITEMS, 1, [2]).id, 3);
      assert.strictEqual(q.pickNextId(ITEMS, 1, undefined).id, 2);
    });

    await test('firstFreshId returns the first undialed row or null', () => {
      assert.strictEqual(q.firstFreshId(ITEMS, new Set([1, 2])), 3);
      assert.strictEqual(q.firstFreshId(ITEMS, new Set([1, 2, 3])), null);
      assert.strictEqual(q.firstFreshId([], new Set()), null);
      assert.strictEqual(q.firstFreshId(null, null), null);
    });

    await test('stepIndex wraps both ways and copes with an unknown index', () => {
      assert.strictEqual(q.stepIndex(5, 0, 1), 1);
      assert.strictEqual(q.stepIndex(5, 4, 1), 0, 'wraps forward');
      assert.strictEqual(q.stepIndex(5, 0, -1), 4, 'wraps backward');
      assert.strictEqual(q.stepIndex(5, 2, -1), 1);
      assert.strictEqual(q.stepIndex(5, -1, 1), 0, 'no active row: forward starts at the top');
      assert.strictEqual(q.stepIndex(5, -1, -1), 4, 'no active row: backward starts at the bottom');
      assert.strictEqual(q.stepIndex(5, 99, 1), 0, 'out-of-range index is treated as "none"');
      assert.strictEqual(q.stepIndex(0, 0, 1), -1);
      assert.strictEqual(q.stepIndex(1, 0, 1), 0, 'single row stays put');
    });

    await test('appendPage merges pages without duplicating ids', () => {
      const merged = q.appendPage([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 3 }]);
      assert.deepStrictEqual(merged.map((p) => p.id), [1, 2, 3]);
      const same = [{ id: 1 }];
      assert.strictEqual(q.appendPage(same, [{ id: 1 }]), same, 'a fully duplicate page must be a no-op');
      assert.deepStrictEqual(q.appendPage([], [{ id: 7 }]).map((p) => p.id), [7]);
      assert.deepStrictEqual(q.appendPage(null, null), []);
      assert.deepStrictEqual(q.appendPage([{ id: 1 }], undefined).map((p) => p.id), [1]);
      assert.deepStrictEqual(q.appendPage([{ id: 1 }], [null, { id: 2 }]).map((p) => p.id), [1, 2]);
    });

    await test('tab helpers agree with the server-side stage filters', () => {
      assert.strictEqual(q.tabForProspect({ stage: 'new' }), 'new');
      for (const s of ['contacted', 'interested', 'followup']) assert.strictEqual(q.tabForProspect({ stage: s }), 'follow');
      for (const s of ['meeting', 'won', 'lost']) assert.strictEqual(q.tabForProspect({ stage: s }), 'all');
      assert.strictEqual(q.tabForProspect(null), null);
      assert.deepStrictEqual(q.QUEUE_TABS.map((t) => t.id), ['new', 'follow', 'all']);
      assert.strictEqual(q.queueTab('follow').label, 'Follow-ups');
      assert.strictEqual(q.queueTab('nope'), null);
      assert(q.queueTab('new').test({ stage: 'new' }));
      assert(!q.queueTab('new').test({ stage: 'contacted' }));
      assert(q.queueTab('all').test({ stage: 'lost' }));
    });

    // ------------------------------------------------------ api client wiring
    section('API client wiring');

    const api = (await vite.ssrLoadModule('/src/api.js')).api;
    const realFetch = globalThis.fetch;
    let calls = [];

    await test('api.queue builds the right URL and forwards the abort signal', async () => {
      calls = [];
      globalThis.fetch = async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true, status: 200, json: async () => ({ items: [] }) };
      };
      await api.queue({ tab: 'new', q: '  acme  ', limit: 25, cursor: 'CUR' });
      assert.strictEqual(calls.length, 1);
      assert(calls[0].url.startsWith('/api/queue?'), `unexpected url ${calls[0].url}`);
      const params = new URLSearchParams(calls[0].url.split('?')[1]);
      assert.strictEqual(params.get('tab'), 'new');
      assert.strictEqual(params.get('q'), 'acme');
      assert.strictEqual(params.get('limit'), '25');
      assert.strictEqual(params.get('cursor'), 'CUR');
      assert.strictEqual(calls[0].opts.method, 'GET');
      assert.strictEqual(calls[0].opts.body, undefined);
      assert.strictEqual(calls[0].opts.signal, undefined);

      const ctrl = new AbortController();
      await api.queue({ signal: ctrl.signal });
      assert.strictEqual(calls[1].opts.signal, ctrl.signal, 'abort signal must reach fetch');
      assert.strictEqual(new URLSearchParams(calls[1].url.split('?')[1]).get('cursor'), null);
    });

    await test('api.queue surfaces the server error message and status', async () => {
      globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'Unknown tab "bogus"' }) });
      await assert.rejects(() => api.queue({ tab: 'bogus' }), (e) => {
        assert.strictEqual(e.status, 400);
        assert.match(e.message, /Unknown tab/);
        return true;
      });
    });

    await test('a non-JSON error body still produces a usable message', async () => {
      globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } });
      await assert.rejects(() => api.queue({}), /Request failed \(502\)/);
    });

    // --------------------------------------------------------- QueueList view
    section('QueueList component (server-rendered markup)');

    await test('renders one row per item, in order', () => {
      const html = render(QueueList, { items: ITEMS, total: 3 });
      assert.strictEqual(count(html, 'q-item'), ITEMS.length, html);
      const order = [...html.matchAll(/<b>([^<]*)<\/b>/g)].map((m) => m[1]);
      assert.deepStrictEqual(order, ['Aarav Mehta', 'Priya Sharma', '(no name)']);
    });

    await test('the active row is marked for assistive tech and gets the pill', () => {
      const html = render(QueueList, { items: ITEMS, activeId: 2, total: 3 });
      assert.strictEqual(count(html, 'aria-current="true"'), 1, 'exactly one row may be current');
      const row = html.split('<button').find((chunk) => chunk.includes('aria-current="true"'));
      assert(row, 'no row carries aria-current');
      assert(row.includes('q-item on'), 'active row needs the "on" class');
      assert(row.includes('q-pill'), 'active row renders the animated pill');
      assert(row.includes('Priya Sharma'), `pill landed on the wrong row: ${row.slice(0, 160)}`);
      assert.strictEqual(count(html, 'q-pill'), 1, 'only the active row gets a pill');
    });

    await test('dialed rows are dimmed and show a check instead of the stage dot', () => {
      const html = render(QueueList, { items: ITEMS, done: new Set([2]), total: 3 });
      assert(html.includes('q-item done'), 'done class applied');
      assert.strictEqual(count(html, 'q-check'), 1);
      assert.strictEqual(count(html, 'class="dot"'), 2, 'the other two rows keep their stage dot');
      // a plain array works too, since `done` crosses a component boundary
      const html2 = render(QueueList, { items: ITEMS, done: [1, 3], total: 3 });
      assert.strictEqual(count(html2, 'q-check'), 2);
    });

    await test('rows are locked while a call is live, except the active one', () => {
      const locked = render(QueueList, { items: ITEMS, activeId: 2, locked: true, total: 3 });
      assert.strictEqual(count(locked, 'disabled=""'), 2, 'both inactive rows must be disabled');
      const open = render(QueueList, { items: ITEMS, activeId: 2, locked: false, total: 3 });
      assert.strictEqual(count(open, 'disabled=""'), 0);
    });

    await test('the sub-line falls back from company to phone', () => {
      const withCompany = render(QueueList, { items: [item()], total: 1 });
      assert(withCompany.includes('Northwind Logistics'), 'company is the sub-line when present');
      const noCompany = render(QueueList, { items: [item({ company: '', phone: '+9199998888' })], total: 1 });
      assert(noCompany.includes('+9199998888'), 'phone is the sub-line when company is blank');
      assert(!noCompany.includes('Northwind'));
    });

    await test('offers "Load more" with a progress count only when there is more', () => {
      const more = render(QueueList, { items: ITEMS, total: 120, hasMore: true });
      assert(more.includes('Load more'), 'load-more button missing');
      assert(more.includes('load-more-count'), 'count chip missing');
      assert(more.includes('3/120'), `expected 3/120 progress, got ${more.match(/load-more-count[^<]*<[^>]*>[^<]*/)}`);
      const end = render(QueueList, { items: ITEMS, total: 3, hasMore: false });
      assert(!end.includes('Load more'), 'load-more must disappear on the last page');
      assert(end.includes('End of queue'), 'terminal state should say so');
    });

    await test('load-more switches to a busy state and disables itself', () => {
      const html = render(QueueList, { items: ITEMS, total: 120, hasMore: true, loadingMore: true });
      assert(html.includes('Loading…'), 'busy label missing');
      assert(/class="btn sm load-more" disabled=""/.test(html), 'button must be disabled while loading');
      assert(html.includes('aria-busy="true"'), 'container should announce that it is busy');
    });

    await test('reports a partial window when the server total is larger', () => {
      const html = render(QueueList, { items: ITEMS, total: 40, hasMore: false });
      assert(html.includes('Showing 3 of 40'), html.match(/queue-end[^<]*</)?.[0] || 'no queue-end line');
    });

    await test('shows a skeleton instead of rows while page 1 loads', () => {
      const html = render(QueueList, { items: [], total: 0, loading: true });
      assert(html.includes('queue-skeleton'), 'skeleton missing');
      assert.strictEqual(count(html, 'q-item'), 0, 'no rows while loading');
      assert.strictEqual(count(html, 'q-skel"'), 6, 'six shimmer rows by default');
      assert(html.includes('aria-busy="true"'));
      assert(html.includes('Loading…') === false, 'do not double up loading affordances');
    });

    await test('QueueSkeleton honours the rows prop and hides itself from AT', () => {
      const html = render(QueueSkeleton, { rows: 3 });
      assert.strictEqual(count(html, 'q-skel"'), 3);
      assert(html.includes('aria-hidden="true"'));
    });

    await test('an empty queue explains itself instead of rendering nothing', () => {
      const html = render(QueueList, { items: [], total: 0, loading: false });
      assert(html.includes('Nobody here'), 'empty message missing');
      assert(!html.includes('queue-skeleton'));
      assert(!html.includes('End of queue'), 'no terminal line for an empty queue');
    });

    await test('a failed page load offers a retry', () => {
      const html = render(QueueList, { items: [], total: 0, loading: false, error: 'Could not load the queue' });
      assert(html.includes('role="alert"'), 'error needs an alert role');
      assert(html.includes('Could not load the queue'));
      assert(html.includes('Retry'), 'retry affordance missing');
      assert(!html.includes('Nobody here'), 'an error is not an empty queue');
    });

    await test('keeps the error visible alongside rows already on screen', () => {
      const html = render(QueueList, { items: ITEMS, total: 120, hasMore: false, error: 'Could not load more' });
      assert.strictEqual(count(html, 'q-item'), 3, 'existing rows must not be thrown away');
      assert(html.includes('Could not load more'));
    });

    await test('the infinite-scroll sentinel is always mounted', () => {
      for (const props of [
        { items: [], total: 0, loading: true },
        { items: ITEMS, total: 3, hasMore: false },
        { items: ITEMS, total: 120, hasMore: true },
        { items: [], total: 0, error: 'boom' },
      ]) {
        const html = render(QueueList, props);
        assert(html.includes('queue-sentinel'), `sentinel missing for ${JSON.stringify(props)}`);
        assert(html.includes('aria-hidden="true"'), 'sentinel must be hidden from AT');
      }
    });

    await test('the queue container is labelled', () => {
      const html = render(QueueList, { items: ITEMS, total: 3 });
      assert(html.includes('aria-label="Dial queue"'));
      assert(html.includes('class="queue-list"'), 'existing CSS hook must be preserved');
    });

    // ------------------------------------------------------ touch target audit
    section('Touch targets (WCAG 2.5.5 / 44px on coarse pointers)');

    await test('a pointer:coarse block exists and carries real rules', () => {
      assert(coarseRules.length >= 20, `only ${coarseRules.length} rules in the coarse block`);
      return `${coarseRules.length} rules`;
    });

    await test('dialer queue rows are at least 44px tall', () => {
      const h = assertMinPx(coarseRules, '.q-item', 'min-height', 44);
      assertMinPx(coarseRules, '.queue-list', 'gap', 6);
      return `${h}px rows, >=6px apart`;
    });

    await test('every button family clears 44px', () => {
      const sizes = [];
      for (const sel of ['.btn', '.btn.sm', '.btn.xs', '.link-btn', '.nav-item', '.chip-btn', '.stage-pill', '.seg button', '.outcome', '.mode-chip', '.load-more']) {
        sizes.push(`${sel}=${assertMinPx(coarseRules, sel, 'min-height', 44)}px`);
      }
      return sizes.slice(0, 4).join(' ') + ' …';
    });

    await test('icon buttons are 44x44 including the small variant', () => {
      const w = assertMinPx(coarseRules, '.icon-btn', 'width', 44);
      const h = assertMinPx(coarseRules, '.icon-btn', 'height', 44);
      const smRules = coarseRules.filter((r) => r.selectors.some((s) => s.trim() === '.icon-btn.sm'));
      assert(smRules.length, 'no dedicated .icon-btn.sm rule for coarse pointers');
      const smW = Math.max(...pxValues(smRules, '.icon-btn.sm', 'width'));
      assert(smW >= 44, `.icon-btn.sm is ${smW}px wide on touch`);
      return `${w}x${h}, small ${smW}px`;
    });

    await test('call button, switch and drag grip are thumb-sized', () => {
      assertMinPx(coarseRules, '.call-btn', 'width', 44);
      assertMinPx(coarseRules, '.call-btn', 'height', 44);
      assertMinPx(coarseRules, '.switch', 'width', 44);
      assertMinPx(coarseRules, '.grip', 'min-width', 44);
      assertMinPx(coarseRules, '.grip', 'min-height', 44);
    });

    await test('inputs are 44px tall and 16px so iOS does not zoom on focus', () => {
      assertMinPx(coarseRules, '.search input', 'min-height', 44);
      assertMinPx(coarseRules, '.form input', 'min-height', 44);
      assertMinPx(coarseRules, '.inline-edit', 'min-height', 44);
      const fontRules = coarseRules.filter((r) => r.selectors.some((s) => s.includes('.form input')));
      assert(fontRules.length, 'no font-size rule for form inputs on coarse pointers');
      assert(/font-size:\s*16px/.test(fontRules[0].body), 'inputs should be 16px to stop focus zoom');
    });

    await test('taps are not delayed by double-tap zoom or a highlight flash', () => {
      assert(/touch-action:\s*manipulation/.test(css), 'touch-action: manipulation missing');
      const globalRule = rulesOf(desktopCss).find((r) => r.selectors.includes('button') && /touch-action/.test(r.body));
      assert(globalRule, 'touch-action must be declared outside the media query so it always applies');
      assert(/-webkit-tap-highlight-color:\s*transparent/.test(css), 'tap highlight should be suppressed');
    });

    await test('the dense desktop layout is left alone', () => {
      const iconBtn = pxValues(desktopRules, '.icon-btn', 'width');
      assert(iconBtn.includes(38), `desktop .icon-btn width should stay 38px, found ${iconBtn.join('/')}`);
      assert(pxValues(desktopRules, '.icon-btn.sm', 'width').includes(28), 'desktop .icon-btn.sm should stay 28px');
      const qItemBase = rulesOf(desktopCss).filter((r) => r.selectors.some((s) => s.trim() === '.q-item'));
      assert(!qItemBase.some((r) => /min-height/.test(r.body)), 'desktop .q-item must not gain a min-height');
      assert(pxValues(desktopRules, '.call-btn', 'width').includes(68), 'desktop call button stays 68px');
    });

    await test('queue pagination styles are defined', () => {
      for (const sel of ['.load-more', '.load-more-count', '.queue-skeleton', '.q-skel', '.queue-error', '.queue-end', '.queue-sentinel', '.seg-count', '.stage-loading', '.btn.xs']) {
        assert(css.includes(sel), `styles.css is missing ${sel}`);
      }
      assert(/@keyframes shimmer/.test(css), 'skeleton needs its shimmer keyframes');
      const reduced = mediaBlock(css, '@media (prefers-reduced-motion: reduce)');
      assert(/animation:\s*none/.test(reduced.body), 'shimmer must be disabled for reduced motion');
    });

    // --------------------------------------------------------- module graph
    section('Module graph (catches broken imports without a browser)');

    await test('every touched module still loads through Vite', async () => {
      const mods = ['/src/queue.js', '/src/api.js', '/src/utils.js', '/src/store.jsx', '/src/useServerQueue.js', '/src/App.jsx', '/src/pages/Dialer.jsx', '/src/components/QueueList.jsx'];
      for (const m of mods) {
        const mod = await vite.ssrLoadModule(m);
        assert(mod, `${m} did not load`);
      }
      const dialer = await vite.ssrLoadModule('/src/pages/Dialer.jsx');
      assert.strictEqual(typeof dialer.default, 'function', 'Dialer must default-export a component');
      const hook = await vite.ssrLoadModule('/src/useServerQueue.js');
      assert.strictEqual(typeof hook.default, 'function', 'useServerQueue must default-export a hook');
      const app = await vite.ssrLoadModule('/src/App.jsx');
      assert.strictEqual(typeof app.default, 'function');
      return `${mods.length} modules`;
    });

    await test('the dialer no longer asks the store for the whole prospect list', () => {
      const src = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'Dialer.jsx'), 'utf8');
      assert(!/refreshProspects/.test(src), 'Dialer still calls refreshProspects(), which downloads every row');
      assert(/useServerQueue/.test(src), 'Dialer must page its queue from the server');
      assert(!/const TABS = \[/.test(src), 'tab definitions should live in src/queue.js now');
      const store = fs.readFileSync(path.join(ROOT, 'src', 'store.jsx'), 'utf8');
      assert(/ensureProspects/.test(store), 'store must expose a lazy ensureProspects()');
    });
  } finally {
    await vite.close();
  }

  process.exit(summarize('UI tests') ? 1 : 0);
}

main().catch((e) => {
  console.error('\nHarness failure:', e);
  process.exit(1);
});
