/**
 * Durable per-user/per-product cooldown for log purchases.
 * Uses a Postgres RPC so protection is shared across Vercel serverless instances.
 */
export async function claimLogPurchaseCooldown(supabase, userId, productKey, seconds = 10) {
  const { data, error } = await supabase.rpc('claim_log_purchase_cooldown', {
    p_user_id: userId,
    p_product_key: String(productKey || '').trim(),
    p_cooldown_seconds: seconds
  });
  if (error) {
    console.error('[log purchase guard] cooldown RPC failed', error.message);
    return { ok: false, unavailable: true };
  }
  return { ok: data === true, blocked: data !== true };
}
