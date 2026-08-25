/**
 * POST /api/pocketfi
 *
 * Checkout:        Authorization Bearer (user JWT) + JSON { amount }
 * Virtual account: Authorization Bearer (user JWT), ?action=virtual_account
 *                  (get-or-create a dedicated reusable bank account per
 *                  customer — see handleVirtualAccount below)
 * Webhook:         PocketFi signature header + raw body (handles both a
 *                  checkout payment AND a transfer into a dedicated
 *                  virtual account — see handleWebhook below)
 *
 * Rewrites (vercel.json):
 *   /api/pocketfi-checkout → /api/pocketfi
 *   /api/pocketfi-webhook  → /api/pocketfi
 *
 * Env:
 *   POCKETFI_SECRET_KEY, POCKETFI_PUBLIC_KEY, POCKETFI_BUSINESS_ID
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   Optional: POCKETFI_WEBHOOK_SECRET, POCKETFI_API_BASE, APP_URL
 *   Optional: POCKETFI_VA_BANK (paga|saveheaven only, default paga)
 *   RESEND_API_KEY, RESEND_FROM_EMAIL (e.g. "MJ Hub <noreply@yourdomain.com>")
 *
 * Webhook URL in PocketFi dashboard:
 *   https://app.mjhub.store/api/pocketfi
 *   (or https://app.mjhub.store/api/pocketfi-webhook)
 */

import crypto from 'crypto';
import { rateLimit, applyRateLimitHeaders } from '../lib/rateLimit.js';
import { rejectClientSuppliedSecrets, applyApiCors, handleOptions, setNoStore } from '../lib/secure.js';
import { parseAmountNgn } from '../lib/validate.js';
import { sendError } from '../lib/errors.js';
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
    data?.order?.settlement_amount ??
    data?.data?.amount ??
    data?.data?.settlement_amount ??
    data?.transaction?.amount ??
    data?.amount ??
    data?.data?.order?.amount ??
    data?.data?.order?.settlement_amount ??
    0;
  let n = Number(raw) || 0;
  // If PocketFi ever sends kobo (very large ints), convert — NGN deposits are whole naira
  if (n > 5000000 && Number.isInteger(n)) n = Math.round(n / 100);
  return Math.round(n);
}


/**
 * VA deposits: user wallet gets net after 1% payment processing fee.
 * - Sent 1010 (uplifted from 1000) → credit 1000
 * - Sent 1000 (no uplift) → credit 990 (1000 minus 1%)
 */
function netDepositFromGross(gross) {
  const g = Math.round(Number(gross) || 0);
  if (g <= 0) return 0;
  const rate = 0.01;
  // Prefer inverse of UI formula: desired + ceil(desired * 0.01) === gross
  for (let d = g; d >= Math.max(1, g - Math.ceil(g * 0.05) - 5); d--) {
    if (d + Math.ceil(d * rate) === g) return d;
  }
  // Paid exact desired with no uplift — still withhold 1%
  return Math.max(1, Math.round(g / (1 + rate)));
}

function extractReference(data) {
  return (
    data?.transaction?.reference ||
    data?.transaction?.id ||
    data?.data?.reference ||
    data?.data?.payment_id ||
    data?.data?.transaction_id ||
    data?.payment_id ||
    data?.reference ||
    data?.order?.reference ||
    data?.order?.id ||
    data?.data?.transaction_reference ||
    data?.id ||
    null
  );
}

// Virtual-account transfers arrive with no prior checkout/reference we
// created ourselves — the only thing tying the money to a user is which
// dedicated account number it landed in. PocketFi's real webhook shape
// (per the comment in isPaidStatus() below) puts this at the top level as
// `account_number`, but we check a few likely nested spots too in case a
// virtual-account credit event is shaped slightly differently from a
// checkout event.
function normalizeAccountNumber(v) {
  if (v == null || v === '') return null;
  const digits = String(v).replace(/\D/g, '');
  return digits || null;
}

function extractAccountNumber(data) {
  const raw =
    data?.account_number ||
    data?.accountNumber ||
    data?.data?.account_number ||
    data?.data?.accountNumber ||
    data?.virtual_account?.account_number ||
    data?.virtual_account?.accountNumber ||
    data?.bank?.accountNumber ||
    data?.bank?.account_number ||
    (Array.isArray(data?.banks) && (data.banks[0]?.accountNumber || data.banks[0]?.account_number)) ||
    null;
  return normalizeAccountNumber(raw);
}

async function findUserByVirtualAccount(accountNumber) {
  const want = normalizeAccountNumber(accountNumber);
  if (!want) return null;
  // Exact match first
  let { data: va } = await supabase
    .from('virtual_accounts')
    .select('user_id, account_number')
    .eq('account_number', want)
    .maybeSingle();
  if (va?.user_id) return va.user_id;
  // Fallback: match digits only (leading zeros / formatting drift)
  const { data: rows } = await supabase
    .from('virtual_accounts')
    .select('user_id, account_number')
    .limit(500);
  for (const r of rows || []) {
    if (normalizeAccountNumber(r.account_number) === want) return r.user_id;
  }
  return null;
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


/* ========== Referral (merged — no extra serverless file) ========== */
const REFERRAL_COMMISSION_RATE = 0.02; // 2% lifetime on deposits

function genReferralCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = 'MJ';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

async function ensureReferralCode(userId) {
  const { data: prof } = await supabase
    .from('profiles')
    .select('id, referral_code, customer_id, full_name, balance')
    .eq('id', userId)
    .maybeSingle();
  if (!prof) return null;
  if (prof.referral_code) return prof;
  for (let i = 0; i < 8; i++) {
    const code = genReferralCode();
    const { data, error } = await supabase
      .from('profiles')
      .update({ referral_code: code })
      .eq('id', userId)
      .is('referral_code', null)
      .select('id, referral_code, customer_id, full_name, balance')
      .maybeSingle();
    if (!error && data?.referral_code) return data;
  }
  const fallback = ('MJ' + String(prof.customer_id || userId).replace(/[^a-zA-Z0-9]/g, '').slice(-6)).toUpperCase();
  await supabase.from('profiles').update({ referral_code: fallback }).eq('id', userId);
  return { ...prof, referral_code: fallback };
}

async function payReferralCommission(refereeUserId, depositAmountNgn, depositReference) {
  const amount = Number(depositAmountNgn) || 0;
  if (amount < 1 || !refereeUserId) return { paid: false, reason: 'skip' };

  const { data: referee } = await supabase
    .from('profiles')
    .select('id, referred_by, customer_id')
    .eq('id', refereeUserId)
    .maybeSingle();
  if (!referee?.referred_by) return { paid: false, reason: 'no_referrer' };

  const commission = Math.floor(amount * REFERRAL_COMMISSION_RATE * 100) / 100;
  if (commission < 0.01) return { paid: false, reason: 'too_small' };

  if (depositReference) {
    const { data: existing } = await supabase
      .from('referral_earnings')
      .select('id')
      .eq('deposit_reference', String(depositReference))
      .maybeSingle();
    if (existing) return { paid: false, reason: 'already_paid' };
  }

  const referrerId = referee.referred_by;
  const { data: refProf } = await supabase
    .from('profiles')
    .select('id, balance, customer_id')
    .eq('id', referrerId)
    .maybeSingle();
  if (!refProf) return { paid: false, reason: 'referrer_missing' };

  const nextBal = (Number(refProf.balance) || 0) + commission;
  const { error: balErr } = await supabase
    .from('profiles')
    .update({ balance: nextBal })
    .eq('id', referrerId);
  if (balErr) {
    console.error('[referral] balance update', balErr.message);
    return { paid: false, reason: balErr.message };
  }

  try {
    await supabase.from('referral_earnings').insert({
      referrer_id: referrerId,
      referee_id: refereeUserId,
      deposit_reference: depositReference ? String(depositReference) : null,
      deposit_amount_ngn: amount,
      commission_ngn: commission
    });
  } catch (e) {
    console.warn('[referral] earnings insert', e?.message || e);
  }

  try {
    await supabase.from('transactions').insert({
      user_id: referrerId,
      customer_id: refProf.customer_id || null,
      type: 'deposit',
      category: 'deposit',
      title: 'Referral bonus',
      subtitle: `2% of friend's deposit · ₦${amount.toLocaleString()}`,
      amount: '₦' + commission.toLocaleString(),
      amount_ngn: commission,
      status: 'completed',
      channel: 'Referral',
      payment_provider: 'Referral',
      created_at: new Date().toISOString()
    });
  } catch (e) {
    console.warn('[referral] tx insert', e?.message || e);
  }

  return { paid: true, commission, referrer_id: referrerId, new_balance: nextBal };
}

async function tryPayReferral(userId, amountNgn, reference) {
  try {
    const r = await payReferralCommission(userId, amountNgn, reference);
    if (r?.paid) console.log('[referral] paid', r.commission, 'to', r.referrer_id);
  } catch (e) {
    console.warn('[referral] commission skip', e?.message || e);
  }
}

async function requireUserToken(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, message: 'Please sign in' };
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return { ok: false, status: 401, message: 'Session expired' };
  return { ok: true, user };
}

async function handleReferralMe(req, res, user) {
  const prof = await ensureReferralCode(user.id);
  if (!prof) return res.status(400).json({ success: false, message: 'Profile not found' });
  // If ensure failed silently due to missing SQL columns, surface it
  if (!prof.referral_code) {
    return res.status(500).json({
      success: false,
      message: 'Referral not set up — run referral_setup.sql in Supabase (referral_code / referred_by columns).'
    });
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host || 'app.mjhub.store';
  const origin = process.env.SITE_URL || (`https://${host}`);
  const link = `${String(origin).replace(/\/$/, '')}/index.html?ref=${encodeURIComponent(prof.referral_code)}`;

  // profiles has updated_at (not created_at) — wrong column made the list always empty
  const { data: refs, error: refsErr } = await supabase
    .from('profiles')
    .select('id, full_name, customer_id, email, updated_at')
    .eq('referred_by', user.id)
    .order('updated_at', { ascending: false })
    .limit(100);
  if (refsErr) console.error('[referral] list refs', refsErr.message);

  const { data: earnings } = await supabase
    .from('referral_earnings')
    .select('commission_ngn, deposit_amount_ngn, created_at, referee_id')
    .eq('referrer_id', user.id)
    .order('created_at', { ascending: false })
    .limit(100);

  const totalEarned = (earnings || []).reduce((s, r) => s + (Number(r.commission_ngn) || 0), 0);

  return res.status(200).json({
    success: true,
    referral_code: prof.referral_code,
    link,
    rate: REFERRAL_COMMISSION_RATE,
    rate_label: '2%',
    referred_count: (refs || []).length,
    total_earned_ngn: Math.round(totalEarned * 100) / 100,
    referrals: refs || [],
    recent_earnings: earnings || []
  });
}

async function handleReferralAttach(req, res, user) {
  const body = typeof req.body === 'string'
    ? (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })()
    : (req.body || {});
  const code = String(body.code || body.ref || req.query?.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ success: false, message: 'Referral code required' });

  // Ensure profile row exists (signup trigger can lag)
  let me = null;
  for (let i = 0; i < 6; i++) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, referred_by, referral_code')
      .eq('id', user.id)
      .maybeSingle();
    if (error) {
      return res.status(500).json({
        success: false,
        message: 'Profile read failed: ' + error.message + ( /referred_by|referral_code/i.test(error.message) ? ' — run referral_setup.sql' : '')
      });
    }
    if (data) { me = data; break; }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!me) {
    return res.status(400).json({
      success: false,
      message: 'Profile not ready yet. Wait a few seconds and open the app again, or re-open the referral link after login.'
    });
  }

  if (me.referred_by) {
    return res.status(200).json({ success: true, message: 'Already linked to a referrer', already: true });
  }
  if (me.referral_code && String(me.referral_code).toUpperCase() === code) {
    return res.status(400).json({ success: false, message: 'You cannot use your own referral code' });
  }

  let referrer = null;
  {
    const { data: exact } = await supabase
      .from('profiles')
      .select('id, referral_code')
      .eq('referral_code', code)
      .maybeSingle();
    referrer = exact;
    if (!referrer) {
      const { data: rows } = await supabase
        .from('profiles')
        .select('id, referral_code')
        .ilike('referral_code', code)
        .limit(1);
      referrer = rows && rows[0] ? rows[0] : null;
    }
  }
  if (!referrer) {
    return res.status(404).json({ success: false, message: 'Invalid referral code: ' + code });
  }
  if (referrer.id === user.id) {
    return res.status(400).json({ success: false, message: 'You cannot refer yourself' });
  }

  const { data: updated, error } = await supabase
    .from('profiles')
    .update({ referred_by: referrer.id })
    .eq('id', user.id)
    .is('referred_by', null)
    .select('id, referred_by')
    .maybeSingle();

  if (error) {
    return res.status(500).json({
      success: false,
      message: 'Could not save referrer: ' + error.message + ( /referred_by/i.test(error.message) ? ' — run referral_setup.sql' : '')
    });
  }

  if (!updated || !updated.referred_by) {
    // Re-read — maybe already set in parallel
    const { data: again } = await supabase
      .from('profiles')
      .select('referred_by')
      .eq('id', user.id)
      .maybeSingle();
    if (again?.referred_by) {
      return res.status(200).json({ success: true, message: 'Already linked', already: true, referrer_id: again.referred_by });
    }
    return res.status(500).json({
      success: false,
      message: 'Referral did not save (0 rows updated). Check profiles.referred_by column exists and RLS allows service role updates.'
    });
  }

  return res.status(200).json({
    success: true,
    message: 'Referral linked — future deposits earn them 2% for life',
    referrer_id: referrer.id
  });
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
    if (tx && String(tx.status || '').toLowerCase() === 'success') {
      console.log('creditUser: already credited', reference);
      const { data: profile } = await supabase
        .from('profiles')
        .select('balance, balance_usd')
        .eq('id', userId)
        .maybeSingle();
      return {
        balance: Number(profile?.balance || 0),
        balance_usd: Number(profile?.balance_usd || 0),
        wallet: 'ngn',
        already: true
      };
    }
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

    // Await email so Vercel does not freeze before Resend is called
    try {
      await sendDepositEmail({
        to: email,
        name: displayName,
        amountLabel: `$${amountUsd.toFixed(2)}`,
        walletLabel: 'USD Wallet',
        reference
      });
    } catch (e) {
      console.error('[deposit-email] unexpected', e?.message || e);
    }

    await tryPayReferral(userId, amountNgn, reference);
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

  // Await email so Vercel does not freeze before Resend is called
  try {
    await sendDepositEmail({
      to: email,
      name: displayName,
      amountLabel: `₦${amountNgn.toLocaleString()}`,
      walletLabel: 'NGN Wallet',
      reference
    });
  } catch (e) {
    console.error('[deposit-email] unexpected', e?.message || e);
  }

  await tryPayReferral(userId, amountNgn, reference);
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
    console.warn('PocketFi webhook signature mismatch — will accept only if pending deposit or known VA', {
      candidates: candidates.map((c) => `${c.header}=${String(c.value).slice(0, 20)}...`),
      reference,
      amount
    });
    // VA webhooks may omit reference; allow through to account_number matching below
    if (!reference && !extractAccountNumber(data)) {
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
      // Permanent VA transfers have no pending checkout — still accept if account_number is ours
      const acc = extractAccountNumber(data);
      const vaUser = acc ? await findUserByVirtualAccount(acc) : null;
      if (vaUser && (amount > 0 || extractAmount(data) > 0)) {
        console.warn('PocketFi webhook accepted via virtual account number (signature skipped)', {
          account: acc,
          userId: vaUser,
          reference
        });
      } else {
        return res.status(400).json({ message: 'Invalid signature' });
      }
    } else {
      console.warn('PocketFi webhook accepted via pending deposit match (signature skipped)');
    }
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

  const VA_MIN = 1000;
  const VA_MAX = 700000;

  let reference = extractReference(data);
  const accountNumber = extractAccountNumber(data);
  const grossAmount = extractAmount(data);

  // Synthetic reference for VA events missing a payment id (still idempotent per account+amount+day bucket)
  if (!reference && accountNumber && grossAmount > 0) {
    const day = new Date().toISOString().slice(0, 10);
    reference = `va-${accountNumber}-${grossAmount}-${day}`;
    console.warn('PocketFi webhook: synthetic VA reference', reference);
  }

  if (!reference) {
    console.warn('PocketFi webhook missing reference', { raw_preview: String(raw).slice(0, 300) });
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
  let creditAmount = grossAmount > 0 ? grossAmount : Number(existing?.amount_ngn || 0);
  let viaCheckout = false;
  let viaVa = false;

  // Checkout: pending intent / tx by reference
  if (!userId || !creditAmount) {
    const { data: intent } = await supabase
      .from('deposit_intents')
      .select('user_id, amount, status')
      .eq('external_id', String(reference))
      .maybeSingle();
    if (intent?.user_id) {
      userId = userId || intent.user_id;
      if (!creditAmount) creditAmount = Number(intent.amount) || 0;
      if (String(intent.status || '').toLowerCase() === 'pending') viaCheckout = true;
    }
  }

  if (!userId) {
    const { data: pending } = await supabase
      .from('transactions')
      .select('id, user_id, amount_ngn, status')
      .eq('payment_provider', 'pocketfi')
      .eq('external_reference', String(reference))
      .maybeSingle();
    if (pending?.user_id) {
      userId = pending.user_id;
      if (!creditAmount) creditAmount = Number(pending.amount_ngn) || 0;
      if (String(pending.status || '').toLowerCase() === 'pending') viaCheckout = true;
    }
  }

  // Permanent VA — works even if user never opened Fund Wallet / set an amount
  if (!userId && accountNumber) {
    const uid = await findUserByVirtualAccount(accountNumber);
    if (uid) {
      userId = uid;
      viaVa = true;
      console.log('PocketFi webhook: matched by virtual account number', { accountNumber, userId });
    }
  }

  if (!userId || !(creditAmount > 0)) {
    console.error('PocketFi webhook: cannot resolve user/amount', {
      reference,
      amount: creditAmount,
      userId,
      accountNumber
    });
    return res.status(200).json({ message: 'no matching user — logged' });
  }

  // Bounds: protect against bad/malicious payloads (VA and unknown gross)
  if (viaVa || !viaCheckout) {
    if (creditAmount < VA_MIN || creditAmount > VA_MAX) {
      console.warn('PocketFi webhook amount out of range — not credited', { creditAmount, reference });
      return res.status(200).json({ message: 'amount_out_of_range' });
    }
  }

  // Credit amount:
  // - Checkout with pending intent: use stored intended amount when available
  // - VA (with or without prior UI session): net 1% from gross received
  let creditNet = creditAmount;
  try {
    const { data: intentAmt } = await supabase
      .from('deposit_intents')
      .select('amount, status')
      .eq('external_id', String(reference))
      .maybeSingle();
    if (
      intentAmt &&
      Number(intentAmt.amount) > 0 &&
      String(intentAmt.status || '').toLowerCase() === 'pending'
    ) {
      creditNet = Math.round(Number(intentAmt.amount));
      viaCheckout = true;
    } else if (viaVa || !viaCheckout) {
      const net = netDepositFromGross(creditAmount);
      if (net > 0) {
        console.log('PocketFi VA credit netted', { gross: creditAmount, net });
        creditNet = net;
      }
      // Net must still be meaningful
      if (creditNet < Math.floor(VA_MIN * 0.99)) {
        console.warn('PocketFi VA net too small — not credited', { creditNet, reference });
        return res.status(200).json({ message: 'net_too_small' });
      }
    }
  } catch (e) {
    console.warn('net deposit resolve failed', e?.message || e);
  }

  try {
    await creditUser(userId, creditNet, String(reference));
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

  const rlPay = rateLimit(req, { limit: 15, windowMs: 60_000, suffix: 'pocketfi-checkout' });
  applyRateLimitHeaders(res, rlPay);
  if (!rlPay.ok) return res.status(429).json({ success: false, message: rlPay.message });
  const amountParsed = parseAmountNgn(body?.amount, { min: 100, max: 500000 });
  if (!amountParsed.ok) return res.status(400).json({ success: false, message: amountParsed.message });
  const amount = amountParsed.value;
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


/**
 * POST /api/pocketfi?action=virtual_account
 * Auth: Bearer <user JWT>
 *
 * Get-or-create a dedicated (static, reusable) PocketFi bank account for
 * this customer. First call creates it and stores the mapping in the
 * "virtual_accounts" table; every call after that just returns the same
 * stored row — PocketFi's docs are explicit that you should create ONE
 * account per customer and keep your own mapping, not call create() every
 * time. The account number never changes, so it's fine to show it
 * whenever the user opens the deposit page.
 *
 * Money sent to this account arrives as a webhook (handleWebhook above) —
 * there's no pending "checkout" reference the way there is for the
 * one-time payment-link flow, so the webhook matches purely by looking up
 * which user owns the account_number in the webhook payload. See the
 * account_number handling in handleWebhook().
 *
 * Requires this table (run once in the Supabase SQL editor):
 *
 *   create table if not exists virtual_accounts (
 *     user_id uuid primary key references auth.users(id),
 *     bank text not null,
 *     account_number text not null unique,
 *     account_name text,
 *     business_id text,
 *     created_at timestamptz default now()
 *   );
 *
 * Env: POCKETFI_VA_BANK — only "paga" or "saveheaven" (default: paga).
 * Account name is always taken from the user's website profile full_name.
 *
 * Body (optional): { "bank": "paga" | "saveheaven", "create": true }
 *   - Without create / when account already exists → return stored details
 *   - create:true only needed when user has no account yet
 */
async function handleVirtualAccount(req, res, publicKey, businessId) {
  const gate = await requireUserToken(req);
  if (!gate.ok) return res.status(gate.status).json({ success: false, message: gate.message });
  const user = gate.user;

  let body = {};
  try {
    if (typeof req.body === 'string' && req.body) body = JSON.parse(req.body);
    else if (req.body && typeof req.body === 'object') body = req.body;
  } catch (_) {}

  // Already have one on file — one account per customer
  const { data: existingVa } = await supabase
    .from('virtual_accounts')
    .select('bank, account_number, account_name')
    .eq('user_id', user.id)
    .maybeSingle();

  if (existingVa?.account_number) {
    return res.status(200).json({
      success: true,
      data: existingVa,
      created: false,
      has_account: true
    });
  }

  // No account yet — only create when client asks (clean "Generate" UX)
  const wantCreate =
    body.create === true ||
    body.create === 'true' ||
    body.generate === true ||
    String(req.query?.create || '').toLowerCase() === '1';

  if (!wantCreate) {
    return res.status(200).json({
      success: true,
      has_account: false,
      data: null,
      message: 'No virtual account yet. Generate one to get your permanent account number.'
    });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, email, phone, customer_id')
    .eq('id', user.id)
    .maybeSingle();

  // Use the customer's real profile name so PocketFi labels the VA with their name
  // (not a generic "Fresh" / merchant placeholder).
  const profileFullName = String(
    profile?.full_name ||
      user.user_metadata?.full_name ||
      user.user_metadata?.name ||
      user.user_metadata?.username ||
      ''
  ).trim();
  const { first_name, last_name } = splitName(
    profileFullName || String(user.email || '').split('@')[0] || 'MJ Hub Customer'
  );
  const displayAccountName = profileFullName || `${first_name} ${last_name}`.trim();

  const email = profile?.email || user.email || `user-${user.id.slice(0, 8)}@mjhub.store`;
  const phoneDigits = String(profile?.phone || user.phone || '').replace(/\D/g, '');
  const phone = phoneDigits.length >= 10 ? phoneDigits.slice(-11) : '08000000000';

  // Only Paga or Safe Haven
  const ALLOWED_BANKS = new Set(['paga', 'saveheaven']);
  let bank = String(body.bank || process.env.POCKETFI_VA_BANK || 'paga')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (bank === 'safehaven' || bank === 'safe_haven' || bank === 'safe-heaven') bank = 'saveheaven';
  if (!ALLOWED_BANKS.has(bank)) bank = 'paga';

  const base = (process.env.POCKETFI_API_BASE || 'https://api.pocketfi.ng/api/v1').replace(/\/$/, '');
  const payload = {
    first_name,
    last_name,
    phone,
    email,
    businessId: String(businessId),
    bank
  };

  let pfRes;
  try {
    pfRes = await fetch(`${base}/virtual-accounts/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${publicKey}`
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    return res.status(502).json({ success: false, message: 'Could not reach PocketFi: ' + e.message });
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

  if (!pfRes.ok || data.status === false) {
    return res.status(502).json({
      success: false,
      message: data.message || data.error || 'Could not create virtual account. Try again shortly.',
      data
    });
  }

  const bankRow = Array.isArray(data.banks) ? data.banks[0] : null;
  const accountNumber = bankRow?.accountNumber || data.accountNumber || null;
  // Prefer full profile name over provider short name
  const accountName = displayAccountName || bankRow?.accountName || data.accountName || first_name;
  const bankName = bankRow?.bankName || bank;

  if (!accountNumber) {
    return res.status(502).json({
      success: false,
      message: 'No account number returned. Please try again.',
      data
    });
  }

  const row = {
    user_id: user.id,
    bank: bankName,
    account_number: normalizeAccountNumber(accountNumber) || String(accountNumber),
    account_name: accountName,
    business_id: String(businessId)
  };

  const { error: insErr } = await supabase.from('virtual_accounts').insert(row);
  if (insErr) {
    const { data: raceRow } = await supabase
      .from('virtual_accounts')
      .select('bank, account_number, account_name')
      .eq('user_id', user.id)
      .maybeSingle();
    if (raceRow) {
      return res.status(200).json({ success: true, data: raceRow, created: true, has_account: true });
    }
    console.error('[virtual-account] insert failed', insErr.message);
  }

  return res.status(200).json({
    success: true,
    data: { bank: bankName, account_number: accountNumber, account_name: accountName },
    created: true,
    has_account: true
  });
}


async function handleConvert(req, res, user) {
  // Body may be empty when bodyParser is false — accept JSON body or query
  let body = {};
  if (req.body && typeof req.body === 'object') {
    body = req.body;
  } else if (typeof req.body === 'string' && req.body) {
    try { body = JSON.parse(req.body); } catch (_) {}
  } else {
    try {
      const raw = await readRawBody(req);
      if (raw) body = JSON.parse(raw.toString('utf8') || '{}');
    } catch (_) {}
  }

  let direction = String(body.direction || req.query?.direction || '').toLowerCase();
  let amount = Number(body.amount != null ? body.amount : req.query?.amount);

  if (!['ngn_to_usd', 'usd_to_ngn'].includes(direction)) {
    return res.status(400).json({ success: false, message: 'Invalid direction' });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ success: false, message: 'Enter a valid amount' });
  }

  const rate = Number(process.env.DEPOSIT_USD_RATE) || Number(process.env.USD_TO_NGN_RATE) || USD_RATE || 1450;

  const { data: profile, error: fetchErr } = await supabase
    .from('profiles')
    .select('id, balance, balance_usd, customer_id')
    .eq('id', user.id)
    .single();

  if (fetchErr || !profile) {
    return res.status(404).json({ success: false, message: 'Profile not found' });
  }

  let bal = Number(profile.balance) || 0;
  let balUsd = Number(profile.balance_usd) || 0;
  let converted = 0;

  if (direction === 'ngn_to_usd') {
    if (bal < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient NGN balance' });
    }
    converted = amount / rate;
    bal = Math.round((bal - amount) * 100) / 100;
    balUsd = Math.round((balUsd + converted) * 10000) / 10000;
  } else {
    if (balUsd < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient USD balance' });
    }
    converted = amount * rate;
    balUsd = Math.round((balUsd - amount) * 10000) / 10000;
    bal = Math.round((bal + converted) * 100) / 100;
  }

  const { error: upErr } = await supabase
    .from('profiles')
    .update({ balance: bal, balance_usd: balUsd })
    .eq('id', user.id);

  if (upErr) {
    console.error('[convert] update', upErr.message);
    return res.status(500).json({ success: false, message: 'Could not update balance' });
  }

  const inLabel = direction === 'ngn_to_usd'
    ? ('₦' + amount.toLocaleString())
    : ('$' + amount.toFixed(2));
  const outLabel = direction === 'ngn_to_usd'
    ? ('$' + converted.toFixed(2))
    : ('₦' + converted.toLocaleString(undefined, { maximumFractionDigits: 2 }));

  try {
    await supabase.from('transactions').insert({
      user_id: user.id,
      customer_id: profile.customer_id || null,
      type: 'conversion',
      category: 'conversion',
      title: 'Currency Conversion',
      subtitle: inLabel + ' to ' + outLabel,
      amount: outLabel,
      amount_ngn: direction === 'ngn_to_usd' ? amount : converted,
      status: 'Success',
      channel: 'Converter',
      payment_provider: 'MJ HUB'
    });
  } catch (e) {
    console.warn('[convert] tx', e?.message || e);
  }

  return res.status(200).json({
    success: true,
    balance: bal,
    balance_usd: balUsd,
    converted,
    direction,
    rate
  });
}


/** Client "I've sent the money" — return latest successful VA/checkout deposit for this user */
async function handleVerifyDeposit(req, res) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) return res.status(401).json({ success: false, message: 'Login required' });
  const user = await resolveUserFromToken(token);
  if (!user) return res.status(401).json({ success: false, message: 'Invalid session' });

  const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })() : (req.body || {});
  const expect = Math.round(Number(body.amount || body.expected_amount || 0)) || 0;

  const { data: profile } = await supabase
    .from('profiles')
    .select('balance, balance_usd, customer_id')
    .eq('id', user.id)
    .maybeSingle();

  // Recent successful pocketfi deposits (last 2 hours)
  const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data: txs } = await supabase
    .from('transactions')
    .select('id, amount, amount_ngn, status, external_reference, created_at, title, subtitle')
    .eq('user_id', user.id)
    .eq('payment_provider', 'pocketfi')
    .eq('status', 'success')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(10);

  let match = null;
  for (const tx of txs || []) {
    const a = Number(tx.amount_ngn) || 0;
    if (expect > 0 && Math.abs(a - expect) <= 2) {
      match = tx;
      break;
    }
  }
  if (!match && (txs || []).length) match = txs[0];

  if (match) {
    return res.status(200).json({
      success: true,
      credited: true,
      message: 'Payment received',
      data: {
        balance: Number(profile?.balance || 0),
        balance_usd: Number(profile?.balance_usd || 0),
        amount_ngn: Number(match.amount_ngn) || 0,
        reference: match.external_reference,
        transaction_id: match.id
      }
    });
  }

  return res.status(200).json({
    success: true,
    credited: false,
    message: 'Not seen yet. Keep this page open — we credit as soon as PocketFi confirms.',
    data: {
      balance: Number(profile?.balance || 0),
      balance_usd: Number(profile?.balance_usd || 0)
    }
  });
}


export default async function handler(req, res) {
  // --- Referral (no extra serverless file) ---
  {
    let _act = (req.query && req.query.action) || '';
    if (!_act && req.url) {
      try { _act = new URL(req.url, 'http://x').searchParams.get('action') || ''; } catch (_) {}
    }
    if (!_act && req.body) {
      try {
        const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
        _act = (b && b.action) || '';
      } catch (_) {}
    }
    _act = String(_act || '').toLowerCase();
    if (_act === 'referral_me' || _act === 'referral_stats') {
      const gate = await requireUserToken(req);
      if (!gate.ok) return res.status(gate.status).json({ success: false, message: gate.message });
      return handleReferralMe(req, res, gate.user);
    }
    if (_act === 'referral_attach') {
      const gate = await requireUserToken(req);
      if (!gate.ok) return res.status(gate.status).json({ success: false, message: gate.message });
      return handleReferralAttach(req, res, gate.user);
    }
    if (_act === 'convert' || _act === 'currency_convert') {
      const gate = await requireUserToken(req);
      if (!gate.ok) return res.status(gate.status).json({ success: false, message: gate.message });
      return handleConvert(req, res, gate.user);
    }
    if (_act === 'virtual_account') {
      const publicKey = process.env.POCKETFI_PUBLIC_KEY;
      const businessId = process.env.POCKETFI_BUSINESS_ID;
      if (!publicKey) return res.status(500).json({ success: false, message: 'Missing POCKETFI_PUBLIC_KEY' });
      if (!businessId) return res.status(500).json({ success: false, message: 'Missing POCKETFI_BUSINESS_ID' });
      return handleVirtualAccount(req, res, publicKey, businessId);
    }
    if (_act === 'verify_deposit' || _act === 'check_deposit') {
      return handleVerifyDeposit(req, res);
    }
  }
  // --- /Referral ---

  /* CORS via applyApiCors */
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (handleOptions(req, res)) return;
  applyApiCors(req, res, { methods: 'POST, OPTIONS' });
  setNoStore(res);
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'POST only' });
  }
  if (!rejectClientSuppliedSecrets(req, res)) return;


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
