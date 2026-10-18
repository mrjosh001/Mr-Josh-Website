import { createClient } from '@supabase/supabase-js';
import { applyMarkup, profitFloorNgn } from '../lib/pricing.js';

/**
 * /api/grizzly-sync — GrizzlySMS (Server 1) + VirtualSMS (Server 3) operations in one file.
 *
 * GET  /api/grizzly-sync                  → continue/kick off Server 1 catalog sync (cron + admin "Sync" button)
 * GET  /api/grizzly-sync?action=start      → start a fresh Server 1 sync job
 * GET  /api/grizzly-sync?action=status     → Server 1 sync job progress
 * GET  /api/grizzly-sync?action=vsms_sync  → Server 3 (VirtualSMS) FULL catalog sync (admin / cron)
 *                                            The admin "Sync Server 3" button now fills the USA + top countries
 *                                            FIRST (about 30 s), then continues with the normal pass.
 *                                            &force=1 refresh everything · &service=wa re-sync one service
 *                                            &country=US fill every missing service for one country (USA first!)
 *                                            &fill=only skip the normal pass and only fill missing pairs
 *                                            &fill=0 skip the gap-fill pass
 * GET  /api/grizzly-sync?action=vsms_probe → Server 3: show what VirtualSMS really returns (admin)
 *                                            &paging=1 also tests which paging parameter the API honours
 * GET  /api/grizzly-sync?action=vsms_purge_legacy → Server 3: delete old broken numeric-id rows (admin)
 * POST /api/grizzly-sync?action=vsms_lookup → Server 3: LIVE supplier check for a service / country the
 *                                            database does not have yet (any signed-in user). Body:
 *                                            { q: "whatsapp" }  |  { service: "wa", country_q: "usa" }
 * POST /api/grizzly-sync?action=order      → buy a number   (provider=virtualsms → Server 3)
 * POST /api/grizzly-sync?action=check      → poll for SMS code (routes by the order's saved source)
 * POST /api/grizzly-sync?action=cancel     → cancel + refund   (routes by the order's saved source)
 *
 * Server 3 uses VirtualSMS' documented MODERN REST API (https://virtualsms.io/api/v1, X-API-Key):
 * ISO-2 country codes with real names, real per-country prices, POST /customer/purchase.
 * number_services.country_id is an integer column, so an ISO code is stored as a reversible integer
 * (vsIsoToId / vsIdToIso); the real name goes in country_name.
 *
 * Pricing is wired the same on every server: applyMarkup() the first time a row is seen, hand-set
 * ('manual' / 'admin') prices are never overwritten, and — safety net — a system-priced row that has
 * fallen under supplier cost + MIN_PROFIT_NGN is re-priced (profitFloorNgn). Orders are refused if a row
 * would sell below supplier cost.
 *
 * WALLET SAFETY (v7): every credit goes through creditWalletOnce() — it never credits twice, it notices when
 * the database wallet guard (credit_balance) refused the credit and then rolls the refund claim back instead of
 * pretending it worked, and it reverses an exact double credit. Refunds on Server 3 only happen once the
 * supplier has CONFIRMED the cancel/expiry, and always inside the guard's 30-minute window.
 *
 * Env: GRIZZLYSMS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET?
 * Optional: USD_TO_NGN_RATE (default 1500), MIN_PROFIT_NGN (500), VIRTUALSMS_API_KEY (Server 3),
 *           VSMS_TIME_BUDGET_MS (240000 cron), VSMS_MANUAL_BUDGET_MS (80000 admin button),
 *           VSMS_MIN_GAP_MS (1100), VSMS_SERVICE_LIMIT (5000), VSMS_STALE_HOURS (3)
 */

/* MJHUB_SERVER3_VIRTUALSMS=7 2026-10-18 Server 3: USA-first fill on the admin button, wallet-guard aware refunds, supplier-confirmed cancel, live lookup */
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
// WALLET SAFETY — one place that credits money, and it can never credit twice
// ===========================================================================

async function readBalance(userId) {
  if (!userId) return null;
  const { data, error } = await supabase.from('profiles').select('balance').eq('id', userId).maybeSingle();
  if (error || !data) return null;
  const n = Number(data.balance);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Credit a customer's wallet EXACTLY ONCE.
 *
 * Why this exists: the old code called the credit_balance RPC and, if the RPC's answer was not shaped the way
 * it expected (void / text / array …), it fell through to a second manual "balance + amount" write — so one
 * refund credited the wallet twice (that is how a ₦5,000 deposit turned into ₦11,000). Rules now:
 *   1. the RPC ran without an error  → check the balance really went up. If it did, it is DONE (never credit
 *                                       again). If it did NOT, the database wallet guard refused (no matching
 *                                       purchase debit) → report ok=false, do NOT bypass the guard;
 *   2. the RPC errored               → re-read the balance (it may have applied anyway); if not, write
 *                                       "balance + amount" with a compare-and-set so it can only land once;
 *   3. after crediting, if the balance moved by exactly 2× the amount (something else — a database trigger
 *      or a duplicate call — already credited the same refund) the extra copy is reversed and logged.
 * Returns { ok, newBalance }. ok=false means the money was NOT credited (callers must not mark the order refunded).
 */
async function creditWalletOnce(userId, amount, label) {
  const amt = Number(amount);
  if (!userId || !(amt > 0)) return { ok: false, reason: 'bad_amount', newBalance: await readBalance(userId) };

  const before = await readBalance(userId);
  let applied = false;

  const { error: rpcErr } = await supabase.rpc('credit_balance', { p_user_id: userId, p_amount: amt });
  if (!rpcErr) {
    const post = await readBalance(userId);
    if (before != null && post != null && post < before + amt - 0.005) {
      // The database guard answered without an error but did not credit (no matching recent purchase debit).
      console.error('[wallet] credit refused by the database wallet guard', { userId, amount: amt, label, before, post });
      return { ok: false, reason: 'guard_refused', newBalance: post };
    }
    applied = true;
  } else {
    console.error(`[wallet] credit_balance RPC error (${label || 'credit'}):`, rpcErr.message);
    const mid = await readBalance(userId);
    if (before != null && mid != null && mid >= before + amt - 0.005) {
      applied = true; // it was applied even though the call reported an error
    } else if (before != null || mid != null) {
      for (let attempt = 0; attempt < 3 && !applied; attempt++) {
        const cur = attempt === 0 ? (mid != null ? mid : before) : await readBalance(userId);
        if (cur == null) break;
        const { data: upd, error: upErr } = await supabase
          .from('profiles')
          .update({ balance: cur + amt })
          .eq('id', userId)
          .eq('balance', cur) // compare-and-set: lands only if nobody changed the balance since we read it
          .select('balance')
          .maybeSingle();
        if (!upErr && upd) applied = true;
      }
    }
  }

  if (!applied) {
    console.error('[wallet] CRITICAL: credit was NOT applied', { userId, amount: amt, label });
    return { ok: false, reason: 'not_applied', newBalance: await readBalance(userId) };
  }

  let after = await readBalance(userId);
  if (before != null && after != null && Math.abs((after - before) - 2 * amt) < 0.01) {
    const { data: fixed } = await supabase
      .from('profiles')
      .update({ balance: after - amt })
      .eq('id', userId)
      .eq('balance', after)
      .select('balance')
      .maybeSingle();
    if (fixed) {
      console.error('[wallet] DOUBLE CREDIT detected and reversed', { userId, amount: amt, label, before, after });
      after = Number(fixed.balance);
    }
  }
  return { ok: true, newBalance: after };
}

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

/** Selling below supplier cost? (price is NGN, supplier_price is USD). Used as an order-time guard. */
function sellsBelowCost(priceNgn, supplierPriceUsd) {
  const rate = Number(process.env.USD_TO_NGN_RATE) || Number(process.env.USD_TO_NGN) || 1500;
  const usd = Number(supplierPriceUsd);
  if (!(usd > 0)) return false; // unknown cost → can't judge
  return !(Number(priceNgn) >= usd * rate);
}

// ===========================================================================
// SYNC (Server 1)
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
 * Sync one country: 1 Grizzly price call + paged existing SELECT + batched writes.
 *
 * Fixes vs the old version:
 *  - the existing-rows SELECT is paged. PostgREST returns at most 1000 rows per request, so for countries with
 *    more than 1000 services the rest looked "new", their batch INSERT hit the unique index (see the repeated
 *    "duplicate key … number_services_source_country_service_key" errors in sync_jobs) and those rows never
 *    got fresh stock/cost again;
 *  - new rows go in with upsert(ignoreDuplicates) so one duplicate can no longer sink a whole batch;
 *  - a system-priced row that has fallen under supplier cost + MIN_PROFIT_NGN is re-priced (hand-set
 *    'manual' / 'admin' prices are never touched).
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

  // All existing services in this country (paged — see note above).
  // Incremental: only INSERT brand-new service_ids and UPDATE rows whose
  // stock / supplier cost / name actually changed (GotSMS-style — never wipe + rewrite).
  const existingRows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error: existErr } = await supabase
      .from('number_services')
      .select('id, service_id, price, price_source, supplier_price, available_quantity, service_name, is_available, country_name')
      .eq('source', 'grizzlysms')
      .eq('country_id', countryId)
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (existErr) {
      counters.errors.push(`country ${countryId} select: ${existErr.message}`);
      return;
    }
    existingRows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  const existingMap = new Map(
    existingRows.map((r) => [String(r.service_id), r])
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
      // Safety net: never keep SELLING under supplier cost + MIN_PROFIT_NGN (system prices only)
      const handPriced = prev.price_source === 'manual' || prev.price_source === 'admin';
      const prevPrice = Number(prev.price) || 0;
      const needsPrice =
        !handPriced &&
        supplierPriceUsd > 0 &&
        (!(prevPrice > 0) || prevPrice < profitFloorNgn(supplierPriceUsd, usdToNgn));
      if (sameCost && sameQty && sameName && sameCountry && sameAvail && !needsPrice) {
        continue; // nothing changed — skip write
      }
      counters.updatedCount += 1;
      const upd = {
        id: prev.id,
        country_name: countryName,
        service_name: friendlyName,
        supplier_price: supplierPriceUsd,
        available_quantity: availableQty,
        providers_raw: providersRaw,
        is_available: nextAvail,
        updated_at: now
      };
      if (needsPrice) {
        upd.price = applyMarkup(supplierPriceUsd, usdToNgn);
        upd.price_source = 'system';
        counters.repriced = (counters.repriced || 0) + 1;
      }
      toUpdate.push(upd);
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

  // Parallel updates (hand-set prices are never touched; system prices only move via the safety net above)
  await runInBatches(toUpdate, UPDATE_CONCURRENCY, async (row) => {
    const { id, ...fields } = row;
    const { error } = await supabase
      .from('number_services')
      .update(fields)
      .eq('id', id);
    if (error) counters.errors.push(`update ${id}: ${error.message}`);
  });

  // Multi-row inserts in batches of 100 (upsert + ignoreDuplicates: a row that already exists can't fail the batch)
  for (let i = 0; i < toInsert.length; i += 100) {
    const batch = toInsert.slice(i, i + 100);
    const { error } = await supabase
      .from('number_services')
      .upsert(batch, { onConflict: 'source,country_id,service_id', ignoreDuplicates: true });
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
      repriced: 0,
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
      repriced_below_floor: counters.repriced,
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
// ORDER (Server 1)
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
  let purchased = false;

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

    // Never sell below supplier cost (supplier raised its price since the last sync, or a hand-set price is too low)
    if (!(price > 0) || sellsBelowCost(price, supplierPriceUsd)) {
      console.error('[grizzly order] blocked: price below supplier cost', {
        country_id: countryId, service_id: serviceId, price, supplierPriceUsd
      });
      return res.status(409).json({
        success: false,
        message: 'This number service is temporarily unavailable. Please try another country or service.'
      });
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

    // Supplier failed → give back exactly what was debited (once), no refund transaction row
    if (!supplierRes.ok || failureReason || !orderData?.activationId) {
      await creditWalletOnce(user_id, price, 'grizzly-order-failed');
      deducted = false;

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
    purchased = true; // the supplier now holds a number for this customer — never auto-refund from here on

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

    if (deducted && !purchased) {
      try {
        await creditWalletOnce(user_id, price, 'grizzly-order-exception');
        // no refund transaction row
      } catch (refundErr) {
        console.error('CRITICAL: Auto-restore failed (grizzly order)', refundErr);
      }
    }

    return res.status(500).json({
      success: false,
      message: deducted && !purchased
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
 * If the wallet credit cannot be applied, the claim is rolled back so a later call can retry.
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
    const cr = await creditWalletOnce(userId, refundAmount, 'refund:' + order.id);
    if (!cr.ok) {
      // Money was NOT credited → undo the claim so the next check / cancel / cron run can retry.
      await supabase
        .from('number_orders')
        .update({
          status: order.status || 'waiting_for_code',
          refunded: false,
          updated_at: new Date().toISOString()
        })
        .eq('id', order.id)
        .eq('refunded', true);
      console.error('[claimAndRefundOrder] credit failed, claim rolled back', { order: order.id, userId, refundAmount, reason: cr.reason });
      return { refunded: false, reason: 'credit_failed' };
    }
    newBalance = cr.newBalance;
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
      if (!result.refunded && result.reason !== 'already_final') {
        return res.status(502).json({ success: false, message: 'Your refund is being processed. Please try again in a moment.' });
      }
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
// CANCEL (Server 1)
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
    if (!refundResult.refunded) {
      return res.status(502).json({
        success: false,
        message: 'Your number was cancelled but the refund could not be applied yet. Tap Check again in a moment.'
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
// Docs facts this code is built on (https://virtualsms.io/api/v1, header X-API-Key):
//  - GET  /customer/countries                → { success, countries:[{country_id:"ID", country_name, min_price, services:"tg,wa"}] }
//  - GET  /customer/countries?service=wa     → countries for that service WITH exact pricing (only countries that have it)
//  - GET  /price?service=wa&country=US       → price + stock for ONE service/country pair (public endpoint)
//  - POST /customer/purchase {service,country} → { order_id, phone_number, price, status:"waiting" }
//  - GET  /customer/order/{id}               → { status: waiting|completed|cancelled|expired, sms_received, messages[] }
//  - POST /customer/cancel/{id}              → 425 inside the first 120 s; 400 once an SMS arrived; error bodies are { error: "..." }
//  - Rate limit ~60 requests / minute.

const VS_REST = 'https://virtualsms.io/api/v1';
const VS_SOURCE = 'virtualsms';
const VS_ID_BASE = 1000;
const VS_CANCEL_COOLDOWN_MS = 120 * 1000;
// If the supplier will not confirm a cancel/expiry, wait this long past the 20-min window before refunding anyway.
// Kept short on purpose: the database wallet guard only refunds a purchase debit made in the last 30 minutes.
const VS_HARD_GRACE_MS = 8 * 60 * 1000;
// Cron gets the long budget; the admin "Sync Server 3" button gets one that fits inside the browser's 90 s timeout.
const VS_TIME_BUDGET_MS = Number(process.env.VSMS_TIME_BUDGET_MS) || 240000;
const VS_MANUAL_BUDGET_MS = Number(process.env.VSMS_MANUAL_BUDGET_MS) || 80000;
const VS_MIN_GAP_MS = Number(process.env.VSMS_MIN_GAP_MS) || 1100; // ~54 requests/minute, under the 60/min limit
const VS_SERVICE_LIMIT = Number(process.env.VSMS_SERVICE_LIMIT) || 5000; // was 150 → only 150 services ever priced
const VS_STALE_MS = (Number(process.env.VSMS_STALE_HOURS) || 3) * 3600 * 1000;
const VS_MAX_PAGES = 25;
const VS_LOCK_MS = 6 * 60 * 1000;
const VS_POPULAR_RE = /whatsapp|telegram|google|gmail|facebook|instagram|twitter|^x$|discord|tiktok|snapchat|microsoft|amazon|uber|netflix|paypal|tinder|linkedin|viber|wechat|apple|line|bumble|yahoo|openai|chatgpt|signal|vk|binance/i;
const VS_POPULAR_CODES = ['wa', 'tg', 'go', 'fb', 'ig', 'tw', 'ds', 'lf', 'tt', 'fu', 'mm', 'am', 'ub', 'nf', 'ts', 'oi', 'tn', 'vi', 'we', 'wx'];
// Countries customers ask for most — the gap-fill pass and the live lookup check these first (USA first).
const VS_PRIORITY_ISO = ['US', 'GB', 'CA', 'DE', 'FR', 'NL', 'ES', 'IT', 'BR', 'IN', 'MX', 'AU', 'PL', 'SE', 'TR', 'ZA', 'NG', 'ID', 'PH', 'VN'];
// The admin button checks the top countries (USA first) for this long BEFORE the normal pass.
const VS_QUICK_FILL_MS = 30000;

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

/** supplier country list → { isoName: Map(ISO→name), expected: Map(service code → Set(ISO)) } */
function vsBuildCountryIndex(countryList) {
  const isoName = new Map();
  const expected = new Map();
  for (const c of countryList || []) {
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
  return { isoName, expected };
}

// ---- free-text country → ISO (usa / america / uk / "united states" / NG …)
const vsNorm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
const VS_ISO_ALIASES = {
  usa: 'US', us: 'US', america: 'US', unitedstates: 'US', unitedstatesofamerica: 'US', theusa: 'US',
  uk: 'GB', gb: 'GB', britain: 'GB', greatbritain: 'GB', england: 'GB', unitedkingdom: 'GB',
  uae: 'AE', emirates: 'AE', unitedarabemirates: 'AE', drc: 'CD', drcongo: 'CD', congokinshasa: 'CD',
  ivorycoast: 'CI', cotedivoire: 'CI', southkorea: 'KR', korea: 'KR', russia: 'RU', holland: 'NL',
  netherlands: 'NL', czechia: 'CZ', czechrepublic: 'CZ', vietnam: 'VN', turkiye: 'TR', turkey: 'TR',
  ksa: 'SA', saudiarabia: 'SA', hongkong: 'HK', southafrica: 'ZA', newzealand: 'NZ'
};
let _vsNameIndex = null;
function vsResolveIso(text, countryList) {
  const n = vsNorm(text);
  if (!n) return null;
  if (VS_ISO_ALIASES[n]) return VS_ISO_ALIASES[n];
  if (/^[a-z]{2}$/.test(n)) return n.toUpperCase();
  if (!_vsNameIndex) {
    _vsNameIndex = new Map();
    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) {
        const iso = String.fromCharCode(a) + String.fromCharCode(b);
        const nm = vsRegionName(iso);
        if (nm) _vsNameIndex.set(vsNorm(nm), iso);
      }
    }
  }
  if (_vsNameIndex.has(n)) return _vsNameIndex.get(n);
  for (const c of countryList || []) {
    const iso = vsCountryIso(c);
    if (iso && vsNorm(vsCountryNameOf(c, iso)) === n) return iso;
  }
  if (n.length >= 3) {
    for (const [nm, iso] of _vsNameIndex) if (nm.startsWith(n)) return iso;
    for (const [nm, iso] of _vsNameIndex) if (nm.includes(n)) return iso;
  }
  return null;
}

// ---------------------------------------------------------------- catalog sync (FULL, paged, resumable)
const VS_PRICE_PROTECTED = new Set(['manual', 'admin']); // hand-set prices — the sync never overwrites these
const vsSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pagination info if the API sends any ({pagination:{…}}, {meta:{…}}, or top-level fields). */
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

/** The ways a supplier might page a list. The first one that returns NEW countries is remembered for the run. */
function vsPageUrl(mode, base, page, got) {
  switch (mode) {
    case 'page': return `${base}&page=${page}`;
    case 'offset': return `${base}&offset=${got}`;
    case 'limit': return `${base}&limit=1000&page=${page}`;
    case 'per_page': return `${base}&per_page=1000&page=${page}`;
    default: return `${base}&page_size=1000&page=${page}`;
  }
}
const VS_PAGE_MODES = ['limit', 'per_page', 'page_size', 'page', 'offset'];

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

/**
 * ONE service, ALL countries. VirtualSMS caps a single answer (~54 countries, cheapest first — which is why the
 * USA, Russia, Turkey, … never arrived). We compare the answer with the supplier's own country list and, when it
 * looks cut off (or the API says there is more), page / enlarge the request until nothing new comes back.
 * Whatever still cannot be read this way is picked up by the gap-fill pass (GET /price per pair) in vsRunSync.
 */
async function vsFetchServiceCountries(code, expectedCount, pace, deadline, paging) {
  const base = '/customer/countries?service=' + encodeURIComponent(code);
  const KEYS = ['countries', 'data', 'items', 'results'];
  const seen = new Set();
  const items = [];
  let pages = 0;
  let incomplete = false;
  let firstKeys = null;
  let curPage = 1;

  const take = (list) => {
    let fresh = 0;
    for (const c of list) {
      const iso = vsCountryIso(c);
      if (iso) { if (seen.has(iso)) continue; seen.add(iso); }
      items.push(c);
      fresh += 1;
    }
    return fresh;
  };
  const get = async (path) => { await pace(); pages += 1; return vsReq(path, { timeoutMs: 15000 }); };

  const r1 = await get(base);
  if (r1.status === 429) return { rateLimited: true, items, incomplete: true, pages };
  if (!r1.ok) return { error: `HTTP ${r1.status || 'no reply'}`, items, incomplete: true, pages };
  if (r1.json && typeof r1.json === 'object') firstKeys = Object.keys(r1.json).slice(0, 12);
  const list1 = vsAsList(r1.json, KEYS);
  take(list1);
  let meta = vsPageMeta(r1.json);

  const apiSaysMore = () => meta.hasMore || (meta.pages && curPage < meta.pages) || (meta.total && seen.size < meta.total);
  // looks cut off compared with the supplier's own country list (only trust that for big answers)
  const looksCapped = () => !!expectedCount && list1.length >= 20 && seen.size < expectedCount * 0.9;

  if (list1.length && (apiSaysMore() || looksCapped())) {
    const hinted = apiSaysMore();
    let modes = paging.mode ? [paging.mode] : (paging.failed && !hinted ? [] : (hinted ? ['page', 'offset', 'limit', 'per_page', 'page_size'] : VS_PAGE_MODES));
    for (const mode of modes) {
      let progressed = false;
      curPage = (mode === 'page' || mode === 'offset') ? 2 : 1;
      for (let guard = 0; guard < VS_MAX_PAGES; guard++) {
        if (Date.now() > deadline) { incomplete = true; break; }
        const r = await get(vsPageUrl(mode, base, curPage, seen.size));
        if (r.status === 429) return { rateLimited: true, items, incomplete: true, pages, seen };
        if (!r.ok) break;
        const fresh = take(vsAsList(r.json, KEYS));
        if (!fresh) break;
        progressed = true;
        curPage += 1;
        meta = vsPageMeta(r.json);
        if (!apiSaysMore() && !looksCapped()) break;
      }
      if (progressed) { paging.mode = mode; paging.failed = false; break; }
      if (incomplete) break;
    }
    if (!paging.mode && !hinted && modes.length) paging.failed = true; // nothing worked: stop trying for this run
  }
  if (apiSaysMore() || looksCapped()) incomplete = true; // never delist on a partial answer
  return { items, incomplete, pages, seen, firstKeys };
}

/** ONE service/country pair straight from the supplier (public price endpoint). Never throws. */
async function vsFetchPair(code, iso, timeoutMs) {
  const r = await vsReq(`/price?service=${encodeURIComponent(code)}&country=${encodeURIComponent(iso)}`, { timeoutMs: timeoutMs || 10000 });
  if (r.status === 429) return { rateLimited: true };
  if (!r.ok) return { none: true, http: r.status };
  const o = (r.json && (r.json.data || r.json.result)) || r.json || {};
  const usd = vsPriceOf(o) || vsPriceOf(r.json || {});
  const count = vsStockKnown(o) ? vsStockOf(o) : (usd > 0 ? 1 : 0);
  if (usd > 0 && count > 0) return { entry: { iso, code, usd, count } };
  return { none: true, usd, count };
}

// ---------------------------------------------------------------- the sync
async function vsRunSync(req, budgetMs) {
  const q = req.query || {};
  const force = q.force === '1' || q.force === 'true';
  const onlyService = String(q.service || '').trim();
  const fillMode = String(q.fill == null ? '' : q.fill).toLowerCase(); // '' (normal+fill) | '0' (no fill) | 'only'
  const started = Date.now();
  const deadline = started + budgetMs - 6000;
  const rate = Number(process.env.USD_TO_NGN_RATE) || Number(process.env.USD_TO_NGN) || 1500;
  const errors = [];
  const note = (m) => { if (errors.length < 20) errors.push(m); };

  // 1) service list + country list
  const [svcRes, ctyRes] = await Promise.all([vsReq('/customer/services'), vsReq('/customer/countries')]);
  if (!svcRes.ok) {
    return { status: 502, body: {
      success: false,
      message: `VirtualSMS services call failed (HTTP ${svcRes.status || 'no reply'}). ${svcRes.status === 401 ? 'Check VIRTUALSMS_API_KEY.' : ''}`,
      raw_hint: (svcRes.err || svcRes.text || '').slice(0, 160)
    } };
  }
  const services = vsAsList(svcRes.json, ['services', 'data', 'items', 'results'])
    .map((s) => { const code = vsServiceCode(s); return code ? { code, name: vsServiceNameOf(s, code) } : null; })
    .filter(Boolean);
  if (!services.length) {
    return { status: 502, body: { success: false, message: 'VirtualSMS returned no services.', raw_hint: svcRes.text.slice(0, 200) } };
  }
  const svcName = new Map(services.map((s) => [s.code, s.name]));

  // the supplier's own country list: which countries carry which services (the "services" field is "tg,wa,ig")
  const countryList = ctyRes.ok ? vsAsList(ctyRes.json, ['countries', 'data', 'items', 'results']) : [];
  const { isoName, expected } = vsBuildCountryIndex(countryList);

  const existing = await vsLoadExisting();

  // 2) which services to do now: never-synced / oldest first, popular first on ties
  const rank = (s) => {
    const pi = VS_POPULAR_CODES.indexOf(s.code);
    if (pi >= 0) return pi;
    return VS_POPULAR_RE.test(s.name) ? 100 : 1000;
  };
  const lastSeen = new Map();
  for (const r of existing.values()) {
    const t = r.updated_at ? new Date(r.updated_at).getTime() : 0;
    if (t > (lastSeen.get(r.service_id) || 0)) lastSeen.set(r.service_id, t);
  }
  const ordered = services.slice(0, VS_SERVICE_LIMIT);
  const now = Date.now();
  let todo = onlyService
    ? ordered.filter((s) => s.code === onlyService)
    : ordered.filter((s) => force || now - (lastSeen.get(s.code) || 0) >= VS_STALE_MS);
  if (fillMode === 'only') todo = [];
  todo = todo.sort((a, b) => (lastSeen.get(a.code) || 0) - (lastSeen.get(b.code) || 0) || rank(a) - rank(b));
  const servicesTotal = ordered.length;
  let servicesDone = servicesTotal - todo.length;

  // 3) fetch (paced + sequential: stays under VirtualSMS' 60 requests/minute)
  let lastCall = 0;
  const pace = async () => {
    const wait = lastCall + VS_MIN_GAP_MS - Date.now();
    if (wait > 0) await vsSleep(wait);
    lastCall = Date.now();
  };
  const paging = { mode: null, failed: false };
  const entries = new Map(); // "ISO|code" -> {iso, code, usd, count}
  const processed = new Set(); // services with a COMPLETE answer (the only ones where "missing" may be delisted)
  let rateLimited = false;
  let stoppedEarly = false;
  let requests = 0;
  let paginated = 0;
  let incompleteServices = 0;
  let firstKeys = null;
  const gapSample = [];
  let gapTotal = 0;

  // GAP FILL — the root cause of "synced, but USA / some countries / some services never show up":
  // VirtualSMS caps the per-service country list (about 50 countries, cheapest first), and a service that was
  // touched in the last few hours is skipped by the normal pass, so the missing countries were never fetched
  // ("fully synced, nothing to do"). The supplier's own country list tells us which (country, service) pairs
  // exist; every pair we do not have is fetched one by one from the price endpoint (USA and top countries first).
  const gap = { missing: 0, checked: 0, added: 0, no_stock: 0, remaining: 0, focus: null };
  const focusRaw = String(q.country || '').trim();
  const focusIso = focusRaw ? vsResolveIso(focusRaw, countryList) : null;
  gap.focus = focusIso;
  const runGap = async (dl) => {
    if (fillMode === '0' || rateLimited || !expected.size) return;
    const pairs = [];
    for (const [code, set] of expected) {
      if (!svcName.has(code)) continue;
      if (onlyService && code !== onlyService) continue;
      for (const iso of set) {
        if (focusIso && iso !== focusIso) continue;
        const cid = vsIsoToId(iso);
        if (cid == null) continue;
        if (entries.has(`${iso}|${code}`)) continue;
        const prev = existing.get(`${cid}|${code}`);
        if (prev) {
          // already known: only re-check sold-out rows that have gone stale (stock may be back)
          const stale = !prev.updated_at || now - new Date(prev.updated_at).getTime() >= VS_STALE_MS;
          const soldOut = prev.is_available === false && Number(prev.available_quantity || 0) <= 0;
          if (!(soldOut && stale)) continue;
        }
        pairs.push({ iso, code });
      }
    }
    gap.missing = pairs.length;
    const rankCode = (code) => rank({ code, name: svcName.get(code) || '' });
    const tier0 = [];
    const tier1 = [];
    for (const p of pairs) ((focusIso || VS_PRIORITY_ISO.includes(p.iso)) ? tier0 : tier1).push(p);
    // popular services first; rotate a little each run so pairs the supplier has no stock for never starve the rest
    const rot = (arr) => {
      if (arr.length < 2) return arr;
      arr.sort((a, b) => rankCode(a.code) - rankCode(b.code) || a.iso.localeCompare(b.iso));
      const off = (Math.floor(Date.now() / 300000) * 61) % arr.length;
      return arr.slice(off).concat(arr.slice(0, off));
    };
    const usFirst = focusIso ? rot(tier0) : rot(tier0.filter((p) => p.iso === 'US')).concat(rot(tier0.filter((p) => p.iso !== 'US')));
    const todoPairs = usFirst.concat(rot(tier1));
    let checkedNow = 0;
    for (const g of todoPairs) {
      if (Date.now() > dl) { if (dl >= deadline) stoppedEarly = true; break; }
      await pace();
      requests += 1;
      gap.checked += 1;
      checkedNow += 1;
      const out = await vsFetchPair(g.code, g.iso, 10000);
      if (out.rateLimited) { rateLimited = true; break; }
      if (out.entry) { entries.set(`${g.iso}|${g.code}`, out.entry); gap.added += 1; }
      else gap.no_stock += 1;
    }
    gap.remaining = Math.max(0, pairs.length - checkedNow);
  };

  // The admin "Sync Server 3" button (no extra options): look for the USA + top countries FIRST, then do the normal pass.
  if (fillMode === '' && !onlyService && !force) await runGap(Math.min(deadline, Date.now() + VS_QUICK_FILL_MS));

  for (const s of todo) {
    if (Date.now() > deadline) { stoppedEarly = true; break; }
    const out = await vsFetchServiceCountries(s.code, (expected.get(s.code) || new Set()).size, pace, deadline, paging);
    requests += out.pages || 0;
    if (out.pages > 1) paginated += 1;
    if (out.rateLimited) { rateLimited = true; break; }
    if (out.error) { note(`${s.code}: ${out.error}`); continue; }
    if (!firstKeys && out.firstKeys) firstKeys = out.firstKeys;

    let priced = 0;
    for (const c of out.items) {
      const iso = vsCountryIso(c);
      if (!iso) continue;
      if (!isoName.has(iso)) isoName.set(iso, vsCountryNameOf(c, iso));
      const usd = vsPriceOf(c);
      // docs: this call only lists countries that HAVE the service; with no stock field a listed price = in stock
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
    if (exp && out.seen) {
      const missing = [...exp].filter((iso) => !out.seen.has(iso));
      if (missing.length) {
        gapTotal += missing.length;
        if (gapSample.length < 8) gapSample.push(`${s.code}: ${missing.slice(0, 6).join(',')}${missing.length > 6 ? ' +' + (missing.length - 6) : ''}`);
      }
    }
    if (out.incomplete) incompleteServices += 1; else processed.add(s.code);
    servicesDone += 1;
  }

  // second gap-fill pass with whatever time is left (explicit &fill=only / &country=XX runs use all of it here)
  await runGap(deadline);

  if (!entries.size && !processed.size) {
    return { status: 200, body: {
      success: true, partial: rateLimited || stoppedEarly, done: !rateLimited && !stoppedEarly && !todo.length, rows_seen: 0, upserted: 0,
      message: rateLimited
        ? 'VirtualSMS rate limit hit (60/min). It will continue on the next run.'
        : (todo.length ? 'VirtualSMS answered but nothing could be read. Open /api/grizzly-sync?action=vsms_probe and check the sample.'
          : (gap.missing ? `Main catalog is up to date. Checked ${gap.checked} missing country/service pairs — none had stock yet. Tap Sync again to keep checking.` : 'Everything was synced recently — nothing to refresh. Add &force=1 to refresh all anyway.')),
      services_done: servicesDone, services_total: servicesTotal, gap_fill: gap, errors, ms: Date.now() - started
    } };
  }

  // 4) build rows
  const nowIso = new Date().toISOString();
  const rows = [];
  for (const e of entries.values()) {
    const cid = vsIsoToId(e.iso);
    if (cid == null) continue;
    const sell = Number(applyMarkup(e.usd, rate));
    rows.push({
      key: `${cid}|${e.code}`, country_id: cid,
      country_name: vsRegionName(e.iso) || isoName.get(e.iso) || e.iso,
      service_id: e.code, service_name: svcName.get(e.code) || e.code.toUpperCase(),
      supplier_price: e.usd, price: Number.isFinite(sell) && sell > 0 ? sell : Math.max(profitFloorNgn(e.usd, rate), 1000),
      available_quantity: e.count
    });
  }

  // 5) write: insert new, update changed, touch unchanged (batched), delist sold-out
  //    Pricing = same wiring as Server 1 / 2: applyMarkup on first sight, hand-set prices never overwritten,
  //    PLUS a safety net — a system price that has fallen under supplier cost + MIN_PROFIT_NGN is re-priced.
  const inserts = [];
  const updates = [];
  const touchIds = [];
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
    const protectedPrice = VS_PRICE_PROTECTED.has(prev.price_source);
    const prevPrice = Number(prev.price) || 0;
    const costMoved = Math.abs(Number(prev.supplier_price || 0) - r.supplier_price) > 0.0001;
    if (protectedPrice && prevPrice < r.supplier_price * rate) manualBelowCost += 1;
    const needsPrice = !protectedPrice && (!(prevPrice > 0) || prevPrice < profitFloorNgn(r.supplier_price, rate));
    // an admin-hidden row (hidden but still has stock) stays hidden; sold-out rows (qty 0) come back
    const adminHidden = prev.is_available === false && Number(prev.available_quantity || 0) > 0;
    const changed = needsPrice || costMoved || Number(prev.available_quantity || 0) !== r.available_quantity ||
      String(prev.country_name || '') !== r.country_name || String(prev.service_name || '') !== r.service_name ||
      (prev.is_available === false && !adminHidden);
    if (!changed) { touchIds.push(prev.id); continue; }
    const f = {
      country_name: r.country_name, service_name: r.service_name, supplier_price: r.supplier_price,
      available_quantity: r.available_quantity, is_available: !adminHidden, updated_at: nowIso
    };
    if (needsPrice) { f.price = r.price; f.price_source = 'system'; repriced += 1; }
    updates.push({ id: prev.id, ...f });
  }
  const goneIds = [];
  for (const [key, prev] of existing) {
    if (seenKeys.has(key) || !processed.has(prev.service_id)) continue;
    if (prev.is_available === false && Number(prev.available_quantity || 0) <= 0) continue;
    goneIds.push(prev.id);
  }

  const stats = { inserted: 0, updated: 0, delisted: 0 };
  for (let i = 0; i < updates.length; i += 20) {
    await Promise.all(updates.slice(i, i + 20).map(async (u) => {
      const { id, ...f } = u;
      const { error } = await supabase.from('number_services').update(f).eq('id', id);
      if (error) note('update: ' + error.message); else stats.updated += 1;
    }));
  }
  for (let i = 0; i < touchIds.length; i += 200) {
    const { error } = await supabase.from('number_services').update({ updated_at: nowIso }).in('id', touchIds.slice(i, i + 200));
    if (error) note('touch: ' + error.message);
  }
  for (let i = 0; i < inserts.length; i += 100) {
    // upsert + ignoreDuplicates: a row that already exists (overlapping run) can no longer sink the whole batch
    const { data, error } = await supabase.from('number_services')
      .upsert(inserts.slice(i, i + 100), { onConflict: 'source,country_id,service_id', ignoreDuplicates: true }).select('id');
    if (error) note('insert: ' + error.message); else stats.inserted += (data || []).length;
  }
  for (let i = 0; i < goneIds.length; i += 200) {
    const slice = goneIds.slice(i, i + 200);
    const { error } = await supabase.from('number_services')
      .update({ available_quantity: 0, is_available: false, updated_at: nowIso }).in('id', slice);
    if (error) note('sold-out: ' + error.message); else stats.delisted += slice.length;
  }

  if (inserts.length + updates.length > 0 && stats.inserted + stats.updated === 0) {
    return { status: 500, body: {
      success: false, message: 'VirtualSMS data was read but nothing could be saved. ' + (errors[0] || ''), errors, rows_seen: rows.length
    } };
  }

  const countriesInRun = new Set(rows.map((r) => r.country_id)).size;
  const partial = stoppedEarly || rateLimited || servicesDone < servicesTotal;
  let message = `Server 3 sync: ${rows.length} in-stock offers from ${processed.size} services this run (${stats.inserted} new, ${stats.updated} updated, ${stats.delisted} sold out). Services up to date: ${Math.min(servicesDone, servicesTotal)}/${servicesTotal}.`;
  if (gap.checked) {
    message += ` Missing-country fill${gap.focus ? ' (' + gap.focus + ')' : ''}: checked ${gap.checked} pairs the supplier lists but we did not have — ${gap.added} added${gap.remaining ? ', about ' + gap.remaining + ' still to check (tap Sync again)' : ''}.`;
  }
  if (partial) message += rateLimited ? ' Rate limit hit — it will continue on the next run.' : ' Not finished — run Sync again (or let the cron continue).';
  if (gapTotal) message += ` Supplier capped ${gapTotal} country/service pairs in the bulk answer — see "coverage"; the fill pass covers them.`;
  if (manualBelowCost) message += ` ${manualBelowCost} hand-priced rows are below supplier cost (orders for them are blocked).`;

  return { status: 200, body: {
    success: true, source: VS_SOURCE, partial, done: !partial, rate_limited: rateLimited,
    rows_seen: rows.length, upserted: stats.inserted + stats.updated, inserted: stats.inserted, updated: stats.updated,
    delisted: stats.delisted, repriced, manual_below_cost: manualBelowCost,
    services_done: servicesDone, services_total: servicesTotal, supplier_requests: requests, ms: Date.now() - started,
    gap_fill: gap,
    coverage: {
      supplier_countries: countryList.length, countries_in_this_run: countriesInRun,
      services_paginated: paginated, services_incomplete: incompleteServices, paging_mode: paging.mode,
      missing_pairs: gapTotal, missing_sample: gapSample, response_keys: firstKeys
    },
    errors, message
  } };
}

// ---------------------------------------------------------------- run lock (best effort, sync_jobs row source='virtualsms')
async function vsGetLock() {
  try {
    const { data } = await supabase.from('sync_jobs').select('status, updated_at').eq('source', VS_SOURCE).maybeSingle();
    if (data && data.status === 'running' && data.updated_at && Date.now() - new Date(data.updated_at).getTime() < VS_LOCK_MS) return true;
  } catch (_) { /* table/row missing → no lock */ }
  return false;
}
async function vsSetJob(fields) {
  try { await supabase.from('sync_jobs').upsert({ source: VS_SOURCE, updated_at: new Date().toISOString(), ...fields }); } catch (_) { /* best effort */ }
}

/**
 * GET|POST /api/grizzly-sync?action=vsms_sync   (admin button + cron)
 *   &force=1      ignore "recently synced" and refresh everything
 *   &service=wa   re-sync one service only
 *   &country=US   fill every service the supplier lists for that country but we do not have
 *   &fill=only    skip the normal pass, only fill missing pairs   ·   &fill=0  skip the fill pass
 * Cron gets the long budget; the admin button gets one that fits inside the browser's 90 s timeout.
 */
async function vsHandleSync(req, res) {
  if (!(await vsAdminOrCron(req, res))) return;
  if (!vsApiKey()) {
    return res.status(500).json({ success: false, message: 'VIRTUALSMS_API_KEY is not set on the server (Vercel → Environment Variables).' });
  }
  const force = String((req.query || {}).force || '') === '1';
  if (!force && await vsGetLock()) {
    return res.status(200).json({ success: true, busy: true, partial: true, done: false, message: 'A Server 3 sync is already running. Wait a minute and check again.' });
  }
  await vsSetJob({ status: 'running', started_at: new Date().toISOString(), errors: [] });
  let out;
  try {
    out = await vsRunSync(req, vsIsCron(req) ? VS_TIME_BUDGET_MS : VS_MANUAL_BUDGET_MS);
  } catch (err) {
    console.error('vsms full sync error:', err);
    out = { status: 500, body: { success: false, message: 'Server 3 sync failed: ' + (err && err.message ? err.message : String(err)) } };
  }
  // release the lock BEFORE answering (a serverless function can be frozen the moment the response is sent)
  await vsSetJob({ status: 'idle' });
  return res.status(out.status).json(out.body);
}

async function vsHandleProbe(req, res) {
  if (!(await vsAdminOrCron(req, res))) return;
  const cut = (r) => ({ status: r.status, err: r.err || undefined, sample: (r.text || '').slice(0, 700) });
  const [svc, cty, wa, bal, usWa] = await Promise.all([
    vsReq('/customer/services'), vsReq('/customer/countries'), vsReq('/customer/countries?service=wa'), vsReq('/customer/balance'),
    vsReq('/price?service=wa&country=US')
  ]);
  const out = { success: true, services: cut(svc), countries: cut(cty), countries_for_wa: cut(wa), balance: cut(bal), price_wa_us: cut(usWa) };
  // how many countries does the bulk answer really contain, and is the USA in it?
  try {
    const waList = vsAsList(wa.json, ['countries', 'data', 'items', 'results']);
    const waIsos = waList.map(vsCountryIso).filter(Boolean);
    out.wa_bulk = { countries_returned: waIsos.length, includes_US: waIsos.includes('US') };
    const ctyList = vsAsList(cty.json, ['countries', 'data', 'items', 'results']);
    const ctyIsos = ctyList.map(vsCountryIso).filter(Boolean);
    out.supplier_country_list = { countries: ctyIsos.length, includes_US: ctyIsos.includes('US') };
  } catch (_) { /* diagnostic only */ }

  // &paging=1 → find out which paging parameter VirtualSMS really honours (&service=xx to test another service)
  if (String((req.query || {}).paging || '') === '1') {
    const code = String((req.query || {}).service || 'wa');
    const base = '/customer/countries?service=' + encodeURIComponent(code);
    const KEYS = ['countries', 'data', 'items', 'results'];
    const first = new Set();
    const tests = {};
    for (const v of ['', '&page=2', '&offset=50', '&limit=1000', '&per_page=1000', '&page_size=1000']) {
      const r = await vsReq(base + v);
      const isos = vsAsList(r.json, KEYS).map(vsCountryIso).filter(Boolean);
      tests[v || '(plain)'] = {
        status: r.status, countries: isos.length,
        new_vs_plain: v ? isos.filter((i) => !first.has(i)).length : isos.length
      };
      if (!v) isos.forEach((i) => first.add(i));
      await vsSleep(VS_MIN_GAP_MS);
    }
    out.paging_test = { service: code, tests, hint: 'A variant with new_vs_plain > 0 is the parameter the sync will use.' };
  }
  return res.status(200).json(out);
}

async function vsHandlePurgeLegacy(req, res) {
  const a = await requireAdmin(req);
  if (!a.ok) return res.status(a.status).json({ success: false, message: a.message });
  const { data, error } = await supabase.from('number_services').delete().eq('source', VS_SOURCE).lt('country_id', VS_ID_BASE).select('id');
  if (error) return res.status(500).json({ success: false, message: error.message });
  return res.status(200).json({ success: true, deleted: (data || []).length, message: `Deleted ${(data || []).length} old Server 3 rows.` });
}

// ---------------------------------------------------------------- LIVE LOOKUP (customer search → ask the supplier)
// When a customer searches a service or a country that is not in our database, the page calls this. We ask
// VirtualSMS directly, save whatever is really available (priced with the normal markup, hand-set prices never
// overwritten) and return it, so the customer sees it immediately and the next customer finds it in the database.
const VS_LOOKUP_MAX_CALLS = 8;
const VS_LOOKUP_BUDGET_MS = 14000;
const VS_LOOKUP_GAP_MS = 800;
const VS_CACHE_MS = 10 * 60 * 1000;
const _vsCache = { services: null, countries: null };
const _vsLookupHits = new Map();

function vsLookupThrottled(userId) {
  const now = Date.now();
  const arr = (_vsLookupHits.get(userId) || []).filter((t) => now - t < 60000);
  if (arr.length >= 12) { _vsLookupHits.set(userId, arr); return true; }
  arr.push(now);
  _vsLookupHits.set(userId, arr);
  if (_vsLookupHits.size > 2000) _vsLookupHits.clear();
  return false;
}
async function vsCachedServices() {
  if (_vsCache.services && Date.now() - _vsCache.services.t < VS_CACHE_MS) return _vsCache.services.list;
  const r = await vsReq('/customer/services');
  if (!r.ok) return _vsCache.services ? _vsCache.services.list : [];
  const list = vsAsList(r.json, ['services', 'data', 'items', 'results'])
    .map((s) => { const code = vsServiceCode(s); return code ? { code, name: vsServiceNameOf(s, code) } : null; })
    .filter(Boolean);
  _vsCache.services = { t: Date.now(), list };
  return list;
}
async function vsCachedCountries() {
  if (_vsCache.countries && Date.now() - _vsCache.countries.t < VS_CACHE_MS) return _vsCache.countries.idx;
  const r = await vsReq('/customer/countries');
  const list = r.ok ? vsAsList(r.json, ['countries', 'data', 'items', 'results']) : [];
  const idx = Object.assign({ list }, vsBuildCountryIndex(list));
  if (list.length) _vsCache.countries = { t: Date.now(), idx };
  return idx;
}

/** Save live entries into number_services (new rows inserted, existing ones refreshed) and return client-ready rows. */
async function vsPersistEntries(list, svcNames, isoNames) {
  if (!list.length) return [];
  const rate = Number(process.env.USD_TO_NGN_RATE) || Number(process.env.USD_TO_NGN) || 1500;
  const nowIso = new Date().toISOString();
  const cids = [...new Set(list.map((e) => vsIsoToId(e.iso)).filter((x) => x != null))];
  const codes = [...new Set(list.map((e) => e.code))];
  const prevMap = new Map();
  const { data: ex } = await supabase
    .from('number_services')
    .select('id, country_id, service_id, price, price_source, supplier_price, available_quantity, is_available')
    .eq('source', VS_SOURCE).in('country_id', cids).in('service_id', codes).limit(2000);
  for (const r of ex || []) prevMap.set(`${r.country_id}|${r.service_id}`, r);

  const out = [];
  const inserts = [];
  const updates = [];
  for (const e of list) {
    const cid = vsIsoToId(e.iso);
    if (cid == null) continue;
    const countryName = vsRegionName(e.iso) || (isoNames && isoNames.get(e.iso)) || e.iso;
    const serviceName = (svcNames && svcNames.get(e.code)) || e.code.toUpperCase();
    const sell = Number(applyMarkup(e.usd, rate));
    const sysPrice = Number.isFinite(sell) && sell > 0 ? sell : Math.max(profitFloorNgn(e.usd, rate), 1000);
    const prev = prevMap.get(`${cid}|${e.code}`);
    if (!prev) {
      inserts.push({
        source: VS_SOURCE, country_id: cid, country_name: countryName, service_id: e.code, service_name: serviceName,
        supplier_price: e.usd, price: sysPrice, price_source: 'system', currency: 'NGN',
        available_quantity: e.count, is_available: true, updated_at: nowIso
      });
      out.push({ service_id: e.code, service_name: serviceName, country_id: cid, country_name: countryName, price: sysPrice, available_quantity: e.count, supplier_price: e.usd });
      continue;
    }
    const protectedPrice = VS_PRICE_PROTECTED.has(prev.price_source);
    const prevPrice = Number(prev.price) || 0;
    const needsPrice = !protectedPrice && (!(prevPrice > 0) || prevPrice < profitFloorNgn(e.usd, rate));
    const adminHidden = prev.is_available === false && Number(prev.available_quantity || 0) > 0;
    const f = { country_name: countryName, service_name: serviceName, supplier_price: e.usd, available_quantity: e.count, is_available: !adminHidden, updated_at: nowIso };
    if (needsPrice) { f.price = sysPrice; f.price_source = 'system'; }
    updates.push({ id: prev.id, f });
    if (!adminHidden) {
      out.push({ service_id: e.code, service_name: serviceName, country_id: cid, country_name: countryName, price: needsPrice ? sysPrice : prevPrice, available_quantity: e.count, supplier_price: e.usd });
    }
  }
  if (inserts.length) {
    const { error } = await supabase.from('number_services').upsert(inserts, { onConflict: 'source,country_id,service_id', ignoreDuplicates: true });
    if (error) console.error('[vsms lookup] insert failed:', error.message);
  }
  await Promise.all(updates.map(async (u) => {
    const { error } = await supabase.from('number_services').update(u.f).eq('id', u.id);
    if (error) console.error('[vsms lookup] update failed:', error.message);
  }));
  return out;
}

/**
 * POST|GET /api/grizzly-sync?action=vsms_lookup   (needs a signed-in customer's Bearer token)
 *   { q: "whatsapp" }                          service search that found nothing locally
 *   { service: "wa", country_q: "usa" }        country search (inside a service) that found nothing locally
 *   { q: "telegram", country_q: "nigeria" }    both
 */
async function vsHandleLookup(req, res) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: 'Please sign in.' });
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ success: false, message: 'Please sign in.' });
  if (!vsApiKey()) return res.status(500).json({ success: false, message: 'This SMS server is not available right now.' });
  if (vsLookupThrottled(user.id)) return res.status(429).json({ success: false, message: 'Too many searches. Wait a few seconds and try again.' });

  let b = {};
  try { b = req.method === 'POST' ? vsBody(req) : (req.query || {}); } catch (_) { b = {}; }
  const q = String(b.q || '').trim().slice(0, 60);
  const serviceHint = String(b.service || '').trim().slice(0, 60);
  const countryQ = String(b.country_q || '').trim().slice(0, 60);
  if (!q && !serviceHint) return res.status(400).json({ success: false, message: 'Nothing to look up.' });

  try {
    const started = Date.now();
    const deadline = started + VS_LOOKUP_BUDGET_MS;
    let calls = 0;
    let lastCall = 0;
    const pace = async () => {
      const wait = lastCall + VS_LOOKUP_GAP_MS - Date.now();
      if (wait > 0) await vsSleep(wait);
      lastCall = Date.now();
    };
    const canCall = () => calls < VS_LOOKUP_MAX_CALLS && Date.now() < deadline;

    const [catalog, cidx] = await Promise.all([vsCachedServices(), vsCachedCountries()]);
    const svcNames = new Map(catalog.map((s) => [s.code, s.name]));

    // 1) which service(s)?
    let services = [];
    if (serviceHint) {
      const nh = vsNorm(serviceHint);
      services = catalog.filter((s) => s.code === serviceHint || vsNorm(s.name) === nh).slice(0, 1);
      if (!services.length && /^[a-z0-9_-]{1,40}$/i.test(serviceHint)) services = [{ code: serviceHint, name: serviceHint.toUpperCase() }];
    } else {
      const nq = vsNorm(q);
      if (nq.length >= 2) {
        const scored = [];
        for (const s of catalog) {
          const nn = vsNorm(s.name);
          let score = -1;
          if (nn === nq || vsNorm(s.code) === nq) score = 0;
          else if (nn.startsWith(nq)) score = 1;
          else if (nn.includes(nq)) score = 2;
          if (score >= 0) scored.push({ s, score });
        }
        scored.sort((a, b2) => a.score - b2.score || a.s.name.length - b2.s.name.length);
        services = scored.slice(0, 3).map((x) => x.s);
      }
    }
    if (!services.length) {
      return res.status(200).json({ success: true, found: 0, rows: [], services: [], message: 'This service is not offered by the supplier.' });
    }

    // 2) which country? (optional)
    let iso = null;
    if (countryQ) {
      iso = vsResolveIso(countryQ, cidx.list);
      if (!iso) return res.status(200).json({ success: true, found: 0, rows: [], services: services.map((s) => ({ service_id: s.code, service_name: s.name })), message: 'That country is not offered by the supplier.' });
    }

    const entries = new Map();
    let rateLimited = false;

    if (iso) {
      // exact pair(s)
      for (const s of services) {
        if (!canCall()) break;
        await pace(); calls += 1;
        const out = await vsFetchPair(s.code, iso, 8000);
        if (out.rateLimited) { rateLimited = true; break; }
        if (out.entry) entries.set(`${iso}|${s.code}`, out.entry);
      }
    } else {
      // service-only: the supplier's country list for the service, then the top countries it may have cut off
      for (const s of services.slice(0, 2)) {
        if (!canCall()) break;
        await pace(); calls += 1;
        const r = await vsReq('/customer/countries?service=' + encodeURIComponent(s.code), { timeoutMs: 10000 });
        if (r.status === 429) { rateLimited = true; break; }
        if (!r.ok) continue;
        for (const c of vsAsList(r.json, ['countries', 'data', 'items', 'results'])) {
          const ciso = vsCountryIso(c);
          if (!ciso) continue;
          const usd = vsPriceOf(c);
          const count = vsStockOf(c) || (vsStockKnown(c) ? 0 : (usd > 0 ? 1 : 0));
          if (usd > 0 && count > 0) entries.set(`${ciso}|${s.code}`, { iso: ciso, code: s.code, usd, count });
        }
        const exp = cidx.expected;
        for (const p of VS_PRIORITY_ISO) {
          if (!canCall() || rateLimited) break;
          if (entries.has(`${p}|${s.code}`)) continue;
          if (exp.size && !(exp.get(s.code) && exp.get(s.code).has(p))) continue; // supplier does not list it for this country
          await pace(); calls += 1;
          const out = await vsFetchPair(s.code, p, 8000);
          if (out.rateLimited) { rateLimited = true; break; }
          if (out.entry) entries.set(`${p}|${s.code}`, out.entry);
        }
      }
    }

    const rows = await vsPersistEntries([...entries.values()], svcNames, cidx.isoName);
    return res.status(200).json({
      success: true,
      found: rows.length,
      rows,
      services: services.map((s) => ({ service_id: s.code, service_name: s.name })),
      rate_limited: rateLimited,
      message: rows.length ? 'Found at the supplier.' : (rateLimited ? 'Supplier is busy — try again in a few seconds.' : 'Not available at the supplier right now.')
    });
  } catch (err) {
    console.error('vsms lookup error:', err);
    return res.status(500).json({ success: false, message: 'Could not check the supplier right now.' });
  }
}

// ---------------------------------------------------------------- orders
/** Kept for the order path: credits ONCE and returns the new balance (see creditWalletOnce). */
async function vsCreditWallet(userId, amount) {
  const r = await creditWalletOnce(userId, amount, 'vsms-order-restore');
  if (!r.ok) console.error('[vsms] CRITICAL: could not restore wallet', { userId, amount, reason: r.reason });
  return r.newBalance;
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

  let originalBalance = 0, price = 0, deducted = false, purchased = false, customerId = null, serviceName = '', countryName = '';
  try {
    const { data: svc } = await supabase.from('number_services')
      .select('service_name, country_name, price, supplier_price, is_available')
      .eq('source', VS_SOURCE).eq('country_id', Number(country_id)).eq('service_id', serviceId).maybeSingle();
    if (!svc) return res.status(404).json({ success: false, message: 'This service is no longer available. Refresh, try another, or contact support.' });
    if (!svc.is_available) return res.status(409).json({ success: false, message: 'This number service is currently out of stock.' });
    serviceName = svc.service_name; countryName = svc.country_name; price = Number(svc.price) || 0;

    // Never sell below supplier cost (also blocks hand-priced rows that are under cost)
    if (!(price > 0) || sellsBelowCost(price, svc.supplier_price)) {
      console.error('[vsms order] blocked: price below supplier cost', { country_id, service_id: serviceId, price, supplier_price: svc.supplier_price });
      return res.status(409).json({ success: false, message: 'This number service is temporarily unavailable. Please try another country or service.' });
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

    const r = await vsReq('/customer/purchase', { method: 'POST', body: { service: serviceId, country: iso }, timeoutMs: 30000 });
    const j = r.json || {};
    const orderId = j.order_id || j.id || (j.order && (j.order.order_id || j.order.id));
    const phone = j.phone_number || j.number || (j.order && (j.order.phone_number || j.order.number)) || null;
    if (!r.ok || j.success === false || !orderId) {
      // The purchase failed → give back exactly what we took, ONCE.
      if (r.status === 0) console.error('[vsms order] UNCERTAIN: no reply from supplier — check supplier history for a charge', { user_id, price, err: r.err });
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
    purchased = true; // the supplier now holds a number for this customer — never auto-refund from here on

    // What VirtualSMS actually charged us vs what we charged the customer (cost moved since the last sync?)
    const paidUsd = vsNum(j.price ?? (j.order && j.order.price));
    if (paidUsd > 0 && sellsBelowCost(price, paidUsd)) {
      console.error('[vsms order] SOLD BELOW COST — supplier charged more than the stored price covers', { orderId, price, paidUsd, supplier_price: svc.supplier_price });
    }

    const row = {
      source: VS_SOURCE, user_id, customer_id: customerId, order_id: String(orderId), idempotency_key: idem,
      country_id: Number(country_id), country_name: countryName, service_id: serviceId, service_name: serviceName,
      phone_number: phone, price, supplier_price: paidUsd > 0 ? paidUsd : (Number(svc.supplier_price) || null), currency: 'NGN',
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
    if (deducted && !purchased) { try { await vsCreditWallet(user_id, price); } catch (e) { console.error('CRITICAL vsms auto-restore failed', e); } }
    return res.status(500).json({ success: false, message: (deducted && !purchased) ? 'Something went wrong. Your balance has been restored.' : 'Something went wrong. Please try again.' });
  }
}

async function vsFindOrder(orderId, userId) {
  const q = supabase.from('number_orders')
    .select('id, user_id, order_id, status, phone_number, created_at, service_name, country_name, country_id, price, refunded, customer_id, code, source')
    .eq('source', VS_SOURCE).eq('order_id', String(orderId));
  if (userId) q.eq('user_id', userId);
  const { data } = await q.maybeSingle();
  return data;
}
const vsView = (o, extra) => ({
  order_id: o.order_id, status: o.status, number: o.phone_number, code: o.code || null, created_at: o.created_at,
  service_name: o.service_name, country_name: o.country_name, country_id: o.country_id != null ? o.country_id : null,
  price: o.price, refunded: !!o.refunded, ...(extra || {})
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

/**
 * Ask VirtualSMS to cancel an order and classify the answer. A refund to the customer is only allowed
 * when this says 'cancelled' (the supplier confirmed) — never on 'failed', 'early' or 'received'.
 */
async function vsCancelAtSupplier(orderId) {
  const r = await vsReq('/customer/cancel/' + encodeURIComponent(orderId), { method: 'POST' });
  const errTxt = String((r.json && (r.json.error || r.json.message)) || r.text || '');
  if (r.status === 425) return { state: 'early', r };
  if (r.ok && !(r.json && r.json.success === false)) return { state: 'cancelled', r };
  if (/sms_received|completed|received/i.test(errTxt)) return { state: 'received', r };
  if (/status:\s*(cancelled|canceled|expired|refunded)/i.test(errTxt)) return { state: 'cancelled', r };
  if (r.status === 404) return { state: 'missing', r };
  return { state: 'failed', r };
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
    // Past the window and still no code. Refund ONLY once the supplier has confirmed the cancel (otherwise a late
    // SMS would be paid for by us AND already refunded to the customer).
    const c = await vsCancelAtSupplier(order.order_id);
    if (c.state === 'cancelled' || c.state === 'missing') return { kind: 'expired' };
    if (c.state === 'received') {
      const peek = await vsReq('/customer/order/' + encodeURIComponent(order.order_id));
      if (peek.ok) {
        const { code } = vsParseOrder(peek.json);
        if (code) { await vsMarkCompleted(order, code); return { kind: 'completed', code, status: 'completed' }; }
      }
      return { kind: 'waiting', pendingExpiry: true };
    }
    // supplier would not confirm (early / failed): keep trying; give up (refund the customer) only after the hard grace
    if (age >= EXPIRY_MS + VS_HARD_GRACE_MS) return { kind: 'expired', unconfirmed: true };
    return { kind: 'waiting', pendingExpiry: true };
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
      if (!rf.refunded && rf.reason !== 'already_final') {
        return res.status(502).json({ success: false, message: 'Your refund is being processed. Please try again in a moment.' });
      }
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
    // The customer is only refunded after the SUPPLIER confirms the cancel (so we never refund a number we still pay for).
    const c = await vsCancelAtSupplier(order.order_id);
    if (c.state === 'early') {
      return res.status(400).json({ success: false, code: 'EARLY_CANCEL_DENIED', wait_seconds: 30, message: 'Cancel is not available yet. Try again in a moment.' });
    }
    if (c.state === 'received') {
      return res.status(409).json({ success: false, code: 'NUMBER_CODE_ALREADY_RECEIVED', message: 'A code was already received — this order cannot be cancelled.' });
    }
    if (c.state === 'missing' && age < EXPIRY_MS) {
      // supplier does not know this order (yet): do not pay out on a guess inside the live window
      return res.status(400).json({ success: false, code: 'SUPPLIER_NOT_FOUND', message: 'The supplier could not find this order yet. Try again in a minute, or contact support.' });
    }
    if (c.state === 'failed') {
      return res.status(400).json({ success: false, code: 'CANCEL_FAILED', message: 'Could not cancel this order right now. Try again shortly.' });
    }
    // c.state === 'cancelled' (or 'missing' after the window has passed) → refund exactly once
    const rf = await claimAndRefundOrder(order, user_id, { status: 'refunded', subtitle: 'Cancelled — balance restored' });
    if (!rf.refunded && rf.reason === 'already_final') return res.status(409).json({ success: false, message: 'This order was already refunded.' });
    if (!rf.refunded) {
      return res.status(502).json({ success: false, message: 'Your number was cancelled but the refund could not be applied yet. Tap Check again in a moment.' });
    }
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
    if (act === 'vsms_lookup') return vsHandleLookup(req, res);
    if (act === 'vsms_purge_legacy') return vsHandlePurgeLegacy(req, res);
    // action is one of: null (continue/cron), 'start', 'status' — handled inside handleSync (Server 1)
    return handleSync(req, res);
  }

  if (req.method === 'POST') {
    if (isVsSync) return vsHandleSync(req, res);
    if (act === 'vsms_lookup') return vsHandleLookup(req, res);
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
      message: "POST requires ?action=order, ?action=check, ?action=cancel, ?action=vsms_lookup, or ?action=vsms_sync"
    });
  }

  return res.status(405).json({ success: false, message: 'Method not allowed' });
}
