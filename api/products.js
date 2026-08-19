import { createClient } from '@supabase/supabase-js';

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


export default async function handler(req, res) {
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

    for (const item of products) {
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

      const { data: existing } = await supabase
        .from('products')
        .select('*')
        .eq('product_key', item.product_key)
        .maybeSingle();

      if (existing) {
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
        const { error } = await supabase
          .from('products')
          .update({
            name: item.name,
            description: cleanDescription,
            display_description: displayDescription,
            supplier_price: supplierPrice,
            stock_quantity: stock,
            is_available: stock > 0,
            source: 'fadded',
            updated_at: new Date().toISOString()
          })
          .eq('product_key', item.product_key);

        if (error) {
          console.error(`Error updating ${item.product_key}:`, error.message);
        }
      } else {
        // NEW product: set full row including auto markup + category
        newCount++;
        const { error } = await supabase
          .from('products')
          .insert({
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
            updated_at: new Date().toISOString()
          });

        if (error) {
          console.error(`Error inserting ${item.product_key}:`, error.message);
        }
      }
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
