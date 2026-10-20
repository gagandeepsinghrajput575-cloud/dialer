// HTTP layer for the call lifecycle.
const callService = require('../services/callService');
const copilotService = require('../services/copilotService');
const prospectService = require('../services/prospectService');
const notes = require('../repositories/noteRepo');
const calls = require('../repositories/callRepo');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');

const start = asyncHandler(async (req, res) => {
  res.json(callService.start(req.params.id, { tzOffset: req.body?.tzOffset }));
});

const patch = asyncHandler(async (req, res) => {
  const result = callService.classify(req.params.id, req.body);
  res.json({ ok: true, status: result.call?.status, prospect: result.prospect, call: result.call });
});

// POST /api/calls/inbound — the browser softphone received a SIP INVITE. Creates the ledger
// row (matching the caller to a prospect, or provisioning a placeholder lead) and returns
// everything the incoming-call modal renders.
const inbound = asyncHandler(async (req, res) => res.json(callService.startInbound(req.body)));

// POST /api/calls/direct — ad-hoc manual dialpad calls
const directDial = asyncHandler(async (req, res) => res.json(callService.startDirectDial(req.body)));

// POST /api/calls/:id/missed — the ring ended unanswered (far-end CANCEL, or Decline).
const missed = asyncHandler(async (req, res) => res.json(callService.markInboundMissed(req.params.id, req.body)));

const voicemailDrop = asyncHandler(async (req, res) => res.json(callService.voicemailDrop(req.params.id, req.body)));

const discard = asyncHandler(async (req, res) => res.json(callService.discard(req.params.id)));

// AI copilot: summarize a finished (or in-flight) call and persist the result.
const summarize = asyncHandler(async (req, res) => {
  const call = calls.get(req.params.id);
  if (!call) throw ApiError.notFound('Call not found');
  const prospect = prospectService.detail(call.prospect_id);
  const result = await copilotService.summarize({ prospect, call, notes: prospect.notes });
  const saved = calls.patch(call.id, {
    summary: result.summary,
    next_step: (result.nextSteps || []).join(' | '),
  });
  res.json({ ...result, call: saved });
});

// GET /api/calls — paginated list of calls with search, direction, and outcome filters
const list = asyncHandler(async (req, res) => {
  const { search, direction, filter, outcome, limit, offset, dryRun } = req.query;
  const parsedLimit = limit ? parseInt(limit, 10) : 50;
  const parsedOffset = offset ? parseInt(offset, 10) : 0;
  const parsedDryRun = dryRun !== undefined ? (dryRun === '1' || dryRun === 'true') : null;

  const result = callService.listHistory({
    search,
    direction,
    filter,
    outcome,
    dryRun: parsedDryRun,
    limit: parsedLimit,
    offset: parsedOffset,
  });
  res.json(result);
});

module.exports = { list, start, directDial, inbound, missed, patch, voicemailDrop, discard, summarize };
