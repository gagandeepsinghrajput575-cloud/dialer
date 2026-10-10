'use strict';
/**
 * Server-side dialer queue primitives: tab filters, the keyset cursor codec and
 * the LIKE-search builder.
 *
 * Extracted from server/index.js so the cursor codec and search escaping can be
 * fuzzed directly. The SQL fragments here are constants — nothing user-supplied
 * is ever interpolated into them; user input only ever travels as a bound
 * parameter (see queueSearch and cursorPredicate).
 */

/** SQL fragment per tab. `all` needs no extra predicate. */
const QUEUE_TABS = {
  new: "stage = 'new'",
  follow: "stage IN ('contacted','interested','followup')",
  all: null,
};
const QUEUE_DEFAULT_LIMIT = 50;
const QUEUE_MAX_LIMIT = 500;
const HAS_PHONE = "(CASE WHEN TRIM(phone) <> '' THEN 1 ELSE 0 END)";

/** Escape LIKE wildcards so a search for `100%` means the literal string. */
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Build the search predicate over the same fields the dialer's client-side
 * filter used. SQLite's LIKE is case-insensitive for ASCII, matching the old
 * toLowerCase(). Returns bound parameters, never interpolated values, so the SQL
 * text is identical for every possible search term.
 */
function queueSearch(q) {
  const needle = String(q || '').trim();
  if (!needle) return { sql: '', params: [] };
  const like = `%${escapeLike(needle)}%`;
  const cols = ['name', 'company', 'phone', 'email', 'title'];
  return {
    sql: ` AND (${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`,
    params: cols.map(() => like),
  };
}

/**
 * Encode the last served row's sort key as an opaque base64url token.
 * The key is exactly (has_phone, id) — that is what the ORDER BY uses. There is
 * no third component, so nothing else is encoded.
 */
function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ p: row.has_phone, i: row.id }), 'utf8').toString('base64url');
}

/**
 * Decode and validate a cursor. Returns `{ hp, id }` or null for anything
 * malformed or tampered with — a bad cursor is a client error, never a crash.
 *
 * `isSafeInteger` rather than `isInteger` on purpose. JSON round-tripping is
 * lossy above 2^53: encoding id 9007199254740993 decoded back as ...992, so the
 * codec silently broke its own round-trip contract and served an empty page for
 * a cursor it could not represent faithfully. No real rowid gets that large, but
 * a client presenting one is either broken or tampering, and a 400 beats a
 * silently wrong page. Found by the property suite.
 */
function decodeCursor(raw) {
  try {
    const v = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    const hp = Number(v?.p);
    const id = Number(v?.i);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    if (hp !== 0 && hp !== 1) return null;
    return { hp, id };
  } catch {
    return null;
  }
}

/** Keyset predicate for "strictly after the row this cursor points at". */
function cursorPredicate(cur) {
  return {
    sql: ` AND (${HAS_PHONE} < ? OR (${HAS_PHONE} = ? AND id > ?))`,
    params: [cur.hp, cur.hp, cur.id],
  };
}

module.exports = {
  QUEUE_TABS,
  QUEUE_DEFAULT_LIMIT,
  QUEUE_MAX_LIMIT,
  HAS_PHONE,
  escapeLike,
  queueSearch,
  encodeCursor,
  decodeCursor,
  cursorPredicate,
};
