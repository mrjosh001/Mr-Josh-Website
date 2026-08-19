export function publicError(err, fallback = 'Something went wrong') {
  const msg = (err && err.message) ? String(err.message) : String(err || fallback);
  if (/service_role|api[_-]?key|password|secret|Bearer\s+\S+/i.test(msg)) return fallback;
  if (msg.length > 200) return fallback;
  return msg || fallback;
}

export function logError(scope, err) {
  const msg = err && err.stack ? err.stack : (err && err.message) || err;
  console.error('[' + scope + ']', msg);
}

export function sendError(res, status, message, err, scope = 'api') {
  if (err) logError(scope, err);
  return res.status(status).json({
    success: false,
    message: message || publicError(err),
  });
}

export default { publicError, logError, sendError };
