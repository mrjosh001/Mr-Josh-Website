import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { getServiceSupabase, requireUser, applyApiCors, handleOptions } from '../lib/secure.js';
import { profitFloorNgn } from '../lib/pricing.js';

const supabase = getServiceSupabase();
const esimSupabase = process.env.ESIM_SUPABASE_URL && process.env.ESIM_SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.ESIM_SUPABASE_URL, process.env.ESIM_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;
const KEY_PREFIX = 'mj_live_';

function json(res, status, payload) {
  return res.status(status).json(payload);
}
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
function newApiKey() {
  return KEY_PREFIX + crypto.randomBytes(32).toString('hex');
}
function bearer(req) {
  const h = String(req.headers.authorization || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}
function toPublicService(row, category, source) {
  const price = Number(row.price ?? row.sell_price ?? row.price_ngn ?? row.amount_ngn ?? 0);
  if (!(price > 0)) return null;
  return {
    id: String(row.api_service_id || row.product_key || row.id),
    category,
    source,
    name: String(row.name || row.service_name || row.plan_name || 'Service'),
    country: row.country_name || row.country || null,
    price: { amount: Math.round(price * 100) / 100, currency: 'NGN' },
    available: row.is_available !== false && row.hidden !== true && row.admin_hidden !== true &&
      (row.stock_quantity == null || Number(row.stock_quantity) > 0) &&
      (row.available_quantity == null || Number(row.available_quantity) > 0),
    metadata: {}
  };
}
async function requireApiKey(req) {
  const raw = bearer(req);
  if (!raw.startsWith(KEY_PREFIX) || raw.length < 40) return { error: { status: 401, message: 'Invalid API key' } };
  const hash = sha256(raw);
  const { data: key, error } = await supabase.from('reseller_api_keys')
    .select('id,reseller_id,status,scopes,last_used_at')
    .eq('key_hash', hash).maybeSingle();
  if (error || !key || key.status !== 'active') return { error: { status: 401, message: 'Invalid or revoked API key' } };
  const { data: reseller, error: resellerError } = await supabase.from('reseller_accounts')
    .select('id,user_id,status,currency')
    .eq('id', key.reseller_id).maybeSingle();
  if (resellerError || !reseller || reseller.status !== 'active') return { error: { status: 403, message: 'Reseller account is not active' } };
  await supabase.from('reseller_api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', key.id);
  return { key, reseller };
}
async function createOrGetReseller(user) {
  const { data: existing, error } = await supabase.from('reseller_accounts')
    .select('id,user_id,status,currency')
    .eq('user_id', user.id).maybeSingle();
  if (error) throw new Error(error.message);
  if (existing) return existing;
  const { data, error: insertError } = await supabase.from('reseller_accounts')
    .insert({ user_id: user.id, status: 'pending', currency: 'NGN' })
    .select('id,user_id,status,currency').single();
  if (insertError) throw new Error(insertError.message);
  return data;
}
async function handleKeyManagement(req, res) {
  const auth = await requireUser(req);
  if (auth.error) return json(res, auth.error.status, { success: false, message: auth.error.message });
  const reseller = await createOrGetReseller(auth.user);
  if (req.method === 'GET') {
    const { data, error } = await supabase.from('reseller_api_keys')
      .select('id,label,key_hint,status,scopes,created_at,last_used_at')
      .eq('reseller_id', reseller.id).order('created_at', { ascending: false });
    if (error) return json(res, 500, { success: false, message: 'Could not load API keys' });
    return json(res, 200, { success: true, reseller, keys: data || [] });
  }
  if (req.method !== 'POST') return json(res, 405, { success: false, message: 'Method not allowed' });
  if (reseller.status !== 'active') return json(res, 403, { success: false, message: 'Reseller access is awaiting approval' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const key = newApiKey();
  const { data, error } = await supabase.from('reseller_api_keys').insert({
    reseller_id: reseller.id,
    key_hash: sha256(key),
    key_hint: key.slice(-6),
    label: String(body.label || 'Default API key').trim().slice(0, 60),
    status: 'active',
    scopes: ['catalog:read', 'wallet:read', 'orders:read', 'orders:write']
  }).select('id,label,key_hint,status,scopes,created_at').single();
  if (error) return json(res, 500, { success: false, message: 'Could not create API key' });
  return json(res, 201, { success: true, key, warning: 'Copy this key now. It cannot be displayed again.', data });
}
async function handleCatalog(req, res, reseller) {
  const page = Math.max(1, Math.min(10000, Number(req.query?.page) || 1));
  const perPage = Math.max(10, Math.min(100, Number(req.query?.per_page) || 50));
  const start = (page - 1) * perPage;
  const end = start + perPage - 1;
  const [numbers, products, boosters, esim] = await Promise.all([
    supabase.from('number_services').select('id,source,service_id,service_name,country_id,country_name,price,is_available,available_quantity').order('id').range(start, end),
    supabase.from('products').select('id,product_key,name,price,source,is_available,stock_quantity,admin_hidden,category').order('id').range(start, end),
    supabase.from('booster_services').select('*').order('id').range(start, end),
    (esimSupabase ? esimSupabase.from('esim_plans').select('*').order('id').range(start, end) : Promise.resolve({ data: [], error: null }))
  ]);
  const errors = [numbers, products, boosters, esim].filter(x => x.error);
  if (errors.length) return json(res, 503, { success: false, message: 'Service catalogue is temporarily unavailable' });
  const items = [];
  for (const row of numbers.data || []) {
    const src = String(row.source || '').toLowerCase();
    const category = src === 'gotsms' ? 'sms.usa_rental' :
      src === 'smsbus_rent' ? 'sms.global_rental' :
      src === 'grizzlysms' || src === 'herosms' ? 'sms.server1' :
      src === 'smsbus' ? 'sms.server2' :
      src === 'virtualsms' ? 'sms.server3' : null;
    if (!category) continue;
    const item = toPublicService({ ...row, api_service_id: category + ':' + src + ':' + (row.country_id || 'all') + ':' + row.service_id }, category, src);
    if (item && item.available) {
      item.metadata = { provider_service_id: String(row.service_id), country_id: row.country_id || null };
      items.push(item);
    }
  }
  for (const row of products.data || []) {
    const item = toPublicService({ ...row, api_service_id: 'logs:' + (row.source || 'manual') + ':' + (row.product_key || row.id) }, 'logs', String(row.source || 'manual'));
    if (item && item.available) items.push(item);
  }
  for (const row of boosters.data || []) {
    const src = String(row.source || '').toLowerCase();
    const supplierCategory = String(row.category || '');
    let category = 'boosting';
    if (src === 'smmkings') {
      if (/telegram\s+premium\s+to\s+any/i.test(supplierCategory)) category = 'telegram.premium';
      else if (/telegram\s+stars\s+to\s+any/i.test(supplierCategory)) category = 'telegram.stars';
      else continue;
    }
    const item = toPublicService({ ...row, api_service_id: category + ':' + src + ':' + row.service_id }, category, src);
    if (item && item.available) {
      item.metadata = { provider_service_id: String(row.service_id), service_type: row.service_type || null,
        min_quantity: Number(row.min_quantity) || null, max_quantity: Number(row.max_quantity) || null,
        refill: row.refill === true, cancel: row.cancel === true };
      items.push(item);
    }
  }
  for (const row of esim.data || []) {
    if (row.is_active === false) continue;
    const item = toPublicService({ ...row, api_service_id: 'esim:' + row.id, name: row.name || row.id, price: row.amount_ngn }, 'esim', 'mjhub_wireless');
    if (item) { item.metadata = { plan_id: String(row.id), days: Number(row.days) || null }; items.push(item); }
  }
  return json(res, 200, {
    success: true, currency: reseller.currency || 'NGN', count: items.length, page, per_page: perPage,
    next_page: {
      number_services: (numbers.data || []).length === perPage ? page + 1 : null,
      products: (products.data || []).length === perPage ? page + 1 : null,
      booster_services: (boosters.data || []).length === perPage ? page + 1 : null,
      esim_plans: (esim.data || []).length === perPage ? page + 1 : null
    },
    data: items
  });
}
async function handleMailOffers(req, res) {
  const site = String(req.query?.site || '').trim().toLowerCase();
  const domain = String(req.query?.domain || '').trim().toLowerCase();
  if (!site || !/^[a-z0-9.-]{3,253}$/.test(site)) {
    return json(res, 400, { success: false, message: 'A valid site/domain is required, e.g. telegram.com' });
  }
  const key = String(process.env.HEROSMS_API_KEY || '').trim();
  if (!key) return json(res, 503, { success: false, message: 'MJ Mails is temporarily unavailable' });
  try {
    const qs = new URLSearchParams({ site });
    if (domain) qs.set('domain', domain);
    const response = await fetch('https://hero-sms.com/api/v1/emails/offers?' + qs.toString(), {
      headers: { Authorization: 'ApiKey ' + key, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) return json(res, 502, { success: false, message: 'MJ Mails supplier could not return offers' });
    const payload = await response.json();
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const offers = rows.flatMap(row => (Array.isArray(row.offers) ? row.offers : [])
      .filter(offer => Number(offer.cost) > 0 && Number(offer.count) > 0)
      .map(offer => {
        const usd = Number(offer.cost);
        const round50 = value => Math.ceil(value / 50) * 50;
        const price = usd < 0.1 ? round50(400 + (usd / 0.1) * 100)
          : usd < 0.5 ? round50(600 + ((usd - 0.1) / 0.4) * 400)
          : usd <= 1 ? round50(1100 + ((usd - 0.5) / 0.5) * 400)
          : profitFloorNgn(usd, Number(process.env.USD_TO_NGN_RATE) || Number(process.env.USD_TO_NGN) || 1500);
        return { category: 'mj_mails', site, domain: String(row.domain || '').toLowerCase(),
          available: Math.floor(Number(offer.count)), supplier_cost_usd: undefined,
          price: { amount: price, currency: 'NGN' } };
      }));
    return json(res, 200, { success: true, category: 'mj_mails', site, count: offers.length, data: offers });
  } catch (_) {
    return json(res, 502, { success: false, message: 'MJ Mails offers are temporarily unavailable' });
  }
}

async function handleBalance(req, res, reseller) {
  const { data, error } = await supabase.from('reseller_wallets')
    .select('balance_minor,currency,updated_at').eq('reseller_id', reseller.id).maybeSingle();
  if (error) return json(res, 500, { success: false, message: 'Could not load reseller wallet' });
  return json(res, 200, {
    success: true,
    balance: { amount: Number(data?.balance_minor || 0) / 100, currency: data?.currency || reseller.currency || 'NGN' },
    updated_at: data?.updated_at || null
  });
}

export default async function handler(req, res) {
  applyApiCors(req, res, { methods: 'GET, POST, OPTIONS' });
  if (handleOptions(req, res)) return;
  try {
    const action = String(req.query?.action || 'catalog').toLowerCase();
    if (action === 'keys') return handleKeyManagement(req, res);
    if (req.method !== 'GET') return json(res, 405, { success: false, message: 'Method not allowed' });
    const auth = await requireApiKey(req);
    if (auth.error) return json(res, auth.error.status, { success: false, message: auth.error.message });
    if (action === 'catalog' || action === 'services') return handleCatalog(req, res, auth.reseller);
    if (action === 'mail_offers') return handleMailOffers(req, res);
    if (action === 'balance') return handleBalance(req, res, auth.reseller);
    return json(res, 404, { success: false, message: 'Unknown reseller API action' });
  } catch (error) {
    console.error('[reseller-api]', error?.message || error);
    return json(res, 500, { success: false, message: 'Reseller API temporarily unavailable' });
  }
}
