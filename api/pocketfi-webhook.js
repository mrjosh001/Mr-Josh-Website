/**
 * POST /api/pocketfi-webhook
 * PocketFi payment webhook — verify HMAC-SHA512 and credit NGN balance once.
 *
 * Env: POCKETFI_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Dashboard: Settings → Webhooks → https://app.mjhub.store/api/pocketfi-webhook
 */
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const config = {
  api: {
    bodyParser: false // need raw body for signature
  }
};

async function readRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  // Vercel may still parse JSON — fall back
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'POST only' });
  }

  const secret = process.env.POCKETFI_SECRET_KEY;
  if (!secret || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ message: 'Server misconfigured' });
  }

  const raw = await readRawBody(req);
  const signature =
    req.headers['http_pocketfi_signature'] ||
    req.headers['x-pocketfi-signature'] ||
    req.headers['pocketfi-signature'] ||
    '';

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
    // Ack so PocketFi stops retrying malformed payloads we can't process
    return res.status(200).json({ message: 'ignored' });
  }

  // Idempotency: already completed?
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

  // Try match pending by payment_id style reference
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

  const current =
    Number(profile?.balance_ngn ?? profile?.balance ?? 0) || 0;
  const next = current + amount;

  // Support either balance or balance_ngn column
  const updatePayload = { balance: next };
  if (profile && 'balance_ngn' in (profile || {})) {
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
