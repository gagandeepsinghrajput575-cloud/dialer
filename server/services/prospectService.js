// Prospect business logic: normalization on write, safe bulk imports, demo data and the
// Danish smart queue ranking.
const prospects = require('../repositories/prospectRepo');
const notes = require('../repositories/noteRepo');
const calls = require('../repositories/callRepo');
const settings = require('../repositories/settingsRepo');
const telephony = require('./telephonyService');
const backup = require('../db/backup');
const { ApiError } = require('../middleware/errorHandler');
const { STAGES, FIELDS } = require('../config/defaults');
const { parseSqlTime } = require('./format');

const { cleanStr } = telephony;

const JUNK_NAMES = new Set(['total', 'grand total', 'subtotal', 'average', 'summary', 'count', 'page 1', 'rows', 'name', 'full name', 'prospect', 'unnamed']);
const JUNK_PATTERN = /^(total|grand total|subtotal|average|summary|count|page \d+.*|sheet\d*|workbook.*|rows?|name|full name|prospect|unnamed|untitled|header|notes)$/i;

// The dialer needs to know a number is premium-rate BEFORE it logs a call, so the flag
// rides along on every prospect rather than only on the dial response.
const withNumberKind = (p) => (p ? { ...p, number_kind: telephony.numberKind(p.phone) } : p);

const list = () => prospects.list().map(withNumberKind);

function detail(id) {
  const p = prospects.get(id);
  if (!p) throw ApiError.notFound('Not found');
  return { ...withNumberKind(p), notes: notes.listByProspect(id), calls: calls.listByProspect(id) };
}

const search = (needle, limit) => prospects.search(needle, limit).map(withNumberKind);

// A blank phone is fine — plenty of real leads have no number yet. But a value that looks
// like a number and normalizes to nothing is junk, and silently storing "" produced leads
// that could never be dialled while the UI cheerfully said "Prospect added".
function normalizedPhone(raw) {
  // cleanStr first, so a placeholder ("N/A", "null", "-", "none") counts as "no number yet"
  // rather than a broken one. This keeps create/patch consistent with bulk import, which
  // cleans every cell before it ever looks at the phone column.
  const given = telephony.cleanStr(raw);
  if (!given) return '';
  const phone = telephony.normalizePhone(given);
  if (!phone) {
    throw ApiError.badRequest(
      `"${given.slice(0, 40)}" is not a diallable phone number. Use at least 8 digits, e.g. +45 20 12 34 56 — or leave the field empty.`,
      [{ field: 'phone', issue: 'unparseable' }],
    );
  }
  return phone;
}

function create(input = {}) {
  const created = prospects.insert({
    name: cleanStr(input.name),
    phone: normalizedPhone(input.phone),
    email: cleanStr(input.email),
    company: cleanStr(input.company),
    title: cleanStr(input.title),
    location: cleanStr(input.location),
    website: cleanStr(input.website),
    extra: input.extra || {},
    stage: STAGES.includes(input.stage) ? input.stage : 'new',
  });
  return withNumberKind(created);
}

function update(id, input = {}) {
  const existing = prospects.raw(id);
  if (!existing) throw ApiError.notFound('Not found');
  const patch = {};
  for (const f of FIELDS) {
    if (!(f in input)) continue;
    patch[f] = f === 'phone' ? normalizedPhone(input[f]) : cleanStr(input[f]);
  }
  if ('stage' in input && STAGES.includes(input.stage)) patch.stage = input.stage;
  if ('dnc' in input) patch.dnc = input.dnc ? 1 : 0;
  if ('follow_up_at' in input) patch.follow_up_at = input.follow_up_at || null;
  if ('extra' in input) patch.extra = JSON.stringify(input.extra || {});
  return withNumberKind(prospects.update(id, patch));
}

const remove = (id) => prospects.remove(id);
const clearAll = () => prospects.clearAll();

// Bulk import. Junk header/summary rows are dropped, duplicates are counted, and a snapshot
// is taken first so a bad import is always recoverable.
async function bulkImport({ rows = [], mapping = {}, skipDuplicates = true } = {}) {
  const backupInfo = rows.length ? await backup.beforeBulkWrite('import') : null;
  const existing = prospects.phones();
  const existingEmails = prospects.emails();
  const mappedCols = new Set(Object.values(mapping).filter(Boolean));
  const prepared = [];
  let dupes = 0, empty = 0, badPhones = 0;

  for (const row of rows) {
    const v = {};
    for (const f of FIELDS) v[f] = mapping[f] ? cleanStr(row[mapping[f]]) : '';
    if (mapping.first_name || mapping.last_name) {
      const fn = mapping.first_name ? cleanStr(row[mapping.first_name]) : '';
      const ln = mapping.last_name ? cleanStr(row[mapping.last_name]) : '';
      mappedCols.add(mapping.first_name); mappedCols.add(mapping.last_name);
      if (!v.name) v.name = `${fn} ${ln}`.trim();
    }
    // Imports must never silently lose a row to a typo, so the row is kept and the bad
    // number is counted instead. The count comes back so a junk column is obvious at once.
    const rawPhone = v.phone;
    v.phone = telephony.normalizePhone(rawPhone);
    if (!v.phone && rawPhone) badPhones++;
    if (v.email && !v.email.includes('@')) v.email = '';

    if (v.name && (JUNK_NAMES.has(v.name.toLowerCase()) || JUNK_PATTERN.test(v.name.trim()))) { empty++; continue; }
    if (!v.phone && !v.name && !v.email) { empty++; continue; }
    if (!v.phone && !v.email && !v.company) { empty++; continue; }
    if (!v.phone && !v.email && v.name.length < 2) { empty++; continue; }
    // A person reached on a mobile and a landline is one contact; the email is usually what
    // gives it away. Either identifier matching is enough to call it a duplicate.
    const emailKey = v.email ? v.email.trim().toLowerCase() : '';
    if (skipDuplicates && ((v.phone && existing.has(v.phone)) || (emailKey && existingEmails.has(emailKey)))) {
      dupes++; continue;
    }

    const extra = {};
    for (const [k, val] of Object.entries(row)) {
      const cleaned = cleanStr(val);
      if (!mappedCols.has(k) && cleaned !== '') extra[k] = cleaned;
    }
    prepared.push({ ...v, extra });
    if (v.phone) existing.add(v.phone);
    if (emailKey) existingEmails.add(emailKey);   // so dupes within the same file are caught too
  }

  const added = prepared.length ? prospects.bulkInsert(prepared) : 0;
  return { added, dupes, empty, badPhones, backup: backupInfo };
}

const DEMO = [
  ['Mette Jensen', '+4520123456', 'mette@nordiclogistik.dk', 'Nordic Logistik', 'Driftschef', 'København, DK'],
  ['Anders Nielsen', '+4522345678', 'anders@brightlab.dk', 'BrightLab ApS', 'Stifter & CEO', 'Aarhus, DK'],
  ['Sofie Hansen', '+4531456789', 'sofie@stackify.dk', 'Stackify Nordic', 'Salgsdirektør', 'Odense, DK'],
  ['Kasper Andersen', '+4540567890', 'kasper@lumenhealth.dk', 'Lumen Health', 'Marketingdirektør', 'Aalborg, DK'],
  ['Ida Christensen', '+4550678901', 'ida@orbitpay.dk', 'OrbitPay', 'CTO', 'København, DK'],
  ['Jonas Larsen', '+4561789012', 'jonas@greenloop.dk', 'GreenLoop Energy', 'Vækstchef', 'Esbjerg, DK'],
  ['Frederikke Sørensen', '+4571890123', 'frederikke@peakfit.dk', 'PeakFit', 'Ejer', 'Vejle, DK'],
  ['Mathias Poulsen', '+4592901234', 'mathias@cloudnest.dk', 'CloudNest', 'Produktchef', 'Roskilde, DK'],
];
const DEMO_STAGES = ['new', 'new', 'contacted', 'interested', 'followup', 'new', 'meeting', 'new'];

function loadDemo() {
  const sizes = ['11-50', '51-200', '201-500'];
  const inserted = DEMO.map((d, i) => {
    const p = prospects.insert({
      name: d[0], phone: d[1], email: d[2], company: d[3], title: d[4], location: d[5],
      extra: { 'Lead source': 'Demo list', 'Company size': sizes[i % 3] }, stage: DEMO_STAGES[i],
    });
    if (DEMO_STAGES[i] !== 'new') notes.insert(p.id, 'Sample note: asked to send a short deck over email.');
    return p;
  });
  return { added: inserted.length };
}

// ---- Danish smart queue ----
// Priority: follow-ups due > never called > no answer > aged voicemail > gatekeeper > routine.
function rankProspect(p, now = Date.now()) {
  if (p.dnc) return { score: -1000, reason: 'dnc' };
  if (!p.phone) return { score: -100, reason: 'no_phone' };

  const followUpDate = parseSqlTime(p.follow_up_at);
  const followUp = followUpDate ? followUpDate.getTime() : null;
  if (followUp && followUp <= now) return { score: 95, reason: 'follow_up_due' };
  if (p.call_count === 0) return { score: 85, reason: 'never_called' };

  // An unparseable timestamp must never turn into NaN: that would silently demote the
  // prospect to the "recently called" branch instead of retrying it.
  const lastCalledDate = parseSqlTime(p.last_called_at);
  const daysSince = lastCalledDate ? (now - lastCalledDate.getTime()) / 86400000 : Infinity;
  switch (p.last_outcome) {
    case 'no_answer': return { score: daysSince >= 1 ? 75 : 45, reason: daysSince >= 1 ? 'no_answer_retry' : 'no_answer_recent' };
    case 'voicemail': return { score: daysSince >= 3 ? 60 : 35, reason: daysSince >= 3 ? 'voicemail_aged' : 'voicemail_recent' };
    case 'gatekeeper': return { score: 55, reason: 'gatekeeper_retry' };
    case 'hung_up': return { score: 40, reason: 'hung_up_retry' };
    case 'wrong_number':
    case 'dnc': return { score: -500, reason: 'dead_number' };
    default: return { score: followUp ? 70 : 20, reason: followUp ? 'follow_up_scheduled' : 'routine' };
  }
}

const QUEUE_TABS = {
  new: (p) => p.stage === 'new',
  follow: (p) => ['contacted', 'interested', 'followup'].includes(p.stage),
  all: () => true,
};

function rankedQueue({ tab = 'all', search: q = '' } = {}) {
  const smart = settings.getBool('queue_smart_sort');
  const test = QUEUE_TABS[tab] || QUEUE_TABS.all;
  const needle = String(q || '').trim().toLowerCase();
  const now = Date.now();

  const rows = prospects.list()
    .filter((p) => !p.dnc && test(p))
    .filter((p) => !needle || `${p.name} ${p.company} ${p.phone} ${p.email}`.toLowerCase().includes(needle))
    .map((p) => ({ ...p, number_kind: telephony.numberKind(p.phone), ...rankProspect(p, now) }))
    .sort((a, b) => (smart ? b.score - a.score : 0) || (b.phone ? 1 : 0) - (a.phone ? 1 : 0) || a.id - b.id);

  const reasons = {};
  for (const r of rows) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  return { smartSort: smart, businessHours: telephony.businessHours(new Date()), rows, reasons, total: rows.length };
}

module.exports = {
  list, detail, search, create, update, remove, clearAll, bulkImport, loadDemo,
  rankProspect, rankedQueue, QUEUE_TABS,
};
