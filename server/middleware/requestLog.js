// One line per request, skipped for static assets and during tests.
const { isTest, logRequests } = require('../config/env');

function requestLog(req, res, next) {
  if (isTest || !logRequests || req.path.startsWith('/assets')) return next();
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    if (req.path.startsWith('/api')) console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
}

module.exports = { requestLog };
