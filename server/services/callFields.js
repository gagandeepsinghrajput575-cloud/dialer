// The columns a call PATCH writes. Pure, so the lifecycle is testable without HTTP or a carrier.
//
// `connected` arrives mid-call and must not close the row. `completed`, `failed` (the carrier
// rejected the INVITE) and `canceled` (the agent hung up before answer) are terminal. A failed
// or canceled attempt never becomes a conversation: it records why, and the lead's stage is
// left to the disposition flow, which is never reached for these calls.

/**
 * @param {object} call   the row being patched (needs `direction` and `status`)
 * @param {object} input  the validated PATCH body
 * @param {string} endedAt SQL timestamp supplied by the caller
 * @returns {object} column values for `callRepo.patch`
 */
function buildClassifyFields(call, input = {}, endedAt) {
  const fields = { ended_at: endedAt };
  if (input.outcome) fields.outcome = input.outcome;
  // A late cancel/rejection (a best-effort ledger patch racing a real answer) must never erase a
  // conversation that already carries talk time.
  const real = call.status === 'completed' || Number(call.duration_sec) > 0;
  if (input.status === 'connected') { fields.status = 'connected'; delete fields.ended_at; }
  else if (input.status === 'completed' || (call.direction === 'inbound' && call.status === 'connected')) fields.status = 'completed';
  else if ((input.status === 'failed' || input.status === 'canceled') && !real) fields.status = input.status;
  if (input.error !== undefined) fields.error = String(input.error || '').slice(0, 500);
  if (Number.isFinite(input.duration_sec)) fields.duration_sec = Math.round(input.duration_sec);
  if (input.vm_dropped !== undefined) fields.vm_dropped = input.vm_dropped ? 1 : 0;
  if (input.summary !== undefined) fields.summary = String(input.summary || '').slice(0, 4000);
  if (input.next_step !== undefined) fields.next_step = String(input.next_step || '').slice(0, 1000);
  if (input.follow_up_at !== undefined) fields.follow_up_at = input.follow_up_at || null;
  return fields;
}

module.exports = { buildClassifyFields };
