import { createClient } from '@supabase/supabase-js';

/**
 * /api/owlet — MJ Boosters supplier (The Owlet SMM panel v2 API)
 * Docs: https://theowlet.com/api
 * Base: POST https://theowlet.com/api/v2
 *
 * Admin-only for interactive use. Cron may call ?action=sync with CRON_SECRET.
 * Not wired to the user dashboard yet.
 *
 * Actions:
 *   balance  — Owlet wallet USD balance
 *   services — live service list from Owlet
 *   sync     — pull services into booster_services (Supabase)
 *   status   — order status { order }
 *
 * Env: OWLET_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional: OWLET_MARKUP_PERCENT (default 50 → sell at 1.5× rate)
 * Optional: USD_TO_NGN_RATE (default 1500) for display prices in NGN
 */

const OWLET_URL = 'https://theowlet.com/api/v2';
const OWLET_KEY = process.env.OWLET_API_KEY;
const MARKUP = Number(process.env.OWLET_MARKUP_PERCENT ?? 50); // 50% → 1.5×
const USD_TO_NGN = Number(process.env.USD_TO_NGN_RATE) || 1500;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function requireAdmin(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, message: 'Missing admin session' };

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return { ok: false, status: 401, message: 'Invalid session' };

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', user.id)
    .maybeSingle();

  const isAdmin = profile && (profile.is_admin === true || profile.is_admin === 'true' || profile.is_admin === 1);
  if (!isAdmin) return { ok: false, status: 403, message: 'Admin privileges required' };
  return { ok: true, adminId: user.id };
}

async function owletCall(params) {
  if (!OWLET_KEY) {
    return { ok: false, status: 500, json: { error: 'OWLET_API_KEY not configured' } };
  }
  const body = new URLSearchParams({ key: OWLET_KEY, ...params });
  const res = await fetch(OWLET_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: body.toString()
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, status: res.status || 502, json: { error: 'Invalid JSON from Owlet', raw: text.slice(0, 300) } };
  }
  return { ok: res.ok, status: res.status, json };
}

function sellPriceUsd(rateUsd) {
  const r = Number(rateUsd) || 0;
  return Math.round(r * (1 + MARKUP / 100) * 10000) / 10000;
}

function sellPriceNgn(rateUsd) {
  return Math.ceil(sellPriceUsd(rateUsd) * USD_TO_NGN);
}

async function handleBalance(req, res) {
  const { ok, status, json } = await owletCall({ action: 'balance' });
  if (!ok || json?.error) {
    return res.status(status || 502).json({
      success: false,
      message: json?.error || json?.message || 'Could not fetch Owlet balance'
    });
  }
  return res.status(200).json({
    success: true,
    balance: json.balance,
    currency: json.currency || 'USD',
    raw: json
  });
}

async function handleServices(req, res) {
  const { ok, status, json } = await owletCall({ action: 'services' });
  if (!ok || json?.error || !Array.isArray(json)) {
    return res.status(status || 502).json({
      success: false,
      message: json?.error || json?.message || 'Could not fetch Owlet services',
      raw: json
    });
  }
  const data = json.map(s => ({
    service_id: String(s.service),
    name: s.name,
    type: s.type,
    category: s.category,
    supplier_rate_usd: Number(s.rate) || 0,
    rate_usd: sellPriceUsd(s.rate),
    rate_ngn: sellPriceNgn(s.rate),
    min: Number(s.min) || 0,
    max: Number(s.max) || 0,
    refill: !!s.refill,
    cancel: !!s.cancel
  }));
  return res.status(200).json({ success: true, count: data.length, data });
}

async function handleSync(req, res) {
  const { ok, status, json } = await owletCall({ action: 'services' });
  if (!ok || json?.error || !Array.isArray(json)) {
    return res.status(status || 502).json({
      success: false,
      message: json?.error || json?.message || 'Could not fetch Owlet services for sync'
    });
  }

  let inserted = 0;
  let updated = 0;
  let errors = [];

  // Load existing by service_id
  const { data: existing, error: exErr } = await supabase
    .from('booster_services')
    .select('id, service_id, price_ngn, price_source')
    .eq('source', 'owlet');

  if (exErr) {
    return res.status(500).json({
      success: false,
      message: 'booster_services table error: ' + exErr.message + ' — run the SQL setup first'
    });
  }

  const map = new Map((existing || []).map(r => [String(r.service_id), r]));

  for (const s of json) {
    const serviceId = String(s.service);
    const supplierUsd = Number(s.rate) || 0;
    const defaultNgn = sellPriceNgn(supplierUsd);
    const row = map.get(serviceId);

    const shared = {
      source: 'owlet',
      service_id: serviceId,
      name: s.name || serviceId,
      category: s.category || 'Other',
      service_type: s.type || 'Default',
      supplier_rate_usd: supplierUsd,
      min_quantity: Number(s.min) || 0,
      max_quantity: Number(s.max) || 0,
      refill: !!s.refill,
      cancel: !!s.cancel,
      is_available: true,
      updated_at: new Date().toISOString()
    };

    try {
      if (row) {
        // Never overwrite manual selling price
        const patch = { ...shared };
        if (row.price_source !== 'manual') {
          patch.price_ngn = defaultNgn;
          patch.price_source = 'system';
        }
        const { error } = await supabase.from('booster_services').update(patch).eq('id', row.id);
        if (error) errors.push(`${serviceId}: ${error.message}`);
        else updated += 1;
      } else {
        const { error } = await supabase.from('booster_services').insert({
          ...shared,
          price_ngn: defaultNgn,
          price_source: 'system'
        });
        if (error) errors.push(`${serviceId}: ${error.message}`);
        else inserted += 1;
      }
    } catch (e) {
      errors.push(`${serviceId}: ${e.message || e}`);
    }
  }

  return res.status(200).json({
    success: true,
    message: `Synced ${json.length} Owlet services (${inserted} new, ${updated} updated)`,
    total: json.length,
    inserted,
    updated,
    errors: errors.slice(0, 10)
  });
}

async function handleStatus(req, res) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const order = body.order || req.query?.order;
  if (!order) return res.status(400).json({ success: false, message: 'order is required' });

  const { ok, status, json } = await owletCall({ action: 'status', order: String(order) });
  if (!ok || json?.error) {
    return res.status(status || 502).json({
      success: false,
      message: json?.error || json?.message || 'Could not fetch order status'
    });
  }
  return res.status(200).json({ success: true, data: json });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, message: 'Missing Supabase env' });
  }

  let action = req.query?.action;
  if (!action && req.url) {
    try {
      action = new URL(req.url, 'http://localhost').searchParams.get('action');
    } catch { /* ignore */ }
  }
  if (!action && req.body) {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
      action = body?.action;
    } catch { /* ignore */ }
  }

  // Vercel Cron can hit sync without an admin session (same pattern as Grizzly / LogsDomain).
  const authHeader = req.headers.authorization || '';
  const isCron =
    !!process.env.CRON_SECRET &&
    authHeader === `Bearer ${process.env.CRON_SECRET}`;

  if (action === 'sync' && isCron) {
    return handleSync(req, res);
  }

  const admin = await requireAdmin(req);
  if (!admin.ok) return res.status(admin.status).json({ success: false, message: admin.message });

  if (action === 'balance') return handleBalance(req, res);
  if (action === 'services') return handleServices(req, res);
  if (action === 'sync') return handleSync(req, res);
  if (action === 'status') return handleStatus(req, res);

  return res.status(400).json({
    success: false,
    message: 'action required: balance | services | sync | status'
  });
}
