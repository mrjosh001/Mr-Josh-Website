/**
 * MJ HUB coupons — validate + redeem (service-role only).
 * Any active admin-created code works. Not limited to a single campaign.
 * Tables: public.coupons, public.coupon_redemptions
 */

function normCode(code) {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, '');
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Quote a coupon against a subtotal. Does not redeem.
 * appliesTo: 'logs' | 'sms' | 'boosters' | 'esim' | 'all'
 */
export async function quoteCoupon(supabase, { code, userId, subtotal, appliesTo = 'all' }) {
  const c = normCode(code);
  if (!c) return { ok: false, message: 'Enter a coupon code' };
  if (!userId) return { ok: false, message: 'Sign in required' };

  const sub = Math.max(0, num(subtotal));
  if (sub <= 0) return { ok: false, message: 'Nothing to discount' };

  const { data: coupon, error } = await supabase
    .from('coupons')
    .select('*')
    .eq('code', c)
    .maybeSingle();

  if (error) {
    console.warn('[coupon] lookup', error.message);
    return { ok: false, message: 'Could not check code. Try again.' };
  }
  if (!coupon) return { ok: false, message: 'Invalid coupon code' };
  if (coupon.active === false) return { ok: false, message: 'This coupon is not active' };

  const now = Date.now();
  if (coupon.starts_at && new Date(coupon.starts_at).getTime() > now) {
    return { ok: false, message: 'This coupon is not active yet' };
  }
  if (coupon.ends_at && new Date(coupon.ends_at).getTime() < now) {
    return { ok: false, message: 'This coupon has expired' };
  }

  const scope = String(coupon.applies_to || 'all').toLowerCase();
  const want = String(appliesTo || 'all').toLowerCase();
  if (scope !== 'all' && scope !== want) {
    return { ok: false, message: 'This coupon does not apply to this purchase' };
  }

  const minOrder = num(coupon.min_order_ngn, 0);
  if (minOrder > 0 && sub < minOrder) {
    return {
      ok: false,
      message: 'Minimum order for this coupon is ₦' + minOrder.toLocaleString()
    };
  }

  if (coupon.max_uses != null) {
    const { count, error: cErr } = await supabase
      .from('coupon_redemptions')
      .select('id', { count: 'exact', head: true })
      .eq('coupon_id', coupon.id);
    if (!cErr && count != null && count >= num(coupon.max_uses)) {
      return { ok: false, message: 'This coupon has reached its usage limit' };
    }
  }

  const perUser = coupon.max_uses_per_user != null ? num(coupon.max_uses_per_user, 1) : 1;
  if (perUser > 0) {
    const { count, error: uErr } = await supabase
      .from('coupon_redemptions')
      .select('id', { count: 'exact', head: true })
      .eq('coupon_id', coupon.id)
      .eq('user_id', userId);
    if (!uErr && count != null && count >= perUser) {
      return { ok: false, message: 'You have already used this coupon' };
    }
  }

  let discount = 0;
  const percent = coupon.percent_off != null ? num(coupon.percent_off) : null;
  const fixed = coupon.amount_off_ngn != null ? num(coupon.amount_off_ngn) : null;

  if (percent != null && percent > 0) {
    discount = Math.floor(sub * (Math.min(percent, 100) / 100));
  } else if (fixed != null && fixed > 0) {
    discount = Math.min(fixed, sub);
  } else {
    return { ok: false, message: 'This coupon has no discount configured' };
  }

  discount = Math.max(0, Math.min(discount, sub));
  return {
    ok: true,
    code: c,
    coupon,
    discount,
    finalTotal: Math.max(0, sub - discount),
    subtotal: sub,
    percent_off: percent,
    amount_off_ngn: fixed
  };
}

/** After a successful paid order only. */
export async function redeemCoupon(supabase, { couponId, userId, orderRef, amountSaved }) {
  try {
    if (!couponId || !userId) return;
    await supabase.from('coupon_redemptions').insert({
      coupon_id: couponId,
      user_id: userId,
      order_ref: orderRef ? String(orderRef).slice(0, 120) : null,
      amount_saved_ngn: num(amountSaved)
    });
  } catch (e) {
    console.warn('[coupon] redeem', e?.message || e);
  }
}
