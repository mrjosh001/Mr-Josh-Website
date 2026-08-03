/**
 * POST /api/pocketfi
 *
 * Single Hobby-safe endpoint for both flows (counts as 1 serverless function):
 *  - Checkout: Authorization Bearer + JSON { amount }
 *  - Webhook:  PocketFi signature header + raw body
 *
 * Optional rewrites in vercel.json:
 *   /api/pocketfi-checkout  → /api/pocketfi
 *   /api/pocketfi-webhook   → /api/pocketfi
 *
 * Env: POCKETFI_SECRET_KEY, POCKETFI_PUBLIC_KEY, POCKETFI_BUSINESS_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional: POCKETFI_API_BASE (default https://api.pocketfi.ng/api/v1)
 *           APP_URL (default https://app.mjhub.store)
 *
 * POCKETFI_SECRET_KEY  → used only to verify the webhook signature (HMAC).
 * POCKETFI_PUBLIC_KEY  → sent as the Bearer token on checkout requests.
 *                        (PocketFi's Public API Key, shown on their
 *                        dashboard — looks like "12345|randomChars...")
 *
 * PocketFi dashboard webhook URL: https://app.mjhub.store/api/pocketfi
 *   (or /api/pocketfi-webhook if rewrite is configured)
 */
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MIN = 1500;
const MAX = 500000;

export const config = {
  api: {
    bodyParser: false // raw body required for webhook HMAC
  }
};

function splitName(full) {
  const parts = String(full || 'Customer User').trim().split(/\s+/);
  const first_name = parts[0] || 'Customer';
  const last_name = parts.slice(1).join(' ') || 'User';
  return { first_name, last_name };
}

async function readRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function getSignature(req) {
  return (
    req.headers['http_pocketfi_signature'] ||
    req.headers['x-pocketfi-signature'] ||
    req.headers['pocketfi-signature'] ||
    ''
  );
}

function isWebhookRequest(req, signature) {
  if (signature) return true;
  const url = req.url || '';
  if (url.includes('mode=webhook') || url.includes('pocketfi-webhook')) return true;
  return false;
}

async function handleWebhook(req, res, raw, secret) {
  const signature = getSignature(req);
  const hashkey = crypto.createHmac('sha512', secret).update(raw).digest('hex');
  if (!signature || signature !== hashkey) {
    console.warn('PocketFi webhook bad signature');
    return res.status(400).json({ message: 'Invalid signature' });
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return res.status(400).json({ message: 'Invalid JSON' });
  }

  const amount = Number(data?.order?.amount || data?.amount || 0);
  const reference =
    data?.transaction?.reference ||
    data?.payment_id ||
    data?.reference ||
    null;

  if (!reference || !(amount > 0)) {
    return res.status(200).json({ message: 'ignored' });
  }

  const { data: existing } = await supabase
    .from('transactions')
    .select('id, user_id, status')
    .eq('external_reference', reference)
    .maybeSingle();

  if (existing && String(existing.status).toLowerCase() === 'success') {
    return res.status(200).json({ message: 'already processed' });
  }

  let userId = existing?.user_id || null;

  if (!userId) {
    const { data: intent } = await supabase
      .from('deposit_intents')
      .select('user_id, amount, status')
      .eq('external_id', reference)
      .maybeSingle();
    if (intent?.user_id) userId = intent.user_id;
  }

  if (!userId) {
    const { data: pending } = await supabase
      .from('transactions')
      .select('id, user_id')
      .eq('payment_provider', 'pocketfi')
      .eq('status', 'pending')
      .eq('external_reference', reference)
      .maybeSingle();
    if (pending?.user_id) userId = pending.user_id;
  }

  if (!userId) {
    console.error('PocketFi webhook: no user for reference', reference);
    return res.status(200).json({ message: 'no matching user — logged' });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('balance, balance_ngn')
    .eq('id', userId)
    .maybeSingle();

  const current = Number(profile?.balance_ngn ?? profile?.balance ?? 0) || 0;
  const next = current + amount;

  const updatePayload = { balance: next };
  if (profile && Object.prototype.hasOwnProperty.call(profile, 'balance_ngn')) {
    updatePayload.balance_ngn = next;
  }

  const { error: balErr } = await supabase
    .from('profiles')
    .update(updatePayload)
    .eq('id', userId);

  if (balErr) {
    console.error('balance update failed', balErr);
    return res.status(500).json({ message: 'balance update failed' });
  }

  if (existing?.id) {
    await supabase
      .from('transactions')
      .update({
        status: 'success',
        title: 'PocketFi deposit',
        subtitle: 'Manual NGN via PocketFi',
        amount: amount
      })
      .eq('id', existing.id);
  } else {
    await supabase.from('transactions').insert({
      user_id: userId,
      type: 'deposit',
      title: 'PocketFi deposit',
      subtitle: 'Funded NGN Wallet',
      amount: amount,
      currency: 'NGN',
      status: 'success',
      payment_provider: 'pocketfi',
      external_reference: reference,
      channel: 'PocketFi'
    });
  }

  try {
    await supabase
      .from('deposit_intents')
      .update({ status: 'success' })
      .eq('external_id', reference);
  } catch (_) {}

  return res.status(200).json({ message: 'success' });
}

async function handleCheckout(req, res, raw, publicKey, businessId) {
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

  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return res.status(400).json({ success: false, message: 'Invalid JSON body' });
  }

  const amount = Math.round(Number(body?.amount) || 0);
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
        Authorization: `Bearer ${publicKey}`
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    return res.status(502).json({
      success: false,
      message: 'Could not reach PocketFi: ' + e.message
    });
  }

  const pfRaw = await pfRes.text();
  let data;
  try {
    data = JSON.parse(pfRaw);
  } catch {
    return res.status(502).json({
      success: false,
      message: 'PocketFi returned non-JSON',
      raw: pfRaw.slice(0, 400)
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
    console.warn('pending tx insert:', e.message || e);
  }

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'POST only' });
  }

  const secret = process.env.POCKETFI_SECRET_KEY;
  const publicKey = process.env.POCKETFI_PUBLIC_KEY;
  const businessId = process.env.POCKETFI_BUSINESS_ID;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, message: 'Missing Supabase env' });
  }
  if (!secret) {
    return res.status(500).json({
      success: false,
      message: 'Missing POCKETFI_SECRET_KEY'
    });
  }

  const raw = await readRawBody(req);
  const signature = getSignature(req);

  if (isWebhookRequest(req, signature)) {
    return handleWebhook(req, res, raw, secret);
  }

  if (!publicKey) {
    return res.status(500).json({
      success: false,
      message: 'Missing POCKETFI_PUBLIC_KEY'
    });
  }

  if (!businessId) {
    return res.status(500).json({
      success: false,
      message: 'Missing POCKETFI_BUSINESS_ID'
    });
  }

  return handleCheckout(req, res, raw, publicKey, businessId);
}
