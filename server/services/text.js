'use strict';
/**
 * Text cleaning shared by every write path (create, patch, bulk import).
 *
 * Pure and side-effect free on purpose: this module must be requireable from a
 * test without booting the server or opening the database.
 */

// Values that spreadsheet exports use to mean "nothing here". Matched
// case-insensitively after trimming.
const PLACEHOLDERS = ['null', 'undefined', 'n/a', 'na', 'none', '-', '--', 'nil'];

function cleanStr(val) {
  if (val === null || val === undefined) return '';
  const s = String(val).trim();
  const lower = s.toLowerCase();
  if (PLACEHOLDERS.includes(lower)) return '';
  return s;
}

module.exports = { cleanStr, PLACEHOLDERS };
