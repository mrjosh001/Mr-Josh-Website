/**
 * Lightweight in-memory rate limiter for Vercel serverless.
 * Each isolate has its own map — blunts bursts; not a global cluster limit.
 */
const buckets = new Map();

function clientKey(req, suffix = '') {
  const xf = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '')
    .toString()
    .split(',')[0]
    .trim();
  const ip = xf || 'unknown';
  const auth = (req.headers.authorization || '').slice(0, 24);
  return ip + '|' + auth + '|' + suffix;
}

export function rateLimit(req, opts = {}) {
  const limit = Math.max(1, opts.limit || 60);
  const windowMs = Math.max(1000, opts.windowMs || 60_000);
  const key = opts.key || clientKey(req, opts.suffix || '');
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (buckets.size > 5000) {
    const first = buckets.keys().next().value;
    buckets.delete(first);
  }
  if (b.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
    return {
      ok: false,
      status: 429,
      message: 'Too many requests. Please wait and try again.',
      retryAfter,
    };
  }
  return { ok: true, remaining: limit - b.count, resetAt: b.resetAt };
}

export function applyRateLimitHeaders(res, result) {
  if (!result) return;
  if (result.ok === false && result.retryAfter) {
    res.setHeader('Retry-After', String(result.retryAfter));
  }
  if (typeof result.remaining === 'number') {
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  }
}

export default { rateLimit, applyRateLimitHeaders, clientKey };
