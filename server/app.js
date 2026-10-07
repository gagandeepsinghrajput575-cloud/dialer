// Express app assembly: middleware -> API routers -> static client -> error handler.
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const routes = require('./routes');
const { requestLog } = require('./middleware/requestLog');
const { rateLimit } = require('./middleware/rateLimit');
const { errorHandler, ApiError } = require('./middleware/errorHandler');
const { root } = require('./config/env');
const { guard, session, hostAllowed } = require('./middleware/guard');

function createApp() {
  const app = express();
  // Only echo back an Origin we already trust — "*" let any website drive the API.
  app.use(cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);           // curl / the test suite / same-origin
      const host = String(origin).replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
      return cb(null, hostAllowed(host) || undefined);
    },
    credentials: false,
  }));
  app.use(express.json({ limit: '25mb' }));
  app.use(requestLog);
  app.use('/api', guard);
  app.use('/api', rateLimit({ windowMs: 60000, max: 1200, name: 'api' }));

  app.get('/api/session', session);
  app.use('/api', routes);
  app.use('/api', (req, res, next) => next(ApiError.notFound(`No such endpoint: ${req.method} ${req.originalUrl}`)));

  const dist = path.join(root, 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
