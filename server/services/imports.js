'use strict';
/**
 * Spreadsheet import filtering: deciding which parsed rows are real contacts and
 * which are the header/footer/summary noise that every exported spreadsheet
 * carries.
 *
 * Extracted from server/index.js verbatim so the heuristics can be fuzzed.
 */

const JUNK_NAMES = new Set([
  'total', 'grand total', 'subtotal', 'average', 'summary', 'count', 'page 1',
  'rows', 'name', 'full name', 'prospect', 'unnamed',
]);

const JUNK_ROW_PATTERN = /^(total|grand total|subtotal|average|summary|count|page \d+.*|sheet\d*|workbook.*|rows?|name|full name|prospect|unnamed|untitled|header|notes)$/i;

/** True when a row's name marks it as spreadsheet furniture rather than a person. */
function isJunkName(name) {
  const v = String(name === null || name === undefined ? '' : name);
  if (!v) return false;
  return JUNK_NAMES.has(v.toLowerCase()) || JUNK_ROW_PATTERN.test(v.trim());
}

/**
 * True when a mapped row carries nothing worth storing. Order and short-circuits
 * match the original bulk-import loop exactly.
 */
function isEmptyRow({ phone = '', name = '', email = '', company = '' } = {}) {
  if (!phone && !name && !email) return true;
  // A contact with no phone, no email and no company is almost always a header or label
  if (!phone && !email && !company) return true;
  if (!phone && !email && String(name).length < 2) return true;
  return false;
}

module.exports = { isJunkName, isEmptyRow, JUNK_NAMES, JUNK_ROW_PATTERN };
