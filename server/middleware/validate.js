// Request validation. On failure the client gets { error, details: [{ field, message }] }.
const { ApiError } = require('./errorHandler');

const validate = (schema, source = 'body') => (req, res, next) => {
  const result = schema.safeParse(req[source] ?? {});
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ field: i.path.join('.') || source, message: i.message }));
    return next(ApiError.badRequest(details[0] ? details[0].message : 'Invalid request', details));
  }
  req[source] = result.data;
  next();
};

module.exports = { validate };
