/**
 * POST /api/pocketfi-checkout
 * Body: { amount: number }
 * Auth: Bearer <supabase access token>
 *
 * Creates a PocketFi hosted checkout session and returns payment_link.
 * Env: POCKETFI_SECRET_KEY, POCKETFI_BUSINESS_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional: POCKETFI_API_BASE (default https://api.pocketfi.ng/api/v1)
 *           APP_URL (default https://app.mjhub.store)
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MIN = 1500;
const MAX = 500000;

function splitName(full) {
  const parts = String(full || 'Customer User').trim().split(/\s+/);
  const first_name = parts[0] || 'Customer';
  const last_name = parts.slice(1).join(' ') || 'User';
  return { first_name, last_name };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'POST only' });
  }

  const secret = process.env.POCKETFI_SECRET_KEY;
  const businessId = process.env.POCKETFI_BUSINESS_ID;
  if (!secret || !businessId) {
    return res.status(500).json({
      success: false,
      message: 'Missing POCKETFI_SECRET_KEY or POCKETFI_BUSINESS_ID'
    });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, message: 'Missing Supabase env' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ success: false, message: 'Login required' });
  }

  const {
    data: { user },
    error: authErr
  } = await supabase.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).json({ success: false, message: 'Invalid session' });
  }

  const amount = Math.round(Number(req.body?.amount) || 0);
  if (amount < MIN) {
    return res.status(400).json({
      success: false,
      message: `Minimum deposit is ₦${MIN.toLocaleString()}`
    });
  }
  if (amount > MAX) {
    return res.status(400).json({
      success: false,
      message: `Maximum deposit is ₦${MAX.toLocaleString()}`
    });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, email, phone, customer_id')
    .eq('id', user.id)
    .maybeSingle();

  const { first_name, last_name } = splitName(
    profile?.full_name || user.user_metadata?.full_name
  );
  const email = profile?.email || user.email || '';
  const phone = String(profile?.phone || user.phone || '08000000000').replace(/\D/g, '');
  const phoneFmt = phone.length >= 10 ? phone.slice(-11) : '08000000000';

  const appUrl = (process.env.APP_URL || 'https://app.mjhub.store').replace(/\/$/, '');
  // Encode user id in redirect so callback page can refresh balance
  const redirect_link = `${appUrl}/?deposit=pocketfi&uid=${encodeURIComponent(user.id)}`;

  const base = (process.env.POCKETFI_API_BASE || 'https://api.pocketfi.ng/api/v1').replace(
    /\/$/,
    ''
  );

  const payload = {
    first_name,
    last_name,
    phone: phoneFmt,
    business_id: String(businessId),
    email: email || `user-${user.id.slice(0, 8)}@mjhub.store`,
    redirect_link,
    amount: String(amount)
  };

  let pfRes;
  try {
    pfRes = await fetch(`${base}/checkout/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    return res.status(502).json({
      success: false,
      message: 'Could not reach PocketFi: ' + e.message
    });
  }

  const raw = await pfRes.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return res.status(502).json({
      success: false,
      message: 'PocketFi returned non-JSON',
      raw: raw.slice(0, 400)
    });
  }

  if (!pfRes.ok || (data.status && data.status !== 'success')) {
    return res.status(502).json({
      success: false,
      message: data.message || data.error || 'PocketFi checkout failed',
      data
    });
  }

  const paymentId = data.payment_id || data.paymentId || null;
  const paymentLink = data.payment_link || data.paymentLink || null;
  if (!paymentLink) {
    return res.status(502).json({
      success: false,
      message: 'No payment_link in PocketFi response',
      data
    });
  }

  // Pending deposit record (idempotent credit later via webhook)
  try {
    await supabase.from('transactions').insert({
      user_id: user.id,
      type: 'deposit',
      title: 'PocketFi deposit (pending)',
      subtitle: paymentId || 'checkout',
      amount: amount,
      currency: 'NGN',
      status: 'pending',
      payment_provider: 'pocketfi',
      external_reference: paymentId,
      channel: 'PocketFi',
      meta: { payment_id: paymentId, redirect_link }
    });
  } catch (e) {
    // Non-fatal if schema differs — webhook can still credit by reference map
    console.warn('pending tx insert:', e.message || e);
  }

  // Optional pending table if you create deposit_intents
  try {
    await supabase.from('deposit_intents').upsert(
      {
        user_id: user.id,
        provider: 'pocketfi',
        amount,
        external_id: paymentId,
        status: 'pending',
        created_at: new Date().toISOString()
      },
      { onConflict: 'external_id' }
    );
  } catch (_) {
    /* optional table */
  }

  return res.status(200).json({
    success: true,
    payment_id: paymentId,
    payment_link: paymentLink,
    amount
  });
}
