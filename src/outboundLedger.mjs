// What an outbound call that never connected leaves in the ledger.
//
// Two terminal shapes, and the difference matters to the agent's numbers:
//   failed   — the carrier refused the INVITE (busy, no route, unknown number); `error` says why.
//   canceled — the agent hung up while it was still ringing. Nothing was said, nobody was reached.
// Both are recorded so the row cannot sit at 'placed' forever, and both are ignored by the daily
// cap and the history funnel (see `callRepo`), which measure real conversations only.
//
// Inbound calls never come through here: they classify their own row on a separate path, and a
// `canceled` inbound row would be a lie about a person who did call us.

/**
 * @param {string} dir     'outbound' | 'inbound'
 * @param {string} [reason] what the carrier said, when it said anything
 * @returns {{status: string, error?: string}|null} the PATCH body, or null when nothing applies
 */
export function unconnectedPatch(dir, reason) {
  if (dir !== 'outbound') return null;
  const why = String(reason || '').trim();
  return why ? { status: 'failed', error: why.slice(0, 500) } : { status: 'canceled' };
}

/**
 * Fire-and-forget: records the attempt without ever blocking the cockpit's teardown.
 * @returns {object|null} the patch that was attempted, for tests
 */
export function recordUnconnected(api, callId, dir, reason) {
  const patch = unconnectedPatch(dir, reason);
  if (patch && callId) api.logCall(callId, patch).catch(() => { /* the ledger is best-effort here */ });
  return patch;
}
