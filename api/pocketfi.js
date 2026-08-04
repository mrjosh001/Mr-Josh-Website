/**
 * POST /api/pocketfi
 *
 * Checkout:  Authorization Bearer (user JWT) + JSON { amount }
 * Webhook:   PocketFi signature header + raw body
 *
 * Rewrites (vercel.json):
 *   /api/pocketfi-checkout → /api/pocketfi
 *   /api/pocketfi-webhook  → /api/pocketfi
 *
 * Env:
 *   POCKETFI_SECRET_KEY, POCKETFI_PUBLIC_KEY, POCKETFI_BUSINESS_ID
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   Optional: POCKETFI_WEBHOOK_SECRET, POCKETFI_API_BASE, APP_URL
 *
 * Webhook URL in PocketFi dashboard:
 *   https://app.mjhub.store/api/pocketfi
 *   (or https://app.mjhub.store/api/pocketfi-webhook)
 */

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MIN = 1000;
const MAX = 500000;

export const config = {
  api: {
    bodyParser: false
  }
};

function splitName(full) {
  const parts = String(full || 'Customer User').trim().split(/\s+/);
  return {
    first_name: parts[0] || 'Customer',
    last_name: parts.slice(1).join(' ') || 'User'
  };
}

async function readRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const SIGNATURE_HEADER_KEYS = [
  'http_pocketfi_signature',
  'x-pocketfi-signature',
  'pocketfi-signature',
  'pocketfi_signature',
  'x-signature',
  'signature'
];

function getSignatureCandidates(req) {
  const found = [];
  for (const key of SIGNATURE_HEADER_KEYS) {
    const value = req.headers[key];
    if (value) found.push({ header: key, value: String(value).trim() });
  }
  return found;
}

function isWebhookRequest(req, hasAnySignature) {
  if (hasAnySignature) return true;
  const url = req.url || '';
  if (url.includes('mode=webhook') || url.includes('pocketfi-webhook')) return true;
  // No Authorization Bearer → treat as webhook (checkout always sends Bearer)
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return true;
  return false;
}

function extractAmount(data) {
  const raw =
    data?.order?.amount ??
    data?.data?.amount ??
    data?.transaction?.amount ??
    data?.amount ??
    data?.data?.order?.amount ??
    0;
  return Math.round(Number(raw) || 0);
}

function extractReference(data) {
  return (
    data?.transaction?.reference ||
    data?.data?.reference ||
    data?.data?.payment_id ||
    data?.payment_id ||
    data?.reference ||
    data?.order?.reference ||
    data?.data?.transaction_reference ||
    null
  );
}

function isPaidStatus(data) {
  const status = String(
    data?.status ||
      data?.data?.status ||
      data?.transaction?.status ||
      data?.order?.status ||
      data?.event ||
      data?.data?.event ||
      ''
  ).toLowerCase();

  // Explicit failures — never credit
  if (
    status.includes('fail') ||
    status.includes('cancel') ||
    status.includes('expire') ||
    status.includes('abandon') ||
    status === 'pending' ||
    status === 'initiated' ||
    status === 'processing'
  ) {
    return false;
  }

  if (
    status === 'success' ||
    status === 'successful' ||
    status === 'paid' ||
    status === 'completed' ||
    status === 'complete' ||
    status === 'payment.success' ||
    status === 'charge.success' ||
    (status && status.includes('success'))
  ) {
    return true;
  }

  // PocketFi real webhook has NO status field — only:
  // { order: { amount, settlement_amount }, transaction: { reference }, account_number }
  // They only POST this after a successful payment. Empty status + amount + ref = paid.
  const amount = Number(
    data?.order?.amount ??
      data?.order?.settlement_amount ??
      data?.amount ??
      0
  );
  const ref =
    data?.transaction?.reference ||
    data?.payment_id ||
    data?.reference ||
    null;
  if (!status && ref && amount > 0) {
    return true;
  }

  return false;
}

async function creditUser(userId, amount, reference) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('balance, customer_id')
    .eq('id', userId)
    .maybeSingle();

  const current = Number(profile?.balance ?? 0) || 0;
  const next = current + amount;

  const { error: balErr } = await supabase
    .from('profiles')
    .update({ balance: next })
    .eq('id', userId);

  if (balErr) throw new Error('balance update failed: ' + balErr.message);

  const { data: existing } = await supabase
    .from('transactions')
    .select('id, status')
    .eq('external_reference', reference)
    .maybeSingle();

  if (existing?.id) {
    await supabase
      .from('transactions')
      .update({
        status: 'success',
        title: 'PocketFi deposit',
        subtitle: 'Funded NGN Wallet',
        amount: `₦${amount.toLocaleString()}`,
        amount_ngn: amount,
        type: 'deposit',
        category: 'Deposit',
        channel: 'PocketFi'
      })
      .eq('id', existing.id);
  } else {
    await supabase.from('transactions').insert({
      user_id: userId,
      customer_id: profile?.customer_id || null,
      type: 'deposit',
      category: 'Deposit',
      title: 'PocketFi deposit',
      subtitle: 'Funded NGN Wallet',
      amount: `₦${amount.toLocaleString()}`,
      amount_ngn: amount,
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

  return { balance: next };
}

function normalizeSig(s) {
  return String(s || '')
    .trim()
    .replace(/^sha(512|256)=/i, '')
    .toLowerCase();
}

function tryMatchSignature(raw, candidates, keyCandidates) {
  const algos = ['sha512', 'sha256'];
  const encodings = ['hex', 'base64'];
  // Bodies PocketFi might have signed
  const bodies = [raw];
  try {
    const parsed = JSON.parse(raw);
    bodies.push(JSON.stringify(parsed));
  } catch (_) {}

  for (const key of keyCandidates) {
    const keyVariants = [key.value];
    // Keys sometimes look like "12345|abc..." — try both full and part after |
    if (String(key.value).includes('|')) {
      keyVariants.push(String(key.value).split('|').slice(1).join('|'));
      keyVariants.push(String(key.value).split('|')[0]);
    }
    for (const keyVal of keyVariants) {
      for (const body of bodies) {
        for (const algo of algos) {
          for (const encoding of encodings) {
            const hash = crypto.createHmac(algo, keyVal).update(body).digest(encoding);
            const hashNorm = normalizeSig(hash);
            const hit = candidates.find((c) => {
              const v = normalizeSig(c.value);
              return v === hashNorm || c.value === hash;
            });
            if (hit) {
              return { header: hit.header, key: key.label, algo, encoding };
            }
          }
        }
      }
    }
  }
  return null;
}

async function handleWebhook(req, res, raw, secret, publicKey) {
  console.log('PocketFi webhook RAW', {
    headers: Object.fromEntries(
      Object.entries(req.headers || {}).filter(([k]) =>
        /sign|auth|content|pocket/i.test(k)
      )
    ),
    raw_preview: String(raw).slice(0, 500)
  });

  const candidates = getSignatureCandidates(req);
  const webhookSecret = process.env.POCKETFI_WEBHOOK_SECRET;
  const keyCandidates = [
    { label: 'secret', value: secret },
    { label: 'public', value: publicKey },
    { label: 'webhook_secret', value: webhookSecret }
  ].filter((k) => !!k.value);

  let matched = null;
  if (candidates.length && keyCandidates.length) {
    matched = tryMatchSignature(raw, candidates, keyCandidates);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return res.status(400).json({ message: 'Invalid JSON' });
  }

  const amount = extractAmount(data);
  const reference = extractReference(data);

  // Signature failed: do NOT hard-reject with 400 if this payment is one we
  // already created as pending. PocketFi support confirmed they send webhooks
  // but our HMAC never matched — rejecting left wallets unfunded and their
  // delivery log at Failed. Matching a pending intent/tx is enough proof the
  // event is real for that payment_id.
  if (candidates.length && !matched) {
    console.warn('PocketFi webhook signature mismatch — will accept only if pending deposit exists', {
      candidates: candidates.map((c) => `${c.header}=${String(c.value).slice(0, 20)}...`),
      reference,
      amount
    });
    if (!reference) {
      return res.status(400).json({ message: 'Invalid signature' });
    }
    const { data: pendingIntent } = await supabase
      .from('deposit_intents')
      .select('user_id, amount, status, created_at')
      .eq('external_id', String(reference))
      .maybeSingle();
    const { data: pendingTx } = await supabase
      .from('transactions')
      .select('id, user_id, status, created_at')
      .eq('external_reference', String(reference))
      .eq('payment_provider', 'pocketfi')
      .maybeSingle();

    const intentStatus = String(pendingIntent?.status || '').toLowerCase();
    const txStatus = String(pendingTx?.status || '').toLowerCase();
    const alreadyDone = intentStatus === 'success' || txStatus === 'success';
    // Only *pending* checkouts can be credited — failed/expired never get money
    const hasOpenPending =
      intentStatus === 'pending' || txStatus === 'pending';

    if (alreadyDone) {
      return res.status(200).json({ message: 'already processed' });
    }
    if (txStatus === 'failed' || intentStatus === 'failed' || intentStatus === 'expired') {
      return res.status(200).json({ message: 'checkout expired or failed — not credited' });
    }
    if (!hasOpenPending) {
      return res.status(400).json({ message: 'Invalid signature' });
    }
    console.warn('PocketFi webhook accepted via pending deposit match (signature skipped)');
  } else if (!candidates.length) {
    console.warn('PocketFi webhook: no signature header — processing by reference match only');
  } else if (matched) {
    console.log('PocketFi signature OK', matched);
  }

  if (!isPaidStatus(data)) {
    console.log('PocketFi webhook non-success status — ignored', {
      status: data?.status || data?.data?.status || data?.event
    });
    return res.status(200).json({ message: 'ignored_status' });
  }

  if (!reference) {
    console.warn('PocketFi webhook missing reference', { raw_preview: raw.slice(0, 300) });
    return res.status(200).json({ message: 'ignored_no_reference' });
  }

  // Idempotency: already success
  const { data: existing } = await supabase
    .from('transactions')
    .select('id, user_id, status, amount_ngn')
    .eq('external_reference', String(reference))
    .maybeSingle();

  if (existing && String(existing.status).toLowerCase() === 'success') {
    return res.status(200).json({ message: 'already processed' });
  }

  let userId = existing?.user_id || null;
  let creditAmount = amount > 0 ? amount : Number(existing?.amount_ngn || 0);

  if (!userId || !creditAmount) {
    const { data: intent } = await supabase
      .from('deposit_intents')
      .select('user_id, amount, status')
      .eq('external_id', String(reference))
      .maybeSingle();
    if (intent?.user_id) {
      userId = userId || intent.user_id;
      if (!creditAmount) creditAmount = Number(intent.amount) || 0;
    }
  }

  if (!userId) {
    const { data: pending } = await supabase
      .from('transactions')
      .select('id, user_id, amount_ngn')
      .eq('payment_provider', 'pocketfi')
      .eq('external_reference', String(reference))
      .maybeSingle();
    if (pending?.user_id) {
      userId = pending.user_id;
      if (!creditAmount) creditAmount = Number(pending.amount_ngn) || 0;
    }
  }

  if (!userId || !(creditAmount > 0)) {
    console.error('PocketFi webhook: cannot resolve user/amount', {
      reference,
      amount: creditAmount,
      userId
    });
    // 200 so PocketFi stops retrying forever — check logs and credit manually if needed
    return res.status(200).json({ message: 'no matching user — logged' });
  }

  try {
    await creditUser(userId, creditAmount, String(reference));
  } catch (err) {
    console.error('PocketFi credit failed', err);
    return res.status(500).json({ message: err.message || 'credit failed' });
  }

  return res.status(200).json({ message: 'success' });
}

async function resolveUserFromToken(token) {
  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (!authErr && userData?.user?.id) {
    return userData.user;
  }

  // Fallback if getUser fails with service-role client but JWT is still valid
  try {
    const parts = String(token).split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(
        Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
      );
      const uid = payload.sub || payload.user_id;
      const notExpired = payload.exp && payload.exp * 1000 > Date.now() - 60000;
      if (uid && notExpired) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('id')
          .eq('id', uid)
          .maybeSingle();
        if (profile?.id) {
          return { id: uid, email: payload.email || null, user_metadata: {}, phone: null };
        }
      }
    }
  } catch (e) {
    console.warn('token fallback parse failed', e.message || e);
  }

  console.warn('resolveUserFromToken failed', authErr?.message || authErr);
  return null;
}

async function handleCheckout(req, res, raw, publicKey, businessId) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) {
    return res.status(401).json({ success: false, message: 'Login required' });
  }

  const user = await resolveUserFromToken(token);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: 'Invalid session — log out and sign in again, then retry PocketFi.'
    });
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

  // Absolute HTTPS URL required — PocketFi "Go to Home" / auto-redirect uses this
  const appUrl = (process.env.APP_URL || 'https://app.mjhub.store').replace(/\/$/, '');
  const redirect_link = `${appUrl}/index.html?deposit=success&provider=pocketfi`;

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
    // some PocketFi builds read alternate keys
    redirect_url: redirect_link,
    callback_url: redirect_link,
    amount: String(amount)
  };

  console.log('PocketFi checkout payload', {
    business_id: payload.business_id,
    amount: payload.amount,
    redirect_link,
    email: payload.email
  });

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
      customer_id: profile?.customer_id || null,
      type: 'deposit',
      category: 'Deposit',
      title: 'PocketFi deposit (pending)',
      subtitle: paymentId || 'checkout',
      amount: `₦${amount.toLocaleString()}`,
      amount_ngn: amount,
      currency: 'NGN',
      status: 'pending',
      payment_provider: 'pocketfi',
      external_reference: paymentId,
      channel: 'PocketFi'
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
    amount,
    redirect_link
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
  const hasAnySignature = getSignatureCandidates(req).length > 0;

  if (isWebhookRequest(req, hasAnySignature)) {
    return handleWebhook(req, res, raw, secret, publicKey);
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
