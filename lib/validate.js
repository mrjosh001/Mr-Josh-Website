/**
 * Shared server-side input validation (never trust the browser alone).
 */
export function parsePositiveInt(value, { min = 1, max = 100, fallback = null } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, message: 'Invalid number' };
  if (n < min || n > max) return { ok: false, message: `Must be between ${min} and ${max}` };
  return { ok: true, value: n };
}

export function parseAmountNgn(value, { min = 100, max = 500000 } = {}) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return { ok: false, message: 'Invalid amount' };
  if (n < min) return { ok: false, message: `Minimum amount is ₦${min.toLocaleString()}` };
  if (n > max) return { ok: false, message: `Maximum amount is ₦${max.toLocaleString()}` };
  return { ok: true, value: n };
}

/** Reject if client-supplied user_id does not match JWT user. */
export function assertSameUser(jwtUserId, claimedUserId) {
  if (claimedUserId == null || claimedUserId === '') return { ok: true };
  if (String(claimedUserId) !== String(jwtUserId)) {
    return { ok: false, status: 403, message: 'You cannot act on another user account' };
  }
  return { ok: true };
}

export function sanitizeString(value, { maxLen = 200 } = {}) {
  if (value == null) return '';
  let s = String(value).trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  // strip obvious script tags
  s = s.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
  return s;
}

export default {
  parsePositiveInt,
  parseAmountNgn,
  assertSameUser,
  sanitizeString,
};
