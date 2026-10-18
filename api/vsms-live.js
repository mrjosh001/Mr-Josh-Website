import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const VS_REST = 'https://virtualsms.io/api/v1';
const VS_KEY = String(process.env.VIRTUALSMS_API_KEY || process.env.VIRTUAL_SMS_API_KEY || '').trim();

function send(res, status, body) { res.status(status).json(body); }

async function requireUser(req) {
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Bearer ')) return null;
  const { data: { user }, error } = await supabase.auth.getUser(h.slice(7).trim());
  return error || !user ? null : user;
}

async function vsReq(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 20000);
  try {
    const r = await fetch(`${VS_REST}${path}`, {
      method: options.method || 'GET',
      headers: { Authorization: `Bearer ${VS_KEY}`, 'X-API-Key': VS_KEY, Accept: 'application/json', ...(options.headers || {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) {}
    return { ok: r.ok, status: r.status, json, text };
  } finally { clearTimeout(timer); }
}

function listOf(json, keys) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  for (const k of keys) if (Array.isArray(json[k])) return json[k];
  const entries = Object.entries(json).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v));
  return entries.length ? entries.map(([key, value]) => ({ _key: key, ...value })) : [];
}
function serviceCode(s) {
  for (const v of [s.code, s.service_id, s.service, s.id, s.key, s._key]) {
    const x = String(v == null ? '' : v).trim();
    if (x && x.length < 80) return x;
  }
  return null;
}
function serviceName(s, code) {
  for (const v of [s.name, s.service_name, s.title, s.label, s.display_name, s.eng]) {
    const x = String(v == null ? '' : v).trim();
    if (x) return x;
  }
  return code;
}
function countryIso(c) {
  for (const v of [c.country_id, c.iso, c.iso2, c.country_code, c.code, c.country, c._key]) {
    const x = String(v == null ? '' : v).trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(x)) return x;
  }
  return null;
}
function countryName(c, iso) {
  for (const v of [c.country_name, c.name, c.eng, c.english, c.title, c.label, c.country]) {
    const x = String(v == null ? '' : v).trim();
    if (x.length > 2 && !/^\d+$/.test(x) && x.toUpperCase() !== iso) return x;
  }
  return iso;
}
function stock(c) {
  for (const v of [c.stock, c.available_quantity, c.quantity, c.count, c.available, c.numbers]) {
    if (v !== undefined && v !== null && v !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
    }
  }
  return null;
}
function priceUsd(c) {
  for (const v of [c.price, c.cost, c.rate, c.price_usd, c.usd_price]) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}
function isoToId(iso) {
  const s = String(iso || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(s)) return null;
  return 1000 + (s.charCodeAt(0) - 65) * 26 + (s.charCodeAt(1) - 65);
}
function retailPrice(usd) {
  const rate = Number(process.env.USD_TO_NGN_RATE) || Number(process.env.USD_TO_NGN) || 1500;
  const minProfit = Number(process.env.MIN_PROFIT_NGN) || 500;
  const minSale = Number(process.env.MIN_NUMBER_PRICE_NGN) || 1000;
  const raw = Number(usd) * rate;
  if (!(raw > 0)) return minSale;
  return Math.ceil(Math.max(raw * 1.8, raw + minProfit, minSale) / 50) * 50;
}

async function upsertLivePairs(serviceId, serviceNameText, countries) {
  const rows = [];
  for (const c of countries) {
    const iso = countryIso(c), usd = priceUsd(c);
    if (!iso || !(usd > 0)) continue;
    const qty = stock(c);
    rows.push({
      source: 'virtualsms', country_id: isoToId(iso), country_name: countryName(c, iso),
      service_id: serviceId, service_name: serviceNameText, supplier_price: usd,
      price: retailPrice(usd), price_source: 'system', available_quantity: qty == null ? 1 : qty,
      is_available: qty == null ? true : qty > 0, currency: 'NGN', updated_at: new Date().toISOString()
    });
  }
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await supabase.from('number_services').upsert(rows.slice(i, i + 100), { onConflict: 'source,country_id,service_id', ignoreDuplicates: false });
    if (error) throw error;
  }
  return rows;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { success: false, message: 'Method not allowed' });
  if (!VS_KEY) return send(res, 500, { success: false, message: 'VirtualSMS is not configured.' });
  if (!(await requireUser(req))) return send(res, 401, { success: false, message: 'Please sign in first.' });

  const q = req.query || {};
  const mode = String(q.mode || 'services').toLowerCase();
  const term = String(q.q || q.search || '').trim().toLowerCase();
  const service = String(q.service || '').trim();
  const country = String(q.country || '').trim().toUpperCase();

  try {
    if (mode === 'services') {
      const r = await vsReq('/customer/services');
      if (!r.ok) return send(res, 502, { success: false, message: 'VirtualSMS service catalog is unavailable right now.' });
      const services = listOf(r.json, ['services', 'data', 'items', 'results']).map(s => { const code = serviceCode(s); return code ? { code, name: serviceName(s, code) } : null; }).filter(Boolean);
      const filtered = term ? services.filter(s => `${s.code} ${s.name}`.toLowerCase().includes(term)) : services;
      return send(res, 200, { success: true, source: 'live', services: filtered.slice(0, 100), total: filtered.length });
    }

    if (mode === 'countries') {
      const r = await vsReq(service ? `/customer/countries?service=${encodeURIComponent(service)}` : '/customer/countries');
      if (!r.ok) return send(res, 502, { success: false, message: 'VirtualSMS country catalog is unavailable right now.' });
      const countries = listOf(r.json, ['countries', 'data', 'items', 'results']).map(c => { const iso = countryIso(c); return iso ? { iso, name: countryName(c, iso), price_usd: priceUsd(c), stock: stock(c) } : null; }).filter(Boolean);
      const filtered = term ? countries.filter(c => `${c.iso} ${c.name}`.toLowerCase().includes(term)) : country ? countries.filter(c => c.iso === country) : countries;
      return send(res, 200, { success: true, source: 'live', service: service || null, countries: filtered.slice(0, 200), total: filtered.length });
    }

    if (mode === 'pair') {
      if (!service || !country) return send(res, 400, { success: false, message: 'service and country are required.' });
      const r = await vsReq(`/customer/countries?service=${encodeURIComponent(service)}`);
      if (!r.ok) return send(res, 502, { success: false, message: 'Could not check live availability.' });
      const countries = listOf(r.json, ['countries', 'data', 'items', 'results']);
      const match = countries.find(c => countryIso(c) === country);
      if (!match) return send(res, 404, { success: false, available: false, message: 'That service is not currently available in this country.' });
      const usd = priceUsd(match), qty = stock(match);
      if (!(usd > 0) || (qty != null && qty <= 0)) return send(res, 404, { success: false, available: false, message: 'No stock is currently available for that service/country pair.' });
      const rows = await upsertLivePairs(service, service, [match]);
      return send(res, 200, { success: true, source: 'live', available: true, row: rows[0] || null });
    }

    return send(res, 400, { success: false, message: 'Unknown mode. Use services, countries, or pair.' });
  } catch (err) {
    console.error('[vsms-live]', err);
    return send(res, 500, { success: false, message: 'Live VirtualSMS lookup failed.' });
  }
}
