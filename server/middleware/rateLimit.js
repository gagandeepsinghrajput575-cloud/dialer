// Small in-memory token bucket. This is a single-user local app, so the limits are generous —
// they exist to stop a runaway script from hammering the dial endpoints.
const buckets = new Map();

const MAX_KEYS = 500;

// Expired buckets are dropped as we go, and the map is capped, so a long-running server
// cannot grow one entry per IP forever.
function sweep(now, windowMs) {
  for (const [key, bucket] of buckets) {
    if (now - bucket.startedAt > windowMs) buckets.delete(key);
  }
}

function rateLimit({ windowMs = 60000, max = 600, name = 'api' } = {}) {
  return (req, res, next) => {
    const key = `${name}:${req.ip || 'local'}`;
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.startedAt > windowMs) {
      if (buckets.size >= MAX_KEYS) sweep(now, windowMs);
      buckets.set(key, { startedAt: now, count: 1 });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.startedAt + windowMs - now) / 1000)));
      return res.status(429).json({ error: `Rate limit reached for ${name} (${max}/${Math.round(windowMs / 1000)}s). Slow down a little.` });
    }
    next();
  };
}

const clear = () => buckets.clear();
const size = () => buckets.size;
module.exports = { rateLimit, clear, size, sweep, MAX_KEYS };
