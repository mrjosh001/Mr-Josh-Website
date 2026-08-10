import { createClient } from '@supabase/supabase-js';

/**
 * /api/owlet — MJ Boosters (The Owlet SMM panel v2)
 * Docs: https://theowlet.com/api
 * POST https://theowlet.com/api/v2
 *
 * Rate from API is USD. Sell NGN = rate_usd * USD_TO_NGN * (1 + markup%).
 * Env: OWLET_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional: USD_TO_NGN_RATE (default 1450), OWLET_MARKUP_PERCENT (default 35), CRON_SECRET
 */

const OWLET_URL = 'https://theowlet.com/api/v2';
const OWLET_KEY = process.env.OWLET_API_KEY;
const USD_TO_NGN = Number(process.env.USD_TO_NGN_RATE) || 1450;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function getMarkupPercent() {
  const env = Number(process.env.OWLET_MARKUP_PERCENT);
  if (Number.isFinite(env) && env >= 0 && env <= 200) return env;
  return 35;
}

/** Owlet rate is USD per 1000 units → sell price in NGN with markup */
function sellPriceNgnFromUsd(rateUsd, markupPercent) {
  const usd = Number(rateUsd) || 0;
  const markup = markupPercent ?? getMarkupPercent();
  const costNgn = usd * USD_TO_NGN;
  return Math.ceil(costNgn * (1 + markup / 100));
}

function supplierUsdFromRate(rateUsd) {
  return Math.round((Number(rateUsd) || 0) * 10000) / 10000;
}

async function owletCall(params = {}) {
  if (!OWLET_KEY) {
    return { ok: false, status: 500, json: { error: 'OWLET_API_KEY not set on server' }, text: '' };
  }
  const body = new URLSearchParams();
  body.set('key', OWLET_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    body.set(k, String(v));
  }
  try {
    const res = await fetch(OWLET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: text || 'Invalid JSON from Owlet' };
    }
    const hasError = !!(json && typeof json === 'object' && !Array.isArray(json) && json.error);
    return { ok: res.ok && !hasError, status: res.status, json, text };
  } catch (e) {
    return { ok: false, status: 502, json: { error: e.message || 'Owlet network error' }, text: '' };
  }
}

async function requireUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, message: 'Sign in required' };
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return { ok: false, status: 401, message: 'Invalid session' };
  return { ok: true, user, token };
}

async function requireAdmin(req) {
  const u = await requireUser(req);
  if (!u.ok) return u;
  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', u.user.id)
    .maybeSingle();
  const isAdmin =
    profile &&
    (profile.is_admin === true || profile.is_admin === 'true' || profile.is_admin === 1);
  if (!isAdmin) return { ok: false, status: 403, message: 'Admin privileges required' };
  return { ok: true, user: u.user, token: u.token };
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
  const markup = getMarkupPercent();
  const data = json.map((s) => {
    const rateUsd = Number(s.rate) || 0;
    return {
      service_id: String(s.service),
      name: s.name,
      type: s.type,
      category: s.category,
      supplier_rate_usd: supplierUsdFromRate(rateUsd),
      rate_usd: Math.round(rateUsd * (1 + markup / 100) * 10000) / 10000,
      rate_ngn: sellPriceNgnFromUsd(rateUsd, markup),
      min: Number(s.min) || 0,
      max: Number(s.max) || 0,
      refill: !!s.refill,
      cancel: !!s.cancel
    };
  });
  return res.status(200).json({ success: true, count: data.length, data });
}

async function handleSync(req, res) {
  const SYNC_SOURCE = 'owlet';
  const TIME_BUDGET_MS = 250000;
  const BATCH = 80;
  const startedAt = Date.now();

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch {
    body = {};
  }
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

  const { ok, status, json } = await owletCall({ action: 'services' });
  if (!ok || json?.error || !Array.isArray(json)) {
    return res.status(status || 502).json({
      success: false,
      message: json?.error || json?.message || 'Could not fetch Owlet services for sync',
      raw: json
    });
  }

  const services = json;
  let cursor = Number(job.cursor_index) || 0;
  if (cursor >= services.length) cursor = 0;

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
  const map = new Map((existing || []).map((r) => [String(r.service_id), r]));

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
    const rows = slice.map((s) => {
      const serviceId = String(s.service);
      const rateUsd = Number(s.rate) || 0;
      const supplierUsdVal = supplierUsdFromRate(rateUsd);
      const defaultNgn = sellPriceNgnFromUsd(rateUsd);
      const prev = map.get(serviceId);
      const manual = prev && prev.price_source === 'manual';
      return {
        source: 'owlet',
        service_id: serviceId,
        name: s.name || serviceId,
        category: s.category || 'Other',
        service_type: s.type || 'Default',
        supplier_rate_usd: supplierUsdVal,
        price_ngn: manual ? Number(prev.price_ngn) : defaultNgn,
        price_source: manual ? 'manual' : 'system',
        min_quantity: Math.max(1, Number(s.min) || 1),
        max_quantity: Math.max(1, Number(s.max) || 1000000),
        refill: !!s.refill,
        cancel: !!s.cancel,
        is_available: true,
        updated_at: now
      };
    });

    let { error } = await supabase.from('booster_services').upsert(rows, { onConflict: 'source,service_id' });
    if (error && /price_source/i.test(error.message || '')) {
      const slim = rows.map(({ price_source, ...rest }) => rest);
      ({ error } = await supabase.from('booster_services').upsert(slim, { onConflict: 'source,service_id' }));
    }
    if (error) {
      errors.push(`batch@${cursor}: ${error.message}`);
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
    markup_percent: getMarkupPercent(),
    usd_to_ngn: USD_TO_NGN,
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
    return res.status(500).json({ success: false, message: error.message });
  }
  let rows = data || [];
  if (q) {
    rows = rows.filter(
      (r) =>
        String(r.name || '').toLowerCase().includes(q) ||
        String(r.category || '').toLowerCase().includes(q)
    );
  }
  return res.status(200).json({ success: true, data: rows, total: count || rows.length, page, page_size: pageSize });
}

async function handleStatus(req, res) {
  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch {
    body = {};
  }
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

async function handleCatalog(req, res) {
  const category = (req.query?.category || '').toString().trim();
  const q = (req.query?.q || '').toString().trim().toLowerCase();
  const page = Math.max(1, parseInt(req.query?.page || '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(12, parseInt(req.query?.page_size || '48', 10) || 48));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data: catRows, error: catErr } = await supabase
    .from('booster_services')
    .select('category')
    .eq('source', 'owlet')
    .eq('is_available', true)
    .limit(15000);

  if (catErr) {
    return res.status(500).json({ success: false, message: catErr.message });
  }

  const counts = {};
  for (const c of catRows || []) {
    const k = c.category || 'Other';
    counts[k] = (counts[k] || 0) + 1;
  }
  const cards = Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  if (!category && !q) {
    return res.status(200).json({
      success: true,
      mode: 'categories',
      categories: cards,
      total_services: (catRows || []).length
    });
  }

  let query = supabase
    .from('booster_services')
    .select(
      'id,service_id,name,category,service_type,supplier_rate_usd,price_ngn,min_quantity,max_quantity,refill,cancel,is_available',
      { count: 'exact' }
    )
    .eq('source', 'owlet')
    .eq('is_available', true)
    .order('price_ngn', { ascending: true })
    .range(from, to);

  if (category) query = query.eq('category', category);

  const { data, error, count } = await query;
  if (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
  let rows = data || [];
  if (q) {
    rows = rows.filter(
      (r) =>
        String(r.name || '').toLowerCase().includes(q) ||
        String(r.category || '').toLowerCase().includes(q)
    );
  }
  return res.status(200).json({
    success: true,
    mode: 'services',
    data: rows,
    total: count || rows.length,
    page,
    page_size: pageSize,
    categories: cards
  });
}

async function handleOrder(req, res) {
  const u = await requireUser(req);
  if (!u.ok) return res.status(u.status).json({ success: false, message: u.message });

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch {
    body = {};
  }
  const serviceId = String(body.service_id || body.service || '').trim();
  const link = String(body.link || '').trim();
  const quantity = parseInt(body.quantity, 10) || 0;
  if (!serviceId) return res.status(400).json({ success: false, message: 'service_id required' });
  if (!link) return res.status(400).json({ success: false, message: 'link required' });

  const { data: service, error: sErr } = await supabase
    .from('booster_services')
    .select('*')
    .eq('source', 'owlet')
    .eq('service_id', serviceId)
    .maybeSingle();

  if (sErr || !service) {
    return res.status(404).json({ success: false, message: 'Service not found' });
  }

  const supplierMin = Number(service.min_quantity) || 1;
  let maxQ = Number(service.max_quantity) || 1000000;
  if (maxQ < 1) maxQ = 1000000;
  let minQ = Math.max(500, supplierMin);
  if (minQ > maxQ) minQ = maxQ;
  if (quantity < minQ || quantity > maxQ) {
    return res.status(400).json({
      success: false,
      message: `Quantity must be between ${minQ.toLocaleString()} and ${maxQ.toLocaleString()}`
    });
  }

  const ratePer1k = Number(service.price_ngn) || 0;
  if (ratePer1k <= 0) {
    return res.status(400).json({ success: false, message: 'Service has invalid price' });
  }
  const totalNgn = Math.ceil((ratePer1k / 1000) * quantity);

  const { data: profile, error: pErr } = await supabase
    .from('profiles')
    .select('id, balance')
    .eq('id', u.user.id)
    .maybeSingle();

  if (pErr || !profile) {
    return res.status(400).json({ success: false, message: 'Profile not found' });
  }
  const bal = Number(profile.balance) || 0;
  if (bal < totalNgn) {
    return res.status(400).json({
      success: false,
      message: `Insufficient balance. Need ₦${totalNgn.toLocaleString()}, have ₦${bal.toLocaleString()}`
    });
  }

  const newBal = bal - totalNgn;
  const { error: debitErr } = await supabase
    .from('profiles')
    .update({ balance: newBal })
    .eq('id', u.user.id)
    .eq('balance', bal);

  if (debitErr) {
    return res.status(409).json({ success: false, message: 'Could not debit wallet — try again' });
  }

  const { ok, status, json } = await owletCall({
    action: 'add',
    service: serviceId,
    link,
    quantity
  });

  if (!ok || json?.error || !json?.order) {
    // refund
    await supabase.from('profiles').update({ balance: bal }).eq('id', u.user.id);
    return res.status(status || 502).json({
      success: false,
      message: json?.error || json?.message || 'Supplier rejected the order — balance refunded'
    });
  }

  const supplierOrderId = String(json.order);
  let history_saved = true;
  let history_error = null;
  try {
    const { error: insErr } = await supabase.from('booster_orders').insert({
      user_id: u.user.id,
      service_id: serviceId,
      service_name: service.name,
      category: service.category,
      link,
      quantity,
      price_ngn: totalNgn,
      rate_per_1k: ratePer1k,
      status: 'Pending',
      supplier_order_id: supplierOrderId,
      source: 'owlet'
    });
    if (insErr) {
      history_saved = false;
      history_error = insErr.message;
      console.error('[owlet order] history insert', insErr.message);
    }
  } catch (e) {
    history_saved = false;
    history_error = e.message;
  }

  try {
    await supabase.from('transactions').insert({
      user_id: u.user.id,
      type: 'debit',
      amount: totalNgn,
      description: `MJ Boosters: ${service.name} × ${quantity}`,
      category: 'mj_boosters',
      meta: { supplier_order_id: supplierOrderId, service_id: serviceId }
    });
  } catch (e) {
    console.warn('[owlet order] tx log', e?.message || e);
  }

  return res.status(200).json({
    success: true,
    order_id: supplierOrderId,
    charge_ngn: totalNgn,
    new_balance: newBal,
    history_saved,
    history_error,
    message: history_saved ? 'Order placed' : 'Order placed but history save failed'
  });
}

async function handleMyOrders(req, res) {
  const u = await requireUser(req);
  if (!u.ok) return res.status(u.status).json({ success: false, message: u.message });

  const page = Math.max(1, parseInt(req.query?.page || '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(10, parseInt(req.query?.page_size || '50', 10) || 50));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabase
    .from('booster_orders')
    .select('*', { count: 'exact' })
    .eq('user_id', u.user.id)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) {
    return res.status(500).json({
      success: false,
      message: error.message + ( /booster_orders/i.test(error.message) ? ' — create booster_orders table' : '')
    });
  }

  const rows = data || [];
  // Refresh status from Owlet for pending rows (best-effort, max 10)
  let updated = 0;
  for (const o of rows.slice(0, 10)) {
    if (!o.supplier_order_id) continue;
    const stName = String(o.status || '').toLowerCase();
    if (stName === 'completed' || stName === 'canceled' || stName === 'cancelled') continue;
    try {
      const st = await owletCall({ action: 'status', order: String(o.supplier_order_id) });
      if (st.ok && st.json && !st.json.error) {
        const patch = {
          status: st.json.status || o.status,
          remains: st.json.remains != null ? Number(st.json.remains) : o.remains,
          start_count: st.json.start_count != null ? Number(st.json.start_count) : o.start_count
        };
        await supabase.from('booster_orders').update(patch).eq('id', o.id);
        Object.assign(o, patch);
        updated++;
      }
    } catch (_) { /* ignore */ }
  }

  return res.status(200).json({ success: true, data: rows, total: count || rows.length, refreshed: updated });
}

async function handleAdminOrders(req, res) {
  const page = Math.max(1, parseInt(req.query?.page || '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(10, parseInt(req.query?.page_size || '50', 10) || 50));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const q = (req.query?.q || '').toString().trim().toLowerCase();

  let query = supabase
    .from('booster_orders')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  const { data, error, count } = await query;
  if (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
  let rows = data || [];
  if (q) {
    rows = rows.filter(
      (r) =>
        String(r.service_name || '').toLowerCase().includes(q) ||
        String(r.link || '').toLowerCase().includes(q) ||
        String(r.supplier_order_id || '').includes(q) ||
        String(r.user_id || '').includes(q)
    );
  }
  return res.status(200).json({ success: true, data: rows, total: count || rows.length });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ success: false, message: 'Missing Supabase env' });
    }
    if (!process.env.OWLET_API_KEY) {
      return res.status(500).json({ success: false, message: 'Missing OWLET_API_KEY env on Vercel' });
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

    const authHeader = req.headers.authorization || '';
    const isCron =
      !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;

    if (action === 'sync' && isCron) {
      return await handleSync(req, res);
    }

    if (action === 'catalog') {
      const u = await requireUser(req);
      if (!u.ok) return res.status(u.status).json({ success: false, message: u.message });
      return await handleCatalog(req, res);
    }
    if (action === 'order') {
      return await handleOrder(req, res);
    }
    if (action === 'my_orders') {
      return await handleMyOrders(req, res);
    }

    const admin = await requireAdmin(req);
    if (!admin.ok) return res.status(admin.status).json({ success: false, message: admin.message });

    if (action === 'balance') return await handleBalance(req, res);
    if (action === 'services') return await handleServices(req, res);
    if (action === 'sync') return await handleSync(req, res);
    if (action === 'list') return await handleList(req, res);
    if (action === 'status') return await handleStatus(req, res);
    if (action === 'admin_orders') return await handleAdminOrders(req, res);

    return res.status(400).json({
      success: false,
      message:
        'action required: catalog | order | my_orders | balance | services | sync | list | status | admin_orders'
    });
  } catch (err) {
    console.error('[owlet] handler error', err);
    return res.status(500).json({
      success: false,
      message: err?.message || String(err) || 'Internal error'
    });
  }
}
