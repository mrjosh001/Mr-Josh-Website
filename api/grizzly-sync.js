import { createClient } from '@supabase/supabase-js';
import { applyMarkup } from '../lib/pricing.js';

/**
 * GET /api/grizzly-sync
 * Chunked GrizzlySMS catalog sync into number_services (source=grizzlysms).
 *
 * SPEED FIXES vs previous version:
 * - Manual chunk budget raised (was 8s → now uses most of maxDuration)
 * - One SELECT per country for existing rows (not one SELECT per service)
 * - Parallel batch UPDATEs + single multi-row INSERT
 * - Customer selling `price` never overwritten on update
 *
 * Progress is stored in sync_jobs — leaving the admin tab does not reset
 * the cursor. Reopen admin or wait for cron to continue.
 *
 * Env: GRIZZLYSMS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET?
 * Optional: USD_TO_NGN_RATE (default 1500)
 */

const BASE = 'https://api.grizzlysms.com/stubs/handler_api.php';
const JOB_SOURCE = 'grizzlysms';

// Manual: use most of the 300s function limit so fewer browser polls are needed.
const MANUAL_TIME_BUDGET_MS = 240000;
// Cron: same ballpark
const CRON_TIME_BUDGET_MS = 280000;

const UPDATE_CONCURRENCY = 20;

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res
      .status(500)
      .json({ success: false, message: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' });
  }
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
