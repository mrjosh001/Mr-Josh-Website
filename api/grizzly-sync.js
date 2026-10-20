import { createClient } from '@supabase/supabase-js';
import { applyMarkup } from '../lib/pricing.js';
import { createHero } from '../lib/hero.js';

/**
 * /api/grizzly-sync — GrizzlySMS (Server 1) + VirtualSMS (Server 3) operations in one file.
 *
 * GET  /api/grizzly-sync                  → continue/kick off Server 1 catalog sync (cron + admin "Sync" button)
 * GET  /api/grizzly-sync?action=start      → start a fresh Server 1 sync job
 * GET  /api/grizzly-sync?action=status     → Server 1 sync job progress
 * GET  /api/grizzly-sync?action=vsms_sync  → Server 3 (VirtualSMS) FULL catalog sync (admin / cron)
 *        &force=1      restart the cycle from the first service and ignore the "already running" lock
 *        &service=wa   re-sync one service only
 * GET  /api/grizzly-sync?action=vsms_probe → Server 3: show what VirtualSMS really returns (admin)
 * GET  /api/grizzly-sync?action=vsms_purge_legacy → Server 3: delete old broken numeric-id rows (admin)
 * GET  /api/grizzly-sync?action=hero_sync  → Server 1 second OTP pool (source=herosms) catalog sync (admin / cron) — see lib/hero.js
 * GET  /api/grizzly-sync?action=hero_probe → second pool: show what the supplier really returns (admin)
 * POST /api/grizzly-sync?action=order      → buy a number   (provider=virtualsms → Server 3; source=herosms → second pool)
 * POST /api/grizzly-sync?action=check      → poll for SMS code (routes by the order's saved source)
 * POST /api/grizzly-sync?action=cancel     → cancel + refund   (routes by the order's saved source)
 *
 * Server 3 uses VirtualSMS' documented MODERN REST API (https://virtualsms.io/api/v1, X-API-Key):
 * ISO-2 country codes with real names, real per-country prices, POST /customer/purchase.
 * number_services.country_id is an integer column, so an ISO code is stored as a reversible integer
 * (vsIsoToId / vsIdToIso); the real name goes in country_name.
 * Server 1 code below is unchanged.
 *
 * Env: GRIZZLYSMS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET (required for cron calls)
 * Optional: USD_TO_NGN_RATE (default 1500), MIN_PROFIT_NGN (500), VIRTUALSMS_API_KEY (Server 3),
 *           VSMS_TIME_BUDGET_MS (200000), VSMS_MIN_GAP_MS (1500), VSMS_SERVICE_LIMIT (5000),
 *           HEROSMS_API_KEY (Server 1 second pool)
 */

/* MJHUB_SERVER3_VIRTUALSMS=5 2026-10-18 Server 3: FULL resumable catalog sync (all services, all countries, pagination), price guards on order, secure cron auth */
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
  // Static seed for the most common apps (always wins over bare codes).
  const map = Object.assign(Object.create(null), GRIZZLY_SERVICE_NAMES);

  // Drop placeholder "Grizzly service xx" style labels if any slipped in.
  for (const k of Object.keys(map)) {
    const v = String(map[k] || '');
    if (/^grizzly\s+service/i.test(v) || (v.length <= 3 && v.toLowerCase() === k.toLowerCase())) {
      // keep short codes only if no better name; leave seed entries that are real brands
    }
    if (/^grizzly\s+service/i.test(v)) delete map[k];
  }

  const mergePayload = (data) => {
    if (!data) return;
    const add = (code, name) => {
      if (!code) return;
      const c = String(code).trim();
      if (!c) return;
      const n = name != null ? String(name).trim() : '';
      // Prefer a real human name over the bare code
      if (n && n.toLowerCase() !== c.toLowerCase() && !/^grizzly\s+service/i.test(n)) {
        map[c] = n;
        map[c.toLowerCase()] = n;
      } else if (!map[c] && !map[c.toLowerCase()]) {
        // no name yet — leave unset so UI can still try other enrichers
      }
    };
    // getServicesList shape: { status, services: [ { code, name } ] }
    const list =
      (data && Array.isArray(data.services) && data.services) ||
      (Array.isArray(data) && data) ||
      null;
    if (list) {
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        add(item.code || item.service || item.id, item.name || item.title || item.eng);
      }
      return;
    }
    if (typeof data === 'object') {
      for (const [key, val] of Object.entries(data)) {
        if (val == null || key === 'status' || key === 'services') continue;
        if (typeof val === 'string') add(key, val);
        else if (typeof val === 'object') {
          const code = val.code || val.service || val.id || key;
          const name = val.name || val.title || val.eng || val.rus;
          add(code, name);
          if (key && !/^\d+$/.test(key)) add(key, name || code);
        }
      }
    }
  };

  // SMS-Activate / Grizzly: getServicesList returns full {code,name} catalogue.
  // getServices is a secondary fallback (some panels only implement one).
  for (const action of ['getServicesList', 'getServices']) {
    try {
      const res = await callGrizzly(apiKey, { action });
      if (!res.text || res.text === 'BAD_KEY') continue;
      let data = null;
      try {
        data = JSON.parse(res.text);
      } catch {
        data = null;
      }
      if (data) mergePayload(data);
    } catch (e) {
      console.warn(action + ' name enrich failed', e && e.message);
    }
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
      title: countryName ? `${serviceName} · ${countryName}` : serviceName,
      subtitle: `${countryName || ''} · waiting for SMS`.trim(),
      amount: `₦${price.toLocaleString()}`,
      amount_ngn: price,
      status: 'pending',
      notes: orderData && (orderData.activationId || orderData.id)
        ? ('sms_order:' + String(orderData.activationId || orderData.id))
        : null,
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
      .or('refunded.eq.false,refunded.is.null')
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

  // Claim won — credit wallet exactly once for this order
  const refundAmount = Number(order.price != null ? order.price : claimed.price) || 0;
  let newBalance = null;

  if (refundAmount > 0) {
    const { data: credited, error: credErr } = await supabase.rpc('credit_balance', {
      p_user_id: userId,
      p_amount: refundAmount
    });
    if (credErr) {
      console.error('[claimAndRefundOrder] credit_balance', credErr.message);
      const { data: still } = await supabase
        .from('number_orders')
        .select('id, refunded')
        .eq('id', order.id)
        .eq('refunded', true)
        .maybeSingle();
      if (still && still.id) {
        const { data: profile } = await supabase.from('profiles').select('balance').eq('id', userId).maybeSingle();
        if (profile) {
          const prevBal = Number(profile.balance || 0);
          const { data: bumped, error: balErr } = await supabase
            .from('profiles')
            .update({ balance: prevBal + refundAmount })
            .eq('id', userId)
            .eq('balance', prevBal)
            .select('balance')
            .maybeSingle();
          if (balErr) console.error('[claimAndRefundOrder] balance credit failed', balErr);
          else if (bumped) newBalance = Number(bumped.balance);
          else {
            const { data: p2 } = await supabase.from('profiles').select('balance').eq('id', userId).maybeSingle();
            if (p2) newBalance = Number(p2.balance);
          }
        }
      }
    } else if (credited != null && typeof credited === 'object' && credited.new_balance != null) {
      newBalance = Number(credited.new_balance);
    } else if (typeof credited === 'number') {
      newBalance = credited;
    } else {
      const { data: p3 } = await supabase.from('profiles').select('balance').eq('id', userId).maybeSingle();
      if (p3) newBalance = Number(p3.balance);
    }
  }

  // Update the SAME purchase transaction — never insert a second refund row
  const txStatus = String(finalStatus).toLowerCase() === 'expired' ? 'expired' : 'cancelled';
  const orderRef = order.order_id ? String(order.order_id) : '';
  try {
    if (orderRef) {
      await supabase
        .from('transactions')
        .update({ status: txStatus, subtitle, notes: notes || ('sms_order:' + orderRef) })
        .eq('user_id', userId)
        .eq('category', category)
        .eq('type', 'purchase')
        .in('status', ['pending', 'completed', 'success'])
        .ilike('notes', '%sms_order:' + orderRef + '%');
    }
  } catch (e) {
    console.warn('[claimAndRefundOrder] tx update by order ref', e.message || e);
  }
  try {
    await supabase
      .from('transactions')
      .update({ status: txStatus, subtitle, ...(notes ? { notes } : {}) })
      .eq('user_id', userId)
      .eq('category', category)
      .eq('type', 'purchase')
      .in('status', ['pending', 'completed', 'success'])
      .eq('amount_ngn', refundAmount);
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
  // Only the secret counts as cron. (The old "x-vercel-cron: 1" header check is removed: any client
  // can send that header, so it let anyone run this job.)
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

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

  // Server 1 second OTP pool (source=herosms) — handled inside lib/hero.js, never mixed with the loop above
  let pool2 = null;
  try {
    pool2 = await HERO.expireStale(rows || []);
  } catch (e) {
    console.error('[pool2 expire_stale]', e.message);
  }

  return res.status(200).json({
    success: true,
    scanned: (stale || []).length,
    expired,
    skipped,
    server3,
    pool2,
    cutoff
  });
}


// ===========================================================================
// SERVER 3 — VirtualSMS (modern REST API). Real country names + real prices.
// ===========================================================================
// Docs facts this code is built on (https://virtualsms.io/api/v1, header X-API-Key):
//  - GET  /customer/countries                → { success, countries:[{country_id:"ID", country_name, min_price, services:"tg,wa"}] }
//  - GET  /customer/countries?service=wa     → countries for that service WITH exact pricing (only countries that have it)
//  - POST /customer/purchase {service,country} → { order_id, phone_number, price, status:"waiting" }
//  - GET  /customer/order/{id}               → { status: waiting|completed|cancelled|expired, sms_received, messages[] }
//  - POST /customer/cancel/{id}              → 425 inside the first 120 s; 400 once an SMS arrived; error bodies are { error: "..." }
//  - Rate limit ~60 requests / minute.
//
// What was wrong with the old Server 3 sync (live DB on 2026-10-18: 54 countries, 150 services, nothing else):
//  - VirtualSMS docs: /customer/services and /customer/countries return PHYSICAL-SIM numbers only unless the
//    request carries include_voip=true. The old sync never sent it, so everything VoIP-backed that the supplier
//    dashboard shows (and the 54-country ceiling seen in the DB) was invisible to the site;
//  - it only ever priced the first 150 services (VS_SERVICE_LIMIT) and then reported "done";
//  - nothing ran it on a schedule (no cron), so the catalog only grew when someone clicked Sync;
//  - it protected only price_source='admin', but the admin table saves hand-set prices as 'manual',
//    so a sync could overwrite them; it also never repriced rows when the supplier cost went up.
//
// This version is INCREMENTAL. Every run: (1) 2 cheap calls (services + countries, VoIP included) and a diff against
// the DB to find services / countries / country-service pairs that are not in the DB yet; (2) price-fetch only those
// services and insert only the missing rows; (3) with the time left, walk the rest of the catalog with a saved cursor
// looking for price / stock changes and write ONLY rows that changed. Nothing is rewritten wholesale: unchanged rows
// are not touched. ?only_new=1 skips step 3.

const VS_REST = 'https://virtualsms.io/api/v1';
const VS_SOURCE = 'virtualsms';
const VS_ID_BASE = 1000;
const VS_CANCEL_COOLDOWN_MS = 120 * 1000;
const VS_TIME_BUDGET_MS = Number(process.env.VSMS_TIME_BUDGET_MS) || 200000; // function limit is 300 s; rows are written after this
const VS_MIN_GAP_MS = Number(process.env.VSMS_MIN_GAP_MS) || 1500; // ~40 requests/minute, leaves room for live orders
const VS_SERVICE_LIMIT = Number(process.env.VSMS_SERVICE_LIMIT) || 5000;
const VS_MAX_PAGES = 25;
const VS_DISCOVERY_MAX = 80; // max services price-fetched per run for newly found pairs
const VS_INCLUDE_VOIP = String(process.env.VSMS_INCLUDE_VOIP || '1') !== '0'; // docs: default is physical SIM only
const VS_LOCK_MS = 6 * 60 * 1000;
const VS_JOB_KEY = 'virtualsms';
const VS_POPULAR_RE = /whatsapp|telegram|google|gmail|facebook|instagram|twitter|^x$|discord|tiktok|snapchat|microsoft|amazon|uber|netflix|paypal|tinder|linkedin|viber|wechat|apple|line|bumble|yahoo|openai|chatgpt|signal|vk|binance/i;
const VS_POPULAR_CODES = ['wa', 'tg', 'go', 'fb', 'ig', 'tw', 'ds', 'lf', 'tt', 'fu', 'mm', 'am', 'ub', 'nf', 'ts', 'oi', 'tn', 'vi', 'we', 'wx'];

const vsApiKey = () => String(process.env.VIRTUALSMS_API_KEY || process.env.VIRTUAL_SMS_API_KEY || '').trim();
const vsVoip = (path) => (VS_INCLUDE_VOIP ? path + (path.includes('?') ? '&' : '?') + 'include_voip=true' : path);
const vsSleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Same inputs Servers 1 & 2 use for pricing (lib/pricing.js applyMarkup)
const vsRate = () => Number(process.env.USD_TO_NGN_RATE) || Number(process.env.USD_TO_NGN) || 1500;
const vsMinProfit = () => Number(process.env.MIN_PROFIT_NGN) || 500;
const vsFloorNgn = (usd) => Math.ceil(usd * vsRate() + vsMinProfit());

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
const VS_STOCK_KEYS = ['available_phones', 'available_count', 'count', 'stock', 'quantity', 'qty', 'numbers', 'available', 'physical_count'];
function vsStockOf(o) {
  const n = vsFirstNum(o, VS_STOCK_KEYS);
  if (n > 0) return Math.floor(n);
  if (o && (o.available === true || o.in_stock === true)) return 1;
  return 0;
}
/** True when the API actually sent a stock field (even if it says 0). */
function vsStockKnown(o) {
  return !!o && (VS_STOCK_KEYS.some((k) => o[k] != null && typeof o[k] !== 'boolean') || o.available === false || o.in_stock === false);
}
function vsPriceOf(o) {
  return vsFirstNum(o, ['price_usd', 'price', 'our_price', 'cost', 'amount', 'min_price', 'retail']);
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
  for (const v of [c.country_id, c.iso, c.iso2, c.country_code, c.code, c.country, c._key]) {
    const s = String(v == null ? '' : v).toUpperCase();
    if (/^[A-Z]{2}$/.test(s)) return s;
  }
  return null;
}
function vsCountryNameOf(c, iso) {
  for (const v of [c.country_name, c.name, c.eng, c.english, c.title, c.label, c.country]) {
    const t = typeof v === 'string' ? v.trim() : '';
    // skip empty values, 2-letter codes like "IE", and plain numbers
    if (t.length > 2 && !/^\d+$/.test(t)) return t;
  }
  return vsRegionName(iso) || iso;
}
function vsServiceCode(s) {
  return String(s.service_id || s.code || s.service || s.service_code || s.slug || s.id || s._key || '').trim();
}
function vsServiceNameOf(s, code) {
  const n = s.name || s.service_name || s.title || s.display_name;
  return n && String(n).trim() ? String(n).trim() : code.toUpperCase();
}
/** Pagination hints, wherever the API puts them (top level or in pagination/meta/paging). */
function vsPageMeta(j) {
  const base = j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  const m = base.pagination || base.meta || base.paging || {};
  const src = Object.assign({}, base, m);
  return {
    total: vsNum(src.total ?? src.total_count ?? src.totalItems ?? src.count_total),
    pages: vsNum(src.total_pages ?? src.pages ?? src.last_page ?? src.pageCount),
    hasMore: src.has_more === true || src.hasMore === true || src.next_page != null ||
      (src.next != null && src.next !== false && src.next !== '')
  };
}
/** A 200 reply that is really an error ({success:false}/{error}) or not JSON must never be read as "no data". */
function vsReplyProblem(r) {
  if (!r.ok) return `HTTP ${r.status || 'no reply'}`;
  if (r.json == null) return 'reply was not JSON';
  if (typeof r.json === 'object' && !Array.isArray(r.json) && (r.json.success === false || r.json.error)) {
    return String(r.json.error || r.json.message || 'success:false').slice(0, 120);
  }
  return null;
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

// Cron = the CRON_SECRET bearer only. (The old "x-vercel-cron: 1" header check is removed: any client can
// send that header, so it let anyone start a sync and burn the supplier rate limit.)
function vsIsCron(req) {
  const h = req.headers.authorization || '';
  return !!process.env.CRON_SECRET && h === `Bearer ${process.env.CRON_SECRET}`;
}
async function vsAdminOrCron(req, res) {
  if (vsIsCron(req)) return true;
  const a = await requireAdmin(req);
  if (a.ok) return true;
  res.status(a.status).json({ success: false, message: a.message });
  return false;
}
const vsBody = (req) => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}));

// ---------------------------------------------------------------- run lock + resume cursor (existing sync_jobs table)
async function vsGetJob() {
  try {
    const { data } = await supabase.from('sync_jobs').select('status, updated_at, cursor_index').eq('source', VS_JOB_KEY).maybeSingle();
    return data || null;
  } catch (_) { return null; }
}
async function vsSetJob(fields) {
  try { await supabase.from('sync_jobs').upsert({ source: VS_JOB_KEY, updated_at: new Date().toISOString(), ...fields }); } catch (_) { /* best effort */ }
}
function vsIsLocked(job) {
  return !!job && job.status === 'running' && !!job.updated_at && Date.now() - new Date(job.updated_at).getTime() < VS_LOCK_MS;
}

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

// ---------------------------------------------------------------- fetch helpers (paced + paginated)
/** The global /services and /countries lists (docs show no pagination; only follows it if the reply says there is more). */
async function vsFetchPagedList(path, keys, idFn, pace) {
  const sep = path.includes('?') ? '&' : '?';
  const seen = new Set();
  const items = [];
  let first = null;
  for (let page = 1; page <= VS_MAX_PAGES; page++) {
    await pace();
    const r = await vsReq(page === 1 ? path : `${path}${sep}page=${page}`);
    if (page === 1) first = r;
    if (r.status === 429) { if (page === 1) return { ok: false, rateLimited: true, status: 429, items, text: r.text }; break; }
    if (page === 1) { const bad = vsReplyProblem(r); if (bad) return { ok: false, status: r.status, problem: bad, items, text: r.text, err: r.err }; }
    if (!r.ok) break; // page=N rejected → keep what we have
    const list = vsAsList(r.json, keys);
    let fresh = 0;
    for (const it of list) {
      const id = idFn(it);
      if (id) { if (seen.has(id)) continue; seen.add(id); }
      items.push(it);
      fresh += 1;
    }
    if (!list.length || !fresh) break;
    const meta = vsPageMeta(r.json);
    const more = meta.hasMore || (meta.pages && page < meta.pages) || (meta.total && items.length < meta.total);
    if (!more) break;
  }
  return { ok: true, status: first ? first.status : 200, items, text: first ? first.text : '' };
}

/**
 * One service → every country that has it, following pagination.
 * truncated=true means "we cannot be sure we saw everything" (deadline, rate limit, page error while the
 * supplier said there was more, page limit) — in that case nothing is delisted for this service.
 */
async function vsFetchServiceCountries(code, expectedCount, pace, deadline) {
  const base = vsVoip('/customer/countries?service=' + encodeURIComponent(code));
  const seen = new Set();
  const items = [];
  let pages = 0;
  let truncated = false;
  let natural = false;       // the loop ended because the supplier ran out of data
  let mustHaveMore = false;  // the supplier (or the supplier's own country list) says there is more than we have
  let firstKeys = null;

  for (let page = 1; page <= VS_MAX_PAGES; page++) {
    if (Date.now() > deadline) { truncated = true; break; }
    await pace();
    const r = await vsReq(page === 1 ? base : `${base}&page=${page}`, { timeoutMs: 15000 });
    pages += 1;
    if (r.status === 429) return { rateLimited: true, items, seen, pages, truncated: true };
    if (page === 1) {
      const bad = vsReplyProblem(r);
      if (bad) return { error: bad, items, seen, pages, truncated: true };
      if (r.json && typeof r.json === 'object') firstKeys = Object.keys(r.json).slice(0, 12);
    } else if (!r.ok) {
      natural = !mustHaveMore;
      if (mustHaveMore) truncated = true;
      break; // the supplier rejects/ignores page=N → keep what we have
    }
    const list = vsAsList(r.json, ['countries', 'data', 'items', 'results']);
    let fresh = 0;
    for (const c of list) {
      const iso = vsCountryIso(c);
      if (iso) { if (seen.has(iso)) continue; seen.add(iso); }
      items.push(c);
      fresh += 1;
    }
    if (!list.length || !fresh) {
      natural = !mustHaveMore;
      if (mustHaveMore) truncated = true;
      break;
    }
    const meta = vsPageMeta(r.json);
    const explicitMore = meta.hasMore || (meta.pages && page < meta.pages) || (meta.total && seen.size < meta.total);
    mustHaveMore = explicitMore;
    if (!explicitMore) { natural = true; break; }
  }
  if (!natural && !truncated) truncated = true; // ran out of pages
  return { items, seen, pages, truncated, firstKeys };
}

// ---------------------------------------------------------------- the sync
async function vsRunSync(req) {
  const q = req.query || {};
  const force = q.force === '1' || q.force === 'true';
  const onlyService = String(q.service || '').trim();
  const onlyNew = q.only_new === '1' || q.only_new === 'true'; // discovery only: skip the price/stock refresh walk
  const started = Date.now();
  const deadline = started + VS_TIME_BUDGET_MS - 6000;
  const rate = vsRate();
  const errors = [];
  const note = (m) => { if (errors.length < 20) errors.push(m); };

  let lastCall = 0;
  const pace = async () => {
    const wait = lastCall + VS_MIN_GAP_MS - Date.now();
    if (wait > 0) await vsSleep(wait);
    lastCall = Date.now();
  };

  // 1) service list + country list (both paginated: VirtualSMS caps a single reply at ~54 items)
  const svcRes = await vsFetchPagedList(vsVoip('/customer/services'), ['services', 'data', 'items', 'results'], (s) => vsServiceCode(s), pace);
  if (!svcRes.ok) {
    return { status: svcRes.rateLimited ? 429 : 502, body: {
      success: false,
      message: `VirtualSMS services call failed (${svcRes.problem || 'HTTP ' + (svcRes.status || 'no reply')}). ${svcRes.status === 401 ? 'Check VIRTUALSMS_API_KEY.' : ''}`,
      raw_hint: (svcRes.err || svcRes.text || '').slice(0, 160)
    } };
  }
  const ctyRes = await vsFetchPagedList(vsVoip('/customer/countries'), ['countries', 'data', 'items', 'results'], (c) => vsCountryIso(c), pace);

  const services = svcRes.items
    .map((s) => { const code = vsServiceCode(s); return code ? { code, name: vsServiceNameOf(s, code) } : null; })
    .filter(Boolean);
  if (!services.length) {
    return { status: 502, body: { success: false, message: 'VirtualSMS returned no services.', raw_hint: (svcRes.text || '').slice(0, 200) } };
  }
  const svcName = new Map(services.map((s) => [s.code, s.name]));

  // supplier's own country list: which countries carry which services (the "services" field is "tg,wa,ig")
  const countryList = ctyRes.ok ? ctyRes.items : [];
  const isoName = new Map();
  const expected = new Map(); // service code -> Set(ISO)
  for (const c of countryList) {
    const iso = vsCountryIso(c);
    if (!iso) continue;
    isoName.set(iso, vsCountryNameOf(c, iso));
    const raw = c.services || c.available_services;
    const codes = Array.isArray(raw)
      ? raw.map((x) => (typeof x === 'string' ? x : vsServiceCode(x || {})))
      : String(raw || '').split(/[,\s]+/);
    for (const code of codes) {
      const k = String(code || '').trim();
      if (!k) continue;
      if (!expected.has(k)) expected.set(k, new Set());
      expected.get(k).add(iso);
    }
  }

  const existing = await vsLoadExisting();

  // 2) DISCOVERY — what does the supplier list that the DB does not have yet?
  //    (from the two cheap list calls above: no per-service price calls needed to know this)
  const dbServices = new Set();
  const dbCountries = new Set();
  for (const r of existing.values()) { dbServices.add(r.service_id); dbCountries.add(r.country_id); }
  const newServiceCodes = services.filter((s) => !dbServices.has(s.code)).map((s) => s.code);
  const newCountryIsos = [];
  for (const c of countryList) {
    const iso = vsCountryIso(c);
    const cid = iso ? vsIsoToId(iso) : null;
    if (cid != null && !dbCountries.has(cid)) newCountryIsos.push(iso);
  }
  const newPairsBySvc = new Map(); // service code -> number of (country, service) pairs the DB lacks
  let newPairsTotal = 0;
  for (const [code, isos] of expected) {
    if (!svcName.has(code)) continue;
    let n = 0;
    for (const iso of isos) { const cid = vsIsoToId(iso); if (cid != null && !existing.has(`${cid}|${code}`)) n += 1; }
    if (n) { newPairsBySvc.set(code, n); newPairsTotal += n; }
  }
  for (const code of newServiceCodes) if (!newPairsBySvc.has(code)) newPairsBySvc.set(code, 0); // service with no country info yet: still fetch it once

  // 3a) which services to price-fetch now.
  //     tier 1 = services with missing pairs (new countries / new services), most missing first
  //     tier 2 = popular services (price/stock check, capped at 40% of the budget)
  //     tier 3 = everything else, walked with a cursor saved in sync_jobs so each run continues where the last stopped
  const rank = (s) => {
    const pi = VS_POPULAR_CODES.indexOf(s.code);
    if (pi >= 0) return pi;
    return VS_POPULAR_RE.test(s.name) ? 100 : 1000;
  };
  const ordered = services
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => rank(a) - rank(b) || a.i - b.i)
    .slice(0, VS_SERVICE_LIMIT);
  const discoveryQueue = ordered
    .filter((s) => newPairsBySvc.has(s.code))
    .sort((a, b) => (newPairsBySvc.get(b.code) || 0) - (newPairsBySvc.get(a.code) || 0) || rank(a) - rank(b))
    .slice(0, VS_DISCOVERY_MAX);
  const discoverySet = new Set(discoveryQueue.map((s) => s.code));
  const prioritySet = new Set(VS_POPULAR_CODES);
  const priority = ordered.filter((s) => prioritySet.has(s.code) && !discoverySet.has(s.code));
  const rest = ordered.filter((s) => !prioritySet.has(s.code)); // stable order → the saved cursor stays valid between runs
  const restIndex = new Map(rest.map((s, i) => [s.code, i]));
  const job = await vsGetJob();
  let start = 0;
  if (!force && !onlyService && job && Number.isInteger(job.cursor_index) && job.cursor_index > 0 && job.cursor_index < rest.length) {
    start = job.cursor_index;
  }
  const queue = onlyService
    ? ordered.filter((s) => s.code === onlyService)
    : (onlyNew ? [...discoveryQueue] : [...discoveryQueue, ...priority, ...rest.slice(start).filter((s) => !discoverySet.has(s.code))]);
  const servicesTotal = ordered.length;

  // 3) fetch (paced, sequential — stays under the 60 requests/minute limit)
  const entries = new Map();   // "ISO|code" -> {iso, code, usd, count}
  const processed = new Set(); // services with a COMPLETE answer (safe to delist what's missing)
  let rateLimited = false;
  let stoppedEarly = false;
  let requests = 0;
  let paginated = 0;
  let incompleteServices = 0;
  let firstKeys = null;
  let cursorPos = start;
  let servicesVisited = 0;
  const gapSample = [];
  let gapTotal = 0;

  // the popular tier gets at most 40% of the time budget, so the rotating cursor always makes progress
  const priorityDeadline = started + Math.floor((deadline - started) * 0.4);
  for (const s of queue) {
    if (Date.now() > deadline) { stoppedEarly = true; break; }
    const isRest = !prioritySet.has(s.code) && !discoverySet.has(s.code);
    if (!isRest && !discoverySet.has(s.code) && Date.now() > priorityDeadline) { servicesVisited += 1; continue; } // refreshed again next run
    const out = await vsFetchServiceCountries(s.code, (expected.get(s.code) || new Set()).size, pace, deadline);
    requests += out.pages || 0;
    if (out.pages > 1) paginated += 1;
    if (out.rateLimited) { rateLimited = true; break; }
    if (out.error) { note(`${s.code}: ${out.error}`); servicesVisited += 1; if (isRest) cursorPos = (restIndex.get(s.code) ?? cursorPos) + 1; continue; }
    if (!firstKeys && out.firstKeys) firstKeys = out.firstKeys;

    let priced = 0;
    for (const c of out.items) {
      const iso = vsCountryIso(c);
      if (!iso) continue;
      if (!isoName.has(iso)) isoName.set(iso, vsCountryNameOf(c, iso));
      const usd = vsPriceOf(c);
      // docs: this call only lists countries that HAVE the service. A real stock number wins; an explicit 0
      // means out of stock; if the API sends no stock field at all, a listed price means "in stock".
      const count = vsStockOf(c) || (vsStockKnown(c) ? 0 : (usd > 0 ? 1 : 0));
      if (usd > 0 && count > 0) {
        const key = `${iso}|${s.code}`;
        const prev = entries.get(key);
        if (!prev) entries.set(key, { iso, code: s.code, usd, count });
        else { if (usd < prev.usd) prev.usd = usd; if (count > prev.count) prev.count = count; }
        priced += 1;
      }
    }
    if (out.items.length && !priced) note(`${s.code}: countries came back without a usable price`);

    const exp = expected.get(s.code);
    if (exp) {
      const missing = [...exp].filter((iso) => !out.seen.has(iso));
      if (missing.length) {
        gapTotal += missing.length;
        if (gapSample.length < 8) gapSample.push(`${s.code}: ${missing.slice(0, 6).join(',')}${missing.length > 6 ? ' +' + (missing.length - 6) : ''}`);
      }
    }
    if (out.truncated) {
      incompleteServices += 1;
      // cut off by the time budget → not visited yet, picked up again by the next run
      if (Date.now() > deadline) { stoppedEarly = true; break; }
    } else {
      processed.add(s.code);
    }
    servicesVisited += 1;
    if (isRest) cursorPos = (restIndex.get(s.code) ?? cursorPos) + 1;
  }

  const completedQueue = !stoppedEarly && !rateLimited && servicesVisited >= queue.length;
  const discoveryBacklog = newPairsBySvc.size > discoveryQueue.length; // more missing services than one run handles
  const nextCursor = (onlyService || onlyNew) ? null : (completedQueue ? 0 : cursorPos);

  if (!entries.size && !processed.size) {
    return { status: 200, cursor: nextCursor, body: {
      success: true, partial: !completedQueue || discoveryBacklog, done: completedQueue && !discoveryBacklog, rate_limited: rateLimited, rows_seen: 0, upserted: 0,
      message: rateLimited
        ? 'VirtualSMS rate limit hit (60/min). It will continue on the next run.'
        : (queue.length ? 'VirtualSMS answered but nothing could be read. Open /api/grizzly-sync?action=vsms_probe and check the sample.'
          : (onlyService ? 'No matching service to sync.' : 'Nothing new: the DB already has every country and service the supplier lists.')),
      discovery: { include_voip: VS_INCLUDE_VOIP, supplier_services: services.length, supplier_countries: countryList.length,
        new_services: newServiceCodes.length, new_countries: newCountryIsos.length, missing_pairs: newPairsTotal },
      services_done: servicesVisited, services_total: servicesTotal, errors, ms: Date.now() - started
    } };
  }

  // 4) build rows
  const nowIso = new Date().toISOString();
  const rows = [];
  for (const e of entries.values()) {
    const cid = vsIsoToId(e.iso);
    if (cid == null) continue;
    const sell = Number(applyMarkup(e.usd, rate)); // same markup function Servers 1 & 2 use
    rows.push({
      key: `${cid}|${e.code}`, country_id: cid,
      // our own region-name list first (Ireland, Canada…), then whatever VirtualSMS sent, never the bare code if avoidable
      country_name: vsRegionName(e.iso) || isoName.get(e.iso) || e.iso,
      service_id: e.code, service_name: svcName.get(e.code) || e.code.toUpperCase(),
      supplier_price: e.usd, price: Number.isFinite(sell) && sell > 0 ? sell : salePriceFromUsd(e.usd),
      available_quantity: e.count
    });
  }

  // 5) write: insert new, update changed, touch unchanged (batched), delist sold-out
  const inserts = [];
  const updates = [];
  const seenKeys = new Set();
  let manualBelowCost = 0;
  let repriced = 0;
  for (const r of rows) {
    seenKeys.add(r.key);
    const prev = existing.get(r.key);
    if (!prev) {
      inserts.push({
        source: VS_SOURCE, country_id: r.country_id, country_name: r.country_name, service_id: r.service_id,
        service_name: r.service_name, supplier_price: r.supplier_price, price: r.price, price_source: 'system',
        currency: 'NGN', available_quantity: r.available_quantity, is_available: true, updated_at: nowIso
      });
      continue;
    }
    // hand-set prices ('manual' from the admin table, 'admin' legacy) are never overwritten
    const protectedPrice = prev.price_source === 'manual' || prev.price_source === 'admin';
    // admin hid this row (hidden but still has quantity — a sold-out delist always zeroes the quantity): keep it hidden
    const adminHidden = prev.is_available === false && Number(prev.available_quantity || 0) > 0;
    const prevPrice = Number(prev.price) || 0;
    const prevCost = Number(prev.supplier_price || 0);
    const costMoved = Math.abs(prevCost - r.supplier_price) > 0.0001;
    const rel = prevCost > 0 ? (r.supplier_price - prevCost) / prevCost : 1;
    const costUp = rel > 0.0001;        // any rise in what the supplier charges us → reprice
    const costDownBig = rel <= -0.05;   // a real drop → reprice so we stay competitive
    const belowFloor = !protectedPrice && prevPrice < vsFloorNgn(r.supplier_price);
    if (protectedPrice && prevPrice < r.supplier_price * rate) manualBelowCost += 1;
    const needsPrice = !protectedPrice && (costUp || costDownBig || belowFloor || !(prevPrice > 0));
    const nextAvail = !adminHidden;
    const changed = needsPrice || costMoved || Number(prev.available_quantity || 0) !== r.available_quantity ||
      String(prev.country_name || '') !== r.country_name || String(prev.service_name || '') !== r.service_name ||
      (prev.is_available === false && nextAvail);
    if (!changed) continue; // unchanged rows are never rewritten
    const f = {
      country_name: r.country_name, service_name: r.service_name, supplier_price: r.supplier_price,
      available_quantity: r.available_quantity, is_available: nextAvail, updated_at: nowIso
    };
    if (needsPrice) { f.price = r.price; f.price_source = 'system'; repriced += 1; }
    updates.push({ id: prev.id, ...f });
  }
  let goneIds = [];
  let existingLiveForProcessed = 0;
  for (const [key, prev] of existing) {
    if (!processed.has(prev.service_id)) continue;
    if (prev.is_available !== false) existingLiveForProcessed += 1;
    if (seenKeys.has(key)) continue;
    if (prev.is_available === false) continue; // already hidden (sold out earlier, or hidden by admin)
    goneIds.push(prev.id);
  }
  // safety net: if one run would delist almost everything, the supplier probably sent a bad answer
  if (goneIds.length >= 100 && goneIds.length > existingLiveForProcessed * 0.7) {
    note(`delist skipped: ${goneIds.length} of ${existingLiveForProcessed} live rows would be removed in one run`);
    goneIds = [];
  }

  const stats = { inserted: 0, updated: 0, delisted: 0 };
  for (let i = 0; i < updates.length; i += 20) {
    await Promise.all(updates.slice(i, i + 20).map(async (u) => {
      const { id, ...f } = u;
      const { error } = await supabase.from('number_services').update(f).eq('id', id);
      if (error) note('update: ' + error.message); else stats.updated += 1;
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
    const slice = goneIds.slice(i, i + 200);
    const { error } = await supabase.from('number_services')
      .update({ available_quantity: 0, is_available: false, updated_at: nowIso }).in('id', slice);
    if (error) note('sold-out: ' + error.message); else stats.delisted += slice.length;
  }

  if (inserts.length + updates.length > 0 && stats.inserted + stats.updated === 0) {
    // nothing saved → do NOT advance the cursor, the same services are retried next run
    return { status: 500, body: {
      success: false, message: 'VirtualSMS data was read but nothing could be saved. ' + (errors[0] || ''), errors, rows_seen: rows.length
    } };
  }

  // old numeric-id rows from the broken legacy sync: hide them once real rows exist
  let legacyHidden = 0;
  if (rows.length >= 20) {
    const { data: lg } = await supabase.from('number_services')
      .update({ available_quantity: 0, is_available: false }).eq('source', VS_SOURCE).lt('country_id', VS_ID_BASE).eq('is_available', true).select('id');
    legacyHidden = (lg || []).length;
  }

  const countriesInRun = new Set(rows.map((r) => r.country_id)).size;
  const partial = !completedQueue || discoveryBacklog;
  const servicesDone = completedQueue ? servicesTotal : Math.min(servicesTotal, discoveryQueue.length + priority.length + cursorPos);
  let message = `Server 3 sync: found ${newServiceCodes.length} new services, ${newCountryIsos.length} new countries, ${newPairsTotal} missing country/service pairs. Checked ${processed.size} services (${stats.inserted} rows added, ${stats.updated} changed, ${stats.delisted} sold out; unchanged rows untouched). Walk progress: ${servicesDone}/${servicesTotal}.`;
  if (partial) message += rateLimited ? ' Rate limit hit — it will continue on the next run.' : ' Not finished — run Sync again (or let the cron continue).';
  if (gapTotal) message += ` Coverage gap: supplier lists ${gapTotal} country/service pairs the API did not return — see "coverage" in the response.`;
  if (manualBelowCost) message += ` ${manualBelowCost} hand-priced rows are below supplier cost (orders for them are blocked).`;
  if (legacyHidden) message += ` Hid ${legacyHidden} old broken rows.`;

  return { status: 200, cursor: nextCursor, body: {
    success: true, source: VS_SOURCE, partial, done: !partial, rate_limited: rateLimited,
    rows_seen: rows.length, upserted: stats.inserted + stats.updated, inserted: stats.inserted, updated: stats.updated,
    delisted: stats.delisted, repriced, manual_below_cost: manualBelowCost,
    discovery: {
      include_voip: VS_INCLUDE_VOIP, supplier_services: services.length, supplier_countries: countryList.length,
      new_services: newServiceCodes.length, new_countries: newCountryIsos.length, new_countries_sample: newCountryIsos.slice(0, 15),
      missing_pairs: newPairsTotal, services_fetched_for_discovery: discoveryQueue.length, backlog: discoveryBacklog
    },
    services_done: servicesDone, services_total: servicesTotal, supplier_requests: requests, ms: Date.now() - started,
    coverage: {
      supplier_countries: countryList.length, countries_in_this_run: countriesInRun,
      services_paginated: paginated, services_incomplete: incompleteServices,
      missing_pairs: gapTotal, missing_sample: gapSample, response_keys: firstKeys
    },
    errors, message
  } };
}

async function vsHandleSync(req, res) {
  if (!(await vsAdminOrCron(req, res))) return;
  if (!vsApiKey()) {
    return res.status(500).json({ success: false, message: 'VIRTUALSMS_API_KEY is not set on the server (Vercel → Environment Variables).' });
  }
  const q = req.query || {};
  const force = q.force === '1' || q.force === 'true';
  if (!force && vsIsLocked(await vsGetJob())) {
    return res.status(200).json({ success: true, busy: true, partial: true, done: false, message: 'A Server 3 sync is already running. Wait a minute and check again.' });
  }
  await vsSetJob({ status: 'running', started_at: new Date().toISOString(), errors: [] });
  let out = null;
  try {
    out = await vsRunSync(req);
  } catch (err) {
    console.error('vsms full sync error:', err);
    out = { status: 500, body: { success: false, message: 'Server 3 sync failed: ' + (err && err.message ? err.message : String(err)) } };
  } finally {
    // the cursor only moves when the run succeeded, so a failed run retries the same services
    await vsSetJob({ status: 'idle', ...(out && out.cursor != null ? { cursor_index: out.cursor } : {}) });
  }
  return res.status(out.status).json(out.body);
}

async function vsHandleProbe(req, res) {
  if (!(await vsAdminOrCron(req, res))) return;
  const cut = (r) => ({ status: r.status, err: r.err || undefined, sample: (r.text || '').slice(0, 500) });
  const S = ['services', 'data', 'items', 'results'];
  const C = ['countries', 'data', 'items', 'results'];
  const n = (r, keys) => (r.json ? vsAsList(r.json, keys).length : 0);
  const [svc, svcV, cty, ctyV, wa, waV, bal] = await Promise.all([
    vsReq('/customer/services'), vsReq('/customer/services?include_voip=true'),
    vsReq('/customer/countries'), vsReq('/customer/countries?include_voip=true'),
    vsReq('/customer/countries?service=wa'), vsReq('/customer/countries?service=wa&include_voip=true'),
    vsReq('/customer/balance')
  ]);
  return res.status(200).json({
    success: true,
    include_voip_in_sync: VS_INCLUDE_VOIP,
    counts: {
      services_physical_only: n(svc, S), services_with_voip: n(svcV, S),
      countries_physical_only: n(cty, C), countries_with_voip: n(ctyV, C),
      whatsapp_countries_physical_only: n(wa, C), whatsapp_countries_with_voip: n(waV, C)
    },
    samples: { services_with_voip: cut(svcV), countries_with_voip: cut(ctyV), whatsapp_with_voip: cut(waV), balance: cut(bal) }
  });
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

function vsExtractSmsCode(text) {
  if (text == null) return null;
  const s = String(text);
  if (!s.trim()) return null;
  // Explicit "code: 688-069" / "OTP is 123456"
  let m = s.match(/(?:code|otp|pin|verification)[:\s#]*([0-9]{3,}[-–\s]?[0-9]{2,8})/i);
  if (m) return m[1].replace(/[\s–]/g, '-').replace(/-+/g, '-');
  // WhatsApp style 688-069
  m = s.match(/\b(\d{3}[-–]\d{3,4})\b/);
  if (m) return m[1].replace('–', '-');
  // Plain 4–8 digit OTP
  m = s.match(/\b(\d{4,8})\b/);
  if (m) return m[1];
  return null;
}
function vsParseOrder(j) {
  const o = (j && (j.order || j.data || j.result)) || j || {};
  let status = String(o.status || j?.status || '').toLowerCase();
  const msgs = o.messages || o.sms || o.sms_list || o.message_list || j?.messages || [];
  let code = null;
  if (o.code || o.sms_code || o.otp || o.sms) {
    const raw = o.code || o.sms_code || o.otp || (typeof o.sms === 'string' ? o.sms : null);
    if (raw) code = vsExtractSmsCode(raw) || String(raw).trim();
  }
  if (!code && Array.isArray(msgs)) {
    for (const m of msgs) {
      if (!m) continue;
      if (m.code || m.otp) { code = String(m.code || m.otp); break; }
      const t = m.content || m.text || m.message || m.body || m.sms || (typeof m === 'string' ? m : '');
      code = vsExtractSmsCode(t);
      if (code) break;
    }
  }
  if (!code && typeof o.last_message === 'string') code = vsExtractSmsCode(o.last_message);
  if (!code && typeof o.message === 'string') code = vsExtractSmsCode(o.message);
  // Supplier marked SMS received but code buried in payload
  if (!code && (o.sms_received === true || status === 'sms_received' || status === 'completed')) {
    code = vsExtractSmsCode(JSON.stringify(j));
  }
  if (code) status = 'completed';
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
      .select('service_name, country_name, price, supplier_price, price_source, is_available')
      .eq('source', VS_SOURCE).eq('country_id', Number(country_id)).eq('service_id', serviceId).maybeSingle();
    if (!svc) return res.status(404).json({ success: false, message: 'This service is no longer available. Refresh, try another, or contact support.' });
    if (!svc.is_available) return res.status(409).json({ success: false, message: 'This number service is currently out of stock.' });
    serviceName = svc.service_name; countryName = svc.country_name; price = Number(svc.price) || 0;

    // Money guard: never sell for nothing or below what the supplier charges us.
    // Hand-set prices ('manual'/'admin') are left alone (just blocked); system-priced rows are repaired.
    const unitCostUsd = Number(svc.supplier_price) || 0;
    if (!(price > 0) || (unitCostUsd > 0 && price < unitCostUsd * vsRate())) {
      if (svc.price_source !== 'manual' && svc.price_source !== 'admin' && unitCostUsd > 0) {
        try {
          await supabase.from('number_services')
            .update({ price: salePriceFromUsd(unitCostUsd), price_source: 'system', updated_at: new Date().toISOString() })
            .eq('source', VS_SOURCE).eq('country_id', Number(country_id)).eq('service_id', serviceId);
        } catch (_) { /* best effort */ }
      }
      console.error('[vsms order] blocked: price below supplier cost', { country: iso, service: serviceId, price, unitCostUsd, source: svc.price_source });
      return res.status(409).json({ success: false, code: 'PRICE_CHANGED', message: 'The price for this number just changed. Please refresh and try again.' });
    }

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

    let r = await vsReq('/customer/purchase', { method: 'POST', body: { service: serviceId, country: iso }, timeoutMs: 30000 });
    // The catalog now includes VoIP-backed stock (docs: include_voip=true). If the plain purchase finds no
    // (physical) number, retry once asking for VoIP too, so a listed VoIP row can actually be bought.
    if (!r.ok && VS_INCLUDE_VOIP && r.status !== 402 && r.status !== 401 && r.status !== 429) {
      const r2 = await vsReq('/customer/purchase', { method: 'POST', body: { service: serviceId, country: iso, include_voip: true }, timeoutMs: 30000 });
      if (r2.ok) r = r2;
    }
    const j = r.json || {};
    const orderId = j.order_id || j.id || (j.order && (j.order.order_id || j.order.id));
    const phone = j.phone_number || j.number || (j.order && (j.order.phone_number || j.order.number)) || null;
    if (!r.ok || j.success === false || !orderId) {
      await vsCreditWallet(user_id, price);
      deducted = false;
      const code = String(j.error || '').toLowerCase();
      const noStock = r.status === 404 || r.status === 409 || /no_numbers|not_available|out_of_stock|unavailable|no numbers/.test(code);
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

    // What the supplier actually charged us (USD). Store the real cost on the order, and if it is higher
    // than the catalog says, fix the catalog row so the next customer is not sold at a loss.
    const paidUsd = vsNum(j.price ?? j.cost ?? j.price_usd ?? (j.order && (j.order.price ?? j.order.cost ?? j.order.price_usd)));
    const costUsd = paidUsd > 0 ? paidUsd : (unitCostUsd || null);

    const row = {
      source: VS_SOURCE, user_id, customer_id: customerId, order_id: String(orderId), idempotency_key: idem,
      country_id: Number(country_id), country_name: countryName, service_id: serviceId, service_name: serviceName,
      phone_number: phone, price, supplier_price: costUsd, currency: 'NGN',
      status: 'waiting_for_code', code: null, time_left: null, refunded: false
    };
    let { error: insErr } = await supabase.from('number_orders').insert(row);
    if (insErr) { await new Promise((r2) => setTimeout(r2, 400)); ({ error: insErr } = await supabase.from('number_orders').insert(row)); }
    if (insErr) console.error('[vsms order] number_orders insert failed after charge:', insErr.message, { orderId, user_id });

    if (paidUsd > 0) {
      if (paidUsd * vsRate() > price) {
        console.error('[vsms order] SOLD BELOW COST', { orderId, country: iso, service: serviceId, price, paidUsd, rate: vsRate() });
      }
      if (paidUsd > unitCostUsd + 0.0001) {
        try {
          const fix = { supplier_price: paidUsd, updated_at: new Date().toISOString() };
          if (svc.price_source !== 'manual' && svc.price_source !== 'admin') { fix.price = salePriceFromUsd(paidUsd); fix.price_source = 'system'; }
          await supabase.from('number_services').update(fix)
            .eq('source', VS_SOURCE).eq('country_id', Number(country_id)).eq('service_id', serviceId);
        } catch (_) { /* best effort */ }
      }
    }

    try {
      await supabase.from('transactions').insert({
        user_id, customer_id: customerId, type: 'purchase', category: 'MJ SMS',
        title: countryName ? (serviceName + ' · ' + countryName) : serviceName,
        subtitle: (countryName || '') + ' · waiting for SMS',
        amount: `₦${price.toLocaleString()}`, amount_ngn: price,
        status: 'pending',
        notes: 'sms_order:' + String(orderId),
        supplier_order: j
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
  let data = null;
  try {
    const r = await supabase.from('number_orders')
      .update({ status: 'completed', code: String(code) })
      .eq('id', order.id).eq('refunded', false).select('id').maybeSingle();
    data = r.data;
    if (r.error) console.warn('[vsms mark completed]', r.error.message);
  } catch (e) {
    console.warn('[vsms mark completed]', e.message || e);
  }
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
    // Docs: errors look like { error: "Cannot cancel order with status: sms_received" }.
    // Only treat the order as "already cancelled/expired" when the supplier says exactly that —
    // an SMS that already arrived must NEVER be refunded.
    const errTxt = String((r.json && (r.json.error || r.json.message)) || r.text || '');
    if (!r.ok && /sms_received|completed|received/i.test(errTxt)) {
      return res.status(409).json({ success: false, code: 'NUMBER_CODE_ALREADY_RECEIVED', message: 'A code was already received — this order cannot be cancelled.' });
    }
    const already = r.status === 404 || /status:\s*(cancelled|canceled|expired|refunded)/i.test(errTxt);
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
// SERVER 1 SECOND OTP POOL (source = 'herosms') — all logic lives in lib/hero.js
// ===========================================================================
// Only reached when body.source === 'herosms' (order), when the saved order.source is 'herosms'
// (check / cancel), or via action=hero_sync / hero_probe. Anything else behaves exactly as before.
const HERO = createHero({ supabase, requireAdmin, claimAndRefundOrder, reclaimAndCompleteOnCode, EXPIRY_MS });

function isHeroSource(b) {
  return String((b && (b.source || b.provider || b.server)) || '').toLowerCase().trim() === 'herosms';
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
    if (act === 'hero_sync') return HERO.sync(req, res);
    if (act === 'hero_probe') return HERO.probe(req, res);
    if (isVsSync) return vsHandleSync(req, res);
    if (act === 'vsms_probe') return vsHandleProbe(req, res);
    if (act === 'vsms_purge_legacy') return vsHandlePurgeLegacy(req, res);
    // action is one of: null (continue/cron), 'start', 'status' — handled inside handleSync (Server 1)
    return handleSync(req, res);
  }

  if (req.method === 'POST') {
    if (act === 'hero_sync') return HERO.sync(req, res);
    if (isVsSync) return vsHandleSync(req, res);
    if (action === 'order') {
      let b = {};
      try { b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (_) { b = {}; }
      if (isHeroSource(b)) return HERO.order(req, res, b);
      if (resolveSupplier(req, b).source === 'virtualsms') return vsHandleOrder(req, res);
      return handleOrder(req, res);
    }
    if (action === 'check') {
      if (await HERO.orderIsHero(req)) return HERO.check(req, res);
      if (await orderIsServer3Rest(req)) return vsHandleCheck(req, res);
      return handleCheck(req, res);
    }
    if (action === 'cancel') {
      if (await HERO.orderIsHero(req)) return HERO.cancel(req, res);
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
