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
 * Configured Selling Markup: fixed 35% (OWLET_MARKUP_PERCENT). Rate from API is USD.
 */

const OWLET_URL = 'https://theowlet.com/api/v2';
const OWLET_KEY = process.env.OWLET_API_KEY;
const USD_TO_NGN = Number(process.env.USD_TO_NGN_RATE) || 1450;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Markup: fixed default 35% (override with OWLET_MARKUP_PERCENT env)
// Owlet API rate is USD (balance/status currency is USD per docs).
function getMarkupPercent() {
  const env = Number(process.env.OWLET_MARKUP_PERCENT);
  if (Number.isFinite(env) && env >= 0 && env <= 200) return env;
  return 35;
}

/** Sell NGN = rate_usd * USD_TO_NGN * (1 + markup/100) */
function sellPriceNgnFromUsd(rateUsd, markupPercent) {
  const usd = Number(rateUsd) || 0;
  const markup = markupPercent ?? getMarkupPercent();
  return Math.ceil(usd * USD_TO_NGN * (1 + markup / 100));
}

function supplierUsdFromRate(rateUsd) {
  return Math.round((Number(rateUsd) || 0) * 10000) / 10000;
}

// Back-compat aliases (old names still used in a few places)
function getRandomMarkup() { return getMarkupPercent(); }
function sellPriceNgn(rate, markupPercent) {
  // treat as USD rate
  return sellPriceNgnFromUsd(rate, markupPercent);
}
function supplierUsd(rate) {
  return supplierUsdFromRate(rate);
}
function sellPriceUsd(rate, markupPercent) {
  const usd = Number(rate) || 0;
  const markup = markupPercent ?? getMarkupPercent();
  return Math.round(usd * (1 + markup / 100) * 10000) / 10000;
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

// Calculate selling price in NGN with dynamic/random markup
function sellPriceNgn(rateNgn, markupPercent) {
  const r = Number(rateNgn) || 0;
  const markup = markupPercent ?? getRandomMarkup();
  return Math.ceil(r * (1 + markup / 100));
}

// Calculate USD supplier rate equivalent using 1450 exchange rate
function supplierUsd(rateNgn) {
  const r = Number(rateNgn) || 0;
  return Math.round((r / USD_TO_NGN) * 10000) / 10000;
}

function sellPriceUsd(rateNgn, markupPercent) {
  return supplierUsd(sellPriceNgn(rateNgn, markupPercent));
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
      // Owlet rate is USD per 1k
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
  const ratePer1k = Number(service.price_ngn) || 0;
  if (ratePer1k <= 0) {
    return res.status(400).json({ success: false, message: 'Service price not configured' });
  }
  const totalNgn = Math.ceil((ratePer1k / 1000) * quantity);
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

  // Refresh a few pending statuses
  const pending = (data || []).filter(o => /pending|progress|processing|in progress/i.test(String(o.status || ''))).slice(0, 5);
  for (const o of pending) {
    if (!o.supplier_order_id) continue;
    try {
      const st = await owletCall({ action: 'status', order: String(o.supplier_order_id) });
      if (st.ok && st.json && !st.json.error) {
        o.status = st.json.status || o.status;
        o.start_count = st.json.start_count ?? o.start_count;
        o.remains = st.json.remains ?? o.remains;
        await supabase.from('booster_orders').update({
          status: o.status,
          start_count: o.start_count,
          remains: o.remains,
          updated_at: new Date().toISOString()
        }).eq('id', o.id);
      }
    } catch (_) {}
  }

  return res.status(200).json({ success: true, data: data || [], page, page_size: pageSize, total: count || 0 });
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
  return res.status(200).json({ success: true, data: data || [], total: count || 0, page, page_size: pageSize });
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
    message: 'action required: catalog | order | my_orders | balance | services | sync | list | status | admin_orders'
  });
  } catch (err) {
    console.error('[owlet] handler error', err);
    return res.status(500).json({ success: false, message: err?.message || String(err) });
  }
}