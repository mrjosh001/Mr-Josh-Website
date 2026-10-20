import { applyMarkup } from './pricing.js';

/**
 * lib/hero.js — second OTP pool for Server 1 (source = 'herosms').
 *
 * Everything Hero-specific lives here so api/grizzly-sync.js only needs a few small hooks:
 *   sync      GET  /api/grizzly-sync?action=hero_sync    (admin / cron)  → number_services rows, source='herosms' ONLY
 *   probe     GET  /api/grizzly-sync?action=hero_probe   (admin / cron)  → what Hero really returns (counts + short samples)
 *   order     POST /api/grizzly-sync?action=order        body.source === 'herosms'
 *   check     POST /api/grizzly-sync?action=check        routed when the saved order.source is 'herosms'
 *   cancel    POST /api/grizzly-sync?action=cancel       routed when the saved order.source is 'herosms'
 *   expireStale  called from handleExpireStale (cron / history page)
 *
 * Rules (from the plan):
 *   - Never touches Grizzly rows or orders. Never falls back to another supplier.
 *   - Customer JSON never contains the supplier name, host, key, raw supplier text or raw supplier codes.
 *   - Admin price overrides / hidden rows are never overwritten by sync.
 *   - Wallet: same dual-wallet (NGN + USD) atomic debit as Server 1/2/3. NOTE: scripts/patch-server1-dual-wallet.mjs
 *     rewrites api/grizzly-sync.js at build time but cannot reach this file, so the dual-wallet debit is done here directly.
 *
 * Env: HEROSMS_API_KEY (required). Optional: HEROSMS_BASE_URL, USD_TO_NGN_RATE, MIN_PROFIT_NGN,
 *      HEROSMS_SYNC_BUDGET_MS, HEROSMS_CANCEL_COOLDOWN_MS
 */

const SOURCE = 'herosms';
const JOB_KEY = 'herosms';
const LOCK_MS = 6 * 60 * 1000;
const SYNC_BUDGET_MS = Number(process.env.HEROSMS_SYNC_BUDGET_MS) || 200000;
const CANCEL_COOLDOWN_MS = Number(process.env.HEROSMS_CANCEL_COOLDOWN_MS) || 120000;
const FINAL = ['refunded', 'completed', 'expired', 'cancelled', 'canceled'];

const baseUrl = () => String(process.env.HEROSMS_BASE_URL || 'https://hero-sms.com/stubs/handler_api.php').trim();
const apiKey = () => String(process.env.HEROSMS_API_KEY || '').trim();
const rate = () => Number(process.env.USD_TO_NGN_RATE) || Number(process.env.USD_TO_NGN) || 1500;
const minProfit = () => Number(process.env.MIN_PROFIT_NGN) || 500;
const floorNgn = (usd) => Math.ceil(usd * rate() + minProfit());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(v) {
  if (v == null || typeof v === 'boolean') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Customer price from supplier USD — same markup function Servers 1/2/3 use. */
function sellFromUsd(usd) {
  const n = Number(applyMarkup(usd, rate()));
  if (Number.isFinite(n) && n > 0) return n;
  return Math.max(1000, Math.ceil(floorNgn(usd) / 50) * 50);
}

async function call(action, params = {}, timeoutMs = 20000) {
  const k = apiKey();
  if (!k) return { ok: false, status: 0, text: '', json: null, err: 'no key' };
  const qs = new URLSearchParams({ api_key: k, action, ...params });
  try {
    const res = await fetch(`${baseUrl()}?${qs.toString()}`, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    const text = String(await res.text()).trim();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* plain text reply */ }
    return { ok: res.ok, status: res.status, text, json };
  } catch (e) {
    return { ok: false, status: 0, text: '', json: null, err: e && e.message ? e.message : String(e) };
  }
}

/** Admin screen balance (USD). Same shape as getGrizzlyBalance() in api/admin.js. */
export async function heroBalance() {
  if (!apiKey()) return { ok: false, error: 'Missing HEROSMS_API_KEY' };
  const r = await call('getBalance');
  if (r.text.startsWith('ACCESS_BALANCE:')) {
    const balance = Number(r.text.split(':')[1]);
    if (Number.isFinite(balance)) return { ok: true, balance, currency: 'USD', source_url: 'getBalance' };
  }
  if (r.text === 'BAD_KEY') return { ok: false, error: 'HEROSMS_API_KEY was rejected' };
  return { ok: false, error: `Unexpected reply (${r.status || r.err || 'no reply'})` };
}

// ---------------------------------------------------------------- parsers
function parseCountries(j) {
  const out = new Map();
  const src = j && !Array.isArray(j) && Array.isArray(j.countries) ? j.countries : j;
  const list = Array.isArray(src)
    ? src
    : (src && typeof src === 'object'
      ? Object.entries(src).map(([k, v]) => (v && typeof v === 'object' ? { id: k, ...v } : { id: k, eng: String(v) }))
      : []);
  for (const c of list) {
    if (!c) continue;
    const id = parseInt(c.id ?? c.country ?? c.code, 10);
    if (!Number.isFinite(id)) continue;
    const name = [c.eng, c.name, c.title, c.rus].find((x) => typeof x === 'string' && x.trim());
    out.set(id, name ? name.trim() : `Country ${id}`);
  }
  return out;
}

function parseServices(j) {
  const out = new Map();
  const src = j && !Array.isArray(j) && typeof j === 'object' && j.services ? j.services : j;
  if (Array.isArray(src)) {
    for (const s of src) {
      if (!s || typeof s !== 'object') continue;
      const code = String(s.code || s.id || s.service || '').trim();
      const name = String(s.name || s.title || s.eng || '').trim();
      if (code) out.set(code, name || code);
    }
  } else if (src && typeof src === 'object') {
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === 'string') out.set(k, v.trim() || k);
      else if (v && typeof v === 'object') out.set(k, String(v.name || v.title || v.eng || '').trim() || k);
    }
  }
  return out;
}

/** getPrices shape: { "<country>": { "<service>": { cost, count } } } */
function collectPrices(j, entries) {
  if (!j || typeof j !== 'object') return 0;
  let seen = 0;
  for (const [cKey, svcs] of Object.entries(j)) {
    const cid = parseInt(cKey, 10);
    if (!Number.isFinite(cid) || !svcs || typeof svcs !== 'object') continue;
    for (const [code, info] of Object.entries(svcs)) {
      if (!info || typeof info !== 'object') continue;
      seen += 1;
      const usd = num(info.cost ?? info.price);
      const count = Math.floor(num(info.count ?? info.physicalCount ?? info.quantity));
      if (usd > 0 && count > 0) entries.push({ cid, code: String(code), usd, count });
    }
  }
  return seen;
}

// customer-facing copy only — no supplier words
const COPY = {
  NO_STOCK: 'No numbers available for this service/country right now. Try another country or service.',
  PRICE_CHANGED: 'The price for this number just changed. Please refresh and try again.',
  UNAVAILABLE: 'This service is temporarily unavailable. Please try again shortly.',
  RESTORED: 'Purchase failed. Your balance has been restored.'
};
function publicFailure(text) {
  const t = String(text || '').toUpperCase();
  if (t.startsWith('NO_NUMBERS')) return 'NO_STOCK';
  if (t.startsWith('WRONG_MAX_PRICE')) return 'PRICE_CHANGED';
  return 'UNAVAILABLE';
}

export function createHero(deps) {
  const { supabase, requireAdmin, claimAndRefundOrder, reclaimAndCompleteOnCode, EXPIRY_MS } = deps;
  const bodyOf = (req) => {
    try { return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (_) { return {}; }
  };

  const isCron = (req) => !!process.env.CRON_SECRET && (req.headers.authorization || '') === `Bearer ${process.env.CRON_SECRET}`;
  async function adminOrCron(req, res) {
    if (isCron(req)) return true;
    const a = await requireAdmin(req);
    if (a.ok) return true;
    res.status(a.status).json({ success: false, message: a.message });
    return false;
  }

  /** Put back exactly what was debited from each wallet (NGN and/or USD). Adds to the CURRENT balance, never overwrites it. */
  async function restoreWallet(userId, split, fallbackNgn) {
    let ngn = Number(split && split.ngn) || 0;
    const usd = Number(split && split.usd) || 0;
    if (!(ngn > 0) && !(usd > 0)) ngn = Number(fallbackNgn) || 0;
    const { data: p } = await supabase.from('profiles').select('balance, balance_usd').eq('id', userId).single();
    const nb = Number((p && p.balance) || 0) + ngn;
    const nu = Number((p && p.balance_usd) || 0) + usd;
    await supabase.from('profiles').update({ balance: nb, balance_usd: nu }).eq('id', userId);
    return { balance: nb, balance_usd: nu };
  }

  // ------------------------------------------------------------ sync
  async function getJob() {
    try {
      const { data } = await supabase.from('sync_jobs').select('status, updated_at, cursor_index').eq('source', JOB_KEY).maybeSingle();
      return data || null;
    } catch (_) { return null; }
  }
  async function setJob(fields) {
    try { await supabase.from('sync_jobs').upsert({ source: JOB_KEY, updated_at: new Date().toISOString(), ...fields }); } catch (_) { /* best effort */ }
  }
  async function loadExisting() {
    const map = new Map();
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('number_services')
        .select('id, country_id, service_id, price, price_source, supplier_price, available_quantity, service_name, country_name, is_available')
        .eq('source', SOURCE)
        .order('id', { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error('load existing: ' + error.message);
      for (const r of data || []) map.set(`${r.country_id}|${r.service_id}`, r);
      if (!data || data.length < 1000) break;
      from += 1000;
    }
    return map;
  }

  async function runSync(force) {
    const started = Date.now();
    const deadline = started + SYNC_BUDGET_MS - 6000;
    const errors = [];
    const note = (m) => { if (errors.length < 20) errors.push(m); };

    const [svcRes, ctyRes] = await Promise.all([call('getServicesList'), call('getCountries')]);
    if (ctyRes.text === 'BAD_KEY' || svcRes.text === 'BAD_KEY') {
      return { status: 401, body: { success: false, message: 'HEROSMS_API_KEY was rejected.' } };
    }
    const names = parseServices(svcRes.json);
    const countries = parseCountries(ctyRes.json);
    if (!names.size) note('service names list came back empty — services will show their codes');
    if (!countries.size) note('country list came back empty — countries will show as "Country N"');

    // 1) everything in one call; if that fails, walk country by country with a saved cursor
    const entries = [];
    let processedAll = false;
    const processedCountries = new Set();
    let partial = false;
    let nextCursor = 0;
    let mode = 'all';

    const all = await call('getPrices', {}, 60000);
    const seenAll = all.json && typeof all.json === 'object' ? collectPrices(all.json, entries) : 0;
    if (seenAll > 0) {
      processedAll = true;
    } else {
      mode = 'per_country';
      const ids = [...countries.keys()];
      if (!ids.length) {
        return { status: 502, body: { success: false, message: 'Supplier answered but no countries or prices could be read. Open /api/grizzly-sync?action=hero_probe.' } };
      }
      const job = await getJob();
      let i = !force && job && Number.isInteger(job.cursor_index) && job.cursor_index > 0 && job.cursor_index < ids.length ? job.cursor_index : 0;
      while (i < ids.length) {
        if (Date.now() > deadline) { partial = true; break; }
        const cid = ids[i];
        const r = await call('getPrices', { country: String(cid) }, 20000);
        if (r.status === 429) { partial = true; break; }
        if (r.json && typeof r.json === 'object') { collectPrices(r.json, entries); processedCountries.add(cid); }
        else note(`country ${cid}: prices not readable`);
        i += 1;
        await sleep(300);
      }
      nextCursor = partial ? i : 0;
    }

    const existing = await loadExisting();
    const nowIso = new Date().toISOString();
    const inserts = [];
    const updates = [];
    const seenKeys = new Set();
    let repriced = 0;

    for (const e of entries) {
      const key = `${e.cid}|${e.code}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const countryName = countries.get(e.cid) || `Country ${e.cid}`;
      const serviceName = names.get(e.code) || e.code;
      const prev = existing.get(key);
      if (!prev) {
        inserts.push({
          source: SOURCE, country_id: e.cid, country_name: countryName, service_id: e.code, service_name: serviceName,
          supplier_price: e.usd, price: sellFromUsd(e.usd), price_source: 'system', currency: 'NGN',
          available_quantity: e.count, is_available: true, updated_at: nowIso
        });
        continue;
      }
      const protectedPrice = prev.price_source === 'manual' || prev.price_source === 'admin';
      const adminHidden = prev.is_available === false && Number(prev.available_quantity || 0) > 0;
      const prevPrice = Number(prev.price) || 0;
      const prevCost = Number(prev.supplier_price || 0);
      const rel = prevCost > 0 ? (e.usd - prevCost) / prevCost : 1;
      const costMoved = Math.abs(prevCost - e.usd) > 0.0001;
      const needsPrice = !protectedPrice && (rel > 0.0001 || rel <= -0.05 || prevPrice < floorNgn(e.usd) || !(prevPrice > 0));
      const nextAvail = !adminHidden;
      const changed = needsPrice || costMoved || Number(prev.available_quantity || 0) !== e.count ||
        String(prev.country_name || '') !== countryName || String(prev.service_name || '') !== serviceName ||
        (prev.is_available === false && nextAvail);
      if (!changed) continue;
      const f = { country_name: countryName, service_name: serviceName, supplier_price: e.usd, available_quantity: e.count, is_available: nextAvail, updated_at: nowIso };
      if (needsPrice) { f.price = sellFromUsd(e.usd); f.price_source = 'system'; repriced += 1; }
      updates.push({ id: prev.id, ...f });
    }

    // sold out / gone: only for countries this run actually covered
    let goneIds = [];
    let liveCovered = 0;
    for (const [key, prev] of existing) {
      const covered = processedAll || processedCountries.has(Number(prev.country_id));
      if (!covered) continue;
      if (prev.is_available !== false) liveCovered += 1;
      if (seenKeys.has(key) || prev.is_available === false) continue;
      goneIds.push(prev.id);
    }
    if (goneIds.length >= 100 && goneIds.length > liveCovered * 0.7) {
      note(`delist skipped: ${goneIds.length} of ${liveCovered} live rows would be removed in one run`);
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
      const { error } = await supabase.from('number_services').update({ available_quantity: 0, is_available: false, updated_at: nowIso }).in('id', slice);
      if (error) note('sold-out: ' + error.message); else stats.delisted += slice.length;
    }

    if (inserts.length + updates.length > 0 && stats.inserted + stats.updated === 0) {
      return { status: 500, body: { success: false, message: 'Data was read but nothing could be saved. ' + (errors[0] || ''), errors } };
    }

    return {
      status: 200,
      cursor: mode === 'per_country' ? nextCursor : 0,
      body: {
        success: true, source: SOURCE, mode, partial, done: !partial,
        rows_seen: seenKeys.size, inserted: stats.inserted, updated: stats.updated, delisted: stats.delisted, repriced,
        countries: countries.size, services: names.size, errors, ms: Date.now() - started,
        message: `Hero sync: ${stats.inserted} added, ${stats.updated} changed, ${stats.delisted} sold out (unchanged rows untouched).${partial ? ' Not finished — run again.' : ''}`
      }
    };
  }

  async function sync(req, res) {
    if (!(await adminOrCron(req, res))) return;
    if (!apiKey()) return res.status(500).json({ success: false, message: 'HEROSMS_API_KEY is not set on the server (Vercel → Environment Variables).' });
    const q = req.query || {};
    const force = q.force === '1' || q.force === 'true';
    const job = await getJob();
    const locked = !!job && job.status === 'running' && !!job.updated_at && Date.now() - new Date(job.updated_at).getTime() < LOCK_MS;
    if (!force && locked) return res.status(200).json({ success: true, busy: true, partial: true, done: false, message: 'A Hero sync is already running. Wait a minute and check again.' });
    await setJob({ status: 'running', started_at: new Date().toISOString(), errors: [] });
    let out = null;
    try {
      out = await runSync(force);
    } catch (err) {
      console.error('hero sync error:', err);
      out = { status: 500, body: { success: false, message: 'Hero sync failed: ' + (err && err.message ? err.message : String(err)) } };
    } finally {
      await setJob({ status: 'idle', ...(out && out.cursor != null ? { cursor_index: out.cursor } : {}) });
    }
    return res.status(out.status).json(out.body);
  }

  // ------------------------------------------------------------ probe (admin only — shows real supplier replies)
  async function probe(req, res) {
    if (!(await adminOrCron(req, res))) return;
    if (!apiKey()) return res.status(500).json({ success: false, message: 'HEROSMS_API_KEY is not set on the server.' });
    const cut = (r) => ({ status: r.status, err: r.err || undefined, sample: (r.text || '').slice(0, 400) });
    const [bal, cty, svc, wa] = await Promise.all([
      call('getBalance'), call('getCountries'), call('getServicesList'), call('getPrices', { service: 'wa' })
    ]);
    const countries = parseCountries(cty.json);
    const services = parseServices(svc.json);
    const waEntries = [];
    collectPrices(wa.json, waEntries);
    const balNum = bal.text.startsWith('ACCESS_BALANCE:') ? Number(bal.text.split(':')[1]) : null;
    return res.status(200).json({
      success: true,
      balance: Number.isFinite(balNum) ? { ok: true, balance: balNum, currency: 'USD' } : { ok: false, error: bal.text === 'BAD_KEY' ? 'Key rejected' : 'Unexpected reply' },
      counts: { countries: countries.size, services: services.size, whatsapp_country_rows: waEntries.length },
      samples: { balance: cut(bal), countries: cut(cty), services: cut(svc), whatsapp_prices: cut(wa) }
    });
  }

  // ------------------------------------------------------------ order
  async function order(req, res, b) {
    const { country_id, service_id, external_order_id, user_id, quoted_price_ngn } = b;
    const countryId = parseInt(country_id, 10);
    const serviceId = service_id != null ? String(service_id) : null;
    if (!Number.isFinite(countryId) || !serviceId || !user_id) {
      return res.status(400).json({ success: false, message: 'country_id, service_id and user_id are required' });
    }
    if (!apiKey()) return res.status(500).json({ success: false, message: 'This SMS server is not available right now. Please contact support.' });

    let originalBalance = 0;
    let originalBalanceUsd = 0;
    let price = 0;
    let deducted = false;
    let split = { ngn: 0, usd: 0 };
    let customerId = null;
    let serviceName = '';
    let countryName = '';
    try {
      const { data: svc } = await supabase
        .from('number_services')
        .select('service_name, country_name, price, supplier_price, price_source, is_available')
        .eq('source', SOURCE).eq('country_id', countryId).eq('service_id', serviceId).maybeSingle();
      if (!svc) return res.status(404).json({ success: false, message: 'This service is no longer available. Refresh, try another, or contact support.' });
      if (!svc.is_available) return res.status(409).json({ success: false, message: 'This number service is currently out of stock.' });

      serviceName = svc.service_name;
      countryName = svc.country_name;
      price = Number(svc.price) || 0;
      const unitCostUsd = Number(svc.supplier_price) || 0;

      const wantFlash = (
        b.verification === true || b.verification === 1 || b.verification === '1' || b.verification === 'true' ||
        b.flash === true || b.flash === 1 ||
        b.voice === true || b.voice === 1 || b.voice === '1' || b.voice === 'true' ||
        String(b.verification_type || '').toLowerCase() === 'flash' ||
        String(b.verification_type || '').toLowerCase() === 'flashcall' ||
        String(b.verification_type || '').toLowerCase() === 'call'
      );

      // money guard: never sell for nothing or below what the supplier charges us
      if (!(price > 0) || (unitCostUsd > 0 && price < unitCostUsd * rate())) {
        if (svc.price_source !== 'manual' && svc.price_source !== 'admin' && unitCostUsd > 0) {
          try {
            await supabase.from('number_services')
              .update({ price: sellFromUsd(unitCostUsd), price_source: 'system', updated_at: new Date().toISOString() })
              .eq('source', SOURCE).eq('country_id', countryId).eq('service_id', serviceId);
          } catch (_) { /* best effort */ }
        }
        return res.status(409).json({ success: false, code: 'PRICE_CHANGED', message: COPY.PRICE_CHANGED });
      }

      // FlashCall + SMS is often more expensive than SMS-only. Re-price before debit so we never lose money.
      let minPrice = price;
      let chargeUsd = unitCostUsd;
      if (wantFlash) {
        try {
          const pr = await call('getPrices', { service: serviceId, country: String(countryId) }, 12000);
          const j = pr.json;
          let cell = null;
          if (j && typeof j === 'object') {
            const cBlock = j[String(countryId)] || j[countryId] || j;
            if (cBlock && typeof cBlock === 'object') cell = cBlock[serviceId] || cBlock[String(serviceId)] || null;
          }
          if (cell && typeof cell === 'object') {
            const callUsd = num(cell.cost_call ?? cell.callCost ?? cell.voice_cost ?? cell.verification_cost);
            const baseUsd = num(cell.cost ?? cell.price ?? cell.rate);
            if (callUsd > 0) chargeUsd = callUsd;
            else if (baseUsd > 0) chargeUsd = Math.max(baseUsd * 1.35, baseUsd + 0.15);
          } else if (unitCostUsd > 0) {
            chargeUsd = unitCostUsd * 1.35;
          }
        } catch (_) {
          if (unitCostUsd > 0) chargeUsd = unitCostUsd * 1.35;
        }
        const flashSell = sellFromUsd(chargeUsd);
        if (flashSell > minPrice) minPrice = flashSell;
      }

      // Customer must pay at least minPrice (SMS catalog or Flash uplift)
      if (quoted_price_ngn != null && quoted_price_ngn !== '') {
        const q = Number(quoted_price_ngn);
        if (!(q >= minPrice - 0.5)) {
          return res.status(409).json({
            success: false,
            code: 'PRICE_CHANGED',
            message: COPY.PRICE_CHANGED,
            data: { price_ngn: minPrice, verification: wantFlash ? 'flash' : 'sms' }
          });
        }
        price = q; // honour the amount shown on the buy sheet when it covers cost
      } else {
        price = minPrice;
      }

      const { data: profile } = await supabase.from('profiles').select('balance, balance_usd, customer_id').eq('id', user_id).single();
      if (!profile) return res.status(400).json({ success: false, message: 'User profile not found' });
      originalBalance = Number(profile.balance || 0);
      originalBalanceUsd = Number(profile.balance_usd || 0);
      customerId = profile.customer_id;

      const idem = (external_order_id && String(external_order_id).trim()) || `MJ-HR-${String(user_id).slice(0, 8)}-${Date.now()}`;
      if (external_order_id) {
        const { data: ex } = await supabase.from('number_orders')
          .select('order_id, phone_number, status, price, service_name, country_name, created_at')
          .eq('source', SOURCE).eq('user_id', user_id).eq('idempotency_key', idem).maybeSingle();
        if (ex && ex.order_id) {
          return res.status(200).json({ success: true, replayed: true, message: 'Order already completed', data: {
            order_id: ex.order_id, number: ex.phone_number, status: ex.status || 'waiting_for_code',
            service_name: ex.service_name || serviceName, country_name: ex.country_name || countryName,
            price: ex.price != null ? Number(ex.price) : price, new_balance: originalBalance, new_balance_usd: originalBalanceUsd,
            created_at: ex.created_at
          } });
        }
      }

      // Shared atomic dual-wallet debit (NGN, USD, or both). Never reject on NGN alone — the RPC decides.
      const { data: debited, error: debErr } = await supabase.rpc('debit_balance_if_sufficient', { p_user_id: user_id, p_amount: price });
      if (debErr) {
        console.error('[hero order] debit_balance_if_sufficient', debErr.message);
        return res.status(500).json({ success: false, message: 'Could not debit your wallet safely. Please try again or contact support.' });
      }
      const debitRow = Array.isArray(debited) ? debited[0] : debited;
      const debitOk = !!debitRow && typeof debitRow === 'object' && (debitRow.success === true || debitRow.success === 'true' || debitRow.success === 1);
      if (!debitOk) {
        return res.status(402).json({
          success: false, message: 'Insufficient balance', required: price,
          available: Number((debitRow && debitRow.new_balance) ?? originalBalance),
          available_usd: Number((debitRow && debitRow.new_balance_usd) ?? originalBalanceUsd)
        });
      }
      split = { ngn: Number(debitRow.ngn_debited || 0), usd: Number(debitRow.usd_debited || 0) };
      const newBalance = Number(debitRow.new_balance ?? (originalBalance - split.ngn));
      const newBalanceUsd = Number(debitRow.new_balance_usd ?? (originalBalanceUsd - split.usd));
      deducted = true;

      const params = { service: serviceId, country: String(countryId) };
      const maxUsd = (wantFlash && chargeUsd > 0) ? chargeUsd : unitCostUsd;
      if (maxUsd > 0) params.maxPrice = String(maxUsd); // cap supplier cost to what we priced
      const operator = String(b.operator || '').toLowerCase().replace(/[^a-z0-9,_-]/g, '').replace(/,+/g, ',').replace(/^,|,$/g, '').slice(0, 120);
      if (operator) params.operator = operator;
      const exc = (Array.isArray(b.phone_exception) ? b.phone_exception.join(',') : String(b.phone_exception || ''))
        .replace(/[^0-9,]/g, '').split(',').filter(Boolean).slice(0, 20).join(',');
      if (exc) params.phoneException = exc;
      // Verification mode already computed above (wantFlash)
      if (wantFlash) {
        params.verification = '1';
        params.voice = '1';
      }

      const r = await call('getNumberV2', params, 30000);
      let activationId = null;
      let phone = null;
      let paidUsd = 0;
      let failText = null;
      if (r.json && typeof r.json === 'object' && (r.json.activationId || r.json.id)) {
        activationId = String(r.json.activationId || r.json.id);
        phone = r.json.phoneNumber || r.json.phone || null;
        paidUsd = num(r.json.activationCost ?? r.json.cost);
      } else if (r.text.startsWith('ACCESS_NUMBER:')) {
        const parts = r.text.split(':');
        activationId = parts[1] || null;
        phone = parts[2] || null;
      } else {
        failText = r.text || r.err || 'EMPTY';
      }

      if (!activationId) {
        await restoreWallet(user_id, split, price);
        deducted = false;
        const pub = publicFailure(failText);
        try {
          await supabase.from('transactions').insert({
            user_id, customer_id: customerId, type: 'purchase', category: 'MJ SMS', title: serviceName,
            subtitle: `Failed: ${pub === 'NO_STOCK' ? 'No stock' : 'Unavailable'}`, amount: `₦${price.toLocaleString()}`,
            amount_ngn: price, status: 'failed', notes: String(failText || '').slice(0, 300)
          });
        } catch (_) { /* optional */ }
        return res.status(400).json({
          success: false, code: pub,
          message: pub === 'NO_STOCK' ? COPY.NO_STOCK : (pub === 'PRICE_CHANGED' ? COPY.PRICE_CHANGED : COPY.RESTORED)
        });
      }

      const costUsd = paidUsd > 0 ? paidUsd : (unitCostUsd || null);
      // If supplier billed more USD than we collected in NGN, cancel and refund — never keep a loss-making activation
      const rateNow = rate();
      if (costUsd > 0 && Number(price) > 0 && costUsd * rateNow > Number(price) + 1) {
        try {
          await call('setStatus', { id: activationId, status: '8' }, 15000); // cancel
        } catch (_) {}
        await restoreWallet(user_id, split, price);
        deducted = false;
        return res.status(409).json({
          success: false,
          code: 'PRICE_CHANGED',
          message: 'Supplier cost moved. Your balance was restored. Please try again.'
        });
      }
      const row = {
        source: SOURCE, user_id, customer_id: customerId, order_id: activationId, idempotency_key: idem,
        country_id: countryId, country_name: countryName, service_id: serviceId, service_name: serviceName,
        phone_number: phone, price, supplier_price: costUsd, currency: 'NGN',
        status: 'waiting_for_code', code: null, time_left: null, refunded: false
      };
      let { error: insErr } = await supabase.from('number_orders').insert(row);
      if (insErr) { await sleep(400); ({ error: insErr } = await supabase.from('number_orders').insert(row)); }
      if (insErr) console.error('[hero order] number_orders insert failed after charge:', insErr.message, { activationId, user_id });

      // supplier charged more than the catalog says → fix the catalog so the next customer is not sold at a loss
      if (paidUsd > unitCostUsd + 0.0001) {
        try {
          const fix = { supplier_price: paidUsd, updated_at: new Date().toISOString() };
          if (svc.price_source !== 'manual' && svc.price_source !== 'admin') { fix.price = sellFromUsd(paidUsd); fix.price_source = 'system'; }
          await supabase.from('number_services').update(fix).eq('source', SOURCE).eq('country_id', countryId).eq('service_id', serviceId);
        } catch (_) { /* best effort */ }
      }

      // ONE purchase row: pending now, completed when the code arrives, cancelled/expired if refunded
      try {
        await supabase.from('transactions').insert({
          user_id, customer_id: customerId, type: 'purchase', category: 'MJ SMS',
          title: countryName ? `${serviceName} · ${countryName}` : serviceName,
          subtitle: `${countryName || ''} · waiting for SMS`.trim(),
          amount: `₦${price.toLocaleString()}`, amount_ngn: price, status: 'pending',
          notes: 'sms_order:' + activationId, supplier_order: r.json || { raw: r.text }
        });
      } catch (_) { /* optional */ }

      return res.status(200).json({ success: true, message: 'Number purchased successfully', data: {
        order_id: activationId, number: phone, status: 'waiting_for_code', service_name: serviceName,
        country_name: countryName, price, new_balance: newBalance, new_balance_usd: newBalanceUsd,
        ngn_debited: split.ngn, usd_debited: split.usd, created_at: new Date().toISOString()
      } });
    } catch (err) {
      console.error('hero order error:', err);
      if (deducted) { try { await restoreWallet(user_id, split, price); } catch (e) { console.error('CRITICAL hero auto-restore failed', e); } }
      return res.status(500).json({ success: false, message: deducted ? 'Something went wrong. Your balance has been restored.' : 'Something went wrong. Please try again.' });
    }
  }

  // ------------------------------------------------------------ status / check / cancel
  async function findOrder(orderId, userId) {
    let q = supabase.from('number_orders')
      .select('id, user_id, order_id, status, phone_number, created_at, service_name, country_name, price, refunded, customer_id, code, source')
      .eq('source', SOURCE).eq('order_id', String(orderId));
    if (userId) q = q.eq('user_id', userId);
    const { data } = await q.maybeSingle();
    return data;
  }
  const view = (o, extra) => ({
    order_id: o.order_id, status: o.status, number: o.phone_number, code: o.code || null, created_at: o.created_at,
    service_name: o.service_name, country_name: o.country_name, price: o.price, refunded: !!o.refunded, ...(extra || {})
  });

  function parseStatus(r) {
    const j = r.json;
    if (j && typeof j === 'object') {
      const code = (j.sms && j.sms.code) || (j.call && j.call.code) || j.code || '';
      if (String(code).trim()) return { kind: 'code', code: String(code).trim() };
      return { kind: 'wait' };
    }
    const t = r.text || '';
    if (t.startsWith('STATUS_OK')) {
      const c = (t.split(':')[1] || '').trim();
      return c ? { kind: 'code', code: c } : { kind: 'wait' };
    }
    if (t === 'STATUS_WAIT_CODE' || t === 'STATUS_WAIT_RESEND' || t.startsWith('STATUS_WAIT_RETRY')) return { kind: 'wait' };
    if (t === 'STATUS_CANCEL' || t === 'NO_ACTIVATION') return { kind: 'dead' };
    return { kind: 'unknown', text: t };
  }

  async function fetchStatus(id) {
    const r = await call('getStatusV2', { id: String(id) });
    let p = parseStatus(r);
    if (p.kind === 'unknown' && (r.text === 'BAD_ACTION' || r.text === '')) {
      const r2 = await call('getStatus', { id: String(id) });
      p = parseStatus(r2);
    }
    return p;
  }

  /** Ask the supplier, then say what should happen: code / dead / expired / wait / error. */
  async function resolve(order, allowExpire) {
    const age = order.created_at ? Date.now() - new Date(order.created_at).getTime() : 0;
    const p = await fetchStatus(order.order_id);
    if (p.kind === 'code') return { kind: 'code', code: p.code };
    if (p.kind === 'dead') return { kind: 'dead' };
    if (allowExpire && age >= EXPIRY_MS) {
      try { await call('setStatus', { id: String(order.order_id), status: '8' }); } catch (_) { /* best effort */ }
      return { kind: 'expired' };
    }
    if (p.kind === 'unknown') return { kind: 'error' };
    return { kind: 'wait' };
  }

  /** Save a received code exactly once; if a refund won the race, re-charge and complete. */
  async function applyCode(order, userId, code) {
    const wasRefunded = order.refunded === true || ['refunded', 'expired', 'cancelled', 'canceled'].includes(String(order.status || '').toLowerCase());
    if (!wasRefunded) {
      const { data: done } = await supabase.from('number_orders')
        .update({ status: 'completed', code: String(code), updated_at: new Date().toISOString() })
        .eq('id', order.id).eq('refunded', false).select('id').maybeSingle();
      if (done) {
        try {
          await supabase.from('transactions')
            .update({ status: 'completed', subtitle: `${order.country_name || ''} · code received`.trim() })
            .eq('user_id', userId).eq('category', 'MJ SMS').eq('type', 'purchase').eq('status', 'pending')
            .ilike('notes', '%sms_order:' + order.order_id + '%');
        } catch (_) { /* cosmetic */ }
        try { await call('setStatus', { id: String(order.order_id), status: '6' }); } catch (_) { /* best effort */ }
        return { ok: true, status: 'completed', code: String(code) };
      }
    }
    const re = await reclaimAndCompleteOnCode({ ...order, refunded: true }, userId, code);
    if (re.ok) {
      try { await call('setStatus', { id: String(order.order_id), status: '6' }); } catch (_) { /* best effort */ }
      return { ok: true, status: 'completed', code: re.code || String(code), recharged: !!re.recharged, amount: re.amount, new_balance: re.new_balance };
    }
    return { ok: false };
  }

  async function check(req, res) {
    const { order_id, user_id } = bodyOf(req);
    if (!order_id || !user_id) return res.status(400).json({ success: false, message: 'order_id and user_id are required' });
    try {
      const order = await findOrder(order_id, user_id);
      if (!order) return res.status(404).json({ success: false, message: 'Order not found for this account' });
      if (order.status === 'completed' && order.code) return res.status(200).json({ success: true, data: view(order) });
      const wasRefunded = order.refunded === true || ['refunded', 'expired', 'cancelled', 'canceled'].includes(String(order.status || '').toLowerCase());

      const out = await resolve(order, !wasRefunded);
      if (out.kind === 'code') {
        const done = await applyCode(order, user_id, out.code);
        if (done.ok) {
          return res.status(200).json({ success: true, data: view(order, {
            status: 'completed', code: done.code, refunded: false,
            ...(done.recharged ? { recharged: true, recharged_amount: done.amount, new_balance: done.new_balance, message: 'Code received — balance charged for this number' } : {})
          }) });
        }
        const { data: cur } = await supabase.from('number_orders').select('*').eq('id', order.id).single();
        return res.status(200).json({ success: true, data: view(cur || order) });
      }
      if (wasRefunded) {
        const { data: cur } = await supabase.from('number_orders').select('*').eq('id', order.id).single();
        return res.status(200).json({ success: true, data: view(cur || order) });
      }
      if (out.kind === 'dead' || out.kind === 'expired') {
        const st = out.kind === 'expired' ? 'expired' : 'refunded';
        const rf = await claimAndRefundOrder(order, user_id, {
          status: st, category: 'MJ SMS',
          subtitle: st === 'expired' ? 'Expired — no SMS, balance restored' : 'No SMS — balance restored'
        });
        return res.status(200).json({ success: true, data: view(order, { status: st, code: null, refunded: true, refunded_amount: rf.refunded_amount, new_balance: rf.new_balance }) });
      }
      if (out.kind === 'error') return res.status(502).json({ success: false, message: 'Could not check this order right now. Try again in a moment.' });
      return res.status(200).json({ success: true, data: view(order, { status: 'waiting_for_code', code: null }) });
    } catch (err) {
      console.error('hero check error:', err);
      return res.status(500).json({ success: false, message: 'Something went wrong checking this order.' });
    }
  }

  async function cancel(req, res) {
    const { order_id, user_id } = bodyOf(req);
    if (!order_id || !user_id) return res.status(400).json({ success: false, message: 'order_id and user_id are required' });
    try {
      const order = await findOrder(order_id, user_id);
      if (!order) return res.status(404).json({ success: false, message: 'Order not found for this account' });
      if (order.status === 'completed') {
        return res.status(409).json({ success: false, code: 'NUMBER_CODE_ALREADY_RECEIVED', message: 'A code was already received — this order cannot be cancelled.' });
      }
      if (order.refunded || FINAL.includes(String(order.status || '').toLowerCase())) {
        return res.status(409).json({ success: false, message: 'This order was already refunded.' });
      }
      const age = order.created_at ? Date.now() - new Date(order.created_at).getTime() : CANCEL_COOLDOWN_MS;
      if (age < CANCEL_COOLDOWN_MS) {
        const wait = Math.ceil((CANCEL_COOLDOWN_MS - age) / 1000);
        return res.status(400).json({ success: false, code: 'EARLY_CANCEL_DENIED', wait_seconds: wait, message: `Cancel available in ${wait}s. Please wait a moment.` });
      }
      // never cancel a number that already received its code
      const peek = await fetchStatus(order.order_id);
      if (peek.kind === 'code') {
        await applyCode(order, user_id, peek.code);
        return res.status(409).json({ success: false, code: 'NUMBER_CODE_ALREADY_RECEIVED', message: 'A code was already received — this order cannot be cancelled.' });
      }
      const r = await call('setStatus', { id: String(order.order_id), status: '8' });
      const t = r.text || '';
      if (t === 'EARLY_CANCEL_DENIED') {
        return res.status(400).json({ success: false, code: 'EARLY_CANCEL_DENIED', wait_seconds: 60, message: 'Cancel is not available yet. Wait a moment and try again.' });
      }
      if (t !== 'ACCESS_CANCEL' && peek.kind !== 'dead') {
        return res.status(400).json({ success: false, code: 'CANCEL_FAILED', message: 'Could not cancel this order right now. Try again shortly.' });
      }
      const rf = await claimAndRefundOrder(order, user_id, {
        status: 'refunded', category: 'MJ SMS', subtitle: 'Cancelled — balance restored',
        notes: 'SMS number cancelled; wallet credited without separate refund row'
      });
      if (!rf.refunded && rf.reason === 'already_final') return res.status(409).json({ success: false, message: 'This order was already refunded.' });
      return res.status(200).json({ success: true, data: {
        order_id, status: 'refunded', refunded: true, refunded_amount: rf.refunded_amount || Number(order.price || 0), new_balance: rf.new_balance
      } });
    } catch (err) {
      console.error('hero cancel error:', err);
      return res.status(500).json({ success: false, message: 'Something went wrong cancelling this order.' });
    }
  }

  /** Called from handleExpireStale with rows already older than the 20-min window. Hero orders only. */
  async function expireStale(rows) {
    let expired = 0;
    let completed = 0;
    let skipped = 0;
    const list = (rows || []).filter((o) => String(o.source || '').toLowerCase() === SOURCE && o.refunded !== true);
    for (const o of list) {
      try {
        const out = await resolve(o, true);
        if (out.kind === 'code') {
          const done = await applyCode(o, o.user_id, out.code);
          if (done.ok) completed += 1; else skipped += 1;
        } else if (out.kind === 'dead' || out.kind === 'expired') {
          const rf = await claimAndRefundOrder(o, o.user_id, { status: 'expired', category: 'MJ SMS', subtitle: 'Expired — no SMS, balance restored' });
          if (rf.refunded) expired += 1; else skipped += 1;
        } else skipped += 1;
      } catch (e) { skipped += 1; }
    }
    return { scanned: list.length, expired, completed, skipped };
  }

  /** True only when EVERY order with this id for this user is a Hero order (a clash with another supplier falls back to the old path). */
  async function orderIsHero(req) {
    try {
      const b = bodyOf(req);
      if (!b.order_id || !b.user_id) return false;
      const { data } = await supabase.from('number_orders').select('source')
        .eq('order_id', String(b.order_id)).eq('user_id', b.user_id).limit(5);
      return Array.isArray(data) && data.length > 0 && data.every((r) => String(r.source || '').toLowerCase() === SOURCE);
    } catch (_) { return false; }
  }


  /** Live operators for a country — GET ?action=hero_operators&country=2 */
  async function operators(req, res) {
    if (!(await adminOrCron(req, res))) return;
    if (!apiKey()) return res.status(503).json({ success: false, message: 'SMS pool offline' });
    try {
      const q = req.query || {};
      const country = String(q.country || q.country_id || '').trim();
      const params = {};
      if (country !== '') params.country = country;
      const r = await call('getOperators', params, 20000);
      let list = [];
      const j = r.json;
      if (j && typeof j === 'object') {
        // Shapes seen across SMS-Activate-compatible APIs
        const block = j.countryOperators || j.operators || j.data || j;
        if (Array.isArray(block)) {
          list = block.map(String);
        } else if (block && typeof block === 'object') {
          if (country !== '' && block[country] != null) {
            const v = block[country];
            list = Array.isArray(v) ? v.map(String) : Object.keys(v || {});
          } else {
            // Flatten all or pick first matching
            for (const k of Object.keys(block)) {
              const v = block[k];
              if (Array.isArray(v)) list = list.concat(v.map(String));
              else if (v && typeof v === 'object') list = list.concat(Object.keys(v));
              else if (typeof v === 'string') list.push(v);
            }
          }
        }
      } else if (typeof r.text === 'string' && r.text && !r.text.startsWith('ERROR') && !r.text.startsWith('BAD')) {
        list = r.text.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
      }
      // de-dupe, drop junk
      const seen = new Set();
      list = list.map((s) => String(s).trim()).filter((s) => {
        if (!s || s.length > 40) return false;
        const k = s.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      return res.status(200).json({ success: true, data: { country: country || null, operators: list } });
    } catch (e) {
      console.error('hero operators', e);
      return res.status(500).json({ success: false, message: 'Could not load operators' });
    }
  }

  /**
   * Options for a service+country before buy — GET ?action=hero_options&service=wa&country=2
   * Returns operators + a best-effort flash/verification flag from getPrices.
   */
  async function options(req, res) {
    // Authenticated user may call this (not only admin) — needed on buy sheet
    try {
      if (!apiKey()) return res.status(503).json({ success: false, message: 'SMS pool offline' });
      const q = req.query || {};
      const country = String(q.country || q.country_id || '').trim();
      const service = String(q.service || q.service_id || '').trim();
      if (!country) return res.status(400).json({ success: false, message: 'country required' });

      // Operators
      let operators = [];
      try {
        const params = { country };
        const r = await call('getOperators', params, 15000);
        const j = r.json;
        if (j && typeof j === 'object') {
          const block = j.countryOperators || j.operators || j.data || j;
          if (Array.isArray(block)) operators = block.map(String);
          else if (block && typeof block === 'object') {
            const v = block[country] != null ? block[country] : null;
            if (Array.isArray(v)) operators = v.map(String);
            else if (v && typeof v === 'object') operators = Object.keys(v);
            else {
              for (const k of Object.keys(block)) {
                const vv = block[k];
                if (Array.isArray(vv)) operators = operators.concat(vv.map(String));
              }
            }
          }
        }
      } catch (e) { console.warn('hero options operators', e); }

      const seen = new Set();
      operators = operators.map((s) => String(s).trim()).filter((s) => {
        if (!s || s.length > 40) return false;
        const k = s.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      // FlashCall availability: only when getPrices for this service/country
      // exposes a call/verification-related field or a separate rate.
      let flashAvailable = false;
      let smsStock = 0;
      let unitUsd = null;
      let flashUsd = null;
      if (service) {
        try {
          const pr = await call('getPrices', { service, country }, 15000);
          const j = pr.json;
          // Typical: { "2": { "wa": { cost, count, physical_count? } } }
          let cell = null;
          if (j && typeof j === 'object') {
            const cBlock = j[country] || j[String(country)] || j;
            if (cBlock && typeof cBlock === 'object') {
              cell = cBlock[service] || cBlock[String(service)] || null;
              if (!cell) {
                // sometimes nested under country only one level of services
                for (const k of Object.keys(cBlock)) {
                  if (String(k).toLowerCase() === service.toLowerCase()) { cell = cBlock[k]; break; }
                }
              }
            }
          }
          if (cell && typeof cell === 'object') {
            smsStock = Number(cell.count || cell.sms_count || 0) || 0;
            unitUsd = num(cell.cost ?? cell.price ?? cell.rate);
            const callUsd = num(cell.cost_call ?? cell.callCost ?? cell.voice_cost ?? cell.verification_cost ?? cell.costVerification);
            if (callUsd > 0) {
              flashAvailable = true;
              flashUsd = callUsd;
            }
            // Heuristics used by SMS-Activate-style panels
            if (cell.verification === true || cell.verification === 1 || cell.verification === '1') flashAvailable = true;
            if (cell.voice === true || cell.voice === 1 || cell.call === true || cell.call === 1) flashAvailable = true;
            if (Number(cell.physical_count || cell.physicalCount || 0) > 0) flashAvailable = true;
            if (cell.types && (String(cell.types).toLowerCase().includes('call') || String(cell.types).toLowerCase().includes('flash'))) flashAvailable = true;
            // If supplier only has one cost but marks verification-capable, flash costs at least SMS cost (never less)
            if (flashAvailable && !(flashUsd > 0) && unitUsd > 0) flashUsd = unitUsd;
          }
        } catch (e) { console.warn('hero options prices', e); }
      }

      // Never expose supplier host/name; only UI flags
      const priceSms = unitUsd > 0 ? sellFromUsd(unitUsd) : null;
      // Never price flash below SMS — if supplier has no separate flash cost, add a safety uplift
      let priceFlash = null;
      if (flashAvailable) {
        const fUsd = (flashUsd > 0) ? flashUsd : (unitUsd > 0 ? unitUsd * 1.35 : 0);
        if (fUsd > 0) priceFlash = Math.max(priceSms || 0, sellFromUsd(fUsd));
      }
      return res.status(200).json({
        success: true,
        data: {
          country,
          service: service || null,
          operators,
          flash_available: flashAvailable,
          stock: smsStock,
          supplier_usd_sms: unitUsd,
          supplier_usd_flash: flashUsd,
          price_ngn_sms: priceSms,
          price_ngn_flash: priceFlash
        }
      });
    } catch (e) {
      console.error('hero options', e);
      return res.status(500).json({ success: false, message: 'Could not load options' });
    }
  }

  return { sync, probe, order, check, cancel, expireStale, orderIsHero, operators, options };
}

