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
 * GET  /api/grizzly-sync?action=vsms_sync  → Server 3 (VirtualSMS) catalog sync (admin)
 * POST /api/grizzly-sync?action=order      → buy a number (was grizzly-order.js)
 * POST /api/grizzly-sync?action=check      → poll for SMS code (was grizzly-check.js)
 * POST /api/grizzly-sync?action=cancel     → cancel + refund (was grizzly-cancel.js)
 *
 * Env: GRIZZLYSMS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET?
 * Optional: USD_TO_NGN_RATE (default 1500), VIRTUALSMS_API_KEY (Server 3)
 */

/* MJHUB_SERVER3_VIRTUALSMS=2 2026-10-18 Server 3 sync fixed: supplier_price NOT NULL, tolerant parser, per-country pricing, sold-out delisting */
const BASE = 'https://api.grizzlysms.com/stubs/handler_api.php';
const VSMS_BASE = 'https://virtualsms.io/stubs/handler_api.php';


/** Deterministic customer NGN price from supplier USD (no random) — used for provider pools */
function salePriceFromUsd(supplierPriceUsd) {
  const rate =
    Number(process.env.USD_TO_NGN_RATE) ||
    Number(process.env.USD_TO_NGN) ||
    1500;
  const percent = 80; // mid-band of 60–100 markup
  const minProfit = Number(process.env.MIN_PROFIT_NGN) || 500;
  const minSale = Number(process.env.MIN_NUMBER_PRICE_NGN) || 1000;
  const supplierNgn = Number(supplierPriceUsd) * rate;
  if (!Number.isFinite(supplierNgn) || supplierNgn <= 0) return minSale;
  const percentPrice = Math.ceil(supplierNgn * (1 + percent / 100));
  const floorPrice = Math.ceil(supplierNgn + minProfit);
  const finalPrice = Math.max(percentPrice, floorPrice, minSale);
  return Math.ceil(finalPrice / 50) * 50;
}

function lowestProviderUsd(providersObj) {
  if (!providersObj || typeof providersObj !== 'object') return null;
  let min = null;
  for (const p of Object.values(providersObj)) {
    const arr = Array.isArray(p?.price) ? p.price : [p?.price];
    for (const x of arr) {
      const n = Number(x);
      if (Number.isFinite(n) && n > 0 && (min == null || n < min)) min = n;
    }
  }
  return min;
}

const GRIZZLY_KEY = process.env.GRIZZLYSMS_API_KEY;
const VIRTUALSMS_KEY = process.env.VIRTUALSMS_API_KEY || process.env.VIRTUAL_SMS_API_KEY || '';
const JOB_SOURCE = 'grizzlysms';

/** Server 1 = grizzlysms, Server 3 = virtualsms (same sms-activate legacy protocol) */
const SUPPLIERS = {
  grizzlysms: { base: BASE, key: () => GRIZZLY_KEY, source: 'grizzlysms', label: 'Server 1' },
  virtualsms: { base: VSMS_BASE, key: () => VIRTUALSMS_KEY, source: 'virtualsms', label: 'Server 3' }
};

function resolveSupplier(req, body) {
  const q = (req && req.query) || {};
  const b = body || {};
  const raw = String(
    b.provider || b.source || b.server || q.provider || q.source || q.server || ''
  ).toLowerCase().trim();
  if (raw === 'virtualsms' || raw === 'vsms' || raw === 'virtual' || raw === '3' || raw === 's3' || raw === 'server3' || raw === 'server_3') {
    return SUPPLIERS.virtualsms;
  }
  return SUPPLIERS.grizzlysms;
}

/**
 * Call a supplier on the legacy sms-activate protocol.
 * timeoutMs is optional (0 = no timeout, the original behaviour for order/check/cancel).
 * The Server 3 catalog sync passes a timeout so one slow reply can never hang the whole sync.
 */
async function callSupplier(sup, params, timeoutMs) {
  const key = typeof sup.key === 'function' ? sup.key() : sup.key;
  if (!key) {
    const err = new Error('missing_api_key');
    err.code = 'missing_api_key';
    throw err;
  }
  const qs = new URLSearchParams({ api_key: key, ...params });
  const opts = { method: 'GET' };
  if (timeoutMs && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    opts.signal = AbortSignal.timeout(timeoutMs);
  }
  const res = await fetch(`${sup.base}?${qs.toString()}`, opts);
  const text = await res.text();
  return { ok: res.ok, status: res.status, text: String(text || '').trim() };
}


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
  // Incremental: only INSERT brand-new service_ids and UPDATE rows whose
  // stock / supplier cost / name actually changed (GotSMS-style — never wipe + rewrite).
  const { data: existingRows, error: existErr } = await supabase
    .from('number_services')
    .select('id, service_id, supplier_price, available_quantity, service_name, is_available, country_name')
    .eq('source', 'grizzlysms')
    .eq('country_id', countryId);

  if (existErr) {
    counters.errors.push(`country ${countryId} select: ${existErr.message}`);
    return;
  }

  const existingMap = new Map(
    (existingRows || []).map((r) => [String(r.service_id), r])
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

    const prev = existingMap.get(String(serviceCode));
    if (prev) {
      // Admin hid this row — keep hidden even if supplier has stock again
      const nextAvail = prev.is_available === false ? false : availableQty > 0;
      const sameCost = Number(prev.supplier_price || 0) === supplierPriceUsd;
      const sameQty = Number(prev.available_quantity || 0) === availableQty;
      const sameName = String(prev.service_name || '') === String(friendlyName);
      const sameCountry = String(prev.country_name || '') === String(countryName);
      const sameAvail = !!prev.is_available === !!nextAvail;
      if (sameCost && sameQty && sameName && sameCountry && sameAvail) {
        continue; // nothing changed — skip write
      }
      counters.updatedCount += 1;
      toUpdate.push({
        id: prev.id,
        country_name: countryName,
        service_name: friendlyName,
        supplier_price: supplierPriceUsd,
        available_quantity: availableQty,
        providers_raw: providersRaw,
        is_available: nextAvail,
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
    return res.status(500).json({ success: false, message: 'This SMS server is not available right now. Please contact support.' });
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
          .json({ success: false, message: 'This SMS server is not available right now. Please contact support.' });
      }
      let countryList;
      try {
        countryList = parseCountryList(countriesRes.text);
      } catch {
        return res.status(502).json({
          success: false,
          message: 'Could not load countries. Try again or contact support.',
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
          .json({ success: false, message: 'This SMS server is not available right now. Please contact support.' });
      }
      let startCountryList;
      try {
        startCountryList = parseCountryList(startCountriesRes.text);
      } catch {
        return res.status(502).json({
          success: false,
          message: 'Could not load countries. Try again or contact support.',
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
        .json({ success: false, message: 'Could not load countries. Try again or contact support.' });
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
      .json({ success: false, message: 'Something went wrong. Try again or contact support.' });
  }
}

// ===========================================================================
// ORDER (was grizzly-order.js) — unchanged
// ===========================================================================

async function handleOrder(req, res) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { country_id, service_id, external_order_id, user_id, provider_id } = body;
  const sup = resolveSupplier(req, body);
  const SOURCE = sup.source;
  const SUP_KEY = typeof sup.key === 'function' ? sup.key() : sup.key;

  const countryId = parseInt(country_id, 10);
  const serviceId = service_id != null ? String(service_id) : null;
  const providerId = provider_id != null && String(provider_id).trim() !== ''
    ? String(provider_id).trim()
    : null;

  if (!Number.isFinite(countryId) || !serviceId || !user_id) {
    return res.status(400).json({
      success: false,
      message: 'country_id, service_id and user_id are required'
    });
  }
  if (!SUP_KEY) {
    return res.status(500).json({ success: false, message: 'This SMS server is not available right now. Please contact support.' });
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
      .select('service_name, country_name, price, supplier_price, is_available, providers_raw, pool_price_overrides')
      .eq('source', SOURCE)
      .eq('country_id', countryId)
      .eq('service_id', serviceId)
      .single();

    if (svcErr || !svc) {
      return res.status(404).json({
        success: false,
        message: 'This service is no longer available. Refresh, try another, or contact support.'
      });
    }
    if (!svc.is_available) {
      return res.status(409).json({
        success: false,
        message: 'This number service is currently out of stock.'
      });
    }

    serviceName = svc.service_name;
    countryName = svc.country_name;

    // Provider pool (getPricesV3): charge the selected tier, not a forged client price
    let supplierPriceUsd = Number(svc.supplier_price) || null;
    let resolvedProviderId = providerId;
    price = Number(svc.price) || 0;

    if (providerId && svc.providers_raw && typeof svc.providers_raw === 'object') {
      const pInfo = svc.providers_raw[providerId] || svc.providers_raw[String(providerId)];
      if (!pInfo) {
        return res.status(400).json({
          success: false,
          message: 'That number pool is no longer available. Pick another option.'
        });
      }
      const priceArr = Array.isArray(pInfo.price) ? pInfo.price : [pInfo.price];
      const nums = priceArr.map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (!nums.length) {
        return res.status(409).json({ success: false, message: 'This pool has no valid price right now.' });
      }
      supplierPriceUsd = Math.min(...nums);
      resolvedProviderId = String(pInfo.provider_id != null ? pInfo.provider_id : providerId);

      // Admin's custom price for this exact pool wins over the fixed-formula
      // price whenever one has been set — this is what actually makes
      // "edit this pool's price" mean something at checkout, not just on
      // the storefront display.
      const overrides = svc.pool_price_overrides && typeof svc.pool_price_overrides === 'object'
        ? svc.pool_price_overrides
        : {};
      const overridden = Number(overrides[resolvedProviderId] ?? overrides[providerId]);
      price = Number.isFinite(overridden) && overridden > 0
        ? overridden
        : salePriceFromUsd(supplierPriceUsd);
    } else if (providerId && !svc.providers_raw) {
      // Client asked for a pool but we have no provider map — fall back to catalog price
      resolvedProviderId = providerId;
    }

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

    const idempotencyKey =
      (external_order_id && String(external_order_id).trim()) ||
      `MJ-${SOURCE === 'virtualsms' ? 'VS' : 'GZ'}-${String(user_id).slice(0, 8)}-${Date.now()}`;

    // Replay: same external_order_id already bought a number → return that order, no second charge
    if (external_order_id) {
      const { data: existing } = await supabase
        .from('number_orders')
        .select('order_id, phone_number, status, price, service_name, country_name, created_at')
        .eq('source', SOURCE)
        .eq('user_id', user_id)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      if (existing && existing.order_id) {
        const { data: balRow } = await supabase.from('profiles').select('balance').eq('id', user_id).maybeSingle();
        return res.status(200).json({
          success: true,
          replayed: true,
          message: 'Order already completed',
          data: {
            order_id: existing.order_id,
            number: existing.phone_number,
            status: existing.status || 'waiting_for_code',
            service_name: existing.service_name || serviceName,
            country_name: existing.country_name || countryName,
            price: existing.price != null ? Number(existing.price) : price,
            new_balance: Number(balRow?.balance || 0),
            created_at: existing.created_at || new Date().toISOString()
          }
        });
      }
    }

    if (originalBalance < price) {
      return res.status(402).json({
        success: false,
        message: 'Insufficient balance',
        required: price,
        available: originalBalance
      });
    }

    // Atomic debit — concurrent double-clicks cannot both succeed if balance only covers one
    let newBalance = originalBalance - price;
    const { data: debited, error: deductErr } = await supabase.rpc('debit_balance_if_sufficient', {
      p_user_id: user_id,
      p_amount: price
    });
    if (deductErr) {
      console.error('[grizzly order] debit_balance_if_sufficient', deductErr.message);
      // Fallback only if RPC missing; still prefer single-flight client lock
      const { data: p2 } = await supabase.from('profiles').select('balance').eq('id', user_id).single();
      const b2 = Number(p2?.balance || 0);
      if (b2 < price) {
        return res.status(402).json({ success: false, message: 'Insufficient balance', required: price, available: b2 });
      }
      const { error: upErr } = await supabase.from('profiles').update({ balance: b2 - price }).eq('id', user_id).gte('balance', price);
      if (upErr) {
        return res.status(500).json({ success: false, message: 'Could not debit your balance. Try again or contact support.' });
      }
      newBalance = b2 - price;
    } else if (debited === false || debited === null || debited === 0) {
      return res.status(402).json({
        success: false,
        message: 'Insufficient balance',
        required: price,
        available: originalBalance
      });
    } else {
      const { data: pAfter } = await supabase.from('profiles').select('balance').eq('id', user_id).maybeSingle();
      if (pAfter) newBalance = Number(pAfter.balance);
    }
    deducted = true;
    const qs = new URLSearchParams({
      api_key: SUP_KEY,
      action: 'getNumberV2',
      service: serviceId,
      country: String(countryId)
    });
    // Pin to selected Grizzly provider pool when user chose a tier
    if (resolvedProviderId) {
      qs.set('providerIds', String(resolvedProviderId));
    }
    if (supplierPriceUsd != null && Number.isFinite(Number(supplierPriceUsd)) && Number(supplierPriceUsd) > 0) {
      // maxPrice in USD per Grizzly docs — helps match the pool the user paid for
      qs.set('maxPrice', String(Number(supplierPriceUsd)));
    }

    const supplierRes = await fetch(`${sup.base}?${qs.toString()}`, { method: 'GET' });
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
      source: SOURCE,
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

/**
 * Claim order for refund once, then credit wallet.
 * Prevents double-credit when Check + Cancel (or two polls) race.
 * Only the first caller that flips refunded=false→true may add balance.
 */
async function claimAndRefundOrder(order, userId, opts = {}) {
  // Hard guard: never auto-refund GotSMS USA rentals or SMS-Bus long rentals via this path
  const srcGuard = String(order && order.source || '').toLowerCase();
  if (srcGuard === 'gotsms' || srcGuard === 'smsbus_rent') {
    return { refunded: false, reason: 'wrong_source' };
  }
  if (!order || !order.id) {
    return { refunded: false, reason: 'missing_order' };
  }
  if (order.refunded || ['refunded', 'completed', 'expired', 'cancelled', 'canceled'].includes(String(order.status || '').toLowerCase())) {
    return { refunded: false, reason: 'already_final' };
  }

  const subtitle = opts.subtitle || 'No SMS — balance restored';
  const notes = opts.notes || null;
  const category = opts.category || 'MJ SMS';
  const finalStatus = opts.status || 'refunded';

  // Atomic claim: only one concurrent request can win this update.
  // Prefer opts.status (e.g. expired); if DB rejects unknown status, fall back to refunded.
  async function tryClaim(statusValue) {
    return supabase
      .from('number_orders')
      .update({
        status: statusValue,
        refunded: true,
        updated_at: new Date().toISOString()
      })
      .eq('id', order.id)
      .eq('refunded', false)
      .in('status', ['waiting_for_code', 'pending', 'active', 'waiting', 'processing'])
      .select('id, price, status, refunded')
      .maybeSingle();
  }

  let claimed = null;
  let claimErr = null;
  ({ data: claimed, error: claimErr } = await tryClaim(finalStatus));
  if (claimErr && finalStatus !== 'refunded') {
    console.warn('[claimAndRefundOrder] status', finalStatus, 'rejected, retry refunded:', claimErr.message);
    ({ data: claimed, error: claimErr } = await tryClaim('refunded'));
  }
  // Re-check claim won (not already refunded by race)
  if (!claimErr && claimed && claimed.refunded === false) {
    // update may have matched wrong row in edge cases
  }
  if (claimErr) {
    console.error('[claimAndRefundOrder] claim failed', claimErr);
    return { refunded: false, reason: 'claim_error', error: claimErr.message };
  }
  if (!claimed) {
    return { refunded: false, reason: 'already_final' };
  }

  const refundAmount = Number(order.price != null ? order.price : claimed.price) || 0;
  let newBalance = null;

  if (refundAmount > 0) {
    const { data: credited, error: credErr } = await supabase.rpc('credit_balance', {
      p_user_id: userId,
      p_amount: refundAmount
    });
    if (credErr) {
      console.error('[claimAndRefundOrder] credit_balance', credErr.message);
      const { data: profile, error: profErr } = await supabase
        .from('profiles')
        .select('balance')
        .eq('id', userId)
        .single();
      if (!profErr && profile) {
        newBalance = Number(profile.balance || 0) + refundAmount;
        const { error: balErr } = await supabase
          .from('profiles')
          .update({ balance: newBalance })
          .eq('id', userId);
        if (balErr) console.error('[claimAndRefundOrder] balance credit failed', balErr);
      }
    } else if (credited != null && typeof credited === 'object' && credited.new_balance != null) {
      newBalance = Number(credited.new_balance);
    } else if (typeof credited === 'number') {
      newBalance = credited;
    }
  }

  try {
    let q = supabase
      .from('transactions')
      .update({
        status: (String(finalStatus).toLowerCase() === 'expired' ? 'expired' : 'cancelled'),
        subtitle,
        ...(notes ? { notes } : {})
      })
      .eq('user_id', userId)
      .eq('category', category)
      .eq('type', 'purchase')
      .in('status', ['pending', 'completed', 'success'])
      .eq('amount_ngn', refundAmount);
    await q;
  } catch (e) {
    console.warn('[claimAndRefundOrder] tx update', e.message || e);
  }

  return {
    refunded: true,
    refunded_amount: refundAmount,
    new_balance: newBalance
  };
}

async function refundOrderSilently(order, userId) {
  return claimAndRefundOrder(order, userId, {
    category: 'MJ SMS',
    subtitle: 'No SMS — balance restored'
  });
}

/**
 * Code arrived after a refund/expiry: re-debit the customer and mark completed.
 * Supplier delivered value — site must charge again (idempotent).
 */
async function reclaimAndCompleteOnCode(order, userId, code) {
  if (!order?.id || !code) return { ok: false, reason: 'missing' };
  if (order.status === 'completed' && order.code) {
    return { ok: true, already: true, order };
  }

  // Claim only refunded/expired rows that are not already completed with a code
  const { data: claimed, error: claimErr } = await supabase
    .from('number_orders')
    .update({
      status: 'completed',
      code: String(code),
      refunded: false,
      updated_at: new Date().toISOString()
    })
    .eq('id', order.id)
    .eq('refunded', true)
    .neq('status', 'completed')
    .select('id, price, phone_number, service_name, country_name, order_id, customer_id')
    .maybeSingle();

  if (claimErr) {
    console.error('[reclaimAndCompleteOnCode]', claimErr.message);
    return { ok: false, reason: 'claim_error', error: claimErr.message };
  }
  if (!claimed) {
    // Maybe already completed by concurrent check
    const { data: current } = await supabase.from('number_orders').select('*').eq('id', order.id).single();
    if (current?.status === 'completed' && current?.code) {
      return { ok: true, already: true, order: current };
    }
    return { ok: false, reason: 'not_reclaimable', order: current };
  }

  const price = Number(order.price != null ? order.price : claimed.price) || 0;
  let newBalance = null;

  if (price > 0) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('balance, customer_id')
      .eq('id', userId)
      .single();
    if (profile) {
      const { data: debited, error: debErr } = await supabase.rpc('debit_balance_if_sufficient', {
        p_user_id: userId,
        p_amount: price
      });
      if (debErr) {
        newBalance = Number(profile.balance || 0) - price;
        await supabase.from('profiles').update({ balance: newBalance }).eq('id', userId);
      } else if (typeof debited === 'number') newBalance = debited;
      else if (debited && debited.new_balance != null) newBalance = Number(debited.new_balance);
      else newBalance = Number(profile.balance || 0) - price;
      try {
        await supabase.from('transactions').insert({
          user_id: userId,
          customer_id: profile.customer_id || claimed.customer_id || order.customer_id,
          type: 'purchase',
          category: 'MJ SMS',
          title: claimed.service_name || order.service_name || 'SMS',
          subtitle: `${claimed.country_name || order.country_name || ''} · code received after refund — recharged`.trim(),
          amount: `₦${price.toLocaleString()}`,
          amount_ngn: price,
          status: 'completed'
        });
      } catch (e) {
        console.warn('[reclaimAndCompleteOnCode] tx', e.message || e);
      }
    }
  }

  return {
    ok: true,
    recharged: true,
    amount: price,
    new_balance: newBalance,
    code: String(code),
    order: { ...order, ...claimed, status: 'completed', code: String(code), refunded: false }
  };
}



async function handleCheck(req, res) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { order_id, user_id } = body;

  if (!order_id || !user_id) {
    return res.status(400).json({ success: false, message: 'order_id and user_id are required' });
  }

  try {
    const { data: existing, error: findErr } = await supabase
      .from('number_orders')
      .select(
        'id, status, phone_number, created_at, service_name, country_name, price, order_id, refunded, customer_id, source'
      )
      .in('source', ['grizzlysms', 'virtualsms'])
      .eq('order_id', String(order_id))
      .eq('user_id', user_id)
      .single();

    if (findErr || !existing) {
      return res.status(404).json({ success: false, message: 'Order not found for this account' });
    }

    const orderSrc = String(existing.source || 'grizzlysms').toLowerCase();
    const sup = orderSrc === 'virtualsms' ? SUPPLIERS.virtualsms : SUPPLIERS.grizzlysms;
    const SUP_KEY = typeof sup.key === 'function' ? sup.key() : sup.key;
    if (!SUP_KEY) {
      return res.status(500).json({ success: false, message: 'This SMS server is not available right now. Please contact support.' });
    }

    // Final success — no further supplier work
    if (existing.status === 'completed') {
      const { data: current } = await supabase
        .from('number_orders')
        .select('*')
        .eq('id', existing.id)
        .single();
      return res.status(200).json({ success: true, data: current });
    }

    // Refunded/expired: still ask supplier. If code exists, re-charge + complete.
    const wasRefunded = existing.refunded === true || ['refunded', 'expired', 'cancelled', 'canceled'].includes(String(existing.status || '').toLowerCase());

    const qs = new URLSearchParams({
      api_key: SUP_KEY,
      action: 'getStatusV2',
      id: String(order_id)
    });
    const supplierRes = await fetch(`${sup.base}?${qs.toString()}`, { method: 'GET' });
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
        api_key: SUP_KEY,
        action: 'getStatus',
        id: String(order_id)
      });
      const v1Res = await fetch(`${sup.base}?${v1Qs.toString()}`, { method: 'GET' });
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
            api_key: SUP_KEY,
            action: 'setStatus',
            id: String(order_id),
            status: '8'
          });
          await fetch(`${sup.base}?${cancelQs.toString()}`, { method: 'GET' });
        } catch (_) {}
        newStatus = 'expired';
      }
    }

    // Code arrived after refund/expiry → charge again and complete
    if (code && wasRefunded) {
      const re = await reclaimAndCompleteOnCode(existing, user_id, code);
      if (re.ok) {
        return res.status(200).json({
          success: true,
          data: {
            order_id,
            status: 'completed',
            number: existing.phone_number,
            code: re.code || code,
            created_at: existing.created_at,
            service_name: existing.service_name,
            country_name: existing.country_name,
            price: existing.price,
            refunded: false,
            recharged: !!re.recharged,
            recharged_amount: re.amount,
            new_balance: re.new_balance,
            message: re.recharged
              ? 'Code received — balance charged for this number'
              : 'Code received',
            raw
          }
        });
      }
    }

    if (newStatus === 'refunded' || newStatus === 'expired') {
      // Do not re-refund if already refunded
      if (wasRefunded) {
        const { data: current } = await supabase.from('number_orders').select('*').eq('id', existing.id).single();
        return res.status(200).json({ success: true, data: current || existing });
      }
      const result = await claimAndRefundOrder(existing, user_id, {
        status: newStatus === 'expired' ? 'expired' : 'refunded',
        subtitle: newStatus === 'expired' ? 'Expired — no SMS, balance restored' : 'No SMS — balance restored',
        category: 'MJ SMS'
      });
      return res.status(200).json({
        success: true,
        data: {
          order_id,
          status: newStatus === 'expired' ? 'expired' : 'refunded',
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

    // Atomic CAS: only complete/update if still un-refunded (blocks free-number race)
    const { data: updatedRows, error: updateErr } = await supabase
      .from('number_orders')
      .update({
        status: newStatus,
        code,
        updated_at: new Date().toISOString()
        // Do NOT force refunded:false — that could clobber a concurrent refund.
      })
      .eq('id', existing.id)
      .eq('refunded', false)
      .select();

    if (updateErr) {
      console.error('[grizzly check] update failed:', updateErr.message, { order_id });
    }

    if (!updateErr && (!updatedRows || updatedRows.length === 0)) {
      // Concurrent refund won — if we have a code, re-charge and complete
      if (code) {
        const re = await reclaimAndCompleteOnCode(
          { ...existing, refunded: true, status: 'refunded' },
          user_id,
          code
        );
        if (re.ok) {
          return res.status(200).json({
            success: true,
            data: {
              order_id,
              status: 'completed',
              number: existing.phone_number,
              code: re.code || code,
              created_at: existing.created_at,
              service_name: existing.service_name,
              country_name: existing.country_name,
              price: existing.price,
              refunded: false,
              recharged: !!re.recharged,
              recharged_amount: re.amount,
              new_balance: re.new_balance,
              message: 'Code received — balance charged for this number',
              raw
            }
          });
        }
      }
      const { data: current } = await supabase.from('number_orders').select('*').eq('id', existing.id).single();
      if (current) {
        return res.status(200).json({
          success: true,
          data: {
            order_id,
            status: current.status,
            number: current.phone_number,
            code: current.code,
            created_at: current.created_at,
            service_name: current.service_name,
            country_name: current.country_name,
            price: current.price,
            refunded: current.refunded,
            raw
          }
        });
      }
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
          api_key: SUP_KEY,
          action: 'setStatus',
          id: String(order_id),
          status: '6'
        });
        await fetch(`${sup.base}?${doneQs.toString()}`, { method: 'GET' });
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

  try {
    const { data: order, error: findErr } = await supabase
      .from('number_orders')
      .select('id, customer_id, price, status, refunded, service_name, created_at, order_id, source')
      .in('source', ['grizzlysms', 'virtualsms'])
      .eq('order_id', String(order_id))
      .eq('user_id', user_id)
      .single();

    if (findErr || !order) {
      return res.status(404).json({ success: false, message: 'Order not found for this account' });
    }

    const orderSrc = String(order.source || 'grizzlysms').toLowerCase();
    const sup = orderSrc === 'virtualsms' ? SUPPLIERS.virtualsms : SUPPLIERS.grizzlysms;
    const SUP_KEY = typeof sup.key === 'function' ? sup.key() : sup.key;
    if (!SUP_KEY) {
      return res.status(500).json({ success: false, message: 'This SMS server is not available right now. Please contact support.' });
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
      api_key: SUP_KEY,
      action: 'setStatus',
      id: String(order_id),
      status: '8'
    });
    const supplierRes = await fetch(`${sup.base}?${qs.toString()}`, { method: 'GET' });
    const raw = (await supplierRes.text()).trim();

    if (raw === 'EARLY_CANCEL_DENIED') {
      return res.status(400).json({
        success: false,
        code: 'EARLY_CANCEL_DENIED',
        wait_seconds: 300,
        message: 'Cancel is not available yet. Wait for the countdown, or contact support if it looks stuck.'
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

    // Confirmed cancel → claim order once, then credit wallet (idempotent)
    const refundResult = await claimAndRefundOrder(order, user_id, {
      category: 'MJ SMS',
      subtitle: 'Cancelled — balance restored',
      notes: 'SMS number cancelled; wallet credited without separate refund row'
    });

    if (!refundResult.refunded && refundResult.reason === 'already_final') {
      return res.status(409).json({
        success: false,
        message: 'This order was already refunded.'
      });
    }

    // Keep secondary tx match for service title when claim path already updated by amount
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
        .in('status', ['pending', 'completed', 'success'])
        .ilike('title', order.service_name || '%');
    } catch (e) {
      console.warn('tx status update skipped', e.message || e);
    }

    // Broader match: any pending MJ SMS purchase for this user around this order price
    try {
      const refundAmount = Number(order.price || 0);
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
        refunded_amount: refundResult.refunded_amount || Number(order.price || 0),
        new_balance: refundResult.new_balance
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


/**
 * Background job: mark + refund Server 1 numbers past the 20-min window
 * without requiring the customer to open the number page.
 * Cron: GET /api/grizzly-sync?action=expire_stale
 */
async function handleExpireStale(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  const isCron =
    (cronSecret && authHeader === `Bearer ${cronSecret}`) ||
    req.headers['x-vercel-cron'] === '1';

  let scopeUserId = null; // null = all users (cron/admin)
  if (!isCron) {
    // Customer JWT: expire only their own stale orders (history / any page can trigger)
    // Admin JWT: expire all
    try {
      const admin = await requireAdmin(req);
      if (admin.ok) {
        scopeUserId = null;
      } else {
        const token = (authHeader.match(/^Bearer\s+(.+)$/i) || [])[1];
        if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });
        const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !user) return res.status(401).json({ success: false, message: 'Unauthorized' });
        scopeUserId = user.id;
      }
    } catch (_) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
  }

  const cutoff = new Date(Date.now() - EXPIRY_MS).toISOString();
  let q = supabase
    .from('number_orders')
    .select('id, user_id, order_id, price, status, refunded, created_at, phone_number, service_name, customer_id, source')
    .in('status', ['waiting_for_code', 'waiting', 'pending', 'active', 'processing'])
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(200);
  if (scopeUserId) q = q.eq('user_id', scopeUserId);
  const { data: rows, error } = await q;

  if (error) {
    console.error('[grizzly expire_stale]', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }

    const stale = (rows || []).filter((o) => {
    if (o.refunded === true) return false;
    const src = String(o.source || '').toLowerCase();
    // Server 1 OTP (grizzlysms) + Server 3 OTP (virtualsms). Never touch SMS-Bus / GotSMS rentals.
    if (src === 'smsbus' || src === 'smsbus_rent' || src === 'gotsms') return false;
    if (src && src !== 'grizzlysms' && src !== 'virtualsms') return false;
    return true;
  }); let expired = 0;
  let skipped = 0;
  for (const order of stale) {
    try {
      // Best-effort supplier cancel
      const orderSrc = String(order.source || 'grizzlysms').toLowerCase();
      const sup = orderSrc === 'virtualsms' ? SUPPLIERS.virtualsms : SUPPLIERS.grizzlysms;
      const k = typeof sup.key === 'function' ? sup.key() : sup.key;
      if (k && order.order_id) {
        try {
          const cancelQs = new URLSearchParams({
            api_key: k,
            action: 'setStatus',
            id: String(order.order_id),
            status: '8'
          });
          await fetch(`${sup.base}?${cancelQs.toString()}`, { method: 'GET' });
        } catch (_) {}
      }
      const result = await claimAndRefundOrder(order, order.user_id, {
        status: 'expired',
        subtitle: 'Expired — no SMS, balance restored',
        category: 'MJ SMS'
      });
      if (result.refunded) expired += 1;
      else skipped += 1;
    } catch (e) {
      console.error('[grizzly expire_stale] order', order.id, e.message);
      skipped += 1;
    }
  }

  return res.status(200).json({
    success: true,
    scanned: (stale || []).length,
    expired,
    skipped,
    cutoff
  });
}



// ===========================================================================
// Server 3 (VirtualSMS) catalog sync — admin only
// Writes number_services with source = 'virtualsms'. Does NOT touch other rows.
//
// Why the previous version saved 0 rows: number_services.supplier_price is
// NOT NULL (default 0) but the old code sent supplier_price = null whenever
// VirtualSMS gave no usable cost, so Postgres rejected every single insert.
// This version never sends null, reads the supplier reply in any of the
// shapes the sms-activate protocol uses, fills missing costs country by
// country (like Server 1), and tells the admin exactly what it saw.
// ===========================================================================

const VSMS_COST_KEYS = ['cost', 'price', 'rate', 'amount', 'min_price', 'minPrice', 'price_usd', 'retail'];
const VSMS_COUNT_KEYS = ['count', 'phones', 'numberCount', 'physicalCount', 'quantity', 'stock', 'available', 'qty'];

/** Number from a number / "0.08" / "$0.08" / array / {min,max} — smallest positive value, 0 if none. */
function vsmsMoney(v) {
  if (v == null || typeof v === 'boolean') return 0;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : 0;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  const list = Array.isArray(v) ? v : (typeof v === 'object' ? Object.values(v) : []);
  const nums = list.map(vsmsMoney).filter((n) => n > 0);
  return nums.length ? Math.min(...nums) : 0;
}

/** Stock count from a number / string / boolean / object of counts (summed). */
function vsmsCount(v) {
  if (v == null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  if (typeof v === 'string') {
    const n = parseInt(v.replace(/[^0-9]/g, ''), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  const list = Array.isArray(v) ? v : (typeof v === 'object' ? Object.values(v) : []);
  return list.reduce((s, x) => s + vsmsCount(x), 0);
}

function vsmsIsLeaf(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  return VSMS_COST_KEYS.some((k) => k in o) || VSMS_COUNT_KEYS.some((k) => k in o);
}

function vsmsLeafValues(o) {
  let cost = 0;
  for (const k of VSMS_COST_KEYS) {
    if (k in o) {
      cost = vsmsMoney(o[k]);
      if (cost > 0) break;
    }
  }
  let count = 0;
  for (const k of VSMS_COUNT_KEYS) {
    if (k in o) {
      count = vsmsCount(o[k]);
      break;
    }
  }
  return { cost, count };
}

/** Peel a single wrapper like { data: {...} } / { prices: {...} } / { result: {...} }. */
function vsmsUnwrap(obj) {
  let cur = obj;
  for (let i = 0; i < 3; i += 1) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) break;
    const keys = Object.keys(cur);
    const wrapKey = ['data', 'prices', 'result', 'response'].find(
      (k) => cur[k] && typeof cur[k] === 'object' && !Array.isArray(cur[k])
    );
    if (wrapKey && keys.length <= 3) cur = cur[wrapKey];
    else break;
  }
  return cur;
}

/**
 * Read a supplier price/stock reply into [{ cid, sid, cost, count }].
 * Handles: { country: { service: { cost, count } } },  { service: { country: {...} } },
 * and flat { "wa_0": 12 } / { "wa_0": { cost, count } }.
 */
function vsmsExtract(obj) {
  const out = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  const isNum = (s) => /^\d+$/.test(String(s));

  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (vsmsIsLeaf(v)) {
        const m = /^(.+)_(\d+)$/.exec(k);
        if (m) out.push({ sid: m[1], cid: m[2], ...vsmsLeafValues(v) });
        continue;
      }
      for (const [ik, iv] of Object.entries(v)) {
        let cid;
        let sid;
        if (isNum(k) && !isNum(ik)) { cid = k; sid = ik; }
        else if (!isNum(k) && isNum(ik)) { cid = ik; sid = k; }
        else { cid = k; sid = ik; }
        if (iv && typeof iv === 'object' && !Array.isArray(iv)) {
          if (vsmsIsLeaf(iv)) out.push({ cid, sid, ...vsmsLeafValues(iv) });
        } else if (iv != null && !Array.isArray(iv)) {
          out.push({ cid, sid, cost: 0, count: vsmsCount(iv) });
        }
      }
    } else if (v != null && !Array.isArray(v)) {
      const m = /^(.+)_(\d+)$/.exec(k);
      if (m) out.push({ sid: m[1], cid: m[2], cost: 0, count: vsmsCount(v) });
    }
  }
  return out;
}

/** Merge extracted rows into a Map keyed "countryId|serviceId" (in stock only, keeps best cost). */
function vsmsMerge(map, rows, counters) {
  for (const r of rows) {
    const sid = String(r.sid || '').trim();
    if (!sid) continue;
    if (!/^\d+$/.test(String(r.cid))) {
      if (counters) counters.badCountry += 1;
      continue;
    }
    const cid = parseInt(r.cid, 10);
    if (!Number.isFinite(cid)) continue;
    const count = Number(r.count) || 0;
    const cost = Number(r.cost) > 0 ? Number(r.cost) : 0;
    const key = `${cid}|${sid}`;
    const prev = map.get(key);
    if (prev) {
      if (cost > 0 && (prev.cost <= 0 || cost < prev.cost)) prev.cost = cost;
      if (count > prev.count) prev.count = count;
      continue;
    }
    if (count <= 0) continue; // only stocked rows
    map.set(key, { cid, sid, cost, count });
  }
}

/** One legacy-protocol call that never throws: { ok, data, text, err }. */
async function vsmsCall(action, params, timeoutMs) {
  try {
    const r = await callSupplier(SUPPLIERS.virtualsms, { action, ...(params || {}) }, timeoutMs || 25000);
    const text = String(r.text || '').trim();
    if (!text) return { ok: false, text, err: `${action}: empty reply (HTTP ${r.status})` };
    let data = null;
    try { data = JSON.parse(text); } catch (_) { data = null; }
    if (data == null || typeof data !== 'object') {
      return { ok: false, text, err: `${action}: ${text.slice(0, 90)}` };
    }
    return { ok: true, data, text };
  } catch (e) {
    return { ok: false, text: '', err: `${action}: ${e && e.message ? e.message : e}` };
  }
}

/** GET JSON from the modern VirtualSMS REST API (best effort, short timeout). */
async function vsmsRest(path, withKey) {
  const headers = { Accept: 'application/json' };
  if (withKey) headers['X-API-Key'] = VIRTUALSMS_KEY;
  const opts = { headers };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    opts.signal = AbortSignal.timeout(10000);
  }
  const r = await fetch(`https://virtualsms.io${path}`, opts);
  const j = JSON.parse(await r.text());
  return Array.isArray(j) ? j : (j.countries || j.services || j.data || j.items || []);
}

async function vsmsCountryNames() {
  const names = {};
  // 1) legacy getCountries ({ "0": { eng, rus, ... } } or array)
  const legacy = await vsmsCall('getCountries', {}, 15000);
  if (legacy.ok) {
    const list = Array.isArray(legacy.data)
      ? legacy.data
      : Object.entries(vsmsUnwrap(legacy.data) || {}).map(([id, c]) => ({
          id,
          ...(c && typeof c === 'object' ? c : { name: c })
        }));
    for (const c of list) {
      const id = c.id ?? c.country_id ?? c.code;
      const name = c.eng || c.name || c.country_name || c.englishName;
      if (id != null && name) names[String(id)] = String(name);
    }
  }
  // 2) REST fallback only if legacy gave nothing
  if (!Object.keys(names).length) {
    for (const [path, withKey] of [['/api/v1/customer/countries', true], ['/api/v1/countries', false]]) {
      try {
        const list = await vsmsRest(path, withKey);
        for (const c of list) {
          const id = c.id ?? c.country_id ?? c.code;
          const name = c.eng || c.name || c.country_name || c.englishName;
          if (id != null && name) names[String(id)] = String(name);
        }
        if (Object.keys(names).length) break;
      } catch (_) { /* try next */ }
    }
  }
  return names;
}

async function vsmsServiceNames() {
  const names = {};
  for (const [path, withKey] of [['/api/v1/customer/services', true], ['/api/v1/services', false]]) {
    try {
      const list = await vsmsRest(path, withKey);
      for (const s of list) {
        const code = s.code || s.service || s.service_code || s.slug || s.id;
        const name = s.name || s.service_name || s.title || s.display_name;
        if (code) names[String(code)] = name || String(code).toUpperCase();
      }
      if (Object.keys(names).length) break;
    } catch (_) { /* try next */ }
  }
  return names;
}

async function handleVsmsSync(req, res) {
  const admin = await requireAdmin(req);
  if (!admin.ok) {
    return res.status(admin.status || 401).json({ success: false, message: admin.message || 'Unauthorized' });
  }
  if (!VIRTUALSMS_KEY) {
    return res.status(500).json({
      success: false,
      message: 'VIRTUALSMS_API_KEY is not set on the server. Add it in Vercel → Environment Variables, then redeploy.'
    });
  }

  const started = Date.now();
  const TIME_BUDGET_MS = 70000;           // admin.html aborts at 90s
  const PRICE_FILL_UNTIL = started + 30000; // per-country price lookups must finish by here
  const deadline = started + TIME_BUDGET_MS;
  const usdToNgn = Number(process.env.USD_TO_NGN_RATE) || Number(process.env.USD_TO_NGN) || 1500;
  const floorNgn = Number(process.env.MIN_NUMBER_PRICE_NGN) || 1000;
  const errors = [];
  const counters = { badCountry: 0 };
  const stats = { inserted: 0, updated: 0, unchanged: 0, delisted: 0 };
  let timedOut = false;

  try {
    // 1) Supplier data in parallel: stock/prices, country names, service names
    const [pricesRes, countryNames, serviceNames] = await Promise.all([
      vsmsCall('getPrices', {}, 40000),
      vsmsCountryNames().catch((e) => { errors.push('countries: ' + (e.message || e)); return {}; }),
      vsmsServiceNames().catch((e) => { errors.push('services: ' + (e.message || e)); return {}; })
    ]);

    const rowsMap = new Map();
    let pricesSample = '';
    if (pricesRes.ok) {
      pricesSample = pricesRes.text.slice(0, 220);
      vsmsMerge(rowsMap, vsmsExtract(vsmsUnwrap(pricesRes.data)), counters);
    } else {
      errors.push(pricesRes.err);
      pricesSample = (pricesRes.text || '').slice(0, 120);
    }

    // Fallback: stock-only map (no prices) when getPrices gave nothing
    let usedStatusFallback = false;
    if (!rowsMap.size) {
      const st = await vsmsCall('getNumbersStatus', {}, 25000);
      if (st.ok) {
        usedStatusFallback = true;
        pricesSample = pricesSample || st.text.slice(0, 220);
        vsmsMerge(rowsMap, vsmsExtract(vsmsUnwrap(st.data)), counters);
      } else {
        errors.push(st.err);
      }
    }

    if (!rowsMap.size) {
      return res.status(502).json({
        success: false,
        message: 'VirtualSMS returned no in-stock services. Check the API key and supplier stock.',
        errors: errors.slice(0, 10),
        raw_hint: pricesSample
      });
    }

    // 2) Costs missing for most rows → ask country by country (same idea as Server 1)
    const countPriced = () => {
      let n = 0;
      for (const r of rowsMap.values()) if (r.cost > 0) n += 1;
      return n;
    };
    let filledCountries = 0;
    if (countPriced() < rowsMap.size * 0.5) {
      const countryIds = Array.from(new Set(Array.from(rowsMap.values()).map((r) => r.cid)));
      let idx = 0;
      const worker = async () => {
        while (idx < countryIds.length && Date.now() < PRICE_FILL_UNTIL) {
          const cid = countryIds[idx];
          idx += 1;
          const r = await vsmsCall('getPrices', { country: String(cid) }, 15000);
          if (r.ok) {
            vsmsMerge(rowsMap, vsmsExtract(vsmsUnwrap(r.data)), counters);
            filledCountries += 1;
          }
        }
      };
      await Promise.all(Array.from({ length: 8 }, worker));
    }

    const pricedRows = countPriced();
    const unpricedRows = rowsMap.size - pricedRows;
    if (pricedRows === 0) {
      errors.push(
        'No supplier cost found in the VirtualSMS reply' +
        (usedStatusFallback ? ' (only stock counts came back)' : '') +
        '. Rows saved at the floor price — sample: ' + pricesSample.slice(0, 160)
      );
    }
    if (counters.badCountry) {
      errors.push(counters.badCountry + ' rows skipped: country id was not a number.');
    }

    // 3) Build rows (never null: supplier_price is NOT NULL in number_services)
    const now = new Date().toISOString();
    const built = [];
    for (const r of rowsMap.values()) {
      const cost = r.cost > 0 ? r.cost : 0;
      let sell = floorNgn;
      if (cost > 0) {
        const marked = applyMarkup(cost, usdToNgn);
        sell = Number.isFinite(Number(marked)) && Number(marked) > 0 ? Number(marked) : salePriceFromUsd(cost);
      }
      built.push({
        key: `${r.cid}|${r.sid}`,
        source: 'virtualsms',
        country_id: r.cid,
        country_name: countryNames[String(r.cid)] || `Country ${r.cid}`,
        service_id: r.sid,
        service_name: serviceNames[r.sid] || GRIZZLY_SERVICE_NAMES[r.sid] || r.sid.toUpperCase(),
        supplier_price: cost,
        price: sell,
        price_source: 'system',
        currency: 'NGN',
        available_quantity: r.count,
        is_available: r.count > 0,
        updated_at: now
      });
    }

    // 4) Load existing Server 3 rows (paged) — admin-set prices are preserved
    const existingMap = new Map();
    {
      let from = 0;
      const page = 1000;
      while (true) {
        const { data, error } = await supabase
          .from('number_services')
          .select('id, country_id, service_id, price, price_source, supplier_price, available_quantity, service_name, country_name, is_available')
          .eq('source', 'virtualsms')
          .order('id', { ascending: true })
          .range(from, from + page - 1);
        if (error) {
          errors.push('load existing: ' + error.message);
          break;
        }
        const batch = data || [];
        for (const r of batch) existingMap.set(`${r.country_id}|${r.service_id}`, r);
        if (batch.length < page) break;
        from += page;
      }
    }

    // 5) Split into inserts / changed updates (unchanged rows are skipped, like Server 1)
    const inserts = [];
    const updates = [];
    for (const row of built) {
      const prev = existingMap.get(row.key);
      const { key, ...clean } = row;
      if (!prev) {
        inserts.push(clean);
        continue;
      }
      // Admin hid it while it was in stock → stay hidden. Came back after selling out → show again.
      const nextAvail = row.available_quantity > 0 &&
        (prev.is_available !== false || Number(prev.available_quantity || 0) <= 0);
      const adminPrice = prev.price_source === 'admin';
      const changed =
        Number(prev.supplier_price || 0) !== row.supplier_price ||
        Number(prev.available_quantity || 0) !== row.available_quantity ||
        String(prev.service_name || '') !== row.service_name ||
        String(prev.country_name || '') !== row.country_name ||
        !!prev.is_available !== !!nextAvail ||
        (!adminPrice && Number(prev.price || 0) !== row.price);
      if (!changed) {
        stats.unchanged += 1;
        continue;
      }
      const fields = {
        country_name: row.country_name,
        service_name: row.service_name,
        supplier_price: row.supplier_price,
        available_quantity: row.available_quantity,
        is_available: nextAvail,
        updated_at: now
      };
      if (!adminPrice) {
        fields.price = row.price;
        fields.price_source = 'system';
      }
      updates.push({ id: prev.id, ...fields });
    }

    const toWrite = inserts.length + updates.length;

    // 6) Updates in parallel batches
    await runInBatches(updates, UPDATE_CONCURRENCY, async (row) => {
      if (Date.now() > deadline) { timedOut = true; return; }
      const { id, ...fields } = row;
      const { error } = await supabase.from('number_services').update(fields).eq('id', id);
      if (error) {
        if (errors.length < 25) errors.push('update: ' + error.message);
      } else {
        stats.updated += 1;
      }
    });

    // 7) Inserts in batches of 100 — if a batch fails, retry row by row to surface the real error
    for (let i = 0; i < inserts.length; i += 100) {
      if (Date.now() > deadline) { timedOut = true; break; }
      const batch = inserts.slice(i, i + 100);
      const { error } = await supabase.from('number_services').insert(batch);
      if (!error) {
        stats.inserted += batch.length;
        continue;
      }
      if (errors.length < 25) errors.push('batch insert: ' + error.message);
      for (const row of batch) {
        if (Date.now() > deadline) { timedOut = true; break; }
        const { error: e2 } = await supabase.from('number_services').insert(row);
        if (e2) {
          if (errors.length < 25) errors.push(`row ${row.service_id}/${row.country_id}: ${e2.message}`);
        } else {
          stats.inserted += 1;
        }
      }
    }

    // 8) Sold-out rows: anything we saved before that VirtualSMS no longer lists → out of stock.
    //    Only on a complete pass of the full getPrices list, never after a timeout or fallback.
    if (!timedOut && pricesRes.ok && !usedStatusFallback && rowsMap.size >= 100) {
      const goneIds = [];
      for (const [key, prev] of existingMap) {
        if (rowsMap.has(key)) continue;
        if (prev.is_available === false && Number(prev.available_quantity || 0) <= 0) continue;
        goneIds.push(prev.id);
      }
      for (let i = 0; i < goneIds.length; i += 200) {
        if (Date.now() > deadline) { timedOut = true; break; }
        const chunk = goneIds.slice(i, i + 200);
        const { error } = await supabase
          .from('number_services')
          .update({ available_quantity: 0, is_available: false, updated_at: now })
          .in('id', chunk);
        if (error) {
          if (errors.length < 25) errors.push('sold-out update: ' + error.message);
        } else {
          stats.delisted += chunk.length;
        }
      }
    }

    const written = stats.inserted + stats.updated;
    if (toWrite > 0 && written === 0) {
      return res.status(500).json({
        success: false,
        message:
          'Saw ' + rowsMap.size + ' in-stock services but could not save any. ' +
          (errors[0] || 'Check number_services columns and constraints.'),
        rows_seen: rowsMap.size,
        errors: errors.slice(0, 15),
        raw_hint: pricesSample
      });
    }

    const partial = timedOut || written < toWrite;
    const parts = [];
    parts.push(stats.inserted + ' new');
    parts.push(stats.updated + ' updated');
    if (stats.unchanged) parts.push(stats.unchanged + ' unchanged');
    if (stats.delisted) parts.push(stats.delisted + ' sold out');
    let message = partial
      ? `Saved ${written} of ${toWrite} so far. Click Sync Server 3 again to continue.`
      : `VirtualSMS sync done. ${rowsMap.size} in stock (${parts.join(', ')}).`;
    if (!partial && unpricedRows > 0) {
      message += ` ${unpricedRows} had no supplier cost and use the ₦${floorNgn.toLocaleString()} floor price.`;
    }

    return res.status(200).json({
      success: true,
      source: 'virtualsms',
      rows_seen: rowsMap.size,
      upserted: written,
      inserted: stats.inserted,
      updated: stats.updated,
      unchanged: stats.unchanged,
      delisted: stats.delisted,
      priced: pricedRows,
      unpriced: unpricedRows,
      price_lookups: filledCountries,
      partial,
      ms: Date.now() - started,
      errors: errors.slice(0, 12),
      message
    });
  } catch (err) {
    console.error('[vsms_sync]', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'VirtualSMS sync failed',
      errors: errors.slice(0, 10)
    });
  }
}


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
    const getAction = String(action || '').toLowerCase();
    if (getAction === 'expire_stale' || getAction === 'expire-stale') {
      return handleExpireStale(req, res);
    }
    if (getAction === 'vsms_sync' || getAction === 'virtualsms_sync' || getAction === 'server3_sync') {
      return handleVsmsSync(req, res);
    }
    // action is one of: null (continue/cron), 'start', 'status' — handled inside handleSync
    return handleSync(req, res);
  }

  if (req.method === 'POST') {
    const postAction = String(action || '').toLowerCase();
    if (postAction === 'vsms_sync' || postAction === 'virtualsms_sync' || postAction === 'server3_sync') {
      return handleVsmsSync(req, res);
    }
    if (action === 'order') return handleOrder(req, res);
    if (action === 'check') return handleCheck(req, res);
    if (action === 'expire_stale' || action === 'expire-stale') return handleExpireStale(req, res);
    if (action === 'cancel') return handleCancel(req, res);
    return res.status(400).json({
      success: false,
      message: "POST requires ?action=order, ?action=check, ?action=cancel, or ?action=vsms_sync"
    });
  }

  return res.status(405).json({ success: false, message: 'Method not allowed' });
}
