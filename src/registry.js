// Reading the registry metadata an enriched lead sheet carried in.
//
// Imported sheets bring columns this app has no field for — CVR numbers, advertising-protection
// flags, "Current CVR Status", source URLs. They are stored verbatim in `prospect.extra` and
// shown in the cockpit under a collapsed "More details" section. Deciding *what* to surface on
// the collapsed bar (a CVR number, a do-not-market flag) is logic, not markup, so it lives here
// where it can be tested against the shapes real sheets produce.
//
// The CVR advertising-protection flag is the one that matters commercially: a protected company
// must not be contacted with marketing material, and finding that out after a call is too late,
// so it gets a warning pill the agent sees before dialing.

const CVR_KEY = /(?:^|[^a-z0-9])cvr(?:[^a-z0-9]|$)/i;
// "Protection", "Reklamebeskyttelse", "Advertising protection" — but not "CVR Status".
const PROTECTION_KEY = /(?:protection|reklamebeskyttelse|beskyttelse)/i;
const AFFIRMATIVE = /^(?:yes|ja|true|1|y|j|aktiv|active)$/i;

/** A value that should be a link rather than text. */
export const isUrlValue = (value) => /^https?:\/\/\S+$/i.test(String(value ?? '').trim());

/** Shorten a long value for display without hiding what it is. */
export const clip = (value, max = 44) => {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/**
 * Everything the cockpit needs to know about a prospect's extra columns.
 *
 * @returns {{
 *   count: number, entries: Array<{key: string, value: string, isUrl: boolean, isCvr: boolean, isProtection: boolean}>,
 *   cvr: string, adProtected: boolean, protectionNote: string, urlCount: number
 * }}
 */
export function extraInsights(extra = {}) {
  const entries = Object.entries(extra || {})
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
    .map(([key, value]) => {
      const text = String(value).trim();
      return {
        key,
        value: text,
        isUrl: isUrlValue(text),
        isCvr: CVR_KEY.test(key) && !PROTECTION_KEY.test(key) && !isUrlValue(text),
        isProtection: PROTECTION_KEY.test(key),
      };
    });

  // The bare registration number, not the status or the protection flag that live beside it.
  const cvr = entries.find((e) => e.isCvr)?.value || '';

  // Affirmative means protected. A blank or "Nej" is not a warning worth crying wolf over, and
  // an unrecognised value is reported in words rather than silently treated as safe.
  const protection = entries.find((e) => e.isProtection);
  const adProtected = !!protection && AFFIRMATIVE.test(protection.value);
  const protectionNote = protection
    ? (adProtected ? `${protection.key}: ${protection.value} — do not send marketing material` : `${protection.key}: ${protection.value}`)
    : '';

  return {
    count: entries.length,
    entries,
    cvr,
    adProtected,
    protectionNote,
    urlCount: entries.filter((e) => e.isUrl).length,
  };
}
