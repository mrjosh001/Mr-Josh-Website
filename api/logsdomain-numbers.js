import { createClient } from '@supabase/supabase-js';
import { applyMarkup } from '../lib/pricing.js';

/**
 * /api/logsdomain-numbers — "Server 2" SMS numbers, powered by LogsDomain's
 * Numbers API (https://logsdomain.com/api-docs/numbers). Uses the same
 * LOGSDOMAIN_API_KEY / wallet already wired up for the Logs product
 * (api/order-logsdomain.js) — one supplier account, two product lines.
 *
 * LIVE for all signed-in users (requireAuth — any valid session, not just
 * admins). Was admin-only during pricing/catalog testing; opened up once
 * verified. Reachable from mj-sms-choose-server.html → mj-sms2.html →
 * mj-sms2-number.html, the LogsDomain counterpart to the existing
 * mj-sms.html → mj-sms-number.html Grizzly flow. The admin "SMS Server 2"
 * tab in admin.html still works the same way — it's just this same API,
 * called by an admin instead of a customer.
 *
 * One file, not five, per instruction — everything routed by ?action=,
 * same shape as grizzly-sync.js's action-based routing.
 *
 * GET  /api/logsdomain-numbers?action=wallet                        → LogsDomain wallet balance (admin visibility)
 * GET  /api/logsdomain-numbers?action=countries                     → live country list
 * GET  /api/logsdomain-numbers?action=services&country_id=1         → live services + marked-up NGN price
 * GET  /api/logsdomain-numbers?action=area-codes&country_id=&service_id= → live area codes
 * GET  /api/logsdomain-numbers?action=orders                        → caller's own order history
 * POST /api/logsdomain-numbers?action=order   {country_id, service_id, selected_area_codes?} → real purchase
 * POST /api/logsdomain-numbers?action=check   {order_id}             → poll for SMS code
 * POST /api/logsdomain-numbers?action=cancel  {order_id}             → cancel + refund
 *
 * Env: LOGSDOMAIN_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET?
 * Optional: MIN_NUMBER_PRICE_NGN (default 1000, shared with Grizzly's floor)
 */

const BASE = 'https://logsdomain.com/api/v1';
const LOGSDOMAIN_KEY = process.env.LOGSDOMAIN_API_KEY;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function requireAuth(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, message: 'Please sign in to continue' };

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return { ok: false, status: 401, message: 'Your session has expired. Please sign in again.' };

  return { ok: true, userId: user.id };
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
  return { ok: true, userId: user.id };
}

async function callLogsDomain(path, { method = 'GET', body = null } = {}) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${LOGSDOMAIN_KEY}`
  };
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json };
}

// Applies the same shared markup + ₦1000 absolute floor used for Grizzly.
// LogsDomain's service price already comes back in NGN (not USD), so we
// pass usdToNgn=1 — applyMarkup just treats the input as already-NGN cost.
function priceForCustomer(supplierPriceNgn) {
  return applyMarkup(Number(supplierPriceNgn) || 0, 1);
}

// ===========================================================================
// READS: wallet / countries / services / area-codes / order history
// ===========================================================================

async function handleWallet(req, res) {
  const { status, ok, json } = await callLogsDomain('/wallet');
  if (!ok || !json?.success) {
    return res.status(status || 502).json({ success: false, message: json?.message || 'Could not reach LogsDomain' });
  }
  return res.status(200).json({ success: true, data: json.data });
}

async function handleCountries(req, res) {
  const { status, ok, json } = await callLogsDomain('/numbers/countries');
  if (!ok || !json?.success) {
    return res.status(status || 502).json({ success: false, message: json?.message || 'Could not reach LogsDomain' });
  }
  return res.status(200).json({ success: true, data: json.data });
}

async function handleServices(req, res) {
  const countryId = parseInt(req.query.country_id, 10);
  if (!Number.isFinite(countryId)) {
    return res.status(400).json({ success: false, message: 'country_id is required' });
  }
  const { status, ok, json } = await callLogsDomain(`/numbers/services?country_id=${countryId}`);
  if (!ok || !json?.success) {
    return res.status(status || 502).json({ success: false, message: json?.message || 'Could not reach LogsDomain' });
  }
  const withPricing = (json.data || []).map(s => ({
    ...s,
    supplier_price: s.price,
    price: priceForCustomer(s.price)
  }));
  return res.status(200).json({ success: true, data: withPricing });
}

async function handleAreaCodes(req, res) {
  const countryId = parseInt(req.query.country_id, 10);
  const serviceId = req.query.service_id;
  if (!Number.isFinite(countryId) || !serviceId) {
    return res.status(400).json({ success: false, message: 'country_id and service_id are required' });
  }
  const { status, ok, json } = await callLogsDomain(`/numbers/area-codes?country_id=${countryId}&service_id=${encodeURIComponent(serviceId)}`);
  if (!ok || !json?.success) {
    return res.status(status || 502).json({ success: false, message: json?.message || 'Could not reach LogsDomain' });
  }
  return res.status(200).json({ success: true, data: json.data });
}

async function handleOrderHistory(req, res, userId) {
  const { data, error } = await supabase
    .from('number_orders')
    .select('*')
    .eq('source', 'logsdomain')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ success: false, message: error.message });
  return res.status(200).json({ success: true, data });
}

// ===========================================================================
// ORDER — debited from the calling user's own wallet
// ===========================================================================

async function placeOrder(countryId, serviceId, selectedAreaCodes, userId) {
  const idempotencyKey = `MJ-LD-NUM-${String(userId).slice(0, 8)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const res = await callLogsDomain('/numbers/orders', {
    method: 'POST',
    body: {
      country_id: countryId,
      service_id: Number(serviceId) || serviceId,
      ...(selectedAreaCodes ? { selected_area_codes: selectedAreaCodes } : {}),
      idempotency_key: idempotencyKey
    }
  });
  res.idempotencyKey = idempotencyKey;
  return res;
}

async function handleOrder(req, res, userId) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const countryId = parseInt(body.country_id, 10);
  const serviceId = body.service_id != null ? String(body.service_id) : null;
  const selectedAreaCodes = Array.isArray(body.selected_area_codes) ? body.selected_area_codes : undefined;

  if (!Number.isFinite(countryId) || !serviceId) {
    return res.status(400).json({ success: false, message: 'country_id and service_id are required' });
  }
  if (!LOGSDOMAIN_KEY) {
    return res.status(500).json({ success: false, message: 'LOGSDOMAIN_API_KEY not configured' });
  }

  // Re-fetch the live service to get current supplier price and name —
  // never trust a price the client sent us.
  async function fetchLiveService() {
    const svcRes = await callLogsDomain(`/numbers/services?country_id=${countryId}`);
    if (!svcRes.ok || !svcRes.json?.success) return null;
    return (svcRes.json.data || []).find(s => String(s.service_id) === serviceId) || null;
  }

  let svc = await fetchLiveService();
  if (!svc) {
    return res.status(404).json({ success: false, message: 'This service is no longer available for that country.' });
  }
  // Not pre-checking svc.available_quantity here: LogsDomain's live catalog
  // has been returning null for this field regardless of real availability,
  // which was blocking every purchase with a false "out of stock" before it
  // ever reached the supplier. The actual /numbers/orders call below is the
  // authoritative check — LogsDomain returns NUMBER_OUT_OF_STOCK itself if a
  // number genuinely isn't available, which we handle below.

  let price = priceForCustomer(svc.price);
  let originalBalance = 0;
  let customerId = null;
  let deducted = false;

  try {
    const { data: profile, error: profErr } = await supabase
      .from('profiles')
      .select('balance, customer_id')
      .eq('id', userId)
      .single();

    if (profErr || !profile) {
      return res.status(400).json({ success: false, message: 'User profile not found' });
    }
    originalBalance = Number(profile.balance || 0);
    customerId = profile.customer_id;

    if (originalBalance < price) {
      return res.status(402).json({ success: false, message: 'Insufficient balance for this purchase', required: price, available: originalBalance });
    }

    let newBalance = originalBalance - price;
    const { error: deductErr } = await supabase.from('profiles').update({ balance: newBalance }).eq('id', userId);
    if (deductErr) {
      return res.status(500).json({ success: false, message: 'Could not debit balance. Please try again.' });
    }
    deducted = true;

    // LogsDomain's catalog prices/stock shift quickly (same as Grizzly), so
    // the order call can transiently reject a quote that was fresh a moment
    // ago. Try once, and if it fails for a price/availability reason,
    // re-fetch the live price and retry a single time before giving up —
    // this is invisible to the customer instead of surfacing a raw
    // "price changed, try again" error for something that usually resolves
    // itself within a second or two.
    let orderRes = await placeOrder(countryId, serviceId, selectedAreaCodes, userId);

    if (!orderRes.ok || !orderRes.json?.success) {
      const msg = (orderRes.json?.message || '').toLowerCase();
      const transient = msg.includes('price changed') || msg.includes('temporarily unavailable') || msg.includes('out of stock');
      console.warn('[logsdomain-numbers order] first attempt failed:', orderRes.status, orderRes.json);

      if (transient) {
        const freshSvc = await fetchLiveService();
        if (freshSvc) {
          svc = freshSvc;
          const freshPrice = priceForCustomer(freshSvc.price);
          if (freshPrice !== price) {
            // Price moved — true up the wallet debit before retrying so we
            // never charge the stale amount.
            const adjustedBalance = originalBalance - freshPrice;
            if (adjustedBalance < 0) {
              await supabase.from('profiles').update({ balance: originalBalance }).eq('id', userId);
              return res.status(402).json({ success: false, message: 'Price changed and your balance no longer covers it. Please try again.' });
            }
            await supabase.from('profiles').update({ balance: adjustedBalance }).eq('id', userId);
            price = freshPrice;
            newBalance = adjustedBalance;
          }
          orderRes = await placeOrder(countryId, serviceId, selectedAreaCodes, userId);
        }
      }
    }

    if (!orderRes.ok || !orderRes.json?.success) {
      // Still failing after retry — restore balance and surface the real
      // supplier message so this is diagnosable if it keeps happening.
      console.error('[logsdomain-numbers order] failed after retry:', orderRes.status, orderRes.json);
      await supabase.from('profiles').update({ balance: originalBalance }).eq('id', userId);

      const failMsg = (orderRes.json?.message || '').toLowerCase();
      if (failMsg.includes('out of stock')) {
        // This is the one moment we ever get a real, trustworthy signal that
        // this exact country/service is actually out of stock — LogsDomain's
        // catalog data itself returns null for available_quantity almost
        // always, so this real failure is the only accurate source we have.
        // Hide it immediately rather than waiting for the next sync.
        await supabase
          .from('number_services')
          .update({ available_quantity: 0, is_available: false, updated_at: new Date().toISOString() })
          .eq('source', 'logsdomain')
          .eq('country_id', countryId)
          .eq('service_id', serviceId)
          .catch(() => {});
      }

      return res.status(orderRes.status === 402 ? 402 : 400).json({
        success: false,
        code: orderRes.json?.code || 'SUPPLIER_ERROR',
        message: orderRes.json?.message || 'Purchase failed. Your balance has been restored.'
      });
    }

    const d = orderRes.json.data;
    const numberOrderRow = {
      source: 'logsdomain',
      user_id: userId,
      customer_id: customerId,
      order_id: String(d.order_id),
      idempotency_key: orderRes.idempotencyKey,
      country_id: countryId,
      country_name: d.country_name || svc.country_name,
      service_id: serviceId,
      service_name: d.service_name || svc.service_name,
      phone_number: d.number || null,
      price,
      supplier_price: svc.price,
      currency: 'NGN',
      status: 'waiting_for_code',
      code: null,
      time_left: d.time_left || null,
      refunded: false
    };
    await supabase.from('number_orders').insert(numberOrderRow);

    await supabase.from('transactions').insert({
      user_id: userId,
      customer_id: customerId,
      type: 'purchase',
      category: 'MJ SMS - Server 2 (LogsDomain)',
      title: d.service_name || svc.service_name,
      subtitle: `${d.country_name || svc.country_name} · waiting for SMS`,
      amount: `₦${price.toLocaleString()}`,
      amount_ngn: price,
      status: 'pending',
      supplier_order: d
    });

    return res.status(200).json({
      success: true,
      message: 'Number purchased successfully',
      data: {
        order_id: d.order_id,
        number: d.number,
        status: 'waiting_for_code',
        service_name: d.service_name || svc.service_name,
        country_name: d.country_name || svc.country_name,
        price,
        time_left: d.time_left,
        new_balance: newBalance
      }
    });
  } catch (err) {
    console.error('[logsdomain-numbers order] error:', err);
    if (deducted) {
      try {
        await supabase.from('profiles').update({ balance: originalBalance }).eq('id', userId);
      } catch (e) {
        console.error('CRITICAL: auto-restore failed (logsdomain-numbers order)', e);
      }
    }
    return res.status(500).json({
      success: false,
      message: deducted ? 'Something went wrong. Your balance has been restored.' : 'Something went wrong. Please try again.'
    });
  }
}

// ===========================================================================
// CHECK — poll for the SMS code
// ===========================================================================

async function handleCheck(req, res, userId) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const orderId = body.order_id;
  if (!orderId) return res.status(400).json({ success: false, message: 'order_id is required' });

  const { data: order, error: fetchErr } = await supabase
    .from('number_orders')
    .select('*')
    .eq('source', 'logsdomain')
    .eq('order_id', String(orderId))
    .eq('user_id', userId)
    .single();

  if (fetchErr || !order) return res.status(404).json({ success: false, message: 'Order not found' });
  if (order.status === 'completed' || order.status === 'refunded') {
    return res.status(200).json({ success: true, data: order });
  }

  const checkRes = await callLogsDomain(`/numbers/orders/${encodeURIComponent(orderId)}/check`, { method: 'POST' });
  if (!checkRes.ok || !checkRes.json?.success) {
    return res.status(502).json({ success: false, message: checkRes.json?.message || 'Could not check for code right now.' });
  }

  const d = checkRes.json.data;
  const updates = {
    status: d.status,
    code: d.code || null,
    time_left: d.time_left ?? order.time_left,
    updated_at: new Date().toISOString()
  };
  await supabase.from('number_orders').update(updates).eq('id', order.id);

  if (d.status === 'completed' && d.code) {
    await supabase
      .from('transactions')
      .update({ status: 'completed', subtitle: `Code received: ${d.code}` })
      .eq('user_id', userId)
      .eq('category', 'MJ SMS - Server 2 (LogsDomain)')
      .eq('amount_ngn', order.price)
      .eq('status', 'pending');
  }

  return res.status(200).json({ success: true, data: { ...order, ...updates } });
}

// ===========================================================================
// CANCEL — cancel + refund an eligible order
// ===========================================================================

async function handleCancel(req, res, userId) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const orderId = body.order_id;
  if (!orderId) return res.status(400).json({ success: false, message: 'order_id is required' });

  const { data: order, error: fetchErr } = await supabase
    .from('number_orders')
    .select('*')
    .eq('source', 'logsdomain')
    .eq('order_id', String(orderId))
    .eq('user_id', userId)
    .single();

  if (fetchErr || !order) return res.status(404).json({ success: false, message: 'Order not found' });
  if (order.refunded || order.status === 'refunded') {
    return res.status(200).json({ success: true, message: 'Already refunded', data: order });
  }
  if (order.status === 'completed') {
    return res.status(409).json({ success: false, message: 'This number already received a code and cannot be cancelled.' });
  }

  const cancelRes = await callLogsDomain(`/numbers/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' });
  if (!cancelRes.ok || !cancelRes.json?.success) {
    return res.status(502).json({ success: false, message: cancelRes.json?.message || 'Could not cancel this order right now.' });
  }

  const refundAmount = Number(order.price || 0);
  const { data: profile } = await supabase.from('profiles').select('balance').eq('id', userId).single();
  if (profile && refundAmount > 0) {
    const restored = Number(profile.balance || 0) + refundAmount;
    await supabase.from('profiles').update({ balance: restored }).eq('id', userId);
  }

  await supabase
    .from('number_orders')
    .update({ status: 'refunded', refunded: true, updated_at: new Date().toISOString() })
    .eq('id', order.id);

  await supabase
    .from('transactions')
    .update({ status: 'cancelled', subtitle: 'No SMS — balance restored' })
    .eq('user_id', userId)
    .eq('category', 'MJ SMS - Server 2 (LogsDomain)')
    .eq('amount_ngn', refundAmount)
    .eq('status', 'pending');

  return res.status(200).json({
    success: true,
    message: 'Order cancelled and refunded',
    data: { refunded_amount: refundAmount, new_balance: profile ? Number(profile.balance || 0) + refundAmount : null }
  });
}

// ===========================================================================
// SYNC — pulls the LogsDomain numbers catalog into number_services, the
// same table GrizzlySMS uses. This is what makes Server 2 show up in the
// admin "SMS Numbers — Supplier Catalog" panel with full search/edit/delete
// parity with Server 1 — that panel already queries number_services
// generically by whatever's in it, no per-supplier UI code needed.
//
// Admin-only when called from the dashboard button (never by customers),
// plus a cron-secret bypass so Vercel's daily scheduled trigger can call
// it unattended (see the CRON_SECRET check at the top of handleSync,
// same pattern as grizzly-sync.js). Time-boxed per call and resumable
// via sync_jobs (cursor persisted between calls) so a large catalog can't
// time out a single Vercel invocation — click "Sync LogsDomain Numbers"
// again if a run finishes partial, same as it would for Grizzly.
// ===========================================================================

const SYNC_JOB_SOURCE = 'logsdomain_numbers';
const SYNC_TIME_BUDGET_MS = 250000; // leaves ~50s headroom under the 300s maxDuration set for this file in vercel.json

async function getSyncJob() {
  const { data, error } = await supabase.from('sync_jobs').select('*').eq('source', SYNC_JOB_SOURCE).maybeSingle();
  if (error) throw new Error(`sync_jobs table error: ${error.message}`);
  return data;
}

async function upsertSyncJob(fields) {
  const { error } = await supabase.from('sync_jobs').upsert({ source: SYNC_JOB_SOURCE, updated_at: new Date().toISOString(), ...fields });
  if (error) throw new Error(`sync_jobs write failed: ${error.message}`);
}

let loggedFirstSyncService = false;

async function handleSync(req, res) {
  const authHeader = req.headers.authorization || '';
  const isCronRequest = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;

  if (!isCronRequest) {
    const admin = await requireAdmin(req);
    if (!admin.ok) return res.status(admin.status).json({ success: false, message: admin.message });
  }

  if (!LOGSDOMAIN_KEY) return res.status(500).json({ success: false, message: 'LOGSDOMAIN_API_KEY not configured' });

  const startedAt = Date.now();

  // Country list is re-fetched every call rather than persisted in the job
  // row (sync_jobs has no column for it) — one cheap extra request per
  // resume, and country ordering from a supplier is stable, so cursor_index
  // still lines up correctly against a freshly-fetched list.
  const countriesRes = await callLogsDomain('/numbers/countries');
  if (!countriesRes.ok || !countriesRes.json?.success) {
    return res.status(countriesRes.status || 502).json({ success: false, message: countriesRes.json?.message || 'Could not reach LogsDomain' });
  }
  const countryList = (countriesRes.json.data || []).map(c => ({ id: Number(c.id), name: c.name }));

  let job = await getSyncJob();
  if (!job || job.status !== 'running') {
    job = { status: 'running', cursor_index: 0, new_count: 0, updated_count: 0, services_seen: 0, errors: [] };
  }

  let cursor = job.cursor_index || 0;
  let newCount = job.new_count || 0;
  let updatedCount = job.updated_count || 0;
  let servicesSeen = job.services_seen || 0;
  const errors = Array.isArray(job.errors) ? [...job.errors] : [];

  while (cursor < countryList.length && (Date.now() - startedAt) < SYNC_TIME_BUDGET_MS) {
    const country = countryList[cursor];
    let ranOutOfTime = false;
    try {
      const svcRes = await callLogsDomain(`/numbers/services?country_id=${country.id}`);
      if (!svcRes.ok || !svcRes.json?.success) {
        errors.push(`country ${country.id} (${country.name}): ${svcRes.json?.message || 'fetch failed'}`);
        cursor += 1;
        continue;
      }
      const services = svcRes.json.data || [];

      // Same lesson as the Sujan ₦0-price bug: log the raw first row once
      // so field names can be verified against what LogsDomain actually
      // sends, not just what the docs/existing code assumed.
      if (!loggedFirstSyncService && services.length) {
        console.log('[logsdomain-numbers sync] raw first service (for field-name verification):', JSON.stringify(services[0]));
        loggedFirstSyncService = true;
      }

      // Look up every existing row for this country in ONE query instead of
      // one per service — this was the real reason a single large country
      // could blow the entire time budget by itself (hundreds of services ×
      // 2 sequential round-trips each). Same batching approach as the other
      // supplier syncs use.
      const { data: existingRows, error: existErr } = await supabase
        .from('number_services')
        .select('id, service_id')
        .eq('source', 'logsdomain')
        .eq('country_id', country.id);
      if (existErr) {
        errors.push(`country ${country.id} lookup: ${existErr.message}`);
      }
      const existingMap = new Map((existingRows || []).map((r) => [String(r.service_id), r.id]));

      const toInsert = [];
      for (const s of services) {
        servicesSeen += 1;
        const serviceId = String(s.service_id ?? s.id ?? '');
        if (!serviceId) continue;
        const supplierPriceNgn = Number(s.price) || 0;
        const qty = (s.available_quantity === null || s.available_quantity === undefined) ? null : Number(s.available_quantity);

        const sharedFields = {
          country_name: country.name,
          service_name: s.service_name || serviceId,
          supplier_price: supplierPriceNgn,
          available_quantity: qty,
          // LogsDomain frequently returns null here regardless of real
          // stock (see handleOrder above) — when it's null, LogsDomain
          // listing the service at all is the only signal available, so it
          // stays visible rather than being hidden on a number we don't
          // actually have. When LogsDomain DOES return a real number,
          // that's authoritative and gates visibility normally.
          is_available: qty === null ? true : qty > 0,
          currency: 'NGN',
          updated_at: new Date().toISOString()
        };

        const existingId = existingMap.get(serviceId);
        if (existingId) {
          updatedCount += 1;
          // price is deliberately excluded from the update — a sync never
          // overwrites the selling price, same rule as every other
          // supplier catalog (Grizzly, Fadded, Logs Domain products, Sujan).
          const { error } = await supabase.from('number_services').update(sharedFields).eq('id', existingId);
          if (error) errors.push(`update ${country.id}/${serviceId}: ${error.message}`);
        } else {
          newCount += 1;
          toInsert.push({
            source: 'logsdomain',
            country_id: country.id,
            service_id: serviceId,
            price: priceForCustomer(supplierPriceNgn),
            ...sharedFields
          });
        }

        // Safety net even with batching — if a country somehow still runs
        // long (e.g. Supabase itself is slow right now), stop mid-country
        // rather than risk the whole function getting hard-killed by
        // Vercel's 300s ceiling with a 504 the browser can't parse. The
        // country cursor only advances below once every service in this
        // country has been handled, so an early exit here just means this
        // same country gets retried (cheaply, thanks to batching) next run.
        if (Date.now() - startedAt > SYNC_TIME_BUDGET_MS) {
          ranOutOfTime = true;
          break;
        }
      }

      for (let i = 0; i < toInsert.length; i += 200) {
        const batch = toInsert.slice(i, i + 200);
        const { error } = await supabase.from('number_services').insert(batch);
        if (error) errors.push(`insert batch country ${country.id}: ${error.message}`);
      }

      if (ranOutOfTime) break;
      cursor += 1;
    } catch (e) {
      errors.push(`country ${country.id} (${country.name}): ${e.message}`);
      cursor += 1;
    }
    if (ranOutOfTime) break;
  }

  const done = cursor >= countryList.length;
  await upsertSyncJob({
    status: done ? 'completed' : 'running',
    cursor_index: done ? 0 : cursor,
    total_countries: countryList.length,
    new_count: done ? 0 : newCount,
    updated_count: done ? 0 : updatedCount,
    services_seen: done ? 0 : servicesSeen,
    errors: errors.slice(-20)
  });

  return res.status(200).json({
    success: true,
    done,
    countries_seen: cursor,
    total_countries: countryList.length,
    services_seen: servicesSeen,
    new_services: newCount,
    updated_services: updatedCount,
    errors: errors.slice(-5),
    message: done ? undefined : `Partial sync — ${cursor}/${countryList.length} countries done this run. Click "Sync LogsDomain Numbers" again to continue.`
  });
}

// ===========================================================================
// ENTRYPOINT
// ===========================================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, message: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' });
  }
  if (!LOGSDOMAIN_KEY) {
    return res.status(500).json({ success: false, message: 'LOGSDOMAIN_API_KEY not configured' });
  }

  const action = req.query?.action || null;

  // sync is admin-only and checks that itself (requireAdmin, not
  // requireAuth) — handled before the general auth check below, which
  // would otherwise let any signed-in customer trigger a full catalog sync.
  if (req.method === 'GET' && action === 'sync') {
    return handleSync(req, res);
  }

  const auth = await requireAuth(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ success: false, message: auth.message });
  }

  if (req.method === 'GET') {
    if (action === 'wallet') return handleWallet(req, res);
    if (action === 'countries') return handleCountries(req, res);
    if (action === 'services') return handleServices(req, res);
    if (action === 'area-codes') return handleAreaCodes(req, res);
    if (action === 'orders') return handleOrderHistory(req, res, auth.userId);
    return res.status(400).json({
      success: false,
      message: 'GET requires ?action=wallet, countries, services, area-codes, or orders'
    });
  }

  if (req.method === 'POST') {
    if (action === 'order') return handleOrder(req, res, auth.userId);
    if (action === 'check') return handleCheck(req, res, auth.userId);
    if (action === 'cancel') return handleCancel(req, res, auth.userId);
    return res.status(400).json({
      success: false,
      message: 'POST requires ?action=order, check, or cancel'
    });
  }

  return res.status(405).json({ success: false, message: 'Method not allowed' });
}
