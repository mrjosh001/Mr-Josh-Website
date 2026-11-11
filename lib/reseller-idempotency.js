import crypto from 'crypto';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = stable(value[key]);
      return out;
    }, {});
  }
  return value;
}

export function hashIdempotencyPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex');
}

export async function claimResellerIdempotency(supabase, resellerId, req, payload) {
  const key = String(req.headers['idempotency-key'] || '').trim();
  if (!key || key.length < 8 || key.length > 128) {
    return { error: { status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Provide an Idempotency-Key header between 8 and 128 characters.' } };
  }
  const { data, error } = await supabase.rpc('reseller_idempotency_claim', {
    p_reseller_id: resellerId,
    p_idempotency_key: key,
    p_request_hash: hashIdempotencyPayload(payload)
  });
  if (error) return { error: { status: 503, code: 'IDEMPOTENCY_UNAVAILABLE', message: 'Idempotency protection is unavailable.' } };
  if (data?.conflict) return { error: { status: 409, code: 'IDEMPOTENCY_CONFLICT', message: 'This Idempotency-Key was already used with a different request.' } };
  return { key, replay: data?.replay === true, orderId: data?.order_id || null, claimed: data?.claimed === true };
}

export async function bindResellerIdempotencyOrder(supabase, resellerId, key, orderId) {
  const { data, error } = await supabase.rpc('reseller_idempotency_bind_order', {
    p_reseller_id: resellerId,
    p_idempotency_key: key,
    p_order_id: orderId
  });
  if (error || data !== true) throw new Error('Could not bind idempotency key to reseller order');
  return true;
}
