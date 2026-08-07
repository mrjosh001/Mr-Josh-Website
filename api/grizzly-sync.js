import { createClient } from '@supabase/supabase-js';
import { applyMarkup } from '../lib/pricing.js';

/**
 * /api/grizzly-sync — all GrizzlySMS operations, merged into one file.
 *
 * This used to be 4 separate files (grizzly-sync.js, grizzly-order.js,
 * grizzly-check.js, grizzly-cancel.js) that all duplicated the same
 * Supabase client setup, BASE url, and GRIZZLY_KEY. They're one supplier's
 * lifecycle (sync catalog → buy number → poll for code → cancel/refund), so
 * they're merged here and routed by method + ?action=, the same pattern this
 * file already used internally for sync (?action=start / ?action=status).
 *
 * Kept as this exact filename (not renamed) on purpose: vercel.json's cron
 * job and the api/grizzly-sync.js maxDuration:300 override both target this
 * path, and admin.html's sync buttons already call it — none of that needed
 * to change.
 *
 * GET  /api/grizzly-sync                  → continue/kick off catalog sync (cron + admin "Sync" button)
 * GET  /api/grizzly-sync?action=start      → start a fresh sync job
 * GET  /api/grizzly-sync?action=status     → sync job progress
 * POST /api/grizzly-sync?action=order      → buy a number (was grizzly-order.js)
 * POST /api/grizzly-sync?action=check      → poll for SMS code (was grizzly-check.js)
 * POST /api/grizzly-sync?action=cancel     → cancel + refund (was grizzly-cancel.js)
 *
 * Env: GRIZZLYSMS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET?
 * Optional: USD_TO_NGN_RATE (default 1500)
 */

const BASE = 'https://api.grizzlysms.com/stubs/handler_api.php';
const GRIZZLY_KEY = process.env.GRIZZLYSMS_API_KEY;
const JOB_SOURCE = 'grizzlysms';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ===========================================================================
// Shared across order/check/cancel
// ===========================================================================

const KNOWN_ERRORS = new Set([
  'BAD_KEY',
  'NO_BALANCE',
  'NO_NUMBERS',
  'SERVICE_UNAVAILABLE_REGION',
  'BAD_SERVICE'
]);

function humanizeGrizzlyError(code) {
  const map = {
    BAD_KEY: 'This service is temporarily unavailable. Please try again shortly.',
    NO_BALANCE:
      'This service is temporarily unavailable. Please try again later or contact support.',
    NO_NUMBERS:
      'No numbers available for this service/country right now. Try another country or service.',
    SERVICE_UNAVAILABLE_REGION:
      'This service is temporarily restricted right now. Please try another service.',
    BAD_SERVICE: 'This service is temporarily unavailable. Please try again shortly.'
  };
  return map[code] || null;
}

// ===========================================================================
// SYNC (was grizzly-sync.js) — unchanged
// ===========================================================================

// Manual: use most of the 300s function limit so fewer browser polls are needed.
const MANUAL_TIME_BUDGET_MS = 240000;
// Cron: same ballpark
const CRON_TIME_BUDGET_MS = 280000;

const UPDATE_CONCURRENCY = 20;

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

  const isAdmin =
    profile &&
    (profile.is_admin === true || profile.is_admin === 'true' || profile.is_admin === 1);
  if (!isAdmin) return { ok: false, status: 403, message: 'Admin privileges required' };
  return { ok: true };
}

async function callGrizzly(apiKey, params) {
  const qs = new URLSearchParams({ api_key: apiKey, ...params });
  const res = await fetch(`${BASE}?${qs.toString()}`, { method: 'GET' });
  const text = await res.text();
  return { status: res.status, text };
}


const GRIZZLY_SERVICE_NAMES = {
  'aaw': 'Signal',
  'aax': 'Haraj',
  'acz': 'Claude / AI',
  'am': 'Amazon',
  'bx': 'Dodo Pizza',
  'ds': 'Discord',
  'ex': 'Lanet',
  'fb': 'Facebook',
  'fd': 'PrimaGame',
  'fu': 'Snapchat',
  'go': 'Google',
  'gr_fw': 'Grizzly service fw',
  'gr_sg': 'Grizzly service sg',
  'gr_ta': 'Grizzly service ta',
  'hw': 'Alipay/Huawei',
  'ig': 'Instagram',
  'im': 'Imo',
  'kc': 'X / Twitter (alt)',
  'kt': 'KakaoTalk',
  'lc': 'Mailru Group',
  'lf': 'TikTok / Douyin',
  'ly': 'Olacabs',
  'ma': 'Mail.ru',
  'mb': 'Yahoo',
  'me': 'Line',
  'mm': 'Microsoft',
  'mo': 'Bumble',
  'nf': 'Netflix',
  'nv': 'Naver',
  'nz': 'Foodpanda',
  'oi': 'Tinder',
  'ok': 'OK.ru',
  'ot': 'Any other',
  'pm': 'AOL',
  'pr': 'Trendyol',
  'qq': 'QQ',
  'sg': 'OZON',
  'tg': 'Telegram',
  'tk': 'TikTok',
  'tl': 'Truecaller',
  'tn': 'LinkedIn',
  'ts': 'PayPal',
  'tw': 'Twitter',
  'uk': 'Airbnb',
  'uu': 'Wildberries',
  'vi': 'Viber',
  'vk': 'VK',
  'wa': 'WhatsApp',
  'wb': 'Weibo',
  'we': 'WeChat',
  'wx': 'Apple',
  'ya': 'Yandex',
  'yi': 'Yalla',
  'yy': 'Hily',
  'zr': 'Tobit',
};

/**
 * service_id (code) -> display name.
 * Prefer Grizzly docs table / static map; merge any getServices payload.
 */
async function getServiceNameMap(apiKey) {
  const map = Object.assign(Object.create(null), GRIZZLY_SERVICE_NAMES);

  try {
    const res = await callGrizzly(apiKey, { action: 'getServices' });
    if (res.text && res.text !== 'BAD_KEY') {
      let data;
      try {
        data = JSON.parse(res.text);
      } catch {
        data = null;
      }
      if (data) {
        const add = (code, name) => {
          if (!code) return;
          const c = String(code).trim();
          const n = name != null ? String(name).trim() : '';
          if (!c) return;
          // Only fill gaps or upgrade code-looking names
          if (n && n.toLowerCase() !== c.toLowerCase()) map[c] = n;
          else if (!map[c]) map[c] = c;
        };
        if (Array.isArray(data)) {
          for (const item of data) {
            if (!item || typeof item !== 'object') continue;
            add(item.code || item.service || item.id, item.name || item.title || item.eng);
          }
        } else if (typeof data === 'object') {
          for (const [key, val] of Object.entries(data)) {
            if (val == null) continue;
            if (typeof val === 'string') add(key, val);
            else if (typeof val === 'object') {
              const code = val.code || val.service || val.id || key;
              const name = val.name || val.title || val.eng || val.rus;
              add(code, name);
              if (key && !/^\d+$/.test(key)) add(key, name || code);
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn('getServices name enrich failed', e.message);
  }

  return map;
}

async function getJob() {
  const { data, error } = await supabase
    .from('sync_jobs')
    .select('*')
    .eq('source', JOB_SOURCE)
    .maybeSingle();
  if (error) {
    throw new Error(
      `sync_jobs table error: ${error.message}. Create the sync_jobs table if missing.`
    );
  }
  return data;
}

async function upsertJob(fields) {
  const { error } = await supabase.from('sync_jobs').upsert({
    source: JOB_SOURCE,
    updated_at: new Date().toISOString(),
    ...fields
  });
  if (error) {
    throw new Error(`sync_jobs write failed: ${error.message}`);
  }
}

function parseCountryList(rawText) {
  const countries = JSON.parse(rawText);
  return Array.isArray(countries)
    ? countries
    : Object.entries(countries || {}).map(([id, c]) => ({
        id,
        ...(typeof c === 'object' ? c : { name: c })
      }));
}

async function runInBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    await Promise.all(slice.map(fn));
  }
}

/**
 * Sync one country: 1 Grizzly price call + 1 existing SELECT + batched writes.
 */
async function syncOneCountry(apiKey, country, usdToNgn, counters, serviceNames) {
  const countryId = parseInt(country.id, 10);
  if (!Number.isFinite(countryId)) return;

  const countryName =
    country.eng || country.name || country.rus || `Country ${countryId}`;

  const pricesRes = await callGrizzly(apiKey, {
    action: 'getPricesV3',
    country: String(countryId)
  });

  let priceData;
  try {
    priceData = JSON.parse(pricesRes.text);
  } catch {
    counters.errors.push(`country ${countryId}: getPricesV3 not JSON`);
    return;
  }

  const countryPrices =
    priceData?.[String(countryId)] || priceData?.[countryId] || {};
  const entries = Object.entries(countryPrices);
  if (!entries.length) return;

  // One query for all existing services in this country
  const { data: existingRows, error: existErr } = await supabase
    .from('number_services')
    .select('id, service_id')
    .eq('source', 'grizzlysms')
    .eq('country_id', countryId);

  if (existErr) {
    counters.errors.push(`country ${countryId} select: ${existErr.message}`);
    return;
  }

  const existingMap = new Map(
    (existingRows || []).map((r) => [String(r.service_id), r.id])
  );

  const toInsert = [];
  const toUpdate = [];
  const now = new Date().toISOString();

  for (const [serviceCode, info] of entries) {
    if (!serviceCode) continue;
    counters.servicesSeen += 1;

    const supplierPriceUsd = Number(info?.price ?? 0);
    const availableQty = Number(info?.count ?? 0);
    const providersRaw =
      info?.providers && typeof info.providers === 'object' ? info.providers : null;

    const friendlyName =
      (serviceNames && (serviceNames[serviceCode] || serviceNames[String(serviceCode).toLowerCase()])) ||
      serviceCode;

    const existingId = existingMap.get(String(serviceCode));
    if (existingId) {
      counters.updatedCount += 1;
      toUpdate.push({
        id: existingId,
        country_name: countryName,
        service_name: friendlyName,
        supplier_price: supplierPriceUsd,
        available_quantity: availableQty,
        providers_raw: providersRaw,
        is_available: availableQty > 0,
        updated_at: now
      });
    } else {
      counters.newCount += 1;
      toInsert.push({
        source: 'grizzlysms',
        country_id: countryId,
        country_name: countryName,
        service_id: serviceCode,
        service_name: friendlyName,
        supplier_price: supplierPriceUsd,
        price: applyMarkup(supplierPriceUsd, usdToNgn),
        price_source: 'system',
        currency: 'NGN',
        available_quantity: availableQty,
        providers_raw: providersRaw,
        is_available: availableQty > 0,
        updated_at: now
      });
    }
  }

  // Parallel updates (does NOT touch customer selling price)
  await runInBatches(toUpdate, UPDATE_CONCURRENCY, async (row) => {
    const { id, ...fields } = row;
    const { error } = await supabase
      .from('number_services')
      .update(fields)
      .eq('id', id);
    if (error) counters.errors.push(`update ${id}: ${error.message}`);
  });

  // Multi-row inserts in batches of 100
  for (let i = 0; i < toInsert.length; i += 100) {
    const batch = toInsert.slice(i, i + 100);
    const { error } = await supabase.from('number_services').insert(batch);
    if (error) counters.errors.push(`insert batch country ${countryId}: ${error.message}`);
  }
}

async function handleSync(req, res) {
  if (!process.env.GRIZZLYSMS_API_KEY) {
    return res.status(500).json({ success: false, message: 'Missing GRIZZLYSMS_API_KEY' });
  }

  const authHeader = req.headers.authorization || '';
  const isCronRequest =
    !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;

  if (!isCronRequest) {
    const admin = await requireAdmin(req);
    if (!admin.ok) {
      return res.status(admin.status).json({ success: false, message: admin.message });
    }
  }

  const apiKey = process.env.GRIZZLYSMS_API_KEY;
  const usdToNgn = Number(process.env.USD_TO_NGN_RATE) || 1500;
  const action = req.query?.action || null;

  try {
    if (action === 'status') {
      const job = await getJob();
      return res.status(200).json({
        success: true,
        job: job || { source: JOB_SOURCE, status: 'idle' }
      });
    }

    if (action === 'start') {
      const countriesRes = await callGrizzly(apiKey, { action: 'getCountries' });
      if (countriesRes.text === 'BAD_KEY') {
        return res
          .status(401)
          .json({ success: false, message: 'GrizzlySMS rejected the API key (BAD_KEY)' });
      }
      let countryList;
      try {
        countryList = parseCountryList(countriesRes.text);
      } catch {
        return res.status(502).json({
          success: false,
          message: 'getCountries did not return JSON',
          raw: countriesRes.text.slice(0, 500)
        });
      }

      await upsertJob({
        status: 'running',
        cursor_index: 0,
        total_countries: countryList.length,
        new_count: 0,
        updated_count: 0,
        services_seen: 0,
        errors: [],
        started_at: new Date().toISOString()
      });

      return res.status(200).json({
        success: true,
        started: true,
        total_countries: countryList.length,
        message: `Sync started — ${countryList.length} countries. Keep dashboard open or let cron finish it.`
      });
    }

    let job = await getJob();

    // Cron auto-starts if idle
    if (isCronRequest && (!job || job.status !== 'running')) {
      const startCountriesRes = await callGrizzly(apiKey, { action: 'getCountries' });
      if (startCountriesRes.text === 'BAD_KEY') {
        return res
          .status(401)
          .json({ success: false, message: 'GrizzlySMS rejected the API key (BAD_KEY)' });
      }
      let startCountryList;
      try {
        startCountryList = parseCountryList(startCountriesRes.text);
      } catch {
        return res.status(502).json({
          success: false,
          message: 'getCountries did not return JSON',
          raw: startCountriesRes.text.slice(0, 500)
        });
      }
      await upsertJob({
        status: 'running',
        cursor_index: 0,
        total_countries: startCountryList.length,
        new_count: 0,
        updated_count: 0,
        services_seen: 0,
        errors: [],
        started_at: new Date().toISOString()
      });
      job = await getJob();
    }

    if (!job || job.status !== 'running') {
      return res.status(200).json({
        success: true,
        done: true,
        idle: true,
        message: 'No sync is currently running. Call ?action=start to begin one.'
      });
    }

    const countriesRes = await callGrizzly(apiKey, { action: 'getCountries' });
    let countryList;
    try {
      countryList = parseCountryList(countriesRes.text);
    } catch {
      await upsertJob({
        status: 'failed',
        errors: [...(job.errors || []), 'getCountries failed mid-sync']
      });
      return res
        .status(502)
        .json({ success: false, message: 'getCountries did not return JSON mid-sync' });
    }

    const TIME_BUDGET_MS = isCronRequest ? CRON_TIME_BUDGET_MS : MANUAL_TIME_BUDGET_MS;
    const startedAt = Date.now();
    let cursor = job.cursor_index || 0;

    const counters = {
      newCount: job.new_count || 0,
      updatedCount: job.updated_count || 0,
      servicesSeen: job.services_seen || 0,
      errors: Array.isArray(job.errors) ? [...job.errors] : []
    };

    // One getServices call per chunk — maps aaw/wa/… → readable names
    const serviceNames = await getServiceNameMap(apiKey);

    while (cursor < countryList.length && Date.now() - startedAt < TIME_BUDGET_MS) {
      const country = countryList[cursor];
      cursor += 1;
      await syncOneCountry(apiKey, country, usdToNgn, counters, serviceNames);
    }

    const done = cursor >= countryList.length;
    await upsertJob({
      status: done ? 'completed' : 'running',
      cursor_index: cursor,
      total_countries: countryList.length,
      new_count: counters.newCount,
      updated_count: counters.updatedCount,
      services_seen: counters.servicesSeen,
      errors: counters.errors.slice(-30)
    });

    return res.status(200).json({
      success: true,
      done,
      cursor_index: cursor,
      total_countries: countryList.length,
      new_services: counters.newCount,
      updated_services: counters.updatedCount,
      services_seen: counters.servicesSeen,
      errors: counters.errors.slice(-20)
    });
  } catch (err) {
    console.error('grizzly-sync error:', err);
    await upsertJob({ status: 'failed', errors: [String(err.message || err)] }).catch(
      () => {}
    );
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Internal server error' });
  }
}

// ===========================================================================
// ORDER (was grizzly-order.js) — unchanged
// ===========================================================================

async function handleOrder(req, res) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { country_id, service_id, external_order_id, user_id } = body;

  const countryId = parseInt(country_id, 10);
  const serviceId = service_id != null ? String(service_id) : null;

  if (!Number.isFinite(countryId) || !serviceId || !user_id) {
    return res.status(400).json({
      success: false,
      message: 'country_id, service_id and user_id are required'
    });
  }
  if (!GRIZZLY_KEY) {
    return res.status(500).json({ success: false, message: 'GRIZZLYSMS_API_KEY not configured' });
  }

  let originalBalance = 0;
  let price = 0;
  let serviceName = '';
  let countryName = '';
  let customerId = null;
  let deducted = false;

  try {
    const { data: svc, error: svcErr } = await supabase
      .from('number_services')
      .select('service_name, country_name, price, supplier_price, is_available')
      .eq('source', 'grizzlysms')
      .eq('country_id', countryId)
      .eq('service_id', serviceId)
      .single();

    if (svcErr || !svc) {
      return res.status(404).json({
        success: false,
        message: 'This service is no longer available. Please refresh and try another.'
      });
    }
    if (!svc.is_available) {
      return res.status(409).json({
        success: false,
        message: 'This number service is currently out of stock.'
      });
    }

    price = Number(svc.price) || 0;
    const supplierPriceUsd = Number(svc.supplier_price) || null;
    serviceName = svc.service_name;
    countryName = svc.country_name;

    const { data: profile, error: profErr } = await supabase
      .from('profiles')
      .select('balance, customer_id')
      .eq('id', user_id)
      .single();

    if (profErr || !profile) {
      return res.status(400).json({ success: false, message: 'User profile not found' });
    }
    originalBalance = Number(profile.balance || 0);
    customerId = profile.customer_id;

    if (originalBalance < price) {
      return res.status(402).json({
        success: false,
        message: 'Insufficient balance',
        required: price,
        available: originalBalance
      });
    }

    const newBalance = originalBalance - price;
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

    const idempotencyKey =
      external_order_id || `MJ-GZ-${String(user_id).slice(0, 8)}-${Date.now()}`;
    const qs = new URLSearchParams({
      api_key: GRIZZLY_KEY,
      action: 'getNumberV2',
      service: serviceId,
      country: String(countryId)
    });

    const supplierRes = await fetch(`${BASE}?${qs.toString()}`, { method: 'GET' });
    const rawText = await supplierRes.text();

    let orderData = null;
    let failureReason = null;
    if (KNOWN_ERRORS.has(rawText.trim())) {
      failureReason = rawText.trim();
    } else {
      try {
        orderData = JSON.parse(rawText);
      } catch {
        failureReason = `Unrecognized response: ${rawText.slice(0, 200)}`;
      }
    }

    // Supplier failed → restore balance only (no refund transaction row)
    if (!supplierRes.ok || failureReason || !orderData?.activationId) {
      await supabase.from('profiles').update({ balance: originalBalance }).eq('id', user_id);

      // Optional single failed purchase marker (not a refund row)
      try {
        await supabase.from('transactions').insert({
          user_id,
          customer_id: customerId,
          type: 'purchase',
          category: 'MJ SMS',
          title: serviceName,
          subtitle: `Failed: ${humanizeGrizzlyError(failureReason) || 'Unavailable'}`,
          amount: `₦${price.toLocaleString()}`,
          amount_ngn: price,
          status: 'failed',
          notes: rawText.slice(0, 500)
        });
      } catch (_) {}

      return res.status(400).json({
        success: false,
        code: failureReason || 'SUPPLIER_ERROR',
        message:
          humanizeGrizzlyError(failureReason) ||
          'Purchase failed. Your balance has been restored.'
      });
    }

    const numberOrderRow = {
      source: 'grizzlysms',
      user_id,
      customer_id: customerId,
      order_id: String(orderData.activationId),
      idempotency_key: idempotencyKey,
      country_id: countryId,
      country_name: countryName,
      service_id: serviceId,
      service_name: serviceName,
      phone_number: orderData.phoneNumber || null,
      price,
      supplier_price: supplierPriceUsd,
      currency: 'NGN',
      status: 'waiting_for_code',
      code: null,
      time_left: null,
      refunded: false
    };

    let { error: insertErr } = await supabase.from('number_orders').insert(numberOrderRow);
    if (insertErr) {
      // One retry — this is the row every SMS stat on the admin dashboard
      // is counted from, and the customer has already been charged and
      // already has a working number at this point, so it's worth a
      // second attempt before giving up rather than silently dropping it.
      await new Promise(r => setTimeout(r, 400));
      ({ error: insertErr } = await supabase.from('number_orders').insert(numberOrderRow));
    }

    if (insertErr) {
      console.error(
        '[grizzly order] FAILED to save number_orders row after retry — customer charged and number reserved:',
        insertErr.message,
        {
          activationId: orderData.activationId,
          user_id,
          country_id: countryId,
          service_id: serviceId
        }
      );
    }

    // Pending until code arrives — history should not show "completed" early
    await supabase.from('transactions').insert({
      user_id,
      customer_id: customerId,
      type: 'purchase',
      category: 'MJ SMS',
      title: serviceName,
      subtitle: `${countryName} · waiting for SMS`,
      amount: `₦${price.toLocaleString()}`,
      amount_ngn: price,
      status: 'pending',
      supplier_order: orderData
    });

    return res.status(200).json({
      success: true,
      message: 'Number purchased successfully',
      data: {
        order_id: orderData.activationId,
        number: orderData.phoneNumber,
        status: 'waiting_for_code',
        service_name: serviceName,
        country_name: countryName,
        price,
        new_balance: newBalance,
        created_at: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error('grizzly order error:', err);

    if (deducted) {
      try {
        await supabase.from('profiles').update({ balance: originalBalance }).eq('id', user_id);
        // no refund transaction row
      } catch (refundErr) {
        console.error('CRITICAL: Auto-restore failed (grizzly order)', refundErr);
      }
    }

    return res.status(500).json({
      success: false,
      message: deducted
        ? 'Something went wrong. Your balance has been restored.'
        : 'Something went wrong. Please try again.'
    });
  }
}

// ===========================================================================
// CHECK (was grizzly-check.js) — unchanged
// ===========================================================================

const EXPIRY_MS = 20 * 60 * 1000;

async function refundOrderSilently(order, userId) {
  if (!order || order.refunded || order.status === 'refunded' || order.status === 'completed') {
    return { refunded: false, reason: 'already_final' };
  }

  const refundAmount = Number(order.price || 0);
  const { data: profile } = await supabase
    .from('profiles')
    .select('balance')
    .eq('id', userId)
    .single();

  if (profile && refundAmount > 0) {
    const restored = Number(profile.balance || 0) + refundAmount;
    await supabase.from('profiles').update({ balance: restored }).eq('id', userId);
  }

  await supabase
    .from('number_orders')
    .update({
      status: 'refunded',
      refunded: true,
      updated_at: new Date().toISOString()
    })
    .eq('id', order.id);

  // Mark original purchase cancelled — no separate refund transaction
  try {
    await supabase
      .from('transactions')
      .update({
        status: 'cancelled',
        subtitle: 'No SMS — balance restored'
      })
      .eq('user_id', userId)
      .eq('category', 'MJ SMS')
      .eq('type', 'purchase')
      .in('status', ['pending', 'completed'])
      .eq('amount_ngn', refundAmount);
  } catch (e) {
    console.warn('tx update on silent refund', e.message || e);
  }

  return {
    refunded: true,
    refunded_amount: refundAmount,
    new_balance: profile ? Number(profile.balance || 0) + refundAmount : null
  };
}

async function handleCheck(req, res) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { order_id, user_id } = body;

  if (!order_id || !user_id) {
    return res.status(400).json({ success: false, message: 'order_id and user_id are required' });
  }
  if (!GRIZZLY_KEY) {
    return res.status(500).json({ success: false, message: 'GRIZZLYSMS_API_KEY not configured' });
  }

  try {
    const { data: existing, error: findErr } = await supabase
      .from('number_orders')
      .select(
        'id, status, phone_number, created_at, service_name, country_name, price, order_id, refunded, customer_id'
      )
      .eq('source', 'grizzlysms')
      .eq('order_id', String(order_id))
      .eq('user_id', user_id)
      .single();

    if (findErr || !existing) {
      return res.status(404).json({ success: false, message: 'Order not found for this account' });
    }

    if (existing.status === 'completed' || existing.status === 'refunded' || existing.refunded) {
      const { data: current } = await supabase
        .from('number_orders')
        .select('*')
        .eq('id', existing.id)
        .single();
      return res.status(200).json({ success: true, data: current });
    }

    const qs = new URLSearchParams({
      api_key: GRIZZLY_KEY,
      action: 'getStatusV2',
      id: String(order_id)
    });
    const supplierRes = await fetch(`${BASE}?${qs.toString()}`, { method: 'GET' });
    const raw = (await supplierRes.text()).trim();

    let newStatus = existing.status;
    let code = null;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* text */
    }

    if (parsed && parsed.sms && parsed.sms.code) {
      newStatus = 'completed';
      code = parsed.sms.code;
    } else if (parsed) {
      newStatus = 'waiting_for_code';
    } else if (raw === 'STATUS_WAIT_CODE' || raw === 'STATUS_WAIT_RESEND') {
      newStatus = 'waiting_for_code';
    } else if (raw.startsWith('STATUS_WAIT_RETRY')) {
      newStatus = 'waiting_for_code';
      code = raw.split(':')[1] || null;
    } else if (raw === 'STATUS_CANCEL') {
      newStatus = 'refunded';
    } else if (raw.startsWith('STATUS_OK')) {
      newStatus = 'completed';
      code = raw.split(':')[1] || null;
    } else if (raw === 'NO_ACTIVATION') {
      // Treat as expired/gone → refund if still open
      newStatus = 'refunded';
    } else if (raw === 'BAD_ACTION') {
      const v1Qs = new URLSearchParams({
        api_key: GRIZZLY_KEY,
        action: 'getStatus',
        id: String(order_id)
      });
      const v1Res = await fetch(`${BASE}?${v1Qs.toString()}`, { method: 'GET' });
      const v1Raw = (await v1Res.text()).trim();
      if (v1Raw === 'STATUS_WAIT_CODE' || v1Raw === 'STATUS_WAIT_RESEND') {
        newStatus = 'waiting_for_code';
      } else if (v1Raw.startsWith('STATUS_WAIT_RETRY')) {
        newStatus = 'waiting_for_code';
        code = v1Raw.split(':')[1] || null;
      } else if (v1Raw === 'STATUS_CANCEL') {
        newStatus = 'refunded';
      } else if (v1Raw.startsWith('STATUS_OK')) {
        newStatus = 'completed';
        code = v1Raw.split(':')[1] || null;
      } else {
        console.error('[grizzly check] v1 unrecognized:', v1Raw, { order_id });
        return res.status(502).json({
          success: false,
          message: 'Unrecognized response from supplier',
          raw: v1Raw
        });
      }
    } else {
      // Local expiry fallback: if past 20 min and still waiting, refund
      const age = existing.created_at
        ? Date.now() - new Date(existing.created_at).getTime()
        : 0;
      if (age >= EXPIRY_MS) {
        newStatus = 'refunded';
      } else {
        console.error('[grizzly check] unrecognized:', raw, { order_id });
        return res.status(502).json({
          success: false,
          message: 'Unrecognized response from supplier',
          raw
        });
      }
    }

    // Also force expiry if still waiting past window even when supplier says wait
    if (newStatus === 'waiting_for_code' && existing.created_at) {
      const age = Date.now() - new Date(existing.created_at).getTime();
      if (age >= EXPIRY_MS) {
        // Try supplier cancel then silent refund
        try {
          const cancelQs = new URLSearchParams({
            api_key: GRIZZLY_KEY,
            action: 'setStatus',
            id: String(order_id),
            status: '8'
          });
          await fetch(`${BASE}?${cancelQs.toString()}`, { method: 'GET' });
        } catch (_) {}
        newStatus = 'refunded';
      }
    }

    if (newStatus === 'refunded') {
      const result = await refundOrderSilently(existing, user_id);
      return res.status(200).json({
        success: true,
        data: {
          order_id,
          status: 'refunded',
          number: existing.phone_number,
          code: null,
          created_at: existing.created_at,
          service_name: existing.service_name,
          country_name: existing.country_name,
          price: existing.price,
          refunded: true,
          refunded_amount: result.refunded_amount,
          new_balance: result.new_balance,
          raw
        }
      });
    }

    const { error: updateErr } = await supabase
      .from('number_orders')
      .update({
        status: newStatus,
        code,
        refunded: false,
        updated_at: new Date().toISOString()
      })
      .eq('id', existing.id);

    if (updateErr) {
      console.error('[grizzly check] update failed:', updateErr.message, { order_id });
    }

    // Code received → lock as completed on purchase transaction
    if (newStatus === 'completed' && code) {
      try {
        await supabase
          .from('transactions')
          .update({
            status: 'completed',
            subtitle: `${existing.country_name || ''} · code received`.trim()
          })
          .eq('user_id', user_id)
          .eq('category', 'MJ SMS')
          .eq('type', 'purchase')
          .eq('status', 'pending')
          .eq('amount_ngn', Number(existing.price || 0));
      } catch (e) {
        console.warn('tx complete update', e.message || e);
      }

      // Tell supplier activation finished (status 6) when supported
      try {
        const doneQs = new URLSearchParams({
          api_key: GRIZZLY_KEY,
          action: 'setStatus',
          id: String(order_id),
          status: '6'
        });
        await fetch(`${BASE}?${doneQs.toString()}`, { method: 'GET' });
      } catch (_) {}
    }

    return res.status(200).json({
      success: true,
      data: {
        order_id,
        status: newStatus,
        number: existing.phone_number,
        code,
        created_at: existing.created_at,
        service_name: existing.service_name,
        country_name: existing.country_name,
        price: existing.price,
        refunded: false,
        raw
      }
    });
  } catch (err) {
    console.error('grizzly check error:', err);
    return res.status(500).json({
      success: false,
      message: 'Something went wrong checking this order.'
    });
  }
}

// ===========================================================================
// CANCEL (was grizzly-cancel.js) — unchanged
// ===========================================================================

const CANCEL_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes before cancel is allowed

async function handleCancel(req, res) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { order_id, user_id } = body;

  if (!order_id || !user_id) {
    return res.status(400).json({ success: false, message: 'order_id and user_id are required' });
  }
  if (!GRIZZLY_KEY) {
    return res.status(500).json({ success: false, message: 'GRIZZLYSMS_API_KEY not configured' });
  }

  try {
    const { data: order, error: findErr } = await supabase
      .from('number_orders')
      .select('id, customer_id, price, status, refunded, service_name, created_at, order_id')
      .eq('source', 'grizzlysms')
      .eq('order_id', String(order_id))
      .eq('user_id', user_id)
      .single();

    if (findErr || !order) {
      return res.status(404).json({ success: false, message: 'Order not found for this account' });
    }
    if (order.refunded || order.status === 'refunded' || order.status === 'cancelled') {
      return res.status(409).json({ success: false, message: 'This order was already refunded.' });
    }
    if (order.status === 'completed') {
      return res.status(409).json({
        success: false,
        code: 'NUMBER_CODE_ALREADY_RECEIVED',
        message: 'A code was already received — this order cannot be cancelled.'
      });
    }

    // Soft server-side cooldown (supplier also enforces EARLY_CANCEL_DENIED)
    if (order.created_at) {
      const age = Date.now() - new Date(order.created_at).getTime();
      if (age < CANCEL_COOLDOWN_MS) {
        const waitSec = Math.ceil((CANCEL_COOLDOWN_MS - age) / 1000);
        return res.status(400).json({
          success: false,
          code: 'EARLY_CANCEL_DENIED',
          wait_seconds: waitSec,
          message: `Cancel available in ${waitSec}s. Please wait a moment.`
        });
      }
    }

    const qs = new URLSearchParams({
      api_key: GRIZZLY_KEY,
      action: 'setStatus',
      id: String(order_id),
      status: '8'
    });
    const supplierRes = await fetch(`${BASE}?${qs.toString()}`, { method: 'GET' });
    const raw = (await supplierRes.text()).trim();

    if (raw === 'EARLY_CANCEL_DENIED') {
      return res.status(400).json({
        success: false,
        code: 'EARLY_CANCEL_DENIED',
        wait_seconds: 300,
        message: 'Cancel is not available yet. Please wait until the countdown finishes (5 minutes from purchase).'
      });
    }

    if (raw !== 'ACCESS_CANCEL') {
      // If supplier already cancelled / expired, still try to refund locally if not refunded
      if (raw === 'NO_ACTIVATION' || raw === 'BAD_STATUS') {
        // fall through only if we can still mark refunded — treat as cancelable on our side
        // Prefer not to refund blindly on NO_ACTIVATION without knowing if they already got value
      }
      return res.status(400).json({
        success: false,
        code: raw,
        message:
          raw === 'NO_ACTIVATION'
            ? 'Supplier has no record of this order.'
            : `Could not cancel this order (${raw}).`
      });
    }

    // Confirmed cancel → credit wallet (no refund transaction row)
    const refundAmount = Number(order.price || 0);
    const { data: profile } = await supabase
      .from('profiles')
      .select('balance')
      .eq('id', user_id)
      .single();

    if (profile) {
      const restored = Number(profile.balance || 0) + refundAmount;
      await supabase.from('profiles').update({ balance: restored }).eq('id', user_id);
    }

    await supabase
      .from('number_orders')
      .update({
        status: 'refunded',
        refunded: true,
        updated_at: new Date().toISOString()
      })
      .eq('id', order.id);

    // Flip original purchase tx to cancelled — do NOT insert a separate refund row
    try {
      await supabase
        .from('transactions')
        .update({
          status: 'cancelled',
          subtitle: 'Cancelled — balance restored',
          notes: 'SMS number cancelled; wallet credited without separate refund row'
        })
        .eq('user_id', user_id)
        .eq('category', 'MJ SMS')
        .eq('type', 'purchase')
        .eq('status', 'pending')
        .ilike('title', order.service_name || '%');
    } catch (e) {
      console.warn('tx status update skipped', e.message || e);
    }

    // Broader match: any pending MJ SMS purchase for this user around this order price
    try {
      await supabase
        .from('transactions')
        .update({ status: 'cancelled', subtitle: 'Cancelled — balance restored' })
        .eq('user_id', user_id)
        .eq('category', 'MJ SMS')
        .eq('type', 'purchase')
        .eq('status', 'pending')
        .eq('amount_ngn', refundAmount);
    } catch (_) {}

    return res.status(200).json({
      success: true,
      data: {
        order_id,
        status: 'refunded',
        refunded: true,
        refunded_amount: refundAmount,
        new_balance: profile ? Number(profile.balance || 0) + refundAmount : null
      }
    });
  } catch (err) {
    console.error('grizzly cancel error:', err);
    return res.status(500).json({
      success: false,
      message: 'Something went wrong cancelling this order.'
    });
  }
}

// ===========================================================================
// DISPATCHER
// ===========================================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res
      .status(500)
      .json({ success: false, message: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' });
  }

  const action = req.query?.action || null;

  if (req.method === 'GET') {
    // action is one of: null (continue/cron), 'start', 'status' — all handled inside handleSync
    return handleSync(req, res);
  }

  if (req.method === 'POST') {
    if (action === 'order') return handleOrder(req, res);
    if (action === 'check') return handleCheck(req, res);
    if (action === 'cancel') return handleCancel(req, res);
    return res.status(400).json({
      success: false,
      message: "POST requires ?action=order, ?action=check, or ?action=cancel"
    });
  }

  return res.status(405).json({ success: false, message: 'Method not allowed' });
}
