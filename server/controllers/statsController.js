const statsService = require('../services/statsService');
const { asyncHandler } = require('../middleware/errorHandler');

const stats = asyncHandler(async (req, res) => {
  const tzOffset = req.query.tzOffset !== undefined ? parseInt(req.query.tzOffset, 10) : null;
  res.json(statsService.stats({ tzOffset }));
});

module.exports = { stats };
