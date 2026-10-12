// Pure queue helpers shared by the API client, the dialer and test suites.
// Deterministic and pure: no React or DOM dependencies.

export const QUEUE_LIMIT = 50;
export const QUEUE_MAX_LIMIT = 500;

// Dialer queue tabs. Keep in sync with server QUEUE_TABS.
export const QUEUE_TABS = [
  { id: 'new', label: 'To call', stages: ['new'], test: (p) => p.stage === 'new' },
  {
    id: 'follow',
    label: 'Follow-ups',
    stages: ['contacted', 'interested', 'followup'],
    test: (p) => ['contacted', 'interested', 'followup'].includes(p.stage),
  },
  { id: 'all', label: 'All', stages: null, test: () => true },
];

export const queueTab = (id) => QUEUE_TABS.find((t) => t.id === id) || null;

/** Which tab a prospect belongs to, used to auto-switch tabs when one is opened from elsewhere. */
export function tabForProspect(p) {
  if (!p) return null;
  if (p.stage === 'new') return 'new';
  if (['contacted', 'interested', 'followup'].includes(p.stage)) return 'follow';
  return 'all';
}

/** Clamp a page size into the range the server accepts. */
export function clampLimit(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return QUEUE_LIMIT;
  return Math.min(QUEUE_MAX_LIMIT, Math.max(1, v));
}

/**
 * Build query string for GET /api/queue. Empty params dropped for clean URLs.
 */
export function buildQueueQuery({ tab = 'all', q = '', limit = QUEUE_LIMIT, cursor = null } = {}) {
  const p = new URLSearchParams();
  p.set('tab', tab || 'all');
  const needle = String(q ?? '').trim();
  if (needle) p.set('q', needle);
  p.set('limit', String(clampLimit(limit)));
  if (cursor) p.set('cursor', String(cursor));
  return p.toString();
}

const toSet = (done) => (done instanceof Set ? done : new Set(done || []));

/**
 * Does this prospect still belong in this tab?
 *
 * The dialer's loaded window is a snapshot. An agent who classifies a lead as "Meeting booked"
 * moves it to a stage the "To call" tab does not show, but the lead keeps sitting in the array
 * the dialer is walking — so the queue would keep offering a lead it no longer contains, and
 * the end-of-queue state could never be reached. Everything that walks the window asks this
 * first, which is what keeps the tab and the list honest about each other.
 */
export function isCallableInTab(prospect, tabId) {
  if (!prospect) return false;
  const tab = queueTab(tabId);
  if (!tab || !tab.test) return false;
  return tab.test(prospect);
}

/**
 * Progress through the active tab: what is left to dial, and whether the tab is finished.
 *
 * `allDone` is deliberately strict — no remaining callable lead *inside this tab*, and nothing
 * more to load — because it is what shows the agent the "you cleared the list" state. Counting
 * a lead that was already archived out of the tab would hide that reward forever.
 */
export function queueProgress(items, done, tabId) {
  const list = Array.isArray(items) ? items : [];
  const doneIds = toSet(done);
  const callable = list.filter((p) => isCallableInTab(p, tabId));
  const remaining = callable.filter((p) => !doneIds.has(p.id));
  return {
    tab: tabId,
    callable: callable.length,
    dialed: callable.length - remaining.length,
    remaining: remaining.length,
    nextId: remaining.length ? remaining[0].id : null,
    allDone: callable.length > 0 && remaining.length === 0,
  };
}

/**
 * Walk forward from `currentId`, skipping prospects already dialed this session.
 *
 * Returns `{ id, hitEnd }`:
 *  - `id`     – next candidate inside the loaded window, or null.
 *  - `hitEnd` – true when the walk ran off the end of the loaded window.
 */
export function pickNextId(items, currentId, done, isEligible = () => true) {
  const list = (Array.isArray(items) ? items : []).filter(isEligible);
  if (!list.length) return { id: null, hitEnd: false };
  const doneIds = toSet(done);
  const start = currentId == null ? -1 : list.findIndex((p) => p.id === currentId);

  if (start === -1) {
    const fresh = list.find((p) => !doneIds.has(p.id));
    return { id: fresh ? fresh.id : null, hitEnd: false };
  }
  for (let i = start + 1; i < list.length; i++) {
    if (!doneIds.has(list[i].id)) return { id: list[i].id, hitEnd: false };
  }
  return { id: null, hitEnd: true };
}

/** First not-yet-dialed item in the window, or null when everything is done. */
export function firstFreshId(items, done, isEligible = () => true) {
  const list = (Array.isArray(items) ? items : []).filter(isEligible);
  const doneIds = toSet(done);
  const fresh = list.find((p) => !doneIds.has(p.id));
  return fresh ? fresh.id : null;
}

/**
 * Wrapped index step for manual prev/next navigation.
 */
export function stepIndex(count, idx, dir) {
  if (!count || count < 1) return -1;
  const d = dir < 0 ? -1 : 1;
  const base = idx < 0 || idx >= count ? (d > 0 ? -1 : 0) : idx;
  return (((base + d) % count) + count) % count;
}

/** Merge freshly fetched page into loaded window, deduplicating by id. */
export function appendPage(current, incoming) {
  const curArr = Array.isArray(current) ? current : [];
  const incArr = Array.isArray(incoming) ? incoming : [];
  const seen = new Set();
  const list = [];
  let curHadDuplicatesOrNulls = false;

  for (const p of curArr) {
    if (p && p.id != null) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        list.push(p);
      } else {
        curHadDuplicatesOrNulls = true;
      }
    } else {
      curHadDuplicatesOrNulls = true;
    }
  }

  const add = [];
  for (const p of incArr) {
    if (p && p.id != null && !seen.has(p.id)) {
      seen.add(p.id);
      add.push(p);
    }
  }

  if (!add.length && !curHadDuplicatesOrNulls) return curArr;
  return add.length ? [...list, ...add] : list;
}
