/**
 * /api/order — everything for Fadded in ONE file (Sujan-style).
 *
 *   GET/POST ?action=sync        → catalog sync into products (+ inactive nudges)
 *   GET/POST ?nudge_only=1       → inactive-user emails only (needs CRON_SECRET if set)
 *   GET/POST ?action=my_orders   → customer logs + SMS list (JWT)
 *   POST                         → buy from Fadded (JWT)
 *
 * Backward compatible:
 *   - Purchases still POST /api/order (unchanged body)
 *   - Old /api/products URL kept via vercel.json rewrite → /api/order?action=sync
 *
 * Env: FADDED_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, optional CRON_SECRET, RESEND_*
 */

import { createClient } from '@supabase/supabase-js';
import { formatCredentials, formatMultiLogCredentials, joinRawLogDetails } from '../lib/formatCredentials.js';
import { rateLimit, applyRateLimitHeaders } from '../lib/rateLimit.js';
import { rejectClientSuppliedSecrets, applyApiCors, handleOptions, setNoStore } from '../lib/secure.js';
import { parsePositiveInt, assertSameUser } from '../lib/validate.js';
import { sendError } from '../lib/errors.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// -------------------------------------------------------------------------
// SUPPLIER ROUTING
// -------------------------------------------------------------------------
// Every product is tagged with product.supplier (defaults to "faded" when
// the column doesn't exist or is empty, so this is 100% backward-compatible
// with the current single-supplier setup).
//
// To add a new supplier later:
//   1. In Supabase, add a text column "supplier" to "products" (default 'faded').
//   2. Add an entry below with that supplier's base URL + API key env var.
//   3. Create a new /api/products-<name>.js sync file (copy api/products.js)
//      that upserts products with supplier: '<name>'.
//   4. That's it — this file already knows how to route orders to whichever
//      supplier a product belongs to.
const SUPPLIERS = {
  faded: {
    baseUrl: 'https://fadded.net/api/v1/reseller',
    apiKey: process.env.FADDED_API_KEY
  }
  // example second supplier:
  // newsupplier: {
  //   baseUrl: 'https://newsupplier.example.com/api/v1/reseller',
  //   apiKey: process.env.NEWSUPPLIER_API_KEY
  // }
};

function getSupplierConfig(product) {
  const key = (product && product.supplier) ? String(product.supplier).trim().toLowerCase() : 'faded';
  return SUPPLIERS[key] || SUPPLIERS.faded;
}


async function requireAuthUser(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token || token.includes('service_role')) {
    return { error: { status: 401, message: 'Not signed in' } };
  }
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return { error: { status: 401, message: 'Invalid or expired session' } };
  }
  return { user };
}


async function insertLogOrder(row) {
  let { error } = await supabase.from('orders').insert(row);
  if (error && /login_credentials_raw|schema cache|column/i.test(String(error.message || ''))) {
    const { login_credentials_raw, ...rest } = row;
    ({ error } = await supabase.from('orders').insert(rest));
  }
  return error;
}

async function handleMyOrders(req, res, userId) {
  try {
    const [logsRes, smsRes] = await Promise.all([
      supabase
        .from('orders')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(150),
      supabase
        .from('number_orders')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(150)
    ]);

    const logs = logsRes.error ? [] : logsRes.data || [];
    const sms = smsRes.error ? [] : smsRes.data || [];
    if (logsRes.error) console.warn('[order my_orders] logs', logsRes.error.message);
    if (smsRes.error) console.warn('[order my_orders] sms', smsRes.error.message);

    return res.status(200).json({
      success: true,
      logs,
      sms,
      counts: { logs: logs.length, sms: sms.length }
    });
  } catch (e) {
    console.error('[order my_orders]', e);
    return res.status(500).json({ success: false, message: 'Could not load orders right now' });
  }
}


// ===== Fadded catalog sync (formerly api/products.js) =====

// Your channels
const MY_WHATSAPP = 'https://whatsapp.com/channel/0029VbBdXJ2KQuJSJcqcck3o';
const MY_TELEGRAM = 'https://t.me/mj_hub_tg';

function stripHtml(html) {
  if (!html) return '';
  let text = String(html);
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  text = text.replace(/<br\s*\/?>/gi, ' ').replace(/<\/(div|p|li)>/gi, ' ');
  text = text.replace(/<[^>]*>/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function replaceChannelLinks(text) {
  if (!text) return text;

  text = text.replace(
    /https?:\/\/(wa\.me\/[^\s]+|api\.whatsapp\.com\/[^\s]+|whatsapp\.com\/[^\s]+|chat\.whatsapp\.com\/[^\s]+)/gi,
    MY_WHATSAPP
  );

  text = text.replace(
    /https?:\/\/(t\.me\/[^\s]+|telegram\.me\/[^\s]+|telegram\.dog\/[^\s]+)/gi,
    MY_TELEGRAM
  );

  return text;
}

/** Random markup between 50% and 100% — only used for NEW products */
function applyRandomMarkup(supplierPrice) {
  const percent = 50 + Math.random() * 50;
  const finalPrice = Math.ceil(supplierPrice * (1 + percent / 100));
  return Math.ceil(finalPrice / 50) * 50;
}

function categorize(name) {
  const n = (name || '').toUpperCase();

  if (n.includes('PROXY')) return '9PROXY (IPS)';
  if (n.includes('VPN') && n.includes('PHONE')) return 'PREMIUM VPN FOR PHONE';
  if (n.includes('VPN')) return 'PREMIUM VPN FOR PC';

  if (
    n.includes('CHATGPT') ||
    n.includes('CHAT GPT') ||
    n.includes('DEEP SEEK') ||
    n.includes('DEEPSEEK') ||
    n.includes('AI ACCOUNT')
  ) {
    return 'AI';
  }

  if (n.includes('ONLYFANS') || n.includes('ONLY FANS')) {
    return 'SOCIAL NETWORKS ACCOUNTS';
  }

  if (n.includes('INSTAGRAM') && n.includes('FOLLOWER')) return 'INSTAGRAM / HIGH FOLLOWERS';
  if (n.includes('INSTAGRAM')) return 'ALL COUNTRIES INSTAGRAM';

  if (n.includes('TIKTOK') || n.includes('TITKOK') || n.includes('TIK TOK')) {
    if (n.includes('FOLLOWER')) return 'TIKTOK/HIGH FOLLOWERS';
    return 'ALL COUNTRIES TIKTOK';
  }

  if (n.includes('DATING')) return 'DATING SITES';

  const isFacebookStyle =
    n.includes('FACEBOOK') ||
    n.includes('MARKETPLACE') ||
    n.includes('2FA') ||
    n.includes('FRIENDS') ||
    n.includes('PROFILE & COVER') ||
    n.includes('REGISTERED FROM');

  if (isFacebookStyle) {
    if (n.includes('RANDOM')) return 'RANDOM COUNTRY FACEBOOK';

    if (
      n.includes('0-5') ||
      n.includes('0-30') ||
      n.includes('MARKETPLACE + 2FA') ||
      (n.includes('MARKETPLACE') && !n.includes('30+'))
    ) {
      return 'COUNTRIES FACEBOOK (0-5 FRIENDS)';
    }

    return 'COUNTRIES FACEBOOK (30+ FRIENDS)';
  }

  if (n.includes('TWITTER') || n.includes(' X ') || n.startsWith('X ')) return 'X / TWITTER';
  if (n.includes('REDDIT')) return 'REDDIT';
  if (n.includes('SNAPCHAT')) return 'SNAPCHAT';
  if (n.includes('LINKEDIN')) return 'LINKEDIN';

  if (
    n.includes('GMAIL') ||
    n.includes('HOTMAIL') ||
    n.includes('GMX') ||
    n.includes('MAIL.RU') ||
    n.includes('TEXPLUS')
  ) {
    return 'MAILS';
  }

  if (
    n.includes('NETFLIX') ||
    n.includes('DISNEY') ||
    n.includes('PRIME VIDEO') ||
    n.includes('APPLE MUSIC')
  ) {
    return 'STREAMING SITE';
  }

  if (n.includes('STEAM')) return 'GAME ACCOUNTS';

  if (
    n.includes('GOOGLE VOICE') ||
    n.includes('TEXT FREE') ||
    n.includes('TALKATONE')
  ) {
    return 'TEXTING APP';
  }

  if (
    n.includes('TWITCH') ||
    n.includes('DISCORD') ||
    n.includes('PINTEREST') ||
    n.includes('QUORA') ||
    n.includes('CANVA')
  ) {
    return 'SOCIAL NETWORKS ACCOUNTS';
  }

  return 'OTHER';
}


// ---------------------------------------------------------------------------
// Inactive user re-engagement (Resend) — runs after catalog sync on daily cron
// No extra serverless function (Hobby 12/12). Env: RESEND_API_KEY, RESEND_FROM_EMAIL
// profiles: nudge_week, last_nudge_at, email_unsubscribed
// ---------------------------------------------------------------------------
const NUDGE_MAX_WEEK = 4;
const NUDGE_BATCH = 25;
const NUDGE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

async function resendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || process.env.RESEND_FROM || 'MJ Hub <onboarding@resend.dev>';
  if (!apiKey || !to) return { ok: false, skipped: true };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to: [to], subject, html })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[nudge-email] Resend error', res.status, json);
    return { ok: false, error: json };
  }
  return { ok: true, id: json.id };
}

function nudgeEmailContent(week, name, appUrl) {
  const safe = String(name || 'there').trim() || 'there';
  const unsub = `${appUrl}/dashboard?unsubscribe=1`;
  const subjects = {
    1: 'Your MJ Hub account is ready — fund & get started',
    2: 'Still exploring? SMS, logs & boosts in one place',
    3: 'Need a hand getting started on MJ Hub?',
    4: 'Last reminder — we are here when you need us'
  };
  const bodies = {
    1: `Hi ${safe},<br><br>You signed up for <strong>MJ Hub</strong> a week ago. Your account is ready whenever you are.<br><br>Fund your wallet, then grab SMS numbers, logs, or social boosts in a few taps.<br><br><a href="${appUrl}/dashboard" style="color:#3b82f6;font-weight:700;">Open your dashboard</a>`,
    2: `Hi ${safe},<br><br>A quick reminder that MJ Hub covers <strong>SMS verification</strong>, <strong>logs</strong>, and <strong>boosters</strong> in one wallet.<br><br>Whenever you are ready, fund and place your first order from the dashboard.<br><br><a href="${appUrl}/dashboard" style="color:#3b82f6;font-weight:700;">Continue on MJ Hub</a>`,
    3: `Hi ${safe},<br><br>If anything blocked you after signup — funding, a product question, or support — reply to this email or use in-app support. We are happy to help.<br><br><a href="${appUrl}/dashboard" style="color:#3b82f6;font-weight:700;">Get help in the app</a>`,
    4: `Hi ${safe},<br><br>This is our last check-in for now. Your MJ Hub account stays open; come back anytime you need SMS, logs, or boosts.<br><br><a href="${appUrl}/dashboard" style="color:#3b82f6;font-weight:700;">Visit MJ Hub</a>`
  };
  const w = Math.min(Math.max(week, 1), 4);
  const subject = subjects[w] || subjects[1];
  const inner = bodies[w] || bodies[1];
  const year = new Date().getFullYear();
  const html = `<!DOCTYPE html><html><body style="margin:0;background:#0a0a0f;font-family:Arial,sans-serif;color:#e5e7eb;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0f;padding:32px 16px;"><tr><td align="center">
  <table width="560" cellpadding="0" cellspacing="0" style="background:#111118;border-radius:16px;border:1px solid #1c1c28;padding:28px;">
  <tr><td style="font-size:20px;font-weight:800;color:#fff;padding-bottom:8px;">MJ Hub</td></tr>
  <tr><td style="font-size:15px;line-height:1.6;color:#cbd5e1;">${inner}</td></tr>
  <tr><td style="padding-top:24px;font-size:12px;color:#6b7280;line-height:1.5;">
  You received this because you registered on MJ Hub and have not placed an order yet.
  <a href="${unsub}" style="color:#9ca3af;">Unsubscribe from these tips</a><br>© ${year} MJ Hub
  </td></tr></table></td></tr></table></body></html>`;
  return { subject, html };
}

async function userHasPurchased(supabase, userId) {
  const checks = ['orders', 'number_orders', 'booster_orders'];
  for (const table of checks) {
    try {
      const { count, error } = await supabase
        .from(table)
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .limit(1);
      if (!error && count && count > 0) return true;
    } catch (e) {
      /* table may differ */
    }
  }
  return false;
}

async function runInactiveNudges(supabase) {
  if (!process.env.RESEND_API_KEY) {
    return { sent: 0, skipped: true, reason: 'no RESEND_API_KEY' };
  }
  const appUrl = (process.env.APP_URL || process.env.SITE_URL || 'https://app.mjhub.store').replace(/\/$/, '');
  const cutoff = new Date(Date.now() - NUDGE_INTERVAL_MS).toISOString();

  // Candidates: registered long enough, not unsubscribed, under max weeks
  let q = supabase
    .from('profiles')
    .select('id, email, full_name, nudge_week, last_nudge_at, email_unsubscribed, created_at')
    .or('email_unsubscribed.is.null,email_unsubscribed.eq.false')
    .lt('nudge_week', NUDGE_MAX_WEEK)
    .not('email', 'is', null)
    .order('created_at', { ascending: true })
    .limit(80);

  const { data: rows, error } = await q;
  if (error) {
    console.error('[nudge] profiles query', error.message);
    return { sent: 0, error: error.message };
  }

  let sent = 0;
  let examined = 0;
  const errors = [];

  for (const row of rows || []) {
    if (sent >= NUDGE_BATCH) break;
    const email = String(row.email || '').trim();
    if (!email || !email.includes('@')) continue;

    const created = row.created_at ? new Date(row.created_at).getTime() : 0;
    if (!created || created > Date.now() - NUDGE_INTERVAL_MS) continue; // need 7+ days since signup

    const week = Number(row.nudge_week) || 0;
    const last = row.last_nudge_at ? new Date(row.last_nudge_at).getTime() : 0;
    if (week === 0) {
      // first nudge: only signup age matters (already checked)
    } else if (last && Date.now() - last < NUDGE_INTERVAL_MS) {
      continue; // wait another week between nudges
    }

    examined++;
    if (await userHasPurchased(supabase, row.id)) {
      // mark as done so we don't keep scanning forever
      await supabase.from('profiles').update({
        nudge_week: NUDGE_MAX_WEEK,
        last_nudge_at: new Date().toISOString()
      }).eq('id', row.id);
      continue;
    }

    const nextWeek = week + 1;
    const { subject, html } = nudgeEmailContent(nextWeek, row.full_name, appUrl);
    const result = await resendEmail({ to: email, subject, html });
    if (!result.ok) {
      errors.push({ email, error: result.error || result });
      continue;
    }

    const { error: upErr } = await supabase.from('profiles').update({
      nudge_week: nextWeek,
      last_nudge_at: new Date().toISOString()
    }).eq('id', row.id);
    if (upErr) console.error('[nudge] update', upErr.message);
    sent++;
  }

  return { sent, examined, errors: errors.slice(0, 5) };
}


async function handleFaddedSync(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({
        success: false,
        message: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'
      });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Manual/test: GET/POST /api/products?nudge_only=1 with Authorization: Bearer CRON_SECRET
    const nudgeOnly = String((req.query && req.query.nudge_only) || '') === '1';
    if (nudgeOnly) {
      const auth = req.headers.authorization || '';
      const cronOk = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
      // Vercel Cron sends no body; allow when CRON_SECRET unset only on Vercel cron user-agent is weak — require secret if set
      if (process.env.CRON_SECRET && !cronOk) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }
      const nudge = await runInactiveNudges(supabase);
      return res.status(200).json({ success: true, inactive_nudges: nudge });
    }

    if (!process.env.FADDED_API_KEY) {
      return res.status(500).json({
        success: false,
        message: 'Missing FADDED_API_KEY'
      });
    }

    const apiRes = await fetch('https://fadded.net/api/v1/reseller/products', {
      method: 'GET',
      headers: {
        'X-Api-Key': process.env.FADDED_API_KEY,
        'Accept': 'application/json'
      }
    });

    if (!apiRes.ok) {
      const errorText = await apiRes.text();
      return res.status(apiRes.status).json({
        success: false,
        message: `Supplier API error: ${apiRes.status}`,
        details: errorText
      });
    }

    const supplierData = await apiRes.json();

    if (!supplierData.success) {
      return res.status(400).json({
        success: false,
        message: 'Supplier reported failure',
        error: supplierData
      });
    }

    const products = supplierData.data || [];
    let newCount = 0;
    let updatedCount = 0;

    // One batched query for every product_key in this sync, instead of a
    // separate select('*') per item (was N+1 — one full-row round trip per
    // product just to check truthiness, times however many products Fadded
    // returns, plus a second round trip each for the actual insert/update).
    // Only the column actually needed for the existence check is selected.
    const allKeys = products.map((item) => item.product_key).filter(Boolean);
    const existingKeySet = new Set();
    const EXISTS_CHECK_BATCH = 500;
    for (let i = 0; i < allKeys.length; i += EXISTS_CHECK_BATCH) {
      const keyBatch = allKeys.slice(i, i + EXISTS_CHECK_BATCH);
      const { data: existingRows, error: existErr } = await supabase
        .from('products')
        .select('product_key')
        .in('product_key', keyBatch);
      if (existErr) {
        console.error('Error checking existing product_keys:', existErr.message);
        continue;
      }
      (existingRows || []).forEach((r) => existingKeySet.add(r.product_key));
    }

    const toInsert = [];
    const toUpdate = [];

    for (const item of products) {
      if (!item.product_key) continue;
      const cleanDescription = stripHtml(item.description);
      const displayDescription = replaceChannelLinks(cleanDescription);

      const supplierPrice = Number(
        item.unit_price ??
        item.price ??
        item.cost ??
        item.amount ??
        item.reseller_price ??
        item.buy_price ??
        item.original_price ??
        0
      ) || 0;

      const stock = item.in_stock ?? 0;
      const now = new Date().toISOString();

      if (existingKeySet.has(item.product_key)) {
        // EXISTING: refresh name/description + supplier cost + stock so the
        // catalog always reflects what the supplier currently calls this
        // product (protects against them renaming/reusing a listing).
        // Your resale price and category are business decisions — those are
        // still never touched here, only ever changed by you in the admin panel.
        // `source` IS re-set here to backfill rows synced before this field
        // existed — otherwise only brand-new products ever got tagged, and
        // the rest of an existing catalog stayed permanently blank on the
        // admin dashboard's supplier badge.
        updatedCount++;
        toUpdate.push({
          product_key: item.product_key,
          name: item.name,
          description: cleanDescription,
          display_description: displayDescription,
          supplier_price: supplierPrice,
          stock_quantity: stock,
          is_available: stock > 0,
          source: 'fadded',
          updated_at: now
        });
      } else {
        // NEW product: set full row including auto markup + category
        newCount++;
        toInsert.push({
          product_key: item.product_key,
          name: item.name,
          description: cleanDescription,
          display_description: displayDescription,
          supplier_price: supplierPrice,
          price: applyRandomMarkup(supplierPrice),
          stock_quantity: stock,
          is_available: stock > 0,
          category: categorize(item.name),
          source: 'fadded',
          updated_at: now
        });
      }
    }

    // Batched upsert for updates — upsert() only touches the columns present
    // in each row, so price/category (deliberately excluded above) are never
    // reset for an existing row, same guarantee as the old per-item .update().
    const WRITE_BATCH = 200;
    for (let i = 0; i < toUpdate.length; i += WRITE_BATCH) {
      const batch = toUpdate.slice(i, i + WRITE_BATCH);
      const { error } = await supabase.from('products').upsert(batch, { onConflict: 'product_key' });
      if (error) console.error('Error updating product batch:', error.message);
    }
    for (let i = 0; i < toInsert.length; i += WRITE_BATCH) {
      const batch = toInsert.slice(i, i + WRITE_BATCH);
      const { error } = await supabase.from('products').insert(batch);
      if (error) console.error('Error inserting product batch:', error.message);
    }

    let nudge = { sent: 0 };
    try {
      nudge = await runInactiveNudges(supabase);
    } catch (nudgeErr) {
      console.error('[nudge] failed', nudgeErr);
      nudge = { sent: 0, error: String(nudgeErr && nudgeErr.message || nudgeErr) };
    }

    return res.status(200).json({
      success: true,
      synced: products.length,
      new_products: newCount,
      updated_products: updatedCount,
      inactive_nudges: nudge
    });
  } catch (error) {
    console.error('Handler error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Internal server error'
    });
  }
}

// ===== Order + my_orders dispatcher =====
export default async function handler(req, res) {
  applyApiCors(req, res, { methods: 'GET, POST, OPTIONS' });
  setNoStore(res);
  if (handleOptions(req, res)) return;
  if (!rejectClientSuppliedSecrets(req, res)) return;

  // -----------------------------------------------------------------------
  // Fadded catalog sync + inactive nudges (was api/products.js)
  // GET/POST /api/order?action=sync   — same as old GET /api/products
  // GET/POST /api/order?nudge_only=1  — nudge emails only
  // No customer JWT required (admin button + Vercel cron).
  // -----------------------------------------------------------------------
  const q = Object.assign({}, req.query || {});
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    u.searchParams.forEach((v, k) => { if (q[k] == null || q[k] === '') q[k] = v; });
  } catch (_) {}
  let bodyPeek = {};
  try {
    if (req.method === 'POST' && req.body) {
      bodyPeek = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    }
  } catch (_) {}
  const action = String(q.action || bodyPeek.action || '').toLowerCase();
  const nudgeOnly = String(q.nudge_only || bodyPeek.nudge_only || '') === '1';
  if (action === 'sync' || action === 'nudge_only' || nudgeOnly) {
    // Slightly higher limit for cron/admin sync
    const rlSync = rateLimit(req, { limit: 10, windowMs: 60_000, suffix: 'fadded-sync' });
    applyRateLimitHeaders(res, rlSync);
    if (!rlSync.ok) {
      return res.status(429).json({ success: false, message: rlSync.message });
    }
    return handleFaddedSync(req, res);
  }

  const rl = rateLimit(req, { limit: 30, windowMs: 60_000, suffix: 'order' });
  applyRateLimitHeaders(res, rl);
  if (!rl.ok) {
    return res.status(429).json({ success: false, message: rl.message });
  }

  // IDOR protection: never trust body.user_id — bind to JWT only
  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ success: false, message: auth.error.message });
  }
  const user_id = auth.user.id;

  // GET /api/order?action=my_orders  — list this user's logs + SMS (no new serverless function)
  let action = req.query?.action;
  if (!action && req.url) {
    try {
      action = new URL(req.url, 'http://localhost').searchParams.get('action');
    } catch (_) {}
  }
  if (req.method === 'GET' || action === 'my_orders') {
    if (req.method === 'GET' || action === 'my_orders') {
      return handleMyOrders(req, res, user_id);
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

  // POST { action: 'my_orders' } also supported
  if (body.action === 'my_orders') {
    return handleMyOrders(req, res, user_id);
  }

  const {
    product_key,
    quantity = 1,
    external_order_id,
    customer_info,
    user_id: bodyUserId
  } = body;

  const same = assertSameUser(user_id, bodyUserId);
  if (!same.ok) return res.status(same.status).json({ success: false, message: same.message });

  if (!product_key || typeof product_key !== 'string' || product_key.length > 120) {
    return res.status(400).json({ success: false, message: 'product_key is required' });
  }

  const qtyCheck = parsePositiveInt(quantity, { min: 1, max: 20 });
  if (!qtyCheck.ok) {
    return res.status(400).json({ success: false, message: 'Invalid quantity (1–20)' });
  }
  const safeQty = qtyCheck.value;

  let originalBalance = 0;
  let total = 0;
  let productName = '';
  let customerId = null;
  let deducted = false;

  try {
    // -------------------------------------------------
    // 1. Get product from your database
    // -------------------------------------------------
    const { data: product, error: prodErr } = await supabase
      .from('products')
      .select('*')
      .eq('product_key', product_key)
      .single();

    if (prodErr || !product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    total = Number(product.price) * Number(safeQty);
    productName = product.name;

    // -------------------------------------------------
    // 2. Get user profile + balance
    // -------------------------------------------------
    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('balance, customer_id')
      .eq('id', user_id)
      .single();

    if (profileErr || !profile) {
      return res.status(400).json({ success: false, message: 'User profile not found' });
    }

    originalBalance = Number(profile.balance || 0);
    customerId = profile.customer_id;

    if (originalBalance < total) {
      return res.status(402).json({
        success: false,
        message: 'Insufficient balance',
        required: total,
        available: originalBalance
      });
    }

    // -------------------------------------------------
    // 3. Debit user immediately
    // -------------------------------------------------
    const newBalance = originalBalance - total;

    const { error: deductErr } = await supabase
      .from('profiles')
      .update({ balance: newBalance })
      .eq('id', user_id);

    if (deductErr) {
      return res.status(500).json({
        success: false,
        message: 'Could not debit your balance. Please try again.'
      });
    }

    deducted = true;

    // -------------------------------------------------
    // 4. Call supplier (Faded)
    // -------------------------------------------------
    const orderRef = external_order_id || `MJ-${user_id.slice(0, 8)}-${Date.now()}`;
    const supplierConfig = getSupplierConfig(product);

    const supplierRes = await fetch(`${supplierConfig.baseUrl}/order`, {
      method: 'POST',
      headers: {
        'X-Api-Key': supplierConfig.apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        product_key,
        quantity: safeQty,
        external_order_id: orderRef,
        customer_info: customer_info || {}
      })
    });

    const orderData = await supplierRes.json();

    // -------------------------------------------------
    // 5. Supplier failed → automatic refund
    // -------------------------------------------------
    if (!orderData.success) {
      // Refund user
      await supabase
        .from('profiles')
        .update({ balance: originalBalance })
        .eq('id', user_id);

      // Record failed purchase → Log Orders tab
      await supabase.from('transactions').insert({
        user_id,
        customer_id: customerId,
        type: 'log',
        category: 'log',
        title: productName,
        subtitle: `Failed: ${orderData.message || orderData.code || 'Supplier error'}`,
        amount: `₦${total.toLocaleString()}`,
        amount_ngn: total,
        status: 'failed',
        notes: JSON.stringify(orderData)
      });

      // Record refund → Deposits tab
      await supabase.from('transactions').insert({
        user_id,
        customer_id: customerId,
        type: 'deposit',
        category: 'deposit',
        title: 'Automatic Refund',
        subtitle: 'Order failed at supplier – balance restored',
        amount: `₦${total.toLocaleString()}`,
        amount_ngn: total,
        status: 'refunded'
      });

      return res.status(400).json({
        success: false,
        code: orderData.code || 'SUPPLIER_ERROR',
        message: orderData.message || 'Order failed at supplier. Your balance has been refunded.'
      });
    }

    // -------------------------------------------------
    // 6. Supplier succeeded → save everything
    // -------------------------------------------------
    const items = orderData.data?.items || [];
    const detailsText = items.map(i => i.details).join('\n\n');

    // Whatever the product's own description is (if it has one) is stored on
    // every order for that product. If the product has no description, this
    // is left blank rather than guessing/filling in something else.
    const orderDescription = (product.display_description || product.description || '').trim() || null;

    // ONE orders row per purchase (same product + qty). All logs share orderRef.
    // Numbered 1. 2. 3. … inside login_credentials so My Orders / admin stay tidy
    // and the DB does not grow one row per unit.
    const formatHint = product.display_description || product.description || '';
    const combinedCreds =
      formatMultiLogCredentials(items, formatHint) ||
      (items[0]
        ? formatCredentials(items[0].details, formatHint) || String(items[0].details || '').trim()
        : null);
    const combinedRaw = joinRawLogDetails(items) || detailsText || null;
    const supplierRefs = items
      .map((it) => it.product_detail_id || it.id || it.serial)
      .filter(Boolean)
      .map(String)
      .join(', ');

    const insertErr = await insertLogOrder({
      order_id: orderRef,
      user_id,
      product_id: product.id,
      product_code: product_key,
      product_name: productName,
      product_type: 'log',
      description: orderDescription,
      quantity: items.length || safeQty,
      amount: total,
      status: 'completed',
      login_credentials: combinedCreds,
      login_credentials_raw: combinedRaw,
      supplier_ref: supplierRefs || orderRef,
      guide_url: 'https://t.me/mj_hub_tg'
    });
    if (insertErr) {
      console.error('[order] insert failed', insertErr.message, { order_id: orderRef, qty: items.length });
    }

    // Save money movement in transactions → Log Orders tab
    await supabase.from('transactions').insert({
      user_id,
      customer_id: customerId,
      type: 'log',
      category: 'log',
      title: productName,
      subtitle: `Qty: ${safeQty}`,
      amount: `₦${total.toLocaleString()}`,
      amount_ngn: total,
      status: 'completed',
      product_details: detailsText,
      supplier_order: orderData.data
    });

    // Reduce local stock
    await supabase
      .from('products')
      .update({
        stock_quantity: Math.max(0, (product.stock_quantity || 0) - quantity),
        is_available: (product.stock_quantity || 0) - quantity > 0
      })
      .eq('product_key', product_key);

    // -------------------------------------------------
    // 7. Return product to customer
    // -------------------------------------------------
    const formattedItems = (items || []).map((i) => ({
      details: formatCredentials(i.details, formatHint) || String(i.details || '').trim(),
      serial: i.serial || i.product_detail_id || i.id || null
    }));
    return res.status(200).json({
      success: true,
      message: 'Order fulfilled successfully',
      data: {
        items: formattedItems.length ? formattedItems : (orderData.data?.items || []),
        login_credentials: combinedCreds || null,
        total_amount: total,
        new_balance: newBalance,
        order_id: orderRef,
        source: 'fadded'
      }
    });

  } catch (err) {
    console.error('Order handler error:', err);

    // Safety net: refund if we already debited
    if (deducted) {
      try {
        await supabase
          .from('profiles')
          .update({ balance: originalBalance })
          .eq('id', user_id);

        await supabase.from('transactions').insert({
          user_id,
          customer_id: customerId,
          type: 'deposit',
          category: 'deposit',
          title: 'Automatic Refund',
          subtitle: `System error – ${err.message}`,
          amount: `₦${total.toLocaleString()}`,
          amount_ngn: total,
          status: 'refunded',
          notes: err.message
        });
      } catch (refundErr) {
        console.error('CRITICAL: Auto-refund failed', refundErr);
      }
    }

    return res.status(500).json({
      success: false,
      message: deducted
        ? 'Something went wrong. Your balance has been refunded.'
        : 'Something went wrong. Please try again.'
    });
  }
}
