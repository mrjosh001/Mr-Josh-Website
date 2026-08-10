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
  // Time-boxed, resumable sync — Owlet catalogs are large enough that a
  // single Vercel invocation (even at 300s) can time out if we upsert
  // everything in one go. Cursor is stored in sync_jobs (source=owlet).
  const SYNC_SOURCE = 'owlet';
  const TIME_BUDGET_MS = 250000; // leave headroom under 300s maxDuration
  const BATCH = 80;
  const startedAt = Date.now();

  const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })() : (req.body || {});
  const forceRestart = !!(body.restart || req.query?.restart === '1');

  let job = null;
  {
    const { data, error } = await supabase.from('sync_jobs').select('*').eq('source', SYNC_SOURCE).maybeSingle();
    if (error && !/does not exist|relation/i.test(error.message || '')) {
      console.warn('[owlet sync] sync_jobs read:', error.message);
    }
    job = data;
  }

  if (forceRestart || !job || job.status === 'completed') {
    job = {
      source: SYNC_SOURCE,
      status: 'running',
      cursor_index: 0,
      items_seen: 0,
      new_count: 0,
      updated_count: 0,
      errors: [],
      updated_at: new Date().toISOString()
    };
  }

  // Fetch full service list from Owlet (one API call — the bottleneck is DB writes)
  const { ok, status, json } = await owletCall({ action: 'services' });
  if (!ok || json?.error || !Array.isArray(json)) {
    return res.status(status || 502).json({
      success: false,
      message: json?.error || json?.message || 'Could not fetch Owlet services for sync'
    });
  }

  const services = json;
  let cursor = Number(job.cursor_index) || 0;
  if (cursor >= services.length) cursor = 0;

  // Existing rows for manual-price preservation (one query)
  const { data: existing, error: exErr } = await supabase
    .from('booster_services')
    .select('service_id, price_ngn, price_source')
    .eq('source', 'owlet');

  if (exErr) {
    return res.status(500).json({
      success: false,
      message: 'booster_services table error: ' + exErr.message + ' — run booster_services.sql in Supabase first'
    });
  }
  const map = new Map((existing || []).map(r => [String(r.service_id), r]));

  let upserted = 0;
  let errors = Array.isArray(job.errors) ? job.errors.slice(0, 20) : [];
  let ranOutOfTime = false;

  while (cursor < services.length) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      ranOutOfTime = true;
      break;
    }

    const slice = services.slice(cursor, cursor + BATCH);
    const now = new Date().toISOString();
    const rows = slice.map(s => {
      const serviceId = String(s.service);
      const supplierUsd = Number(s.rate) || 0;
      const defaultNgn = sellPriceNgn(supplierUsd);
      const prev = map.get(serviceId);
      const manual = prev && prev.price_source === 'manual';
      return {
        source: 'owlet',
        service_id: serviceId,
        name: s.name || serviceId,
        category: s.category || 'Other',
        service_type: s.type || 'Default',
        supplier_rate_usd: supplierUsd,
        price_ngn: manual ? Number(prev.price_ngn) : defaultNgn,
        price_source: manual ? 'manual' : 'system',
        min_quantity: Number(s.min) || 0,
        max_quantity: Number(s.max) || 0,
        refill: !!s.refill,
        cancel: !!s.cancel,
        is_available: true,
        updated_at: now
      };
    });

    let { error } = await supabase
      .from('booster_services')
      .upsert(rows, { onConflict: 'source,service_id' });

    if (error && /price_source/i.test(error.message || '')) {
      const slim = rows.map(({ price_source, ...rest }) => rest);
      ({ error } = await supabase.from('booster_services').upsert(slim, { onConflict: 'source,service_id' }));
    }

    if (error) {
      errors.push(`batch@${cursor}: ${error.message}`);
      // skip this batch rather than abort entire job
    } else {
      upserted += rows.length;
    }

    cursor += slice.length;
  }

  const done = cursor >= services.length && !ranOutOfTime;
  const jobFields = {
    source: SYNC_SOURCE,
    status: done ? 'completed' : 'running',
    cursor_index: done ? 0 : cursor,
    items_seen: services.length,
    new_count: (Number(job.new_count) || 0) + upserted,
    updated_count: upserted,
    errors: errors.slice(0, 20),
    updated_at: new Date().toISOString()
  };

  // Best-effort job persist (table may not exist yet — sync still works)
  try {
    await supabase.from('sync_jobs').upsert(jobFields, { onConflict: 'source' });
  } catch (e) {
    console.warn('[owlet sync] sync_jobs write failed', e?.message || e);
  }

  return res.status(200).json({
    success: true,
    done,
    message: done
      ? `Owlet sync complete — ${services.length} services`
      : `Owlet sync progress ${cursor}/${services.length} — run Sync again to continue`,
    total: services.length,
    cursor,
    upserted_this_run: upserted,
    errors: errors.slice(0, 5)
  });
}


async function handleList(req, res) {
  const q = (req.query?.q || '').toString().trim().toLowerCase();
  const category = (req.query?.category || '').toString().trim();
  const hideUnavailable = String(req.query?.hide_unavailable || '1') !== '0';
  const page = Math.max(1, parseInt(req.query?.page || '1', 10) || 1);
  const pageSize = Math.min(200, Math.max(20, parseInt(req.query?.page_size || '100', 10) || 100));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabase
    .from('booster_services')
    .select(
      'id,source,service_id,name,category,service_type,supplier_rate_usd,price_ngn,price_source,min_quantity,max_quantity,refill,cancel,is_available,updated_at',
      { count: 'exact' }
    )
    .eq('source', 'owlet')
    .order('category', { ascending: true })
    .order('name', { ascending: true })
    .range(from, to);

  if (hideUnavailable) query = query.neq('is_available', false);
  if (category) query = query.eq('category', category);

  const { data, error, count } = await query;
  if (error) {
    return res.status(500).json({
      success: false,
      message: error.message + ( /permission|rls|policy/i.test(error.message)
        ? ' — run the RLS SQL for booster_services'
        : '')
    });
  }

  let rows = data || [];
  if (q) {
    rows = rows.filter(s =>
      (s.name || '').toLowerCase().includes(q) ||
      (s.category || '').toLowerCase().includes(q) ||
      String(s.service_id).includes(q)
    );
  }

  // Categories for filter dropdown (light query)
  const { data: catRows } = await supabase
    .from('booster_services')
    .select('category')
    .eq('source', 'owlet')
    .limit(5000);
  const categories = [...new Set((catRows || []).map(r => r.category).filter(Boolean))].sort();

  return res.status(200).json({
    success: true,
    data: rows,
    page,
    page_size: pageSize,
    total: count ?? rows.length,
    categories
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
  if (action === 'list') return handleList(req, res);
  if (action === 'status') return handleStatus(req, res);

  return res.status(400).json({
    success: false,
    message: 'action required: balance | services | sync | list | status'
  });
}
