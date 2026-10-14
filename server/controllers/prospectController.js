// HTTP layer for prospects. Validation happens in the route; logic lives in the services.
const prospectService = require('../services/prospectService');
const csvService = require('../services/csvService');
const telephony = require('../services/telephonyService');
const followUpService = require('../services/followUpService');
const { asyncHandler } = require('../middleware/errorHandler');

const list = asyncHandler(async (req, res) => res.json(prospectService.list()));

const detail = asyncHandler(async (req, res) => res.json(prospectService.detail(req.params.id)));

// 200 (not 201) on purpose — the existing UI and test suite expect the legacy contract.
const create = asyncHandler(async (req, res) => res.json(prospectService.create(req.body)));

const patch = asyncHandler(async (req, res) => res.json(prospectService.update(req.params.id, req.body)));

const remove = asyncHandler(async (req, res) => { prospectService.remove(req.params.id); res.json({ ok: true }); });

const clearAll = asyncHandler(async (req, res) => { prospectService.clearAll(); res.json({ ok: true }); });

const bulk = asyncHandler(async (req, res) => res.json(await prospectService.bulkImport(req.body)));
const batchPronunciations = asyncHandler(async (req, res) => res.json(await prospectService.bulkPronunciations(req.body)));

// Bulk management from the prospects table. Both are atomic in the service layer, and both
// report what they actually changed so the UI never claims more than it did.
const bulkStage = asyncHandler(async (req, res) => res.json(prospectService.bulkUpdateStage(req.body.ids, req.body.stage)));
const bulkDelete = asyncHandler(async (req, res) => res.json(prospectService.bulkDelete(req.body.ids)));

const search = asyncHandler(async (req, res) => res.json(prospectService.search(req.query.q, req.query.limit)));

const queue = asyncHandler(async (req, res) => res.json(prospectService.rankedQueue({
  tab: req.query.tab,
  search: req.query.q,
  limit: req.query.limit !== undefined ? Number(req.query.limit) : undefined,
  cursor: req.query.cursor,
})));

const followUps = asyncHandler(async (req, res) => res.json({ due: followUpService.due(), businessHours: telephony.businessHours() }));

const demo = asyncHandler(async (req, res) => res.json({ ok: true, ...prospectService.loadDemo() }));

// GET /api/prospects/export?format=csv|json — CSV keeps the legacy column order.
const exportData = asyncHandler(async (req, res) => {
  const date = new Date().toISOString().slice(0, 10);
  if (String(req.query.format || 'csv').toLowerCase() === 'json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pulse-export-${date}.json"`);
    return res.send(JSON.stringify(csvService.toJson(), null, 2));
  }
  const { csv, filename } = csvService.toCsv();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

module.exports = { list, detail, create, patch, remove, clearAll, bulk, bulkStage, bulkDelete, batchPronunciations, search, queue, followUps, demo, exportData };
