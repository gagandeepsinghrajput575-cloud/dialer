'use strict';
/**
 * Phone normalisation.
 *
 * Extracted from server/index.js so it can be property-tested without booting
 * the server. Behaviour is deliberately unchanged; the one difference is that
 * the default country code is now supplied by the caller instead of being read
 * from the settings table inside here, which keeps this module pure. Every call
 * site in server/index.js passes getSetting('default_country_code').
 */
const { cleanStr } = require('./text');

const MIN_DIGITS = 5;

/**
 * Normalise a raw phone-ish value to E.164 (`+<digits>`), or '' when it cannot
 * be a number.
 *
 * SIP addresses and email-style identifiers are passed through untouched:
 * Sonetel accepts them as a call target, and stripping their non-digits would
 * destroy them. Note this means the return value is NOT always `+` followed by
 * digits only — callers must not assume that.
 */
function normalizePhone(raw, countryCode) {
  if (!raw) return '';
  const s = cleanStr(raw);
  if (!s) return '';
  if (/@/.test(s) || /^sip:/i.test(s)) return s; // SIP address, keep as is
  const hasPlus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits || digits.length < MIN_DIGITS) return ''; // clearly junk (< 5 digits)
  const cc = String(countryCode === undefined || countryCode === null ? '' : countryCode).replace(/\D/g, '');

  let out;
  if (hasPlus) {
    out = digits;
  } else if (digits.startsWith('00')) {
    out = digits.slice(2); // 00 is the international access prefix outside the NANP
  } else {
    let local = digits;
    if (cc && local.startsWith('0')) local = local.replace(/^0+/, ''); // trunk prefix
    if (cc && local.length <= 10) out = cc + local;
    else if (cc && local.startsWith(cc) && local.length > 10) out = local;
    else out = local;
  }

  // Validate the RESULT, not just the input. Stripping a `00` access prefix or a
  // trunk `0` can drop what looked like a long enough string below the minimum,
  // and returning it anyway made this function non-idempotent: normalizePhone
  // turned '00568' into '+568', which normalised to '' on the second pass, so
  // the same logical value had two different canonical forms depending on how
  // many times it had been through here. Found by the property suite.
  return out.length >= MIN_DIGITS ? '+' + out : '';
}

module.exports = { normalizePhone, MIN_DIGITS };
