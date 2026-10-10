'use strict';
/**
 * CSV writing helpers.
 *
 * Extracted from server/index.js unchanged so the formula-injection defences can
 * be property-tested in isolation.
 */

// A CSV cell that begins with = + - @ (or a leading tab/CR) is evaluated as a
// formula when the export is opened in Excel or Sheets, which turns an imported
// lead name into code execution on the operator's machine (OWASP "CSV
// injection"). Prefixing a single quote makes the spreadsheet treat it as text.
const CSV_FORMULA_HEAD = /^[=+\-@\t\r]/;

// Exception: a leading +/- followed by nothing but digits is a phone number or a
// quantity, which can only ever render as a number — quoting those would corrupt
// every exported international phone number for no security gain.
const NUMERIC_AFTER_SIGN = /^\d+(\.\d+)?$/;

/** The character a neutralised cell is prefixed with. */
const NEUTRALISED_PREFIX = "'";

/** True when `val` would be evaluated as a formula by a spreadsheet. */
function isFormulaRisk(val) {
  const s = String(val === null || val === undefined ? '' : val);
  if (!CSV_FORMULA_HEAD.test(s)) return false;
  const head = s[0];
  const rest = s.slice(1).trim();
  const harmlessNumber = (head === '+' || head === '-') && NUMERIC_AFTER_SIGN.test(rest);
  return !harmlessNumber;
}

/**
 * Escape one CSV field per RFC4180 and neutralise formula injection.
 *
 * The returned string is the raw field, not a parsed cell: when the value needs
 * quoting (it contains a comma, quote, CR or LF) the result is wrapped in double
 * quotes, so a neutralised cell can look like `"'=1+1"`. Parse the field before
 * asserting on its first character.
 */
function escapeCsv(val) {
  if (val === null || val === undefined) return '';
  let s = String(val);
  if (isFormulaRisk(s)) s = NEUTRALISED_PREFIX + s;
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

module.exports = { escapeCsv, isFormulaRisk, CSV_FORMULA_HEAD, NEUTRALISED_PREFIX };
