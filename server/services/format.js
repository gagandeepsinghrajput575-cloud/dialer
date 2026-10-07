// Tiny shared formatters.

// The app stores timestamps as 'YYYY-MM-DD HH:MM:SS' (UTC, written by datetime('now') and
// sqlTime()), but older rows and API round-trips can carry a full ISO string with 'Z'.
// Appending another 'Z' to an ISO value produces Invalid Date -> NaN -> silently wrong
// queue ranking, so every timestamp in the codebase is parsed through here.
function parseSqlTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const str = String(value).trim();
  if (!str) return null;
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(str) ? str : str.replace(' ', 'T') + 'Z';
  const d = new Date(withZone);
  if (Number.isNaN(d.getTime())) {
    const loose = new Date(str); // last resort: let the engine try the raw string
    return Number.isNaN(loose.getTime()) ? null : loose;
  }
  return d;
}

function fmtDuration(totalSec) {
  const sec = Math.max(0, Math.round(totalSec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}
const fmtDate = (iso) => {
  const d = parseSqlTime(iso);
  return d ? d.toISOString().slice(0, 16).replace('T', ' ') : '';
};
module.exports = { fmtDuration, fmtDate, parseSqlTime };
