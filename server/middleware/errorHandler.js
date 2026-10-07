// Structured errors. Throw ApiError anywhere; the handler turns it into a clean JSON response.
class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
  static badRequest(msg, details) { return new ApiError(400, msg, details); }
  static notFound(msg = 'Not found') { return new ApiError(404, msg); }
  static forbidden(msg) { return new ApiError(403, msg); }
  static unauthorized(msg = 'Unauthorized') { return new ApiError(401, msg); }
  static conflict(msg) { return new ApiError(409, msg); }
  static tooMany(msg) { return new ApiError(429, msg); }
}

// Multer reports upload problems as its own error class; the client should see a clean 4xx.
const MULTER_STATUS = {
  LIMIT_FILE_SIZE: 413,
  LIMIT_FILE_COUNT: 413,
  LIMIT_FIELD_COUNT: 400,
  LIMIT_FIELD_KEY: 400,
  LIMIT_FIELD_VALUE: 413,
  LIMIT_PART_COUNT: 413,
  LIMIT_UNEXPECTED_FILE: 400,
};

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let status = err.status || 500;
  let message = err.message || 'Unexpected error';
  let details = err.details;

  if (err.name === 'MulterError' || err.code in MULTER_STATUS) {
    status = MULTER_STATUS[err.code] || 400;
    message = err.code === 'LIMIT_FILE_SIZE'
      ? `File too large. The limit is ${Math.round((err.limit || 30 * 1024 * 1024) / 1048576)} MB.`
      : `Upload rejected: ${err.code || message}`;
  }
  if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'That is not valid JSON.';
  }
  if (err.type === 'entity.too.large') {
    status = 413;
    message = 'Request body too large.';
  }

  if (status >= 500) console.error('[error]', err);
  // Streaming responses (file downloads, SSE) may already have flushed their headers;
  // writing a JSON error then would throw a second time and take the process down.
  if (res.headersSent) return next(err);
  res.status(status).json({ error: message, details });
}

// Wraps async controllers so rejected promises reach the error handler.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { ApiError, errorHandler, asyncHandler };
