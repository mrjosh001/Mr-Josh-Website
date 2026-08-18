import { createClient } from '@supabase/supabase-js';

/**
 * /api/owlet — MJ Boosters supplier (The Owlet SMM panel v2 API)
 * Docs: https://theowlet.com/api
 * Base: POST https://theowlet.com/api/v2
 *
 * Admin-only for interactive use. Cron may call ?action=sync with CRON_SECRET.
 *
 * Actions:
 *   balance  — Owlet wallet NGN balance
 *   services — live service list from Owlet
 *   sync     — pull services into booster_services (Supabase)
 *   status   — order status { order }
 *
 * Configured Exchange Rate: $1 = ₦1450 NGN
 * Markup random 35%–70% (or fixed via OWLET_MARKUP_PERCENT). Rate currency AUTO/USD/NGN via OWLET_RATE_CURRENCY.
 */

const OWLET_URL = 'https://theowlet.com/api/v2';
const OWLET_KEY = process.env.OWLET_API_KEY;
const USD_TO_NGN = Number(process.env.USD_TO_NGN_RATE) || 1450;
/** No booster service / order is sold below this (NGN). Override with OWLET_MIN_SELL_NGN */
const MIN_SELL_PRICE_NGN = Math.max(0, Number(process.env.OWLET_MIN_SELL_NGN) || 200);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Markup: random 35%–70% per service (override with OWLET_MARKUP_PERCENT env for fixed)
// Owlet rate currency depends on the panel wallet.
// Docs examples use USD, but Naira accounts often return rate already in NGN.
// Force with env OWLET_RATE_CURRENCY=USD or NGN.
function getMarkupPercent() {
  const env = Number(process.env.OWLET_MARKUP_PERCENT);
  if (Number.isFinite(env) && env >= 0 && env <= 200) return env;
  // Random profit margin between 35% and 70%
  return Math.floor(Math.random() * (70 - 35 + 1)) + 35;
}

function getRateCurrency() {
  const env = String(process.env.OWLET_RATE_CURRENCY || '').trim().toUpperCase();
  if (env === 'USD' || env === 'NGN') return env;
  return 'AUTO';
}

/**
 * Resolve supplier cost in NGN from Owlet `rate`.
 * AUTO: rate < 100 → treat as USD; rate >= 100 → already NGN
 * (avoids ₦millions when NGN rates were wrongly × 1450)
 */
function costNgnFromRate(rate) {
  const r = Number(rate) || 0;
  if (r <= 0) return 0;
  const mode = getRateCurrency();
  if (mode === 'USD') return r * USD_TO_NGN;
  if (mode === 'NGN') return r;
  // AUTO
  if (r < 100) return r * USD_TO_NGN; // typical USD SMM rates
  return r; // already NGN-scale
}

/**
 * Never sell below MIN_SELL_PRICE_NGN (₦200).
 * If a calculated price is under the floor, lift it into a stable band
 * ₦200–₦349 so cheap services don't all display as exactly ₦200.
 * Uses serviceId (when provided) so the same service always gets the same price.
 */
function floorSellNgn(n, serviceId) {
  const v = Math.ceil(Number(n) || 0);
  if (v >= MIN_SELL_PRICE_NGN) return v;
  const seed = String(serviceId != null ? serviceId : v);
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  // 200 + 0..149 → 200–349
  return MIN_SELL_PRICE_NGN + (h % 150);
}

function sellPriceNgnFromRate(rate, markupPercent, serviceId) {
  const cost = costNgnFromRate(rate);
  const markup = markupPercent ?? getMarkupPercent();
  const raw = Math.ceil(cost * (1 + markup / 100));
  // Under ₦200 → stable 200–349 band (not a flat 200 for every cheap service)
  return floorSellNgn(raw, serviceId != null ? serviceId : rate);
}

function supplierUsdFromRate(rate) {
  const r = Number(rate) || 0;
  const mode = getRateCurrency();
  if (mode === 'USD' || (mode === 'AUTO' && r > 0 && r < 100)) {
    return Math.round(r * 10000) / 10000;
  }
  // NGN → approximate USD
  return Math.round((r / USD_TO_NGN) * 10000) / 10000;
}

// Back-compat names used across handlers
function getRandomMarkup() { return getMarkupPercent(); }
function sellPriceNgn(rate, markupPercent) { return sellPriceNgnFromRate(rate, markupPercent); }
function sellPriceNgnFromUsd(rate, markupPercent) { return sellPriceNgnFromRate(rate, markupPercent); }
function supplierUsd(rate) { return supplierUsdFromRate(rate); }
function sellPriceUsd(rate, markupPercent) {
  const sellNgn = sellPriceNgnFromRate(rate, markupPercent);
  return Math.round((sellNgn / USD_TO_NGN) * 10000) / 10000;
}

async function requireUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, message: 'Please sign in' };
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return { ok: false, status: 401, message: 'Session expired — sign in again' };
  return { ok: true, user };
}

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
  const data = json.map(s => {
    const randomMarkup = getRandomMarkup();
    return {
      service_id: String(s.service),
      name: s.name,
      type: s.type,
      category: s.category,
      supplier_rate_ngn: Number(s.rate) || 0,
      supplier_rate_usd: supplierUsd(s.rate),
      rate_usd: sellPriceUsd(s.rate, randomMarkup),
      rate_ngn: sellPriceNgn(s.rate, randomMarkup),
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
      const rateRaw = Number(s.rate) || 0;
      const supplierUsdVal = supplierUsdFromRate(rateRaw);
      const defaultNgn = sellPriceNgnFromRate(rateRaw, null, serviceId);

      const prev = map.get(serviceId);
      const manual = prev && prev.price_source === 'manual';
      // Manual admin prices kept, but never below site minimum ₦200
      const listed = manual ? floorSellNgn(prev.price_ngn, serviceId) : floorSellNgn(defaultNgn, serviceId);
      return {
        source: 'owlet',
        service_id: serviceId,
        name: s.name || serviceId,
        category: s.category || 'Other',
        service_type: s.type || 'Default',
        supplier_rate_usd: supplierUsdVal,
        price_ngn: listed,
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
    rate_currency_mode: getRateCurrency(),
    markup_range: '35%–70% (random per service)',
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

  const { data: catRows } = await supabase
    .from('booster_services')
    .select('category')
    .eq('source', 'owlet')
    .limit(5000);
  const categories = [...new Set((catRows || []).map(r => r.category).filter(Boolean))].sort();

  rows = rows.map(s => ({
    ...s,
    price_ngn: floorSellNgn(s.price_ngn, s.service_id)
  }));

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


async function handleCatalog(req, res) {
  // Public to signed-in users — categories + optional services
  const category = (req.query?.category || '').toString().trim();
  const q = (req.query?.q || '').toString().trim().toLowerCase();
  const page = Math.max(1, parseInt(req.query?.page || '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(12, parseInt(req.query?.page_size || '48', 10) || 48));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  // Distinct categories
  const { data: catRows } = await supabase
    .from('booster_services')
    .select('category')
    .eq('source', 'owlet')
    .eq('is_available', true)
    .limit(8000);
  const categories = [...new Set((catRows || []).map(r => r.category).filter(Boolean))].sort();

  if (!category && !q) {
    // Overview: return category cards with counts only (fast)
    const counts = {};
    for (const c of (catRows || [])) {
      const k = c.category || 'Other';
      counts[k] = (counts[k] || 0) + 1;
    }
    const cards = Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    return res.status(200).json({ success: true, mode: 'categories', categories: cards, total_services: (catRows || []).length });
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
    rows = rows.filter(s =>
      (s.name || '').toLowerCase().includes(q) ||
      (s.category || '').toLowerCase().includes(q) ||
      String(s.service_id).includes(q)
    );
  }

  // Enforce ₦200 floor on every service shown to users (old DB rows included)
  rows = rows.map(s => ({
    ...s,
    price_ngn: floorSellNgn(s.price_ngn, s.service_id)
  }));

  return res.status(200).json({
    success: true,
    mode: 'services',
    category: category || null,
    categories,
    data: rows,
    page,
    page_size: pageSize,
    total: count ?? rows.length
  });
}

async function handleOrder(req, res) {
  const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })() : (req.body || {});
  const serviceId = String(body.service_id || body.service || '').trim();
  const link = String(body.link || '').trim();
  const quantity = Math.max(1, parseInt(body.quantity, 10) || 0);

  if (!serviceId || !link || !quantity) {
    return res.status(400).json({ success: false, message: 'service_id, link, and quantity are required' });
  }
  if (!/^https?:\/\//i.test(link) && !link.includes('.') && !link.startsWith('@')) {
    // allow @handles and bare domains/usernames common for SMM
  }

  const userGate = await requireUser(req);
  if (!userGate.ok) return res.status(userGate.status).json({ success: false, message: userGate.message });
  const user = userGate.user;

  const { data: service, error: sErr } = await supabase
    .from('booster_services')
    .select('*')
    .eq('source', 'owlet')
    .eq('service_id', serviceId)
    .maybeSingle();

  if (sErr || !service) {
    return res.status(404).json({ success: false, message: 'Service not found or unavailable' });
  }
  if (service.is_available === false) {
    return res.status(400).json({ success: false, message: 'This service is temporarily unavailable' });
  }

  // Site rule: never sell below 500 units. Supplier min wins if higher.
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

  // price_ngn is selling rate per 1000 units (SMM standard)
  // Listed rate never below ₦200 even if DB still has old cheap rows
  const ratePer1k = floorSellNgn(service.price_ngn, service.service_id);
  if (ratePer1k <= 0) {
    return res.status(400).json({ success: false, message: 'Service price not configured' });
  }
  const totalNgn = Math.max(MIN_SELL_PRICE_NGN, Math.ceil((ratePer1k / 1000) * quantity));
  if (totalNgn < 1) {
    return res.status(400).json({ success: false, message: 'Order total too low' });
  }

  const { data: profile, error: pErr } = await supabase
    .from('profiles')
    .select('id, balance, customer_id')
    .eq('id', user.id)
    .maybeSingle();

  if (pErr || !profile) {
    return res.status(400).json({ success: false, message: 'Could not load your profile' });
  }

  const originalBalance = Number(profile.balance) || 0;
  if (originalBalance < totalNgn) {
    return res.status(400).json({
      success: false,
      message: `Insufficient balance. Need ₦${totalNgn.toLocaleString()}, you have ₦${originalBalance.toLocaleString()}`,
      required: totalNgn,
      available: originalBalance
    });
  }

  const newBalance = originalBalance - totalNgn;
  const { error: deductErr } = await supabase
    .from('profiles')
    .update({ balance: newBalance })
    .eq('id', user.id)
    .eq('balance', originalBalance); // optimistic lock

  if (deductErr) {
    // retry without eq balance
    const { error: d2 } = await supabase.from('profiles').update({ balance: newBalance }).eq('id', user.id);
    if (d2) {
      return res.status(500).json({ success: false, message: 'Could not debit wallet. Try again.' });
    }
  }

  // Place order with Owlet
  const { ok, status, json } = await owletCall({
    action: 'add',
    service: serviceId,
    link,
    quantity: String(quantity)
  });

  if (!ok || json?.error || !json?.order) {
    // refund
    await supabase.from('profiles').update({ balance: originalBalance }).eq('id', user.id);
    const errMsg = json?.error || json?.message || 'Supplier rejected the order';
    try {
      await supabase.from('transactions').insert({
        user_id: user.id,
        customer_id: profile.customer_id || null,
        type: 'booster',
        category: 'booster',
        title: service.name || 'MJ Booster',
        subtitle: `Failed: ${errMsg}`,
        amount: totalNgn,
        status: 'failed',
        created_at: new Date().toISOString()
      });
    } catch (_) {}
    return res.status(502).json({ success: false, message: errMsg });
  }

  const supplierOrderId = String(json.order);
  const nowIso = new Date().toISOString();
  const orderRow = {
    user_id: user.id,
    customer_id: profile.customer_id || null,
    source: 'owlet',
    supplier_order_id: supplierOrderId,
    service_id: serviceId,
    service_name: service.name,
    category: service.category || null,
    link,
    quantity,
    charge_usd: null,
    price_ngn: totalNgn,
    rate_per_1k: ratePer1k,
    status: 'Pending',
    start_count: null,
    remains: null,
    raw: json,
    created_at: nowIso,
    updated_at: nowIso
  };

  // MUST persist — history depends on this. Retry with fewer columns if schema is thin.
  let saved = null;
  let saveErrMsg = null;
  {
    let ins = await supabase
      .from('booster_orders')
      .insert(orderRow)
      .select('id, supplier_order_id, service_name, quantity, price_ngn, status, link, created_at, user_id, customer_id')
      .maybeSingle();

    if (ins.error) {
      console.error('[owlet order] booster_orders insert failed:', ins.error.message);
      // Minimal fallback (table may lack optional columns)
      const minimal = {
        user_id: user.id,
        customer_id: profile.customer_id || null,
        source: 'owlet',
        supplier_order_id: supplierOrderId,
        service_id: serviceId,
        service_name: service.name,
        link,
        quantity,
        price_ngn: totalNgn,
        status: 'Pending',
        created_at: nowIso
      };
      ins = await supabase
        .from('booster_orders')
        .insert(minimal)
        .select('id, supplier_order_id, service_name, quantity, price_ngn, status, link, created_at, user_id, customer_id')
        .maybeSingle();
      if (ins.error) {
        saveErrMsg = ins.error.message;
        console.error('[owlet order] minimal insert also failed:', ins.error.message);
      } else {
        saved = ins.data;
      }
    } else {
      saved = ins.data;
    }
  }

  // If DB save failed after supplier accepted, still return success but flag it —
  // do NOT refund (supplier already charged). Admin can reconcile via supplier_order_id.
  try {
    await supabase.from('transactions').insert({
      user_id: user.id,
      customer_id: profile.customer_id || null,
      type: 'booster',
      category: 'booster',
      title: service.name || 'MJ Booster',
      subtitle: `${quantity.toLocaleString()} · ${link.slice(0, 60)}`,
      amount: `₦${totalNgn.toLocaleString()}`,
      amount_ngn: totalNgn,
      status: 'completed',
      created_at: nowIso
    });
  } catch (e) {
    console.warn('[owlet order] transactions insert:', e?.message || e);
  }

  // Best-effort status pull
  let statusData = null;
  try {
    const st = await owletCall({ action: 'status', order: supplierOrderId });
    if (st.ok && st.json && !st.json.error) {
      statusData = st.json;
      if (saved?.id || supplierOrderId) {
        await supabase.from('booster_orders').update({
          status: st.json.status || 'Pending',
          start_count: st.json.start_count != null ? String(st.json.start_count) : null,
          remains: st.json.remains != null ? String(st.json.remains) : null,
          charge_usd: st.json.charge ? Number(st.json.charge) : null,
          updated_at: new Date().toISOString()
        }).eq('supplier_order_id', supplierOrderId);
      }
    }
  } catch (_) {}

  if (saveErrMsg) {
    return res.status(200).json({
      success: true,
      message: 'Boost sent to supplier, but history save failed — run booster_orders SQL in Supabase',
      warning: saveErrMsg,
      order: { supplier_order_id: supplierOrderId, service_name: service.name, quantity, price_ngn: totalNgn, status: 'Pending', link },
      supplier_order_id: supplierOrderId,
      new_balance: newBalance,
      status: statusData,
      history_saved: false
    });
  }

  return res.status(200).json({
    success: true,
    message: 'Boost order placed successfully',
    order: saved || orderRow,
    supplier_order_id: supplierOrderId,
    new_balance: newBalance,
    status: statusData,
    history_saved: true
  });
}

// If Owlet's own status for an order flips to Canceled/Refunded/Failed
// *after* it was already accepted (discovered here, during a later status
// poll — not via the customer manually cancelling, which is handled
// separately in handleCancel), the customer's wallet was never being
// credited back — only the status text updated. This is the fix: refund
// automatically the first time we observe that transition, and never
// again for the same order (guarded by only firing when the OLD status
// wasn't already terminal, so re-polling an already-refunded order is a
// no-op instead of a double-refund).
async function refundIfSupplierFailed(order, oldStatus, newStatus) {
  const wasTerminal = /completed|canceled|cancelled|refunded|failed/i.test(String(oldStatus || ''));
  const isNowFailed = /canceled|cancelled|refunded|failed/i.test(String(newStatus || ''));
  if (wasTerminal || !isNowFailed) return 0;
  if (!order.user_id || !(Number(order.price_ngn) > 0)) return 0;

  const { data: prof } = await supabase.from('profiles').select('balance').eq('id', order.user_id).maybeSingle();
  if (!prof) return 0;
  const bal = Number(prof.balance) || 0;
  const refunded = Number(order.price_ngn) || 0;
  await supabase.from('profiles').update({ balance: bal + refunded }).eq('id', order.user_id);
  try {
    await supabase.from('transactions').insert({
      user_id: order.user_id,
      customer_id: order.customer_id || null,
      type: 'booster',
      category: 'booster',
      title: 'Booster auto-refund (supplier failed)',
      subtitle: `Order #${order.supplier_order_id} — ${newStatus}`,
      amount: refunded,
      amount_ngn: refunded,
      status: 'completed',
      created_at: new Date().toISOString()
    });
  } catch (_) {}
  return refunded;
}

async function handleMyOrders(req, res) {
  const userGate = await requireUser(req);
  if (!userGate.ok) return res.status(userGate.status).json({ success: false, message: userGate.message });

  const page = Math.max(1, parseInt(req.query?.page || '1', 10) || 1);
  const pageSize = Math.min(50, Math.max(10, parseInt(req.query?.page_size || '20', 10) || 20));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabase
    .from('booster_orders')
    .select('*', { count: 'exact' })
    .eq('user_id', userGate.user.id)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) {
    return res.status(500).json({
      success: false,
      message: error.message + (/relation|does not exist/i.test(error.message) ? ' — run booster_orders SQL' : '')
    });
  }

  // Live refresh from Owlet for active orders (Pending / In progress / Processing)
  const active = (data || []).filter((o) => {
    const s = String(o.status || '').toLowerCase();
    return /pending|progress|processing|awaiting|waiting|partial/i.test(s)
      && !/completed|canceled|cancelled|refunded|failed/i.test(s);
  }).slice(0, 15);

  for (const o of active) {
    if (!o.supplier_order_id) continue;
    try {
      const st = await owletCall({ action: 'status', order: String(o.supplier_order_id) });
      if (!st.ok || !st.json || st.json.error) continue;

      const j = st.json;
      const oldStatus = o.status;
      o.status = j.status || o.status;

      // Normalize numbers (Owlet often returns strings)
      if (j.start_count != null && j.start_count !== '') {
        const n = Number(j.start_count);
        if (!Number.isNaN(n)) o.start_count = n;
      }
      if (j.remains != null && j.remains !== '') {
        const n = Number(j.remains);
        if (!Number.isNaN(n)) o.remains = n;
      }
      if (j.charge != null && j.charge !== '') o.charge = j.charge;
      if (j.currency) o.currency = j.currency;

      // Derived delivered for client convenience
      const qty = Number(o.quantity) || 0;
      if (o.remains != null && qty > 0) {
        o.delivered = Math.max(0, Math.min(qty, qty - Number(o.remains)));
      } else if (/completed/i.test(String(o.status || ''))) {
        o.delivered = qty;
        o.remains = 0;
      }

      const refunded = await refundIfSupplierFailed(o, oldStatus, o.status);
      await supabase.from('booster_orders').update({
        status: o.status,
        start_count: o.start_count,
        remains: o.remains,
        updated_at: new Date().toISOString()
      }).eq('id', o.id);
      if (refunded) o.auto_refunded = refunded;
      o.live = true;
      o.synced_at = new Date().toISOString();
    } catch (_) {}
  }

  return res.status(200).json({
    success: true,
    data: data || [],
    page,
    page_size: pageSize,
    total: count || 0,
    live_refreshed: active.length
  });
}

async function handleAdminOrders(req, res) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return res.status(admin.status).json({ success: false, message: admin.message });

  const page = Math.max(1, parseInt(req.query?.page || '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(10, parseInt(req.query?.page_size || '50', 10) || 50));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const q = (req.query?.q || '').toString().trim();

  let query = supabase
    .from('booster_orders')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (q) {
    query = query.or(`supplier_order_id.ilike.%${q}%,service_name.ilike.%${q}%,customer_id.ilike.%${q}%,link.ilike.%${q}%`);
  }

  const { data, error, count } = await query;
  if (error) {
    return res.status(500).json({ success: false, message: error.message });
  }

  // Same live-status-pull the customer's My Orders page already does —
  // the admin "Refresh" button previously only re-read whatever status
  // was already stored, which stayed stale forever unless a customer
  // happened to open their own order history in the meantime (the only
  // place this existed until now). Capped to this page's non-terminal
  // orders so Refresh stays fast instead of hammering Owlet for the
  // entire order history on every click.
  const pending = (data || []).filter(o => /pending|progress|processing|in progress/i.test(String(o.status || '')));
  for (const o of pending) {
    if (!o.supplier_order_id) continue;
    try {
      const st = await owletCall({ action: 'status', order: String(o.supplier_order_id) });
      if (st.ok && st.json && !st.json.error) {
        const oldStatus = o.status;
        o.status = st.json.status || o.status;
        o.start_count = st.json.start_count ?? o.start_count;
        o.remains = st.json.remains ?? o.remains;
        const refunded = await refundIfSupplierFailed(o, oldStatus, o.status);
        await supabase.from('booster_orders').update({
          status: o.status,
          start_count: o.start_count,
          remains: o.remains,
          updated_at: new Date().toISOString()
        }).eq('id', o.id);
        if (refunded) o.auto_refunded = refunded;
      }
    } catch (_) {}
  }

  return res.status(200).json({ success: true, data: data || [], total: count || 0, page, page_size: pageSize });
}



async function handleCancel(req, res) {
  const userGate = await requireUser(req);
  if (!userGate.ok) return res.status(userGate.status).json({ success: false, message: userGate.message });

  const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })() : (req.body || {});
  const orderId = String(body.order || body.supplier_order_id || req.query?.order || '').trim();
  if (!orderId) {
    return res.status(400).json({ success: false, message: 'order is required' });
  }

  const { data: row } = await supabase
    .from('booster_orders')
    .select('*')
    .eq('supplier_order_id', orderId)
    .eq('user_id', userGate.user.id)
    .maybeSingle();

  if (!row) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }

  const st = String(row.status || '').toLowerCase();
  // Only allow cancel while truly pending. Once supplier has started, cancel
  // often fails on Owlet while we still refunded locally — that loses money.
  if (!/pending|awaiting|waiting/i.test(st)) {
    return res.status(400).json({
      success: false,
      message: 'This order can no longer be cancelled. Contact support if there is an issue.'
    });
  }

  // Ask supplier to cancel first. Never refund until supplier confirms.
  const { ok, status, json } = await owletCall({ action: 'cancel', orders: orderId });

  // PerfectPanel-style: [{ order: "123", cancel: 1 }] success; cancel: 0 or { error } = fail
  let cancelOk = false;
  let errMsg = null;
  if (Array.isArray(json)) {
    const hit = json.find((x) => String(x.order) === String(orderId)) || json[0];
    if (hit) {
      if (hit.cancel === 1 || hit.cancel === '1' || hit.cancel === true) cancelOk = true;
      else if (hit.cancel && typeof hit.cancel === 'object' && hit.cancel.error) errMsg = String(hit.cancel.error);
      else if (hit.error) errMsg = String(hit.error);
      else errMsg = 'Supplier did not confirm cancel';
    } else {
      errMsg = 'Supplier did not return this order';
    }
  } else if (json && (json.cancel === 1 || json.cancel === '1' || json.cancel === true)) {
    cancelOk = true;
  } else if (json?.error || json?.message) {
    errMsg = json.error || json.message;
  } else {
    errMsg = 'Supplier did not confirm cancel';
  }

  if (!ok || !cancelOk) {
    return res.status(status || 502).json({
      success: false,
      message: errMsg || 'Supplier could not cancel this order. No refund issued.'
    });
  }

  // Double-check status on supplier so we never refund a still-running order
  let supplierStatus = '';
  try {
    const stRes = await owletCall({ action: 'status', order: orderId });
    if (stRes.ok && stRes.json) {
      supplierStatus = String(stRes.json.status || stRes.json.order_status || '').toLowerCase();
    }
  } catch (_) {}

  const supplierStopped = !supplierStatus
    || /cancel|refund|fail|error|stop/i.test(supplierStatus);

  if (supplierStatus && !supplierStopped) {
    // Supplier still running — do not mark local cancel / do not refund
    return res.status(409).json({
      success: false,
      message: 'Supplier is still processing this order (' + supplierStatus + '). No refund issued.',
      supplier_status: supplierStatus
    });
  }

  await supabase.from('booster_orders').update({
    status: 'Canceled',
    updated_at: new Date().toISOString()
  }).eq('id', row.id);

  let refunded = 0;
  if (Number(row.price_ngn) > 0) {
    const { data: prof } = await supabase.from('profiles').select('balance').eq('id', userGate.user.id).maybeSingle();
    const bal = Number(prof?.balance) || 0;
    refunded = Number(row.price_ngn) || 0;
    await supabase.from('profiles').update({ balance: bal + refunded }).eq('id', userGate.user.id);
    try {
      await supabase.from('transactions').insert({
        user_id: userGate.user.id,
        customer_id: row.customer_id || null,
        type: 'booster',
        category: 'booster',
        title: 'Booster cancel refund',
        subtitle: 'Order #' + orderId + ' (supplier confirmed)',
        amount: refunded,
        amount_ngn: refunded,
        status: 'Success',
        created_at: new Date().toISOString()
      });
    } catch (_) {}
  }

  return res.status(200).json({
    success: true,
    message: refunded
      ? ('Order cancelled with supplier. ₦' + refunded.toLocaleString() + ' returned to wallet.')
      : 'Order cancelled with supplier.',
    refunded,
    order_id: orderId,
    supplier_status: supplierStatus || 'canceled'
  });
}

async function handleRefill(req, res) {
  const userGate = await requireUser(req);
  if (!userGate.ok) return res.status(userGate.status).json({ success: false, message: userGate.message });

  const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })() : (req.body || {});
  const orderId = String(body.order || body.supplier_order_id || req.query?.order || '').trim();
  if (!orderId) {
    return res.status(400).json({ success: false, message: 'order is required' });
  }

  const { data: row } = await supabase
    .from('booster_orders')
    .select('*')
    .eq('supplier_order_id', orderId)
    .eq('user_id', userGate.user.id)
    .maybeSingle();

  if (!row) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }

  const { ok, status, json } = await owletCall({ action: 'refill', order: orderId });
  if (!ok || json?.error || (json?.refill && typeof json.refill === 'object' && json.refill.error)) {
    const msg = json?.error || json?.refill?.error || json?.message || 'Refill not available for this order';
    return res.status(status || 502).json({ success: false, message: msg });
  }

  const refillId = json?.refill != null ? String(json.refill) : null;
  try {
    const patch = {
      updated_at: new Date().toISOString(),
      raw: { ...(typeof row.raw === 'object' && row.raw ? row.raw : {}), last_refill_id: refillId, last_refill_at: new Date().toISOString() }
    };
    await supabase.from('booster_orders').update(patch).eq('id', row.id);
  } catch (_) {}

  return res.status(200).json({
    success: true,
    message: 'Refill requested',
    refill_id: refillId,
    order_id: orderId
  });
}

async function handleRefillStatus(req, res) {
  const userGate = await requireUser(req);
  if (!userGate.ok) return res.status(userGate.status).json({ success: false, message: userGate.message });

  const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })() : (req.body || {});
  const refillId = String(body.refill || req.query?.refill || '').trim();
  if (!refillId) {
    return res.status(400).json({ success: false, message: 'refill id is required' });
  }

  const { ok, status, json } = await owletCall({ action: 'refill_status', refill: refillId });
  if (!ok || json?.error) {
    return res.status(status || 502).json({
      success: false,
      message: json?.error || json?.message || 'Could not fetch refill status'
    });
  }
  return res.status(200).json({ success: true, data: json });
}


export default async function handler(req, res) {
  try {
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

  const authHeader = req.headers.authorization || '';
  const isCron =
    !!process.env.CRON_SECRET &&
    authHeader === `Bearer ${process.env.CRON_SECRET}`;

  if (action === 'sync' && isCron) {
    return handleSync(req, res);
  }

  // User-facing (any signed-in user)
  if (action === 'catalog') {
    const u = await requireUser(req);
    if (!u.ok) return res.status(u.status).json({ success: false, message: u.message });
    return handleCatalog(req, res);
  }
  if (action === 'order') {
    return handleOrder(req, res);
  }
  if (action === 'my_orders') {
    return handleMyOrders(req, res);
  }
  if (action === 'cancel') {
    return handleCancel(req, res);
  }
  if (action === 'refill') {
    return handleRefill(req, res);
  }
  if (action === 'refill_status') {
    return handleRefillStatus(req, res);
  }

  // Admin-only
  const admin = await requireAdmin(req);
  if (!admin.ok) return res.status(admin.status).json({ success: false, message: admin.message });

  if (action === 'balance') return handleBalance(req, res);
  if (action === 'services') return handleServices(req, res);
  if (action === 'sync') return handleSync(req, res);
  if (action === 'list') return handleList(req, res);
  if (action === 'status') return handleStatus(req, res);
  if (action === 'admin_orders') return handleAdminOrders(req, res);

  return res.status(400).json({
    success: false,
    message: 'action required: catalog | order | my_orders | cancel | refill | refill_status | balance | services | sync | list | status | admin_orders'
  });
  } catch (err) {
    console.error('[owlet] handler error', err);
    return res.status(500).json({ success: false, message: err?.message || String(err) });
  }
}