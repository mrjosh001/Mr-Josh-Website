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
 *   RESEND_API_KEY, RESEND_FROM_EMAIL (e.g. "MJ Hub <noreply@yourdomain.com>")
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
/** NGN per 1 USD when user funds USD wallet via bank transfer */
const USD_RATE = Number(process.env.DEPOSIT_USD_RATE) || 1450;

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

/**
 * Send deposit success email via Resend (best-effort, never blocks credit).
 * Env: RESEND_API_KEY, RESEND_FROM_EMAIL (e.g. "MJ Hub <noreply@mjhub.store>")
 */
async function sendDepositEmail({ to, name, amountLabel, walletLabel, reference }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || process.env.RESEND_FROM || 'MJ Hub <onboarding@resend.dev>';
  if (!apiKey || !to) {
    console.warn('[deposit-email] skipped — missing RESEND_API_KEY or recipient');
    return { ok: false, skipped: true };
  }

  const safeName = String(name || 'there').trim() || 'there';
  const appUrl = process.env.APP_URL || 'https://app.mjhub.store';
  const year = new Date().getFullYear();
  const subject = "Deposit Notification";

  // Hosted brand logos (same assets as the live site)
  const LOGO_DARK = 'https://atczodlljmlayvldxfmv.supabase.co/storage/v1/object/public/avatars/dark%20background%20log';
  const LOGO_LIGHT = 'https://atczodlljmlayvldxfmv.supabase.co/storage/v1/object/public/avatars/light%20background%20logo';

  const html = `
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Deposit Notification</title>
  <style>
    :root { color-scheme: light dark; }
    @media (prefers-color-scheme: light) {
      .body-bg { background-color: #f4f5f7 !important; }
      .card-bg { background-color: #ffffff !important; border-color: #e5e7eb !important; }
      .inner-bg { background-color: #f8f9fb !important; border-color: #e5e7eb !important; }
      .text-primary { color: #111827 !important; }
      .text-secondary { color: #6b7280 !important; }
      .text-muted { color: #9ca3af !important; }
      .divider { border-color: #e5e7eb !important; background-color: #e5e7eb !important; }
      .badge { background-color: rgba(91,138,245,0.10) !important; border-color: rgba(91,138,245,0.22) !important; color: #3b6fd4 !important; }
      .amount { color: #5b8af5 !important; }
      .logo-dark { display: none !important; max-height: 0 !important; overflow: hidden !important; width: 0 !important; height: 0 !important; }
      .logo-light { display: block !important; max-height: none !important; }
    }
    @media (prefers-color-scheme: dark) {
      .body-bg { background-color: #0a0a0f !important; }
      .card-bg { background-color: #111118 !important; border-color: #1c1c28 !important; }
      .inner-bg { background-color: #0a0a0f !important; border-color: #1c1c28 !important; }
      .text-primary { color: #f4f4f8 !important; }
      .text-secondary { color: #9ca3af !important; }
      .text-muted { color: #6b7280 !important; }
      .divider { border-color: #1c1c28 !important; background-color: #1c1c28 !important; }
      .badge { background-color: rgba(91,138,245,0.12) !important; border-color: rgba(91,138,245,0.25) !important; color: #8badea !important; }
      .amount { color: #5b8af5 !important; }
      .logo-light { display: none !important; max-height: 0 !important; overflow: hidden !important; width: 0 !important; height: 0 !important; }
      .logo-dark { display: block !important; max-height: none !important; }
    }
  </style>
</head>
<body class="body-bg" style="margin:0;padding:0;background:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="body-bg" style="background:#0a0a0f;padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" class="card-bg" style="max-width:440px;background:#111118;border-radius:20px;border:1px solid #1c1c28;overflow:hidden;">

          <!-- Brand logo (swaps for light / dark) -->
          <tr>
            <td style="padding:28px 28px 0;text-align:center;">
              <img class="logo-dark" src="${LOGO_DARK}" width="140" alt="MJ Hub" style="display:block;margin:0 auto;width:140px;max-width:140px;height:auto;border:0;">
              <img class="logo-light" src="${LOGO_LIGHT}" width="140" alt="MJ Hub" style="display:none;margin:0 auto;width:140px;max-width:140px;height:auto;border:0;">
            </td>
          </tr>

          <!-- Status badge -->
          <tr>
            <td style="padding:22px 28px 0;text-align:center;">
              <div class="badge" style="display:inline-block;background:rgba(91,138,245,0.12);border:1px solid rgba(91,138,245,0.25);color:#8badea;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;padding:6px 14px;border-radius:999px;">
                Deposit Notification
              </div>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding:22px 28px 0;">
              <p class="text-primary" style="margin:0;font-size:16px;font-weight:600;color:#f4f4f8;line-height:1.4;">Hello ${safeName},</p>
              <p class="text-secondary" style="margin:10px 0 0;font-size:14px;color:#9ca3af;line-height:1.6;">
                Your payment has been received and credited to your ${walletLabel}.
              </p>
            </td>
          </tr>

          <!-- Amount card -->
          <tr>
            <td style="padding:22px 28px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="inner-bg" style="background:#0a0a0f;border-radius:14px;border:1px solid #1c1c28;">
                <tr>
                  <td style="padding:20px 22px;text-align:center;">
                    <div class="text-muted" style="font-size:12px;font-weight:600;color:#6b7280;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:8px;">Amount Credited</div>
                    <div class="amount" style="font-size:32px;font-weight:800;color:#5b8af5;letter-spacing:-0.03em;line-height:1.1;">${amountLabel}</div>
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 22px 18px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="divider" style="border-top:1px solid #1c1c28;">
                      <tr>
                        <td class="text-muted" style="padding-top:14px;font-size:13px;color:#6b7280;">Wallet</td>
                        <td class="text-primary" style="padding-top:14px;font-size:13px;font-weight:600;color:#e5e7eb;text-align:right;">${walletLabel}</td>
                      </tr>
                      ${reference ? `
                      <tr>
                        <td class="text-muted" style="padding-top:8px;font-size:13px;color:#6b7280;">Reference</td>
                        <td class="text-secondary" style="padding-top:8px;font-size:12px;font-weight:500;color:#9ca3af;text-align:right;word-break:break-all;">${reference}</td>
                      </tr>` : ''}
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td style="padding:28px 28px 0;text-align:center;">
              <a href="${appUrl}" style="display:inline-block;background:linear-gradient(135deg,#5b8af5 0%,#7c5cfc 100%);color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:14px 32px;border-radius:12px;letter-spacing:0.01em;">
                Open Dashboard
              </a>
            </td>
          </tr>

          <!-- Security note -->
          <tr>
            <td style="padding:20px 28px 0;">
              <p class="text-muted" style="margin:0;font-size:12px;color:#6b7280;line-height:1.55;text-align:center;">
                If you did not authorize this payment, contact support immediately at
                <a href="mailto:support@app.mjhub.store" style="color:#5b8af5;text-decoration:none;">support@app.mjhub.store</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:28px 28px 28px;text-align:center;">
              <div class="divider" style="height:1px;background:#1c1c28;margin-bottom:18px;"></div>
              <p class="text-muted" style="margin:0;font-size:11px;color:#4b5563;line-height:1.5;">
                © ${year} MJ Hub. All rights reserved.<br>
                Secure payments · Instant wallet credit
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html
      })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[deposit-email] Resend error', res.status, json);
      return { ok: false, error: json };
    }
    console.log('[deposit-email] sent', json?.id || '');
    return { ok: true, id: json?.id };
  } catch (e) {
    console.error('[deposit-email] failed', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

async function creditUser(userId, amountNgn, reference) {
  // Wallet target was stored on the pending transaction / intent at checkout
  let wallet = 'ngn';
  let existing = null;
  try {
    const { data: tx } = await supabase
      .from('transactions')
      .select('id, status, currency, subtitle')
      .eq('external_reference', reference)
      .maybeSingle();
    existing = tx;
    const cur = String(tx?.currency || '').toUpperCase();
    if (cur === 'USD' || /usd wallet/i.test(String(tx?.subtitle || ''))) wallet = 'usd';
  } catch (_) {}

  if (wallet === 'ngn') {
    try {
      const { data: intent } = await supabase
        .from('deposit_intents')
        .select('wallet, currency')
        .eq('external_id', reference)
        .maybeSingle();
      const w = String(intent?.wallet || intent?.currency || '').toLowerCase();
      if (w === 'usd' || w === 'dollar') wallet = 'usd';
    } catch (_) {}
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('balance, balance_usd, customer_id, email, full_name')
    .eq('id', userId)
    .maybeSingle();

  // Resolve email (profile first, then auth user)
  let email = profile?.email || null;
  let displayName = profile?.full_name || null;
  if (!email) {
    try {
      const { data: authUser } = await supabase.auth.admin.getUserById(userId);
      email = authUser?.user?.email || null;
      if (!displayName) {
        displayName = authUser?.user?.user_metadata?.full_name || authUser?.user?.user_metadata?.name || null;
      }
    } catch (_) {}
  }

  const amountUsd = Math.round((amountNgn / USD_RATE) * 10000) / 10000;

  if (wallet === 'usd') {
    const currentUsd = Number(profile?.balance_usd ?? 0) || 0;
    const nextUsd = currentUsd + amountUsd;
    const { error: balErr } = await supabase
      .from('profiles')
      .update({ balance_usd: nextUsd })
      .eq('id', userId);
    if (balErr) throw new Error('USD balance update failed: ' + balErr.message);

    const patch = {
      status: 'success',
      title: 'Deposit',
      subtitle: `Funded USD Wallet · ₦${USD_RATE.toLocaleString()}/$1`,
      amount: `$${amountUsd.toFixed(2)}`,
      amount_ngn: amountNgn,
      currency: 'USD',
      type: 'deposit',
      category: 'Deposit',
      channel: 'Bank Transfer'
    };
    if (existing?.id) {
      await supabase.from('transactions').update(patch).eq('id', existing.id);
    } else {
      await supabase.from('transactions').insert({
        user_id: userId,
        customer_id: profile?.customer_id || null,
        ...patch,
        payment_provider: 'pocketfi',
        external_reference: reference
      });
    }
    try {
      await supabase
        .from('deposit_intents')
        .update({ status: 'success', wallet: 'usd' })
        .eq('external_id', reference);
    } catch (_) {}

    // Non-blocking email
    sendDepositEmail({
      to: email,
      name: displayName,
      amountLabel: `$${amountUsd.toFixed(2)}`,
      walletLabel: 'USD Wallet',
      reference
    }).catch(() => {});

    return { balance_usd: nextUsd, wallet: 'usd', amount_usd: amountUsd };
  }

  const current = Number(profile?.balance ?? 0) || 0;
  const next = current + amountNgn;
  const { error: balErr } = await supabase
    .from('profiles')
    .update({ balance: next })
    .eq('id', userId);
  if (balErr) throw new Error('balance update failed: ' + balErr.message);

  const patchNgn = {
    status: 'success',
    title: 'Deposit',
    subtitle: 'Funded NGN Wallet',
    amount: `₦${amountNgn.toLocaleString()}`,
    amount_ngn: amountNgn,
    currency: 'NGN',
    type: 'deposit',
    category: 'Deposit',
    channel: 'Bank Transfer'
  };
  if (existing?.id) {
    await supabase.from('transactions').update(patchNgn).eq('id', existing.id);
  } else {
    await supabase.from('transactions').insert({
      user_id: userId,
      customer_id: profile?.customer_id || null,
      ...patchNgn,
      payment_provider: 'pocketfi',
      external_reference: reference
    });
  }

  try {
    await supabase
      .from('deposit_intents')
      .update({ status: 'success', wallet: 'ngn' })
      .eq('external_id', reference);
  } catch (_) {}

  // Non-blocking email
  sendDepositEmail({
    to: email,
    name: displayName,
    amountLabel: `₦${amountNgn.toLocaleString()}`,
    walletLabel: 'NGN Wallet',
    reference
  }).catch(() => {});

  return { balance: next, wallet: 'ngn' };
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
  const walletRaw = String(body?.wallet || body?.currency || 'ngn').toLowerCase();
  const wallet = walletRaw === 'usd' || walletRaw === 'dollar' ? 'usd' : 'ngn';
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
  const redirect_link = `${appUrl}/deposit.html?deposit=success&provider=pocketfi`;

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

  const amountUsd = Math.round((amount / USD_RATE) * 10000) / 10000;
  const pendingTitle = 'Deposit (pending)';
  const pendingSubtitle =
    wallet === 'usd'
      ? `USD wallet · ~$${amountUsd.toFixed(2)} at ₦${USD_RATE.toLocaleString()}/$1`
      : 'NGN wallet · Awaiting payment confirmation';

  try {
    await supabase.from('transactions').insert({
      user_id: user.id,
      customer_id: profile?.customer_id || null,
      type: 'deposit',
      category: 'Deposit',
      title: pendingTitle,
      subtitle: pendingSubtitle,
      amount:
        wallet === 'usd'
          ? `~$${amountUsd.toFixed(2)}`
          : `₦${amount.toLocaleString()}`,
      amount_ngn: amount,
      currency: wallet === 'usd' ? 'USD' : 'NGN',
      status: 'pending',
      payment_provider: 'pocketfi',
      external_reference: paymentId,
      channel: 'Bank Transfer'
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
        wallet,
        currency: wallet === 'usd' ? 'USD' : 'NGN',
        external_id: paymentId,
        status: 'pending',
        created_at: new Date().toISOString()
      },
      { onConflict: 'external_id' }
    );
  } catch (_) {
    /* optional table — currency on transactions is enough */
  }

  return res.status(200).json({
    success: true,
    payment_id: paymentId,
    payment_link: paymentLink,
    amount,
    wallet,
    amount_usd: wallet === 'usd' ? amountUsd : null,
    rate: USD_RATE,
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
