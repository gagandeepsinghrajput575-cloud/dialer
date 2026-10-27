// Exports: a flat CSV for spreadsheets and a full JSON snapshot for reporting.
const prospects = require('../repositories/prospectRepo');
const notes = require('../repositories/noteRepo');
const calls = require('../repositories/callRepo');
const settings = require('../repositories/settingsRepo');
const statsService = require('./statsService');

// A cell that starts with = + - @ (or a tab/CR) is executed as a formula by Excel and
// Google Sheets, so prospect data like "=HYPERLINK(\"http://evil\")" would run on the
// recipient's machine. Prefixing a single quote neutralizes it without changing the text
// a human reads.
const FORMULA_LEAD = /^[=+\-@\t\r]/;
function neutralizeFormula(s) {
  return FORMULA_LEAD.test(s) ? `'${s}` : s;
}

// Excel only reads a UTF-8 CSV as UTF-8 when it carries a BOM — without it the Danish
// ø/å/æ in names come out as mojibake.
const UTF8_BOM = '\uFEFF';

function escapeCsv(val) {
  if (val === null || val === undefined) return '';
  const s = neutralizeFormula(String(val));
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_HEADERS = [
  'ID', 'Name', 'Phone', 'Email', 'Company', 'Title', 'Stage',
  'Do Not Call', 'Calls Count', 'Last Called At', 'Last Outcome',
  'Follow Up Date', 'Location', 'Website', 'Notes', 'Created At',
  'Total Talk Sec', 'Voicemail Drops', 'Last Dial URI',
];

function callAggregates(allCalls = calls.all()) {
  const byProspect = {};
  for (const c of allCalls) {
    const agg = byProspect[c.prospect_id] || (byProspect[c.prospect_id] = { talkSec: 0, vmDrops: 0, lastDialUri: '' });
    agg.talkSec += c.duration_sec || 0;
    if (c.vm_dropped) agg.vmDrops++;
    if (c.dial_uri) agg.lastDialUri = c.dial_uri;
  }
  return byProspect;
}

function toCsv() {
  const rows = prospects.list();
  const notesByProspect = {};
  for (const n of notes.all()) {
    (notesByProspect[n.prospect_id] || (notesByProspect[n.prospect_id] = [])).push(n.body);
  }
  const aggs = callAggregates();

  const lines = [CSV_HEADERS.join(',')];
  for (const r of rows) {
    const agg = aggs[r.id] || { talkSec: 0, vmDrops: 0, lastDialUri: '' };
    lines.push([
      r.id, escapeCsv(r.name), escapeCsv(r.phone), escapeCsv(r.email), escapeCsv(r.company),
      escapeCsv(r.title), escapeCsv(r.stage), r.dnc ? 'YES' : 'NO', r.call_count,
      escapeCsv(r.last_called_at || ''), escapeCsv(r.last_outcome || ''), escapeCsv(r.follow_up_at || ''),
      escapeCsv(r.location || ''), escapeCsv(r.website || ''),
      escapeCsv((notesByProspect[r.id] || []).join(' | ')), escapeCsv(r.created_at),
      agg.talkSec, agg.vmDrops, escapeCsv(agg.lastDialUri),
    ].join(','));
  }
  return { csv: UTF8_BOM + lines.join('\r\n'), filename: `pulse-prospects-${new Date().toISOString().slice(0, 10)}.csv` };
}

// Full JSON snapshot: prospects with their notes, complete call history and talk times.
// Single-pass grouping avoids 2N+1 per-prospect SQL queries on large lead lists.
function toJson() {
  const allCalls = calls.all();
  const aggs = callAggregates(allCalls);
  const callsByProspect = {};
  // Sort newest first to match calls.listByProspect(id, 1000)
  for (let i = allCalls.length - 1; i >= 0; i--) {
    const c = allCalls[i];
    const list = callsByProspect[c.prospect_id] || (callsByProspect[c.prospect_id] = []);
    if (list.length < 1000) list.push(c);
  }
  const notesByProspect = {};
  for (const n of notes.all()) {
    (notesByProspect[n.prospect_id] || (notesByProspect[n.prospect_id] = [])).push(n);
  }
  const stats = statsService.stats({}); // computed once for both sections
  return {
    exported_at: new Date().toISOString(),
    app: 'Pulse Dialer',
    telephony: {
      mode: settings.get('telephony_mode'),
      protocol: settings.get('softphone_protocol'),
      sip_server: settings.get('flynumber_sip_server') || settings.get('telnyx_sip_server'),
      caller_id: settings.get('caller_id'),
      caller_id_pool: settings.get('caller_id_pool'),
      default_country_code: settings.get('default_country_code'),
    },
    summary: stats.today,
    stageCounts: stats.stageCounts,
    prospects: prospects.list().map((p) => ({
      ...p,
      totalTalkSec: (aggs[p.id] || {}).talkSec || 0,
      voicemailDrops: (aggs[p.id] || {}).vmDrops || 0,
      notes: notesByProspect[p.id] || [],
      calls: callsByProspect[p.id] || [],
    })),
  };
}

module.exports = { toCsv, toJson, escapeCsv, neutralizeFormula, CSV_HEADERS, UTF8_BOM };
