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
import { debitWallet, refundWalletDebit } from '../lib/wallet.js';
import { sendPushToUser, sendPushToAdmins} from '../lib/push.js';
import { quoteCoupon, redeemCoupon } from '../lib/coupons.js';
import { formatCredentials, formatMultiLogCredentials, joinRawLogDetails } from '../lib/formatCredentials.js';
import { readSupplierStock } from '../lib/supplierStock.js';
import { rateLimit, applyRateLimitHeaders } from '../lib/rateLimit.js';
import { rejectClientSuppliedSecrets, applyApiCors, handleOptions, setNoStore, requireAdminOrCron } from '../lib/secure.js';
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

async function handleSupportTicket(req, res, user) {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const message = String(body.message || body.complaint || '').trim();
    if (!message || message.length < 3) {
      return res.status(400).json({ success: false, message: 'Write your complaint first' });
    }
    if (message.length > 4000) {
      return res.status(400).json({ success: false, message: 'Complaint is too long' });
    }
    const orderId = String(body.order_id || '').slice(0, 120);
    const product = String(body.product || 'Order').slice(0, 160);

    let customerId = String(body.customer_id || '').slice(0, 40);
    let fullName = String(body.user_name || '').slice(0, 120);
    try {
      const { data: prof } = await supabase
        .from('profiles')
        .select('customer_id, full_name')
        .eq('id', user.id)
        .maybeSingle();
      if (prof && prof.customer_id) customerId = String(prof.customer_id);
      if (prof && prof.full_name) fullName = String(prof.full_name);
    } catch (e) {}

    const subject = ('Order complaint' + (orderId ? ' · ' + orderId : '')).slice(0, 180);
    const ticketRow = {
      user_id: user.id,
      customer_id: customerId || null,
      user_email: user.email || null,
      user_name: fullName || null,
      subject,
      status: 'open'
    };

    let created = null;
    let error = null;
    ({ data: created, error } = await supabase.from('support_tickets').insert(ticketRow).select('id').single());
    if (error) {
      ({ data: created, error } = await supabase.from('support_tickets').insert({
        user_id: user.id,
        subject,
        status: 'open'
      }).select('id').single());
    }
    if (error || !created) {
      console.error('[order support_ticket]', error && error.message);
      return res.status(500).json({ success: false, message: 'Could not create the support ticket' });
    }

    const bodyText = String(message || '').trim().slice(0, 8000);

    const { error: msgErr } = await supabase.from('support_messages').insert({
      ticket_id: created.id,
      sender_type: 'user',
      sender_id: user.id,
      body: bodyText
    });
    if (msgErr) {
      console.error('[order support_ticket message]', msgErr.message);
      return res.status(500).json({ success: false, message: 'Ticket opened but the message did not save. Try again.' });
    }

    return res.status(200).json({
      success: true,
      ticket_id: created.id,
      customer_id: customerId || null
    });
  } catch (e) {
    console.error('[order support_ticket]', e);
    return res.status(500).json({ success: false, message: 'Could not send the complaint right now' });
  }
}

async function handleSupportUpload(req, res, user) {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const raw = String(body.data || body.base64 || '').replace(/\s/g, '');
    if (!raw || raw.length < 32 || raw.length > 500000) {
      return res.status(400).json({ success: false, message: 'Photo is missing or too large' });
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(raw.slice(0, 80))) {
      return res.status(400).json({ success: false, message: 'Invalid photo' });
    }
    const buf = Buffer.from(raw, 'base64');
    if (!buf || buf.length < 32) {
      return res.status(400).json({ success: false, message: 'Invalid photo' });
    }
    const ticketPart = String(body.ticket_id || user.id || 'misc').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
    const path = 'tickets/' + ticketPart + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.jpg';
    const buckets = ['support-attachments', 'support', 'attachments'];
    try {
      await supabase.storage.createBucket('support-attachments', { public: true, fileSizeLimit: 2 * 1024 * 1024 });
    } catch (e) {}
    let savedUrl = '';
    for (const bucket of buckets) {
      const up = await supabase.storage.from(bucket).upload(path, buf, {
        contentType: 'image/jpeg',
        upsert: true
      });
      if (up.error) continue;
      const pub = supabase.storage.from(bucket).getPublicUrl(path);
      if (pub && pub.data && pub.data.publicUrl) {
        savedUrl = pub.data.publicUrl;
        break;
      }
      const signed = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60 * 24 * 365);
      if (signed && signed.data && signed.data.signedUrl) {
        savedUrl = signed.data.signedUrl;
        break;
      }
    }
    if (!savedUrl) {
      return res.status(500).json({ success: false, message: 'Could not store the photo' });
    }
    return res.status(200).json({ success: true, url: savedUrl });
  } catch (e) {
    console.error('[order support_upload]', e);
    return res.status(500).json({ success: false, message: 'Could not store the photo' });
  }
}

async function handleUpdateProfile(req, res, user) {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const full_name = String(body.full_name || body.name || '').trim().slice(0, 80);
    const phone = String(body.phone || body.phone_number || '').trim().slice(0, 30);
    const address = String(body.address || '').trim().slice(0, 200);
    const bio = String(body.bio || '').trim().slice(0, 500);
    if (!full_name) {
      return res.status(400).json({ success: false, message: 'Enter your name' });
    }
    const patch = {
      full_name,
      name: full_name,
      phone: phone || null,
      phone_number: phone || null,
      address: address || null,
      bio: bio || null,
      updated_at: new Date().toISOString()
    };
    let { data, error } = await supabase
      .from('profiles')
      .update(patch)
      .eq('id', user.id)
      .select('id, full_name, name, phone, phone_number, address, bio')
      .maybeSingle();
    if (error && /column|schema cache|Could not find/i.test(String(error.message || ''))) {
      const slim = { full_name, phone: phone || null };
      ({ data, error } = await supabase
        .from('profiles')
        .update(slim)
        .eq('id', user.id)
        .select('id, full_name, phone')
        .maybeSingle());
    }
    if ((error || !data) && !error) {
      const insertRow = { id: user.id, email: user.email || null, ...patch };
      ({ data, error } = await supabase
        .from('profiles')
        .upsert(insertRow, { onConflict: 'id' })
        .select('id, full_name, phone, address, bio')
        .maybeSingle());
    }
    if (error || !data) {
      console.error('[order update_profile]', error && error.message);
      return res.status(500).json({ success: false, message: (error && error.message) || 'Could not save profile' });
    }
    const savedName = String(data.full_name || data.name || '');
    if (savedName && savedName !== full_name) {
      return res.status(500).json({ success: false, message: 'Profile did not keep the new name. A database rule is blocking the change.' });
    }
    return res.status(200).json({
      success: true,
      profile: {
        full_name: data.full_name || data.name || full_name,
        phone: data.phone_number || data.phone || phone,
        address: data.address || address,
        bio: data.bio || bio
      }
    });
  } catch (e) {
    console.error('[order update_profile]', e);
    return res.status(500).json({ success: false, message: 'Could not save profile' });
  }
}

async function handleMyOrders(req, res, userId) {
  try {
    // Incremental mode: ?since=ISO&action=my_orders → only new rows (+ open SMS for status)
    // Full mode: default or ?full=1
    let since = null;
    let wantFull = false;
    try {
      const q = req.query || {};
      since = q.since || null;
      wantFull = q.full === '1' || q.force === '1' || q.full === 1;
      if (!since || !wantFull) {
        const u = new URL(req.url || '', 'http://localhost');
        if (!since) since = u.searchParams.get('since');
        if (u.searchParams.get('full') === '1' || u.searchParams.get('force') === '1') wantFull = true;
      }
    } catch (_) {}

    let customer_id = null;
    let full_name = null;
    try {
      const { data: prof } = await supabase
        .from('profiles')
        .select('customer_id, full_name')
        .eq('id', userId)
        .maybeSingle();
      customer_id = (prof && prof.customer_id) || null;
      full_name = (prof && prof.full_name) || null;
    } catch (e) {}

    // --- Incremental: small egress ---
    if (since && !wantFull) {
      // Validate before calling toISOString(); invalid dates throw RangeError.
      const parsedSince = new Date(since);
      if (Number.isNaN(parsedSince.getTime())) {
        return res.status(400).json({ success: false, message: 'Invalid since timestamp' });
      }
      const sinceIso = parsedSince.toISOString();
      const openStatuses = ['active', 'waiting', 'waiting_for_code', 'pending', 'processing'];
      const [logsRes, smsNewRes, smsOpenRes] = await Promise.all([
        supabase
          .from('orders')
          .select('*')
          .eq('user_id', userId)
          .gt('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(50),
        supabase
          .from('number_orders')
          .select('*')
          .eq('user_id', userId)
          // Include existing rentals whose status changed after the history cache watermark.
          .or('created_at.gt.' + sinceIso + ',updated_at.gt.' + sinceIso)
          .order('created_at', { ascending: false })
          .limit(100),
        // Re-sync status for still-open numbers only (tiny set)
        supabase
          .from('number_orders')
          .select('*')
          .eq('user_id', userId)
          .in('status', openStatuses)
          .order('created_at', { ascending: false })
          .limit(40)
      ]);
      if (logsRes.error) console.warn('[order my_orders incremental] logs', logsRes.error.message);
      if (smsNewRes.error) console.warn('[order my_orders incremental] sms new', smsNewRes.error.message);
      if (smsOpenRes.error) console.warn('[order my_orders incremental] sms open', smsOpenRes.error.message);

      const logs = logsRes.error ? [] : logsRes.data || [];
      const smsMap = new Map();
      for (const row of [...(smsOpenRes.data || []), ...(smsNewRes.data || [])]) {
        if (!row) continue;
        const k = String(row.id || row.order_id || '');
        if (k) smsMap.set(k, row);
      }
      const sms = Array.from(smsMap.values());
      return res.status(200).json({
        success: true,
        incremental: true,
        since: sinceIso,
        logs,
        sms,
        customer_id,
        full_name,
        counts: { logs: logs.length, sms: sms.length }
      });
    }

    // --- Full snapshot ---
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
      incremental: false,
      logs,
      sms,
      customer_id,
      full_name,
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
// Customer care emails (Resend → Mailtrap)
// Track A: never bought  |  Track B: last order older than 14 days
// Cadence: at most 1 email every 7 days per user. Batch capped per cron run.
// profiles: nudge_week, last_nudge_at, email_unsubscribed
// optional: lapse_week, last_lapse_at (Track B; skipped gracefully if missing)
// Env: RESEND_API_KEY, RESEND_FROM_EMAIL, MAILTRAP_API_TOKEN, MAILTRAP_FROM_EMAIL
// ---------------------------------------------------------------------------
const NUDGE_MAX_WEEK = 6;
const LAPSE_MAX_WEEK = 4;
const NUDGE_BATCH = 40;
const NUDGE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const LAPSE_IDLE_MS = 14 * 24 * 60 * 60 * 1000;

function isProviderQuotaError(status, json) {
  if (status === 429 || status === 402 || status === 403) return true;
  const msg = JSON.stringify(json || {}).toLowerCase();
  return /rate limit|quota|too many|monthly|daily limit|free tier|usage limit|exceeded|insufficient/i.test(msg);
}

function parseFromAddress(raw, fallbackEmail) {
  const s = String(raw || '').trim();
  const m = s.match(/^(.+?)\s*<([^>]+)>$/);
  if (m) {
    return {
      name: m[1].trim().replace(/^["']|["']$/g, '') || 'MJ Hub',
      email: m[2].trim()
    };
  }
  if (s.includes('@')) return { name: 'MJ Hub', email: s };
  return { name: 'MJ Hub', email: fallbackEmail || 'noreply@mjhub.store' };
}

/** Send via Resend, then Mailtrap on quota. Never both for the same recipient. */
async function sendCareEmail({ to, subject, html }) {
  const resendKey = process.env.RESEND_API_KEY;
  const mailtrapKey = process.env.MAILTRAP_API_TOKEN || process.env.MAILTRAP_API_KEY;
  const fromResend =
    process.env.RESEND_FROM_EMAIL || process.env.RESEND_FROM || 'MJ Hub <onboarding@resend.dev>';
  const fromMailtrap =
    process.env.MAILTRAP_FROM_EMAIL ||
    process.env.RESEND_FROM_EMAIL ||
    process.env.RESEND_FROM ||
    'MJ Hub <noreply@mjhub.store>';

  if (!resendKey && !mailtrapKey) return { ok: false, skipped: true, error: 'no email keys' };

  if (resendKey) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from: fromResend, to: [to], subject, html })
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, provider: 'resend', id: json.id };
      if (!isProviderQuotaError(res.status, json)) {
        console.error('[care-email] Resend error', res.status, json);
        return { ok: false, provider: 'resend', error: json };
      }
      console.warn('[care-email] Resend quota, trying Mailtrap for', to);
    } catch (e) {
      console.error('[care-email] Resend exception', e.message);
      if (!mailtrapKey) return { ok: false, provider: 'resend', error: e.message };
    }
  }

  if (!mailtrapKey) return { ok: false, provider: 'resend', error: 'quota and no Mailtrap' };

  const from = parseFromAddress(fromMailtrap, 'noreply@mjhub.store');
  try {
    const res = await fetch('https://send.api.mailtrap.io/api/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mailtrapKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: { email: from.email, name: from.name },
        to: [{ email: to }],
        subject,
        html
      })
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && (json.success === true || json.message_ids || res.status === 200)) {
      return { ok: true, provider: 'mailtrap' };
    }
    console.error('[care-email] Mailtrap error', res.status, json);
    return { ok: false, provider: 'mailtrap', error: json };
  } catch (e) {
    console.error('[care-email] Mailtrap exception', e.message);
    return { ok: false, provider: 'mailtrap', error: e.message };
  }
}

// 28 short human messages. Rotated by user id + step so the same person
// does not always get the same wording, and different people get variety.
const CARE_MESSAGES = [
  {
    subject: 'Your MJ Hub account is ready',
    body: 'You signed up a little while ago and your account is waiting for you.\n\nWhenever you are ready, fund your wallet and order SMS numbers, logs, boosters, eSIM plans, or Telegram Stars and blue tick help from one dashboard.\n\nWe are glad you joined.'
  },
  {
    subject: 'A simple way to start on MJ Hub',
    body: 'If you have not ordered yet, the easiest first step is usually an SMS number or a log.\n\nFund once in Naira, then order from the same wallet. Everything lands in your dashboard.\n\nWe are here if you need a hand.'
  },
  {
    subject: 'SMS, logs, boosters and more in one place',
    body: 'A quick look at what sits behind your MJ Hub login.\n\nSMS OTP and rental numbers across many countries.\nReviewed logs for Facebook, Instagram, X, Gmail and more.\nBoosters for Instagram, TikTok and other platforms.\neSIM plans when you need data.\nTelegram Stars and blue tick verification help.\n\nOne wallet covers all of it.'
  },
  {
    subject: 'Stuck on funding or what to order?',
    body: 'If funding or choosing a product slowed you down, that is normal.\n\nWhatsApp and Telegram support are there for that. Reply to this mail or open support in the app and we will help you through the first order.'
  },
  {
    subject: 'A short note from the team',
    body: 'No pressure to buy. Just checking in so you know the account is still yours.\n\nWhen you need SMS, logs, boosters, eSIM or Telegram help, we will be right here.'
  },
  {
    subject: 'We will keep your account open',
    body: 'This is a quiet note from us.\n\nYour MJ Hub account stays active. Come back anytime you need numbers, logs, growth tools, an eSIM, or Telegram Stars and blue tick help.\n\nThank you for signing up.'
  },
  {
    subject: 'Country numbers are live on MJ Hub',
    body: 'Looking for reliable numbers for online verification? We have SMS OTP and rental numbers from many countries.\n\nPick a country, fund your wallet, and place the order from your dashboard.'
  },
  {
    subject: 'Fresh logs are on the catalog',
    body: 'New log listings go up regularly. Social accounts, email logs and more, with the details shown before you pay.\n\nBrowse the catalog, fund your wallet, and grab what you need.'
  },
  {
    subject: 'Need numbers for verification?',
    body: 'Get the number, receive the code in your dashboard, and move on with your signup.\n\nFund your wallet, pick your number, and you are set.'
  },
  {
    subject: 'While you rest, we keep the shop open',
    body: 'We stay on so your digital tools stay easy to reach.\n\nSMS numbers, logs, boosters, eSIM plans, Telegram Stars and blue tick help are all in one wallet when you need them.'
  },
  {
    subject: 'A fresh day on MJ Hub',
    body: 'Stock updates through the day. If you have been meaning to grab a log or an SMS number, this is a good time.\n\nFund your wallet, browse, and order from the dashboard.'
  },
  {
    subject: 'Your digital tools in one wallet',
    body: 'SMS, logs, boosters, eSIM and Telegram services sit in the same MJ Hub account.\n\nFund once, then order what you need without jumping between apps.'
  },
  {
    subject: 'It has been a little while',
    body: 'We noticed you have not ordered in a couple of weeks. Everything still works the same way.\n\nSMS, logs, boosters, eSIM and Telegram tools are in your dashboard whenever you need them.'
  },
  {
    subject: 'Need SMS or logs again?',
    body: 'If you are back to verifying apps or stocking accounts, the catalog is live and stock updates daily.\n\nSame wallet, same dashboard.'
  },
  {
    subject: 'We still have your back',
    body: 'Just a friendly check in. Your balance and order history are where you left them.\n\nWhenever you need us again, we are ready.'
  },
  {
    subject: 'Last note for now',
    body: 'We will pause the reminders here so your inbox stays calm.\n\nYour account stays open. Come back anytime for SMS, logs, boosters, eSIM or Telegram help.\n\nSee you when you need us.'
  },
  {
    subject: 'Telegram Stars and blue tick help',
    body: 'If you have been meaning to sort Telegram Stars or blue tick verification, that path is available inside MJ Hub.\n\nOpen the Telegram section on your dashboard when you are ready.'
  },
  {
    subject: 'Boosters when you need growth',
    body: 'Instagram, TikTok and other growth packages sit under MJ Boosters.\n\nFund your wallet, choose a package, and track the order until delivery completes.'
  },
  {
    subject: 'eSIM plans on MJHUB Wireless',
    body: 'Need data without swapping your physical SIM? MJHUB Wireless eSIM plans are available from your dashboard.\n\nFund your wallet and pick a plan that fits.'
  },
  {
    subject: 'Good morning from MJ Hub',
    body: 'A new day is a good time to clear a small digital task.\n\nWhether that is an SMS number, a log, a booster, an eSIM or Telegram help, your wallet and catalog are ready.'
  },
  {
    subject: 'Still online? We are too',
    body: 'If you are up late working or browsing, the shop is open.\n\nFund your wallet and order SMS, logs, boosters, eSIM or Telegram services when it suits you.'
  },
  {
    subject: 'One dashboard for the work you do',
    body: 'Numbers for verification, logs for accounts, boosters for reach, eSIM for data, Telegram Stars and blue tick help.\n\nAll of that lives under the same MJ Hub login.'
  },
  {
    subject: 'Stock moves every day',
    body: 'Logs and numbers refresh often. If something you needed was out last week, it may be back now.\n\nOpen the catalog and take a quick look.'
  },
  {
    subject: 'Fund once, order what you need',
    body: 'Add money to your Naira wallet, then spend across SMS, logs, boosters, eSIM and Telegram services without another payment dance each time.'
  },
  {
    subject: 'We built this for people who buy digital tools often',
    body: 'Agencies, resellers and everyday users run orders from the same dashboard.\n\nWhen you are ready, fund your wallet and place the next one.'
  },
  {
    subject: 'A quiet check in',
    body: 'No hard sell. Just a short note so you know MJ Hub is still here for SMS, logs, boosters, eSIM and Telegram help.\n\nYour account is open whenever you need it.'
  },
  {
    subject: 'WhatsApp and Telegram support are live',
    body: 'If something about funding or ordering is unclear, support is a message away.\n\nReply to this email or use in app support and we will help you through it.'
  },
  {
    subject: 'Your next order can be simple',
    body: 'Open the dashboard, pick SMS, logs, boosters, eSIM or Telegram help, pay from your wallet, and track delivery in the same place.\n\nThat is the whole flow.'
  }
];

function escapeNudge(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function pickCareMessage(userId, step) {
  const n = CARE_MESSAGES.length;
  let h = 0;
  const s = String(userId || '') + ':' + String(step || 0);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return CARE_MESSAGES[h % n];
}

function buildCareEmailHtml({ name, subject, body, appUrl }) {
  const safe = String(name || 'there').trim() || 'there';
  const base = String(appUrl || 'https://app.mjhub.store').replace(/\/$/, '');
  const unsub = base + '/dashboard.html?unsubscribe=1';
  const inner = escapeNudge(body)
    .split(/\n\n/)
    .map((p) => {
      const withBr = p.replace(/\n/g, '<br>');
      return (
        '<p class="text-body" style="margin:0 0 14px;font-size:16px;line-height:1.65;color:#1e293b;">' +
        withBr +
        '</p>'
      );
    })
    .join('');
  const year = new Date().getFullYear();
  const html =
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light dark">' +
    '<title>' +
    escapeNudge(subject) +
    '</title>' +
    '<style>:root{color-scheme:light dark}' +
    '@media (prefers-color-scheme:dark){.page{background-color:#0b1220!important}.card{background-color:#111827!important;border-color:#1e293b!important}' +
    '.text-body{color:#e2e8f0!important}.text-muted{color:#94a3b8!important}.rule{border-color:#1e293b!important}}</style></head>' +
    '<body class="page" style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="page" style="background:#f1f5f9;"><tr><td align="center" style="padding:24px 12px;">' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="card" style="max-width:560px;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;">' +
    '<tr><td align="center" style="padding:28px 24px 8px;">' +
    '<img src="https://atczodlljmlayvldxfmv.supabase.co/storage/v1/object/public/avatars/mjhub-mark-only.png" alt="MJ Hub" width="120" style="display:block;height:44px;width:auto;border:0;">' +
    '<div style="margin-top:6px;font-size:13px;font-weight:800;letter-spacing:0.14em;color:#0f172a;">MJ HUB</div></td></tr>' +
    '<tr><td style="padding:8px 32px 0;"><p class="text-body" style="margin:0 0 16px;font-size:18px;font-weight:700;color:#0f172a;">Hi ' +
    escapeNudge(safe) +
    ',</p></td></tr>' +
    '<tr><td style="padding:0 32px 8px;">' +
    inner +
    '</td></tr>' +
    '<tr><td align="center" style="padding:8px 32px 28px;">' +
    '<a href="' +
    base +
    '/dashboard.html" style="display:inline-block;background-color:#2563eb;color:#ffffff;font-weight:700;font-size:15px;text-decoration:none;padding:14px 28px;border-radius:12px;">Open MJ Hub</a>' +
    '</td></tr>' +
    '<tr><td style="padding:0 32px 28px;"><hr class="rule" style="border:none;border-top:1px solid #e2e8f0;margin:0 0 16px;">' +
    '<p class="text-muted" style="margin:0;font-size:12px;line-height:1.5;color:#64748b;text-align:center;">' +
    '<a href="' +
    unsub +
    '" style="color:#2563eb;text-decoration:none;">Unsubscribe</a><br>© ' +
    year +
    ' MJ Hub</p></td></tr></table></td></tr></table></body></html>';
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

async function userLastOrderAt(supabase, userId) {
  let latest = 0;
  const tables = ['orders', 'number_orders', 'booster_orders'];
  for (const table of tables) {
    try {
      const { data, error } = await supabase
        .from(table)
        .select('created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!error && data && data.created_at) {
        const t = new Date(data.created_at).getTime();
        if (t > latest) latest = t;
      }
    } catch (e) {
      /* ignore */
    }
  }
  return latest || null;
}

async function runInactiveNudges(supabase) {
  const hasResend = !!process.env.RESEND_API_KEY;
  const hasMailtrap = !!(process.env.MAILTRAP_API_TOKEN || process.env.MAILTRAP_API_KEY);
  if (!hasResend && !hasMailtrap) {
    return { sent: 0, skipped: true, reason: 'no RESEND_API_KEY or MAILTRAP_API_TOKEN' };
  }

  const appUrl = (process.env.APP_URL || process.env.SITE_URL || 'https://app.mjhub.store').replace(
    /\/$/,
    ''
  );

  let sent = 0;
  let examined = 0;
  const errors = [];
  const byTrack = { never_bought: 0, lapsed: 0 };

  // ---- Track A: never bought ----
  try {
    const { data: rows, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, nudge_week, last_nudge_at, email_unsubscribed')
      .or('email_unsubscribed.is.null,email_unsubscribed.eq.false')
      .lt('nudge_week', NUDGE_MAX_WEEK)
      .order('last_nudge_at', { ascending: true, nullsFirst: true })
      .limit(200);

    if (error) {
      console.error('[nudge] profiles query', error.message);
    } else {
      for (const row of rows || []) {
        if (sent >= NUDGE_BATCH) break;
        const email = String(row.email || '').trim();
        if (!email || !email.includes('@')) continue;

        const week = Number(row.nudge_week) || 0;
        const last = row.last_nudge_at ? new Date(row.last_nudge_at).getTime() : 0;

        if (week === 0) {
          let signupCreatedAt = null;
          try {
            const authLookup = await supabase.auth.admin.getUserById(row.id);
            signupCreatedAt = authLookup.data?.user?.created_at || null;
          } catch (lookupError) {
            console.warn('[nudge] signup lookup', lookupError?.message || lookupError);
          }
          const created = signupCreatedAt ? new Date(signupCreatedAt).getTime() : 0;
          if (!created || Number.isNaN(created) || created > Date.now() - NUDGE_INTERVAL_MS) continue;
        } else if (last && Date.now() - last < NUDGE_INTERVAL_MS) {
          continue;
        }

        examined++;
        if (await userHasPurchased(supabase, row.id)) {
          await supabase
            .from('profiles')
            .update({ nudge_week: NUDGE_MAX_WEEK, last_nudge_at: new Date().toISOString() })
            .eq('id', row.id);
          continue;
        }

        const nextWeek = week + 1;
        const msg = pickCareMessage(row.id, nextWeek);
        const { subject, html } = buildCareEmailHtml({
          name: row.full_name,
          subject: msg.subject,
          body: msg.body,
          appUrl
        });
        const result = await sendCareEmail({ to: email, subject, html });
        if (!result.ok) {
          errors.push({ email, track: 'never_bought', error: result.error || result });
          continue;
        }
        const { error: upErr } = await supabase
          .from('profiles')
          .update({ nudge_week: nextWeek, last_nudge_at: new Date().toISOString() })
          .eq('id', row.id);
        if (upErr) console.error('[nudge] update', upErr.message);
        sent++;
        byTrack.never_bought++;
      }
    }
  } catch (e) {
    console.error('[nudge] track A', e.message);
  }

  // ---- Track B: bought before, idle 14+ days ----
  if (sent < NUDGE_BATCH) {
    try {
      const { data: rows, error } = await supabase
        .from('profiles')
        .select('id, email, full_name, lapse_week, last_lapse_at, email_unsubscribed, nudge_week')
        .or('email_unsubscribed.is.null,email_unsubscribed.eq.false')
        .or('lapse_week.is.null,lapse_week.lt.' + LAPSE_MAX_WEEK)
        .order('last_lapse_at', { ascending: true, nullsFirst: true })
        .limit(150);

      if (error) {
        // Column may not exist yet
        if (/lapse_week|last_lapse_at|column/i.test(error.message || '')) {
          console.warn(
            '[nudge] Track B skipped: add columns lapse_week int default 0, last_lapse_at timestamptz on profiles'
          );
        } else {
          console.error('[nudge] lapse query', error.message);
        }
      } else {
        for (const row of rows || []) {
          if (sent >= NUDGE_BATCH) break;
          const email = String(row.email || '').trim();
          if (!email || !email.includes('@')) continue;

          const lapseWeek = Number(row.lapse_week) || 0;
          if (lapseWeek >= LAPSE_MAX_WEEK) continue;
          const lastLapse = row.last_lapse_at ? new Date(row.last_lapse_at).getTime() : 0;
          if (lastLapse && Date.now() - lastLapse < NUDGE_INTERVAL_MS) continue;

          examined++;
          const lastOrderAt = await userLastOrderAt(supabase, row.id);
          if (!lastOrderAt) continue; // never bought → Track A only
          if (Date.now() - lastOrderAt < LAPSE_IDLE_MS) {
            // recently active buyer: reset lapse counter
            if (lapseWeek > 0) {
              await supabase
                .from('profiles')
                .update({ lapse_week: 0, last_lapse_at: null })
                .eq('id', row.id);
            }
            continue;
          }

          const nextWeek = lapseWeek + 1;
          const msg = pickCareMessage(row.id, 'L' + nextWeek);
          const { subject, html } = buildCareEmailHtml({
            name: row.full_name,
            subject: msg.subject,
            body: msg.body,
            appUrl
          });
          const result = await sendCareEmail({ to: email, subject, html });
          if (!result.ok) {
            errors.push({ email, track: 'lapsed', error: result.error || result });
            continue;
          }
          const { error: upErr } = await supabase
            .from('profiles')
            .update({ lapse_week: nextWeek, last_lapse_at: new Date().toISOString() })
            .eq('id', row.id);
          if (upErr) {
            console.error('[nudge] lapse update', upErr.message);
            // still count send; progress may not persist without columns
          }
          sent++;
          byTrack.lapsed++;
        }
      }
    } catch (e) {
      console.error('[nudge] track B', e.message);
    }
  }

  return { sent, examined, byTrack, errors: errors.slice(0, 8) };
}


async function handleFaddedSync(req, res) {
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

    const products = [];
    let lastSupplierData = null;
    for (let page = 1; page <= 1; page++) {
      const apiRes = await fetch(`https://fadded.net/api/v1/reseller/products?page=${page}&per_page=100`, {
        method: 'GET',
        headers: {
          'X-Api-Key': process.env.FADDED_API_KEY,
          'Accept': 'application/json'
        }
      });

      if (!apiRes.ok) {
        const errorText = await apiRes.text();
        if (page === 1) {
          return res.status(apiRes.status).json({
            success: false,
            message: `Supplier API error: ${apiRes.status}`,
            details: errorText
          });
        }
        break;
      }

      const supplierData = await apiRes.json();
      lastSupplierData = supplierData;
      if (supplierData && supplierData.success === false && page === 1) {
        return res.status(400).json({
          success: false,
          message: 'Supplier reported failure',
          error: supplierData
        });
      }
      const batch = Array.isArray(supplierData.data)
        ? supplierData.data
        : (supplierData.data?.data || supplierData.products || []);
      if (!Array.isArray(batch) || !batch.length) break;
      products.push(...batch);
      if (batch.length < 100) break;
    }
    let newCount = 0;
    let updatedCount = 0;

    // One batched query for every product_key in this sync, instead of a
    // separate select('*') per item (was N+1 — one full-row round trip per
    // product just to check truthiness, times however many products Fadded
    // returns, plus a second round trip each for the actual insert/update).
    // Only the column actually needed for the existence check is selected.
    const allKeys = products.map((item) => item.product_key).filter(Boolean);
    const existingKeySet = new Set();
    const adminHiddenSet = new Set();
    const EXISTS_CHECK_BATCH = 500;
    for (let i = 0; i < allKeys.length; i += EXISTS_CHECK_BATCH) {
      const keyBatch = allKeys.slice(i, i + EXISTS_CHECK_BATCH);
      const { data: existingRows, error: existErr } = await supabase
        .from('products')
        .select('product_key, admin_hidden')
        .in('product_key', keyBatch);
      if (existErr) {
        console.error('Error checking existing product_keys:', existErr.message);
        continue;
      }
      (existingRows || []).forEach((r) => { if (r.product_key) existingKeySet.add(String(r.product_key)); if (r.admin_hidden) adminHiddenSet.add(String(r.product_key)); });
    }

    const toInsert = [];
    const toUpdate = []; // { product_key, patch }

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

      const stock = readSupplierStock(item);
      const now = new Date().toISOString();
      const key = String(item.product_key);

      if (existingKeySet.has(key) || existingKeySet.has(item.product_key)) {
        // EXISTING: NEVER touch admin customer-facing fields:
        // price, category, name, description, display_description, is_available (except force off if stock 0).
        // Only refresh supplier cost + stock so ordering still works.
        updatedCount++;
        const patch = {
          supplier_price: supplierPrice,
          stock_quantity: stock,
          source: 'fadded',
          updated_at: now
        };
        // 0 stock stays hidden. Stock back in → show again (this was leaving leftovers hidden).
        if (stock <= 0) patch.is_available = false; else if (!adminHiddenSet.has(key)) patch.is_available = true;
        toUpdate.push({ product_key: item.product_key, patch });
      } else {
        // NEW product only: full row + auto markup.
        // Always OTHER so admin can sort; existing products keep their category.
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
          category: 'OTHER',
          source: 'fadded',
          updated_at: now
        });
      }
    }

    // Per-row UPDATE (not upsert) so omitted columns can never be nulled.
    for (const row of toUpdate) {
      const { error } = await supabase
        .from('products')
        .update(row.patch)
        .eq('product_key', row.product_key);
      if (error) console.error('Error updating product', row.product_key, error.message);
    }
    const WRITE_BATCH = 200;
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
      in_stock_from_api: products.filter((p) => readSupplierStock(p) > 0).length,
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

/** Idempotency: same external_order_id for same user → return existing order, no second charge/delivery */
async function findExistingLogOrder(userId, orderRef) {
  if (!orderRef || !userId) return null;
  try {
    const { data } = await supabase
      .from('orders')
      .select('order_id, product_name, quantity, amount, status, login_credentials, supplier_ref, created_at')
      .eq('order_id', String(orderRef))
      .eq('user_id', userId)
      .maybeSingle();
    if (data && String(data.status || '').toLowerCase() !== 'failed') return data;
  } catch (_) {}
  return null;
}

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
    const syncAuth = await requireAdminOrCron(req);
    if (syncAuth.error) {
      return res.status(syncAuth.error.status).json({ success: false, message: syncAuth.error.message });
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

  if (action === 'support_ticket') {
    return handleSupportTicket(req, res, auth.user);
  }
  if (action === 'support_upload') {
    return handleSupportUpload(req, res, auth.user);
  }
  if (action === 'update_profile') {
    return handleUpdateProfile(req, res, auth.user);
  }

  // GET /api/order?action=my_orders  — list this user's logs + SMS (no new serverless function)
  // `action` already parsed above from query/body
  if (req.method === 'GET' || action === 'my_orders') {
    return handleMyOrders(req, res, user_id);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

  // POST { action: 'my_orders' } also supported
  if (body.action === 'my_orders') {
    return handleMyOrders(req, res, user_id);
  }

  if (body.action === 'validate_coupon') {
    const sub = Number(body.subtotal || body.total || 0);
    const q = await quoteCoupon(supabase, {
      code: body.coupon_code || body.code,
      userId: user_id,
      subtotal: sub,
      appliesTo: body.applies_to || 'logs'
    });
    if (!q.ok) return res.status(400).json({ success: false, message: q.message });
    return res.status(200).json({
      success: true,
      code: q.code,
      discount: q.discount,
      final_total: q.finalTotal,
      subtotal: q.subtotal,
      percent_off: q.percent_off,
      amount_off_ngn: q.amount_off_ngn
    });
  }

  const {
    product_key,
    quantity = 1,
    external_order_id,
    customer_info,
    coupon_code,
    user_id: bodyUserId
  } = body;

  const same = assertSameUser(user_id, bodyUserId);
  if (!same.ok) return res.status(same.status).json({ success: false, message: same.message });

  if (!product_key || typeof product_key !== 'string' || product_key.length > 120) {
    return res.status(400).json({ success: false, message: 'product_key is required' });
  }

  const qtyCheck = parsePositiveInt(quantity, { min: 1, max: 10 });
  if (!qtyCheck.ok) {
    return res.status(400).json({ success: false, message: 'Invalid quantity (1–10)' });
  }
  const safeQty = qtyCheck.value;

  let originalBalance = 0;
  let originalBalanceUsd = 0;
  let total = 0;
  let productName = '';
  let customerId = null;
  let deducted = false;
  let walletDebitId = null;
  let newBalance = 0;
  let newBalanceUsd = 0;
    // Idempotency: duplicate click with same external_order_id
    if (external_order_id) {
      const existing = await findExistingLogOrder(user_id, external_order_id);
      if (existing) {
        const { data: balRow } = await supabase.from('profiles').select('balance, balance_usd').eq('id', user_id).maybeSingle();
        return res.status(200).json({
          success: true,
          replayed: true,
          message: 'Order already completed',
          data: {
            order_id: existing.order_id,
            login_credentials: existing.login_credentials,
            items: existing.login_credentials ? [{ details: existing.login_credentials }] : [],
            quantity: existing.quantity,
            new_balance: Number(balRow?.balance || 0)
          }
        });
      }
    }


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

    // Coupon (any active admin code; server re-validates)
    let couponQuote = null;
    let couponDiscount = 0;
    if (coupon_code) {
      couponQuote = await quoteCoupon(supabase, {
        code: coupon_code,
        userId: user_id,
        subtotal: total,
        appliesTo: 'logs'
      });
      if (!couponQuote.ok) {
        return res.status(400).json({ success: false, message: couponQuote.message || 'Invalid coupon code' });
      }
      couponDiscount = Number(couponQuote.discount || 0);
      total = Number(couponQuote.finalTotal);
    }

    // -------------------------------------------------
    // 2. Get user profile + balance
    // -------------------------------------------------
    let { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('balance, balance_usd, customer_id')
      .eq('id', user_id)
      .maybeSingle();

    if (profileErr || !profile) {
      const email = auth.user.email || null;
      const name =
        auth.user.user_metadata?.full_name ||
        auth.user.user_metadata?.name ||
        (email ? String(email).split('@')[0] : 'User');
      const customer_id = 'MJ' + String(Date.now()).slice(-8) + Math.random().toString(36).slice(2, 5).toUpperCase();
      const { error: upErr } = await supabase.from('profiles').upsert({
        id: user_id,
        email,
        full_name: name,
        customer_id,
        balance: 0,
        balance_usd: 0,
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' });
      if (upErr) {
        console.error('[order] profile upsert', upErr.message || profileErr?.message);
        return res.status(400).json({ success: false, message: 'User profile not found' });
      }
      const again = await supabase
        .from('profiles')
        .select('balance, balance_usd, customer_id')
        .eq('id', user_id)
        .maybeSingle();
      profile = again.data;
      if (!profile) {
        return res.status(400).json({ success: false, message: 'User profile not found' });
      }
    }

    originalBalance = Number(profile.balance || 0);
    originalBalanceUsd = Number(profile.balance_usd || 0);
    customerId = profile.customer_id;

    // The database atomically allocates NGN first and USD for the remainder.
    const debit = await debitWallet(supabase, user_id, total);
    if (!debit.ok) {
      return res.status(402).json({
        success: false,
        message: debit.message || 'Insufficient combined wallet balance',
        required_ngn: total,
        balance_ngn: debit.balance_ngn,
        balance_usd: debit.balance_usd
      });
    }
    walletDebitId = debit.wallet_debit_id;
    newBalance = debit.balance_ngn;
    newBalanceUsd = debit.balance_usd;
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
      // Refund the exact debit split, never restore a stale profile snapshot.
      const refund = await refundWalletDebit(supabase, user_id, walletDebitId);
      if (!refund.ok) {
        return res.status(500).json({ success: false, message: 'Order failed and wallet refund needs support review.' });
      }
      deducted = false;

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
      wallet_debit_id: walletDebitId,
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
    
    if (typeof couponQuote !== 'undefined' && couponQuote && couponQuote.ok && couponQuote.coupon) {
      try {
        await redeemCoupon(supabase, {
          couponId: couponQuote.coupon.id,
          userId: user_id,
          orderRef: (typeof orderRef !== 'undefined' ? orderRef : null) || (typeof supplierOrderId !== 'undefined' ? supplierOrderId : null),
          amountSaved: couponDiscount || 0
        });
      } catch (_) {}
    }

    await sendPushToUser(supabase, user_id, {
      title: 'Order completed',
      body: 'Your ' + productName + ' order has been fulfilled successfully.',
      url: '/dashboard.html',
      type: 'purchase'
    });
    try {
      const cust = (typeof customerId !== 'undefined' && customerId) ? String(customerId) : 'Customer';
      const qtyLabel = (typeof safeQty !== 'undefined' && safeQty) ? (' ×' + safeQty) : ((typeof qty !== 'undefined' && qty) ? (' ×' + qty) : '');
      await sendPushToAdmins(supabase, {
        title: 'New log order',
        body: cust + ' bought ' + productName + qtyLabel + ' · ₦' + Number(total || 0).toLocaleString(),
        url: '/admin.html',
        type: 'admin_sale'
      });
    } catch (_) {}
    return res.status(200).json({
      success: true,
      message: 'Order fulfilled successfully',
      data: {
        items: formattedItems.length ? formattedItems : (orderData.data?.items || []),
        login_credentials: combinedCreds || null,
        total_amount: total,
        new_balance: newBalance,
        new_balance_usd: newBalanceUsd,
        amount_ngn: total,
        order_id: orderRef,
        source: 'fadded'
      }
    });

  } catch (err) {
    console.error('Order handler error:', err);

    // Safety net: refund if we already debited
    if (deducted) {
      try {
        const refund = await refundWalletDebit(supabase, user_id, walletDebitId);
        if (!refund.ok) throw new Error(refund.error || refund.message || 'Exact wallet refund failed');
        deducted = false;

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
