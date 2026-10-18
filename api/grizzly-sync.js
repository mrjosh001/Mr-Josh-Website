import { createClient } from '@supabase/supabase-js';
import { applyMarkup } from '../lib/pricing.js';

/**
 * /api/grizzly-sync — GrizzlySMS (Server 1) + VirtualSMS (Server 3) operations in one file.
 *
 * GET  /api/grizzly-sync                  → continue/kick off Server 1 catalog sync (cron + admin "Sync" button)
 * GET  /api/grizzly-sync?action=start      → start a fresh Server 1 sync job
 * GET  /api/grizzly-sync?action=status     → Server 1 sync job progress
 * GET  /api/grizzly-sync?action=vsms_sync  → Server 3 (VirtualSMS) catalog sync (admin / cron)
 * GET  /api/grizzly-sync?action=vsms_probe → Server 3: show what VirtualSMS really returns (admin)
 * GET  /api/grizzly-sync?action=vsms_purge_legacy → Server 3: delete old broken numeric-id rows (admin)
 * POST /api/grizzly-sync?action=order      → buy a number   (provider=virtualsms → Server 3)
 * POST /api/grizzly-sync?action=check      → poll for SMS code (routes by the order's saved source)
 * POST /api/grizzly-sync?action=cancel     → cancel + refund   (routes by the order's saved source)
 *
 * Server 3 now uses VirtualSMS' documented MODERN REST API (https://virtualsms.io/api/v1, X-API-Key):
 * ISO-2 country codes with real names, real per-country prices, POST /customer/purchase.
 * number_services.country_id is an integer column, so an ISO code is stored as a reversible integer
 * (vsIsoToId / vsIdToIso); the real name goes in country_name.
 * Server 1 code below is unchanged.
 *
 * Env: GRIZZLYSMS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET?
 * Optional: USD_TO_NGN_RATE (default 1500), VIRTUALSMS_API_KEY (Server 3),
 *           VSMS_SERVICES_PER_RUN (40), VSMS_SERVICE_LIMIT (150), VSMS_STALE_HOURS (5)
 */

/* MJHUB_SERVER3_VIRTUALSMS=3 2026-10-18 Server 3 moved to VirtualSMS REST API: real country names + real prices */
const BASE = 'https://api.grizzlysms.com/stubs/handler_api.php';
const VSMS_BASE = 'https://virtualsms.io/stubs/handler_api.php'; // legacy: only for old numeric-id Server 3 orders


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

/** Server 1 = grizzlysms, Server 3 = virtualsms (legacy entry kept only for old numeric-id orders) */
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
// SYNC (Server 1) — unchanged
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
// ORDER (Server 1) — unchanged
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
// CHECK helpers (shared) — unchanged
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
// CANCEL (Server 1) — unchanged
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
// EXPIRE STALE — Server 1 (unchanged logic) + Server 3 (REST) in the same cron
// ===========================================================================

/**
 * Background job: mark + refund numbers past the 20-min window
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

  // Server 1 (grizzlysms) + old numeric-id Server 3 orders (legacy protocol).
  // New Server 3 orders (REST ids) are handled by vsExpireStale below. Never touch SMS-Bus / GotSMS rentals.
  const stale = (rows || []).filter((o) => {
    if (o.refunded === true) return false;
    const src = String(o.source || '').toLowerCase();
    if (src === 'smsbus' || src === 'smsbus_rent' || src === 'gotsms') return false;
    if (src && src !== 'grizzlysms' && src !== 'virtualsms') return false;
    if (src === 'virtualsms' && !/^\d+$/.test(String(o.order_id || ''))) return false;
    return true;
  });
  let expired = 0;
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

  let server3 = null;
  try {
    server3 = await vsExpireStale(rows || []);
  } catch (e) {
    console.error('[vsms expire_stale]', e.message);
  }

  return res.status(200).json({
    success: true,
    scanned: (stale || []).length,
    expired,
    skipped,
    server3,
    cutoff
  });
}


// ===========================================================================
// SERVER 3 — VirtualSMS (modern REST API). Real country names + real prices.
// ===========================================================================

const VS_REST = 'https://virtualsms.io/api/v1';
const VS_SOURCE = 'virtualsms';
const VS_ID_BASE = 1000;
const VS_CANCEL_COOLDOWN_MS = 120 * 1000;
const VS_TIME_BUDGET_MS = 55000;
const VS_SERVICES_PER_RUN = Number(process.env.VSMS_SERVICES_PER_RUN) || 40;
const VS_SERVICE_LIMIT = Number(process.env.VSMS_SERVICE_LIMIT) || 150;
const VS_STALE_MS = (Number(process.env.VSMS_STALE_HOURS) || 5) * 3600 * 1000;
const VS_POPULAR_RE = /whatsapp|telegram|google|gmail|facebook|instagram|twitter|^x$|discord|tiktok|snapchat|microsoft|amazon|uber|netflix|paypal|tinder|linkedin|viber|wechat|apple|line|bumble|yahoo|openai|chatgpt|signal|vk|binance/i;
const VS_POPULAR_CODES = ['wa', 'tg', 'go', 'fb', 'ig', 'tw', 'ds', 'lf', 'tt', 'fu', 'mm', 'am', 'ub', 'nf', 'ts', 'oi', 'tn', 'vi', 'we', 'wx'];

const vsApiKey = () => String(process.env.VIRTUALSMS_API_KEY || process.env.VIRTUAL_SMS_API_KEY || '').trim();

// ---------------------------------------------------------------- helpers
function vsIsoToId(iso) {
  const s = String(iso || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(s)) return null;
  return VS_ID_BASE + (s.charCodeAt(0) - 65) * 26 + (s.charCodeAt(1) - 65);
}
function vsIdToIso(id) {
  const n = Number(id) - VS_ID_BASE;
  if (!Number.isInteger(n) || n < 0 || n >= 676) return null;
  return String.fromCharCode(65 + Math.floor(n / 26)) + String.fromCharCode(65 + (n % 26));
}
let _vsRegionNames = null;
function vsRegionName(iso) {
  try {
    if (!_vsRegionNames) _vsRegionNames = new Intl.DisplayNames(['en'], { type: 'region' });
    const n = _vsRegionNames.of(iso);
    return n && n !== iso ? n : null;
  } catch (_) { return null; }
}
function vsNum(v) {
  if (v == null || typeof v === 'boolean') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function vsFirstNum(o, keys) {
  for (const k of keys) { const n = vsNum(o && o[k]); if (n > 0) return n; }
  return 0;
}
function vsStockOf(o) {
  const n = vsFirstNum(o, ['available_phones', 'available_count', 'count', 'stock', 'quantity', 'qty', 'numbers', 'available']);
  if (n > 0) return Math.floor(n);
  if (o && (o.available === true || o.in_stock === true)) return 1;
  return 0;
}
function vsPriceOf(o) {
  return vsFirstNum(o, ['price_usd', 'price', 'cost', 'amount', 'min_price', 'retail']);
}
/** Pull an array out of whatever wrapper the API uses ({countries:[…]}, {data:[…]}, [..], {GB:{…}}). */
function vsAsList(j, keys) {
  if (Array.isArray(j)) return j;
  if (!j || typeof j !== 'object') return [];
  for (const k of keys) {
    const v = j[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const e = Object.entries(v).filter(([, x]) => x && typeof x === 'object');
      if (e.length) return e.map(([key, x]) => ({ _key: key, ...x }));
    }
  }
  const e = Object.entries(j).filter(([, x]) => x && typeof x === 'object' && !Array.isArray(x));
  return e.length > 3 ? e.map(([key, x]) => ({ _key: key, ...x })) : [];
}
function vsCountryIso(c) {
  for (const v of [c.iso, c.iso2, c.country_code, c.code, c.country_id, c.country, c._key]) {
    const s = String(v == null ? '' : v).toUpperCase();
    if (/^[A-Z]{2}$/.test(s)) return s;
  }
  return null;
}
function vsCountryNameOf(c, iso) {
  for (const v of [c.name, c.country_name, c.eng, c.english, c.title, c.label]) {
    if (v && typeof v === 'string' && v.trim().length > 1) return v.trim();
  }
  return vsRegionName(iso) || iso;
}
function vsServiceCode(s) {
  return String(s.code || s.service || s.service_code || s.slug || s.id || s._key || '').trim();
}
function vsServiceNameOf(s, code) {
  const n = s.name || s.service_name || s.title || s.display_name;
  return n && String(n).trim() ? String(n).trim() : code.toUpperCase();
}

async function vsReq(path, opts = {}) {
  const headers = { Accept: 'application/json', 'X-API-Key': vsApiKey() };
  if (opts.body) headers['Content-Type'] = 'application/json';
  try {
    const res = await fetch(VS_REST + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs || 20000)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not json */ }
    return { ok: res.ok, status: res.status, json, text: String(text || '') };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: '', err: e && e.message ? e.message : String(e) };
  }
}

function vsIsCron(req) {
  const h = req.headers.authorization || '';
  return (!!process.env.CRON_SECRET && h === `Bearer ${process.env.CRON_SECRET}`) || req.headers['x-vercel-cron'] === '1';
}
async function vsAdminOrCron(req, res) {
  if (vsIsCron(req)) return true;
  const a = await requireAdmin(req);
  if (a.ok) return true;
  res.status(a.status).json({ success: false, message: a.message });
  return false;
}
const vsBody = (req) => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}));

// ---------------------------------------------------------------- catalog sync
async function vsLoadExisting() {
  const map = new Map();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('number_services')
      .select('id, country_id, service_id, price, price_source, supplier_price, available_quantity, service_name, country_name, is_available, updated_at')
      .eq('source', VS_SOURCE)
      .gte('country_id', VS_ID_BASE)
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error('load existing: ' + error.message);
    for (const r of data || []) map.set(`${r.country_id}|${r.service_id}`, r);
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return map;
}

async function vsHandleSync(req, res) {
  if (!(await vsAdminOrCron(req, res))) return;
  if (!vsApiKey()) {
    return res.status(500).json({ success: false, message: 'VIRTUALSMS_API_KEY is not set on the server (Vercel → Environment Variables).' });
  }
  const started = Date.now();
  const rate = Number(process.env.USD_TO_NGN_RATE) || Number(process.env.USD_TO_NGN) || 1500;
  const errors = [];
  const note = (m) => { if (errors.length < 15) errors.push(m); };

  // 1) service list + country list (2 calls)
  const [svcRes, ctyRes] = await Promise.all([vsReq('/customer/services'), vsReq('/customer/countries')]);
  if (!svcRes.ok) {
    return res.status(502).json({
      success: false,
      message: `VirtualSMS services call failed (HTTP ${svcRes.status || 'no reply'}). ${svcRes.status === 401 ? 'Check VIRTUALSMS_API_KEY.' : ''}`,
      raw_hint: (svcRes.err || svcRes.text || '').slice(0, 160)
    });
  }
  const services = vsAsList(svcRes.json, ['services', 'data', 'items', 'results'])
    .map((s) => { const code = vsServiceCode(s); return code ? { code, name: vsServiceNameOf(s, code) } : null; })
    .filter(Boolean);
  if (!services.length) {
    return res.status(502).json({ success: false, message: 'VirtualSMS returned no services.', raw_hint: svcRes.text.slice(0, 200) });
  }
  const svcName = new Map(services.map((s) => [s.code, s.name]));

  const countryList = ctyRes.ok ? vsAsList(ctyRes.json, ['countries', 'data', 'items', 'results']) : [];
  const isoName = new Map();
  for (const c of countryList) {
    const iso = vsCountryIso(c);
    if (iso) isoName.set(iso, vsCountryNameOf(c, iso));
  }

  const entries = new Map();      // "ISO|code" -> {iso, code, usd, count}
  const processed = new Set();    // service codes we got a complete answer for
  const addEntry = (iso, code, usd, count) => {
    if (!iso || !code) return;
    const prev = entries.get(`${iso}|${code}`);
    if (prev) { if (usd > 0 && (prev.usd <= 0 || usd < prev.usd)) prev.usd = usd; if (count > prev.count) prev.count = count; return; }
    entries.set(`${iso}|${code}`, { iso, code, usd, count });
  };

  // 2a) best case: the country list already carries per-service prices
  let embedded = 0;
  for (const c of countryList) {
    const iso = vsCountryIso(c);
    const emb = c.services || c.available_services || c.service_prices || c.prices;
    if (!iso || !emb || typeof emb !== 'object') continue;
    const arr = Array.isArray(emb) ? emb : Object.entries(emb).map(([k, v]) => (v && typeof v === 'object' ? { _key: k, ...v } : { _key: k, price: v }));
    for (const s of arr) {
      const code = typeof s === 'string' ? s : vsServiceCode(s);
      const usd = typeof s === 'object' ? vsPriceOf(s) : 0;
      if (code && usd > 0) { addEntry(iso, code, usd, typeof s === 'object' ? (vsStockOf(s) || 1) : 1); embedded += 1; }
    }
  }
  const existing = await vsLoadExisting();
  let servicesDone = 0;
  let servicesTotal = 0;
  let stoppedEarly = false;
  let rateLimited = false;

  if (embedded > 0) {
    for (const s of services) processed.add(s.code);
    servicesDone = servicesTotal = services.length;
  } else {
    // 2b) price services one by one: /customer/countries?service=CODE (exact price + stock per country)
    const rank = (s) => {
      const pi = VS_POPULAR_CODES.indexOf(s.code);
      if (pi >= 0) return pi;
      return VS_POPULAR_RE.test(s.name) ? 100 : 1000;
    };
    const ordered = services.map((s, i) => ({ ...s, i })).sort((a, b) => rank(a) - rank(b) || a.i - b.i).slice(0, VS_SERVICE_LIMIT);
    servicesTotal = ordered.length;
    const lastSeen = new Map();
    for (const r of existing.values()) {
      const t = r.updated_at ? new Date(r.updated_at).getTime() : 0;
      if (t > (lastSeen.get(r.service_id) || 0)) lastSeen.set(r.service_id, t);
    }
    const now = Date.now();
    servicesDone = ordered.filter((s) => now - (lastSeen.get(s.code) || 0) < VS_STALE_MS).length;
    const todo = ordered
      .filter((s) => now - (lastSeen.get(s.code) || 0) >= VS_STALE_MS)
      .sort((a, b) => (lastSeen.get(a.code) || 0) - (lastSeen.get(b.code) || 0) || rank(a) - rank(b))
      .slice(0, VS_SERVICES_PER_RUN);

    let idx = 0;
    const worker = async () => {
      while (idx < todo.length && Date.now() - started < VS_TIME_BUDGET_MS && !rateLimited) {
        const s = todo[idx]; idx += 1;
        const r = await vsReq('/customer/countries?service=' + encodeURIComponent(s.code), { timeoutMs: 15000 });
        if (r.status === 429) { rateLimited = true; return; }
        if (!r.ok) { note(`${s.code}: HTTP ${r.status || 'no reply'}`); continue; }
        const list = vsAsList(r.json, ['countries', 'data', 'items', 'results']);
        let priced = 0;
        for (const c of list) {
          const iso = vsCountryIso(c);
          if (!iso) continue;
          if (!isoName.has(iso)) isoName.set(iso, vsCountryNameOf(c, iso));
          const usd = vsPriceOf(c);
          const count = vsStockOf(c);
          if (usd > 0 && count > 0) { addEntry(iso, s.code, usd, count); priced += 1; }
        }
        if (list.length && !priced) note(`${s.code}: countries came back without a usable price`);
        processed.add(s.code);
        servicesDone += 1;
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    stoppedEarly = idx < todo.length;
  }

  if (!entries.size && !processed.size) {
    return res.status(200).json({
      success: true, partial: false, done: true, rows_seen: 0, upserted: 0,
      message: rateLimited ? 'VirtualSMS rate limit hit (60/min). Wait a minute and click Sync again.' : 'Nothing to refresh right now — every service was synced recently.',
      services_done: servicesDone, services_total: servicesTotal, errors, ms: Date.now() - started
    });
  }

  // 3) build rows
  const nowIso = new Date().toISOString();
  const rows = [];
  for (const e of entries.values()) {
    if (!(e.usd > 0) || !(e.count > 0)) continue;
    const cid = vsIsoToId(e.iso);
    if (cid == null) continue;
    const sell = Number(applyMarkup(e.usd, rate));
    rows.push({
      key: `${cid}|${e.code}`, country_id: cid,
      country_name: isoName.get(e.iso) || vsRegionName(e.iso) || e.iso,
      service_id: e.code, service_name: svcName.get(e.code) || e.code.toUpperCase(),
      supplier_price: e.usd, price: Number.isFinite(sell) && sell > 0 ? sell : salePriceFromUsd(e.usd),
      available_quantity: e.count
    });
  }

  // 4) write: insert new, update changed (never overwrite an admin-set price), delist sold-out
  const inserts = [];
  const updates = [];
  const seen = new Set();
  let unchanged = 0;
  for (const r of rows) {
    seen.add(r.key);
    const prev = existing.get(r.key);
    if (!prev) {
      inserts.push({
        source: VS_SOURCE, country_id: r.country_id, country_name: r.country_name, service_id: r.service_id,
        service_name: r.service_name, supplier_price: r.supplier_price, price: r.price, price_source: 'system',
        currency: 'NGN', available_quantity: r.available_quantity, is_available: true, updated_at: nowIso
      });
      continue;
    }
    const admin = prev.price_source === 'admin';
    const costMoved = Math.abs(Number(prev.supplier_price || 0) - r.supplier_price) > 0.0001;
    const changed = costMoved || Number(prev.available_quantity || 0) !== r.available_quantity ||
      String(prev.country_name || '') !== r.country_name || String(prev.service_name || '') !== r.service_name || prev.is_available === false;
    if (!changed) { updates.push({ id: prev.id, updated_at: nowIso, _touch: true }); unchanged += 1; continue; }
    const f = {
      country_name: r.country_name, service_name: r.service_name, supplier_price: r.supplier_price,
      available_quantity: r.available_quantity, is_available: true, updated_at: nowIso
    };
    if (!admin && costMoved) { f.price = r.price; f.price_source = 'system'; }
    updates.push({ id: prev.id, ...f });
  }
  const goneIds = [];
  for (const [key, prev] of existing) {
    if (seen.has(key) || !processed.has(prev.service_id)) continue;
    if (prev.is_available === false && Number(prev.available_quantity || 0) <= 0) continue;
    goneIds.push(prev.id);
  }

  const stats = { inserted: 0, updated: 0, delisted: 0 };
  for (let i = 0; i < updates.length; i += 20) {
    await Promise.all(updates.slice(i, i + 20).map(async (u) => {
      const { id, _touch, ...f } = u;
      const { error } = await supabase.from('number_services').update(f).eq('id', id);
      if (error) note('update: ' + error.message); else if (!_touch) stats.updated += 1;
    }));
  }
  for (let i = 0; i < inserts.length; i += 100) {
    const batch = inserts.slice(i, i + 100);
    const { error } = await supabase.from('number_services').insert(batch);
    if (!error) { stats.inserted += batch.length; continue; }
    note('batch insert: ' + error.message);
    for (const row of batch) {
      const { error: e2 } = await supabase.from('number_services').insert(row);
      if (e2) note(`row ${row.service_id}/${row.country_name}: ${e2.message}`); else stats.inserted += 1;
    }
  }
  for (let i = 0; i < goneIds.length; i += 200) {
    const { error } = await supabase.from('number_services')
      .update({ available_quantity: 0, is_available: false, updated_at: nowIso }).in('id', goneIds.slice(i, i + 200));
    if (error) note('sold-out: ' + error.message); else stats.delisted += Math.min(200, goneIds.length - i);
  }

  const written = stats.inserted + stats.updated;
  if (inserts.length + updates.length - unchanged > 0 && written === 0 && !unchanged) {
    return res.status(500).json({
      success: false, message: 'VirtualSMS data was read but nothing could be saved. ' + (errors[0] || ''), errors, rows_seen: rows.length
    });
  }
  // old numeric-id rows from the broken legacy sync: hide them once real rows exist
  let legacyHidden = 0;
  if (rows.length >= 20) {
    const { data: lg } = await supabase.from('number_services')
      .update({ available_quantity: 0, is_available: false }).eq('source', VS_SOURCE).lt('country_id', VS_ID_BASE).eq('is_available', true).select('id');
    legacyHidden = (lg || []).length;
  }

  const partial = stoppedEarly || rateLimited || servicesDone < servicesTotal;
  let message = `VirtualSMS sync: ${rows.length} in-stock offers across ${processed.size} services (${stats.inserted} new, ${stats.updated} updated${stats.delisted ? ', ' + stats.delisted + ' sold out' : ''}).`;
  if (embedded === 0) message += ` Services priced: ${Math.min(servicesDone, servicesTotal)}/${servicesTotal}.`;
  if (partial) message += rateLimited ? ' Rate limit hit — wait ~1 min, then Sync again.' : ' Click Sync Server 3 again to continue.';
  if (legacyHidden) message += ` Hid ${legacyHidden} old broken rows.`;
  return res.status(200).json({
    success: true, source: VS_SOURCE, partial, done: !partial, rate_limited: rateLimited, rows_seen: rows.length,
    upserted: written, inserted: stats.inserted, updated: stats.updated, delisted: stats.delisted,
    services_done: servicesDone, services_total: servicesTotal, ms: Date.now() - started, errors, message
  });
}

async function vsHandleProbe(req, res) {
  if (!(await vsAdminOrCron(req, res))) return;
  const cut = (r) => ({ status: r.status, err: r.err || undefined, sample: (r.text || '').slice(0, 700) });
  const [svc, cty, wa, bal] = await Promise.all([
    vsReq('/customer/services'), vsReq('/customer/countries'), vsReq('/customer/countries?service=wa'), vsReq('/customer/balance')
  ]);
  return res.status(200).json({ success: true, services: cut(svc), countries: cut(cty), countries_for_wa: cut(wa), balance: cut(bal) });
}

async function vsHandlePurgeLegacy(req, res) {
  const a = await requireAdmin(req);
  if (!a.ok) return res.status(a.status).json({ success: false, message: a.message });
  const { data, error } = await supabase.from('number_services').delete().eq('source', VS_SOURCE).lt('country_id', VS_ID_BASE).select('id');
  if (error) return res.status(500).json({ success: false, message: error.message });
  return res.status(200).json({ success: true, deleted: (data || []).length, message: `Deleted ${(data || []).length} old Server 3 rows.` });
}

// ---------------------------------------------------------------- orders
async function vsCreditWallet(userId, amount) {
  const { data, error } = await supabase.rpc('credit_balance', { p_user_id: userId, p_amount: amount });
  if (!error) {
    if (data && typeof data === 'object' && data.new_balance != null) return Number(data.new_balance);
    if (typeof data === 'number') return data;
  }
  const { data: p } = await supabase.from('profiles').select('balance').eq('id', userId).single();
  const nb = Number((p && p.balance) || 0) + amount;
  await supabase.from('profiles').update({ balance: nb }).eq('id', userId);
  return nb;
}

function vsParseOrder(j) {
  const o = (j && (j.order || j.data)) || j || {};
  const status = String(o.status || j?.status || '').toLowerCase();
  const msgs = o.messages || o.sms || j?.messages || [];
  let code = null;
  for (const m of Array.isArray(msgs) ? msgs : []) {
    const c = m && (m.code || m.otp);
    if (c) { code = String(c); break; }
    const t = m && (m.text || m.message || m.body || (typeof m === 'string' ? m : ''));
    const hit = t && String(t).match(/\b(\d{4,8})\b/);
    if (hit) { code = hit[1]; break; }
  }
  if (!code && o.code) code = String(o.code);
  return { status, code };
}

async function vsHandleOrder(req, res) {
  const b = vsBody(req);
  const { country_id, service_id, external_order_id, user_id } = b;
  const iso = vsIdToIso(country_id);
  const serviceId = service_id != null ? String(service_id) : null;
  if (!iso || !serviceId || !user_id) {
    return res.status(400).json({ success: false, message: 'country_id, service_id and user_id are required' });
  }
  if (!vsApiKey()) return res.status(500).json({ success: false, message: 'This SMS server is not available right now. Please contact support.' });

  let originalBalance = 0, price = 0, deducted = false, customerId = null, serviceName = '', countryName = '';
  try {
    const { data: svc } = await supabase.from('number_services')
      .select('service_name, country_name, price, supplier_price, is_available')
      .eq('source', VS_SOURCE).eq('country_id', Number(country_id)).eq('service_id', serviceId).maybeSingle();
    if (!svc) return res.status(404).json({ success: false, message: 'This service is no longer available. Refresh, try another, or contact support.' });
    if (!svc.is_available) return res.status(409).json({ success: false, message: 'This number service is currently out of stock.' });
    serviceName = svc.service_name; countryName = svc.country_name; price = Number(svc.price) || 0;

    const { data: profile } = await supabase.from('profiles').select('balance, customer_id').eq('id', user_id).single();
    if (!profile) return res.status(400).json({ success: false, message: 'User profile not found' });
    originalBalance = Number(profile.balance || 0);
    customerId = profile.customer_id;

    const idem = (external_order_id && String(external_order_id).trim()) || `MJ-VS-${String(user_id).slice(0, 8)}-${Date.now()}`;
    if (external_order_id) {
      const { data: ex } = await supabase.from('number_orders')
        .select('order_id, phone_number, status, price, service_name, country_name, created_at')
        .eq('source', VS_SOURCE).eq('user_id', user_id).eq('idempotency_key', idem).maybeSingle();
      if (ex && ex.order_id) {
        return res.status(200).json({ success: true, replayed: true, message: 'Order already completed', data: {
          order_id: ex.order_id, number: ex.phone_number, status: ex.status || 'waiting_for_code',
          service_name: ex.service_name || serviceName, country_name: ex.country_name || countryName,
          price: ex.price != null ? Number(ex.price) : price, new_balance: originalBalance, created_at: ex.created_at
        } });
      }
    }
    if (originalBalance < price) {
      return res.status(402).json({ success: false, message: 'Insufficient balance', required: price, available: originalBalance });
    }

    let newBalance = originalBalance - price;
    const { data: debited, error: debErr } = await supabase.rpc('debit_balance_if_sufficient', { p_user_id: user_id, p_amount: price });
    if (debErr) {
      const { data: p2 } = await supabase.from('profiles').select('balance').eq('id', user_id).single();
      const b2 = Number((p2 && p2.balance) || 0);
      if (b2 < price) return res.status(402).json({ success: false, message: 'Insufficient balance', required: price, available: b2 });
      const { error: upErr } = await supabase.from('profiles').update({ balance: b2 - price }).eq('id', user_id).gte('balance', price);
      if (upErr) return res.status(500).json({ success: false, message: 'Could not debit your balance. Try again or contact support.' });
      newBalance = b2 - price;
    } else if (debited === false || debited === null || debited === 0) {
      return res.status(402).json({ success: false, message: 'Insufficient balance', required: price, available: originalBalance });
    } else {
      const { data: pa } = await supabase.from('profiles').select('balance').eq('id', user_id).maybeSingle();
      if (pa) newBalance = Number(pa.balance);
    }
    deducted = true;

    const r = await vsReq('/customer/purchase', { method: 'POST', body: { service: serviceId, country: iso }, timeoutMs: 30000 });
    const j = r.json || {};
    const orderId = j.order_id || j.id || (j.order && (j.order.order_id || j.order.id));
    const phone = j.phone_number || j.number || (j.order && (j.order.phone_number || j.order.number)) || null;
    if (!r.ok || j.success === false || !orderId) {
      await vsCreditWallet(user_id, price);
      deducted = false;
      const code = String(j.error || '').toLowerCase();
      const noStock = r.status === 404 || r.status === 409 || /no_numbers|not_available|out_of_stock|unavailable/.test(code);
      try {
        await supabase.from('transactions').insert({
          user_id, customer_id: customerId, type: 'purchase', category: 'MJ SMS', title: serviceName,
          subtitle: `Failed: ${noStock ? 'No stock' : 'Unavailable'}`, amount: `₦${price.toLocaleString()}`,
          amount_ngn: price, status: 'failed', notes: (r.text || r.err || '').slice(0, 500)
        });
      } catch (_) { /* optional */ }
      return res.status(400).json({
        success: false, code: j.error || 'SUPPLIER_ERROR',
        message: noStock ? 'No numbers available for this service/country right now. Try another country or service.'
          : 'Purchase failed. Your balance has been restored.'
      });
    }

    const row = {
      source: VS_SOURCE, user_id, customer_id: customerId, order_id: String(orderId), idempotency_key: idem,
      country_id: Number(country_id), country_name: countryName, service_id: serviceId, service_name: serviceName,
      phone_number: phone, price, supplier_price: Number(svc.supplier_price) || null, currency: 'NGN',
      status: 'waiting_for_code', code: null, time_left: null, refunded: false
    };
    let { error: insErr } = await supabase.from('number_orders').insert(row);
    if (insErr) { await new Promise((r2) => setTimeout(r2, 400)); ({ error: insErr } = await supabase.from('number_orders').insert(row)); }
    if (insErr) console.error('[vsms order] number_orders insert failed after charge:', insErr.message, { orderId, user_id });
    try {
      await supabase.from('transactions').insert({
        user_id, customer_id: customerId, type: 'purchase', category: 'MJ SMS', title: serviceName,
        subtitle: `${countryName} · waiting for SMS`, amount: `₦${price.toLocaleString()}`, amount_ngn: price,
        status: 'pending', supplier_order: j
      });
    } catch (_) { /* optional */ }

    return res.status(200).json({ success: true, message: 'Number purchased successfully', data: {
      order_id: String(orderId), number: phone, status: 'waiting_for_code', service_name: serviceName,
      country_name: countryName, price, new_balance: newBalance, created_at: new Date().toISOString()
    } });
  } catch (err) {
    console.error('vsms order error:', err);
    if (deducted) { try { await vsCreditWallet(user_id, price); } catch (e) { console.error('CRITICAL vsms auto-restore failed', e); } }
    return res.status(500).json({ success: false, message: deducted ? 'Something went wrong. Your balance has been restored.' : 'Something went wrong. Please try again.' });
  }
}

async function vsFindOrder(orderId, userId) {
  const q = supabase.from('number_orders')
    .select('id, user_id, order_id, status, phone_number, created_at, service_name, country_name, price, refunded, customer_id, code, source')
    .eq('source', VS_SOURCE).eq('order_id', String(orderId));
  if (userId) q.eq('user_id', userId);
  const { data } = await q.maybeSingle();
  return data;
}
const vsView = (o, extra) => ({
  order_id: o.order_id, status: o.status, number: o.phone_number, code: o.code || null, created_at: o.created_at,
  service_name: o.service_name, country_name: o.country_name, price: o.price, refunded: !!o.refunded, ...(extra || {})
});

async function vsMarkCompleted(order, code) {
  const { data } = await supabase.from('number_orders')
    .update({ status: 'completed', code: String(code), updated_at: new Date().toISOString() })
    .eq('id', order.id).eq('refunded', false).select('id').maybeSingle();
  if (data) {
    try {
      await supabase.from('transactions')
        .update({ status: 'completed', subtitle: `${order.country_name || ''} · code received`.trim() })
        .eq('user_id', order.user_id).eq('category', 'MJ SMS').eq('type', 'purchase').eq('status', 'pending')
        .eq('amount_ngn', Number(order.price || 0));
    } catch (_) { /* cosmetic */ }
  }
  return !!data;
}

/** Shared by check + expire_stale: ask the supplier, then complete / refund / keep waiting. */
async function vsResolveOrder(order, { allowExpire = true } = {}) {
  const age = order.created_at ? Date.now() - new Date(order.created_at).getTime() : 0;
  const r = await vsReq('/customer/order/' + encodeURIComponent(order.order_id));
  if (r.ok) {
    const { status, code } = vsParseOrder(r.json);
    if (code) { await vsMarkCompleted(order, code); return { kind: 'completed', code, status }; }
    if (['cancelled', 'canceled', 'expired', 'refunded', 'failed'].includes(status)) return { kind: 'dead', status };
  } else if (r.status !== 404 && !(allowExpire && age >= EXPIRY_MS)) {
    return { kind: 'error', http: r.status };
  }
  if (allowExpire && age >= EXPIRY_MS) {
    try { await vsReq('/customer/cancel/' + encodeURIComponent(order.order_id), { method: 'POST' }); } catch (_) { /* best effort */ }
    return { kind: 'expired' };
  }
  return { kind: 'waiting' };
}

async function vsHandleCheck(req, res) {
  const { order_id, user_id } = vsBody(req);
  if (!order_id || !user_id) return res.status(400).json({ success: false, message: 'order_id and user_id are required' });
  try {
    const order = await vsFindOrder(order_id, user_id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found for this account' });
    if (order.status === 'completed' || order.refunded || ['refunded', 'expired', 'cancelled'].includes(order.status)) {
      return res.status(200).json({ success: true, data: vsView(order) });
    }
    const out = await vsResolveOrder(order);
    if (out.kind === 'completed') return res.status(200).json({ success: true, data: vsView(order, { status: 'completed', code: out.code }) });
    if (out.kind === 'dead' || out.kind === 'expired') {
      const st = out.kind === 'expired' ? 'expired' : 'refunded';
      const rf = await claimAndRefundOrder(order, user_id, { status: st, subtitle: st === 'expired' ? 'Expired — no SMS, balance restored' : 'No SMS — balance restored' });
      return res.status(200).json({ success: true, data: vsView(order, { status: st, refunded: true, refunded_amount: rf.refunded_amount, new_balance: rf.new_balance }) });
    }
    if (out.kind === 'error') return res.status(502).json({ success: false, message: 'Could not reach the supplier. Try again.' });
    return res.status(200).json({ success: true, data: vsView(order, { status: 'waiting_for_code' }) });
  } catch (err) {
    console.error('vsms check error:', err);
    return res.status(500).json({ success: false, message: 'Something went wrong checking this order.' });
  }
}

async function vsHandleCancel(req, res) {
  const { order_id, user_id } = vsBody(req);
  if (!order_id || !user_id) return res.status(400).json({ success: false, message: 'order_id and user_id are required' });
  try {
    const order = await vsFindOrder(order_id, user_id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found for this account' });
    if (order.refunded || ['refunded', 'cancelled', 'expired'].includes(order.status)) {
      return res.status(409).json({ success: false, message: 'This order was already refunded.' });
    }
    if (order.status === 'completed') {
      return res.status(409).json({ success: false, code: 'NUMBER_CODE_ALREADY_RECEIVED', message: 'A code was already received — this order cannot be cancelled.' });
    }
    const age = order.created_at ? Date.now() - new Date(order.created_at).getTime() : VS_CANCEL_COOLDOWN_MS;
    if (age < VS_CANCEL_COOLDOWN_MS) {
      const wait = Math.ceil((VS_CANCEL_COOLDOWN_MS - age) / 1000);
      return res.status(400).json({ success: false, code: 'EARLY_CANCEL_DENIED', wait_seconds: wait, message: `Cancel available in ${wait}s. Please wait a moment.` });
    }
    // never cancel a number that already received its SMS
    const peek = await vsReq('/customer/order/' + encodeURIComponent(order.order_id));
    if (peek.ok) {
      const { code } = vsParseOrder(peek.json);
      if (code) {
        await vsMarkCompleted(order, code);
        return res.status(409).json({ success: false, code: 'NUMBER_CODE_ALREADY_RECEIVED', message: 'A code was already received — this order cannot be cancelled.' });
      }
    }
    const r = await vsReq('/customer/cancel/' + encodeURIComponent(order.order_id), { method: 'POST' });
    if (r.status === 425) {
      return res.status(400).json({ success: false, code: 'EARLY_CANCEL_DENIED', wait_seconds: 30, message: 'Cancel is not available yet. Try again in a moment.' });
    }
    const already = r.status === 404 || r.status === 409 || /already|cancel|expired|refund/i.test(String(r.text || '')) && r.status < 500 && !r.ok;
    if (!r.ok && !already) {
      return res.status(400).json({ success: false, code: 'CANCEL_FAILED', message: 'Could not cancel this order right now. Try again shortly.' });
    }
    const rf = await claimAndRefundOrder(order, user_id, { status: 'refunded', subtitle: 'Cancelled — balance restored' });
    if (!rf.refunded && rf.reason === 'already_final') return res.status(409).json({ success: false, message: 'This order was already refunded.' });
    return res.status(200).json({ success: true, data: { order_id, status: 'refunded', refunded: true, refunded_amount: rf.refunded_amount || Number(order.price || 0), new_balance: rf.new_balance } });
  } catch (err) {
    console.error('vsms cancel error:', err);
    return res.status(500).json({ success: false, message: 'Something went wrong cancelling this order.' });
  }
}


/** Refund / complete Server 3 (REST) orders older than 20 min. Called from handleExpireStale. */
async function vsExpireStale(rows) {
  let expired = 0, completed = 0, skipped = 0;
  const list = (rows || []).filter((o) =>
    String(o.source || '').toLowerCase() === VS_SOURCE && o.refunded !== true && !/^\d+$/.test(String(o.order_id || ''))
  );
  for (const o of list) {
    try {
      const out = await vsResolveOrder(o);
      if (out.kind === 'completed') { completed += 1; continue; }
      if (out.kind === 'dead' || out.kind === 'expired') {
        const rf = await claimAndRefundOrder(o, o.user_id, { status: 'expired', subtitle: 'Expired — no SMS, balance restored' });
        if (rf.refunded) expired += 1; else skipped += 1;
      } else skipped += 1;
    } catch (e) { skipped += 1; }
  }
  return { scanned: list.length, expired, completed, skipped };
}

/** Which server does this order belong to? Used so check/cancel go to the right supplier. */
async function orderIsServer3Rest(req) {
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!b.order_id || !b.user_id) return false;
    if (/^\d+$/.test(String(b.order_id))) return false; // legacy numeric id → existing handlers
    const { data } = await supabase.from('number_orders').select('source')
      .eq('order_id', String(b.order_id)).eq('user_id', b.user_id).maybeSingle();
    return !!data && String(data.source || '').toLowerCase() === VS_SOURCE;
  } catch (_) { return false; }
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
  const act = String(action || '').toLowerCase();
  const isVsSync = act === 'vsms_sync' || act === 'virtualsms_sync' || act === 'server3_sync';

  if (req.method === 'GET') {
    if (act === 'expire_stale' || act === 'expire-stale') {
      return handleExpireStale(req, res);
    }
    if (isVsSync) return vsHandleSync(req, res);
    if (act === 'vsms_probe') return vsHandleProbe(req, res);
    if (act === 'vsms_purge_legacy') return vsHandlePurgeLegacy(req, res);
    // action is one of: null (continue/cron), 'start', 'status' — handled inside handleSync (Server 1)
    return handleSync(req, res);
  }

  if (req.method === 'POST') {
    if (isVsSync) return vsHandleSync(req, res);
    if (action === 'order') {
      let b = {};
      try { b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (_) { b = {}; }
      if (resolveSupplier(req, b).source === 'virtualsms') return vsHandleOrder(req, res);
      return handleOrder(req, res);
    }
    if (action === 'check') {
      if (await orderIsServer3Rest(req)) return vsHandleCheck(req, res);
      return handleCheck(req, res);
    }
    if (action === 'cancel') {
      if (await orderIsServer3Rest(req)) return vsHandleCancel(req, res);
      return handleCancel(req, res);
    }
    if (act === 'expire_stale' || act === 'expire-stale') return handleExpireStale(req, res);
    return res.status(400).json({
      success: false,
      message: "POST requires ?action=order, ?action=check, ?action=cancel, or ?action=vsms_sync"
    });
  }

  return res.status(405).json({ success: false, message: 'Method not allowed' });
}
