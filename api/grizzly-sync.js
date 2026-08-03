import { createClient } from '@supabase/supabase-js';

/**
 * GET /api/grizzly-sync
 * Admin-only. Pulls the country + price/stock catalog from GrizzlySMS
 * (sms-activate-compatible protocol: query-string GET, api_key as a query
 * param — NOT the JSON/Bearer style used by LogsDomain) and upserts into
 * number_services with source='grizzlysms'.
 *
 * This file is intentionally self-contained — it does not import or share
 * any code with numbers-sync.js (LogsDomain) or any future
 * smspva-sync.js / smsman-sync.js, so a bug or API change in one supplier
 * integration can never break another.
 *
 * Env: GRIZZLYSMS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const BASE = 'https://api.grizzlysms.com/stubs/handler_api.php';

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

  const isAdmin = profile && (profile.is_admin === true || profile.is_admin === 'true' || profile.is_admin === 1);
  if (!isAdmin) return { ok: false, status: 403, message: 'Admin privileges required' };
  return { ok: true };
}

/** Kept as its own copy on purpose — see numbers-sync.js / products-logsdomain.js
 *  for why markup logic is never shared across supplier integrations. */
function applyMarkup(supplierPriceUsd, usdToNgn) {
  const percent = 50 + Math.random() * 50;
  const ngn = Number(supplierPriceUsd) * usdToNgn;
  const finalPrice = Math.ceil(ngn * (1 + percent / 100));
  return Math.ceil(finalPrice / 50) * 50;
}

async function callGrizzly(apiKey, params) {
  const qs = new URLSearchParams({ api_key: apiKey, ...params });
  const res = await fetch(`${BASE}?${qs.toString()}`, { method: 'GET' });
  const text = await res.text();
  return { status: res.status, text };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, message: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' });
  }
  if (!process.env.GRIZZLYSMS_API_KEY) {
    return res.status(500).json({ success: false, message: 'Missing GRIZZLYSMS_API_KEY' });
  }

  const admin = await requireAdmin(req);
  if (!admin.ok) return res.status(admin.status).json({ success: false, message: admin.message });

  const apiKey = process.env.GRIZZLYSMS_API_KEY;
  // Query-param override lets you sync a manageable slice first
  // (?country_id=1) instead of every country in one call while you're
  // still validating the response shape against your real key.
  const onlyCountryId = req.query?.country_id ? parseInt(req.query.country_id, 10) : null;
  const usdToNgn = Number(process.env.USD_TO_NGN_RATE) || 1420;

  try {
    // 1. Countries: GrizzlySMS's own tooling exposes a getCountries action
    //    (see their MCP server docs). If your key returns a different shape
    //    than expected here, this will show up as `countries_error` below
    //    instead of silently corrupting number_services — check that field
    //    first if sync comes back with 0 countries.
    const countriesRes = await callGrizzly(apiKey, { action: 'getCountries' });
    let countries;
    try {
      countries = JSON.parse(countriesRes.text);
    } catch {
      return res.status(502).json({
        success: false,
        message: 'getCountries did not return JSON — check GRIZZLYSMS_API_KEY and raw response',
        raw: countriesRes.text.slice(0, 500)
      });
    }

    if (countriesRes.text === 'BAD_KEY') {
      return res.status(401).json({ success: false, message: 'GrizzlySMS rejected the API key (BAD_KEY)' });
    }

    // Response is expected as an array or {id: {id, eng/name, ...}} map —
    // handle both defensively rather than assuming one shape.
    const countryList = Array.isArray(countries)
      ? countries
      : Object.entries(countries || {}).map(([id, c]) => ({ id, ...(typeof c === 'object' ? c : { name: c }) }));

    const targetCountries = onlyCountryId
      ? countryList.filter((c) => parseInt(c.id, 10) === onlyCountryId)
      : countryList;

    let newCount = 0;
    let updatedCount = 0;
    let servicesSeen = 0;
    const errors = [];

    for (const country of targetCountries) {
      const countryId = parseInt(country.id, 10);
      if (!Number.isFinite(countryId)) continue;
      const countryName = country.eng || country.name || country.rus || `Country ${countryId}`;

      // 2. Prices for this country, v3: gives per-provider price+stock
      //    breakdown, not just one aggregate number. Shape:
      //    { "<country>": { "<service>": { price, count, providers: {
      //        "<providerId>": { price: [p1,p2,...], count, provider_id } } } } }
      const pricesRes = await callGrizzly(apiKey, { action: 'getPricesV3', country: String(countryId) });
      let priceData;
      try {
        priceData = JSON.parse(pricesRes.text);
      } catch {
        errors.push(`country ${countryId}: getPricesV3 did not return JSON (${pricesRes.text.slice(0, 100)})`);
        continue;
      }

      const countryPrices = priceData?.[String(countryId)] || priceData?.[countryId] || {};

      for (const [serviceCode, info] of Object.entries(countryPrices)) {
        servicesSeen += 1;
        if (!serviceCode) continue;

        // Top-level price/count on v3 is Grizzly's own aggregate (effectively
        // their best/cheapest pick across providers) — use that as our
        // supplier cost, and keep the full per-provider breakdown alongside
        // it so admin can see exactly which providers are behind that number
        // and at what price/stock each one sits.
        const supplierPriceUsd = Number(info?.price ?? 0);
        const availableQty = Number(info?.count ?? 0);
        const providersRaw = info?.providers && typeof info.providers === 'object' ? info.providers : null;

        const { data: existing } = await supabase
          .from('number_services')
          .select('id')
          .eq('source', 'grizzlysms')
          .eq('country_id', countryId)
          .eq('service_id', serviceCode)
          .maybeSingle();

        if (existing) {
          updatedCount += 1;
          const { error } = await supabase
            .from('number_services')
            .update({
              country_name: countryName,
              service_name: serviceCode, // display-friendly name mapping can be layered on later via getServicesList
              supplier_price: supplierPriceUsd,
              available_quantity: availableQty,
              providers_raw: providersRaw,
              is_available: availableQty > 0,
              updated_at: new Date().toISOString()
            })
            .eq('id', existing.id);
          if (error) errors.push(`update ${countryId}/${serviceCode}: ${error.message}`);
        } else {
          newCount += 1;
          const { error } = await supabase
            .from('number_services')
            .insert({
              source: 'grizzlysms',
              country_id: countryId,
              country_name: countryName,
              service_id: serviceCode,
              service_name: serviceCode,
              supplier_price: supplierPriceUsd,
              price: applyMarkup(supplierPriceUsd, usdToNgn),
              currency: 'NGN',
              available_quantity: availableQty,
              providers_raw: providersRaw,
              is_available: availableQty > 0,
              updated_at: new Date().toISOString()
            });
          if (error) errors.push(`insert ${countryId}/${serviceCode}: ${error.message}`);
        }
      }
    }

    return res.status(200).json({
      success: true,
      source: 'grizzlysms',
      countries_scanned: targetCountries.length,
      services_seen: servicesSeen,
      new_services: newCount,
      updated_services: updatedCount,
      errors: errors.slice(0, 20)
    });
  } catch (err) {
    console.error('grizzly-sync error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}
