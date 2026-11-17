/**
 * Durable idempotent purchase-attempt ledger for MJ HUB SMS suppliers.
 * This helper only records purchase lifecycle state. Supplier calls and wallet
 * operations remain in their existing service handlers.
 */
const ALLOWED = new Set([
  'grizzlysms',
  'herosms',
  'smsbus',
  'smsbus_rent',
  'gotsms',
  'virtualsms',
  'virtualsms_rent'
]);

export async function reserveSmsPurchaseAttempt(supabase, input) {
  const source = String(input.source || '').toLowerCase().trim();
  if (!ALLOWED.has(source)) throw new Error('Unsupported SMS supplier source');
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  if (!idempotencyKey) throw new Error('A stable purchase idempotency key is required');

  const priceNgn = Number(input.priceNgn);
  if (!Number.isFinite(priceNgn) || priceNgn <= 0) {
    throw new Error('A valid customer purchase price is required');
  }

  const row = {
    user_id: input.userId,
    source,
    idempotency_key: idempotencyKey,
    country_id: Number.isFinite(Number(input.countryId)) ? Number(input.countryId) : null,
    service_id: String(input.serviceId || input.requestKind || 'sms_purchase'),
    provider_id: input.providerId == null ? null : String(input.providerId),
    price_ngn: priceNgn,
    supplier_price_usd: input.supplierPriceUsd == null ? null : Number(input.supplierPriceUsd),
    request_kind: input.requestKind == null ? null : String(input.requestKind),
    request_metadata: input.requestMetadata && typeof input.requestMetadata === 'object'
      ? input.requestMetadata : {},
    state: 'initiated'
  };

  const { data, error } = await supabase.from('sms_purchase_attempts')
    .insert(row).select('*').single();
  if (!error && data) return { created: true, attempt: data };

  if (error && (error.code === '23505' || /duplicate key/i.test(error.message || ''))) {
    const { data: existing, error: readError } = await supabase.from('sms_purchase_attempts')
      .select('*').eq('user_id', input.userId).eq('source', source)
      .eq('idempotency_key', idempotencyKey).maybeSingle();
    if (readError) throw readError;
    if (existing) return { created: false, attempt: existing };
  }
  throw error || new Error('Could not reserve SMS purchase attempt');
}

export async function updateSmsPurchaseAttempt(supabase, id, fields) {
  if (!id) throw new Error('Purchase attempt id is required');
  const { data, error } = await supabase.from('sms_purchase_attempts')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id).select('id,state').single();
  if (error || !data) throw error || new Error('Purchase attempt update was not saved');
  return data;
}

// Backwards-compatible names used by the existing GrizzlySMS and HeroSMS paths.
export const reserveServer1Attempt = reserveSmsPurchaseAttempt;
export const updateServer1Attempt = updateSmsPurchaseAttempt;

export async function recordServer1PurchaseTransaction(supabase, fields) {
  // A wallet debit is the stable identity of one SMS purchase. Reuse its
  // existing transaction row for pending, completed and refunded transitions.
  const externalReference = String(fields.walletDebitId || '').trim();
  if (!externalReference) throw new Error('SMS purchase wallet debit reference is required');
  const tx = {
    user_id: fields.userId,
    customer_id: fields.customerId || null,
    type: 'purchase',
    category: 'MJ SMS',
    title: fields.title || 'SMS purchase',
    subtitle: fields.subtitle || '',
    amount: `₦${Number(fields.priceNgn || 0).toLocaleString()}`,
    amount_ngn: Number(fields.ngnDebited || 0),
    amount_usd: Number(fields.usdDebited || 0),
    external_reference: externalReference,
    status: fields.status,
    notes: fields.notes || null,
    supplier_order: fields.supplierOrder || null
  };

  const { data: existing, error: lookupError } = await supabase.from('transactions')
    .select('id')
    .eq('user_id', fields.userId)
    .eq('type', 'purchase')
    .eq('category', 'MJ SMS')
    .eq('external_reference', externalReference)
    .limit(1)
    .maybeSingle();
  if (lookupError) throw lookupError;

  if (existing?.id) {
    const { data, error } = await supabase.from('transactions')
      .update(tx)
      .eq('id', existing.id)
      .select('id')
      .maybeSingle();
    if (error || !data) throw error || new Error('Existing SMS purchase transaction was not updated');
    return data;
  }

  const { data, error } = await supabase.from('transactions')
    .insert(tx)
    .select('id')
    .maybeSingle();
  if (error || !data) throw error || new Error('SMS purchase transaction was not inserted');
  return data;
}
