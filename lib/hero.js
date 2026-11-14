import { WALLET_USD_RATE } from './wallet-rate.js';
import { debitWallet, refundWalletDebit } from './wallet.js';
import { applyMarkup } from './pricing.js';
import { randomUUID } from 'node:crypto';
import { sendPushToUser } from './push.js';

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
const rate = () => WALLET_USD_RATE;
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

  // Match the shared SMS-provider notification behaviour. Never put OTP values
  // or sensitive account/payment details in lock-screen notification text.
  async function notifyOtpReceived(order, userId) {
    if (!userId) return;
    const phone = String(order && order.phone_number || '').trim();
    const service = String(order && order.service_name || '').trim();
    try {
      await sendPushToUser(supabase, userId, {
        title: phone || 'New SMS',
        body: service
          ? 'Your ' + service + ' verification SMS has arrived. Open Number History to view it.'
          : 'A new verification SMS has arrived. Open Number History to view it.',
        url: '/mj-sms-history.html',
        type: 'sms_code'
      });
    } catch (error) {
      console.warn('[hero push]', error && error.message || error);
    }
  }

  const isCron = (req) => !!process.env.CRON_SECRET && (req.headers.authorization || '') === `Bearer ${process.env.CRON_SECRET}`;
  async function adminOrCron(req, res) {
    if (isCron(req)) return true;
    const a = await requireAdmin(req);
    if (a.ok) return true;
    res.status(a.status).json({ success: false, message: a.message });
    return false;
  }

  /** Put back exactly what was debited from each wallet (NGN and/or USD). Adds to the CURRENT balance, never overwrites it. */
  async function restoreWallet(userId, split, fallbackNgn, walletDebitId) {
    const refund = await refundWalletDebit(supabase, userId, walletDebitId);
    if (!refund.ok) throw new Error(refund.error || refund.message || 'Exact wallet refund failed');
    return { balance: refund.balance_ngn, balance_usd: refund.usd_restored };
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
  async function loadExisting(countryIds = null) {
    const map = new Map();
    // Keyset pagination (id > last id) instead of OFFSET/range. OFFSET gets slower with every
    // page, and on the large Hero catalog it tripped Postgres' statement timeout
    // ("load existing: canceling statement due to statement timeout"). Each keyset page is
    // bounded, and a timed-out page is retried before the sync gives up.
    // Pairs with sql/number_services_source_id_index.sql (index on source, id).
    const PAGE = 500;
    let lastId = null;
    while (true) {
      let rows = null;
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let q = supabase
          .from('number_services')
          .select('id, country_id, service_id, price, price_source, supplier_price, available_quantity, service_name, country_name, is_available')
          .eq('source', SOURCE)
          .order('id', { ascending: true })
          .limit(PAGE);
        if (Array.isArray(countryIds) && countryIds.length) q = q.in('country_id', countryIds);
        if (lastId != null) q = q.gt('id', lastId);
        const res = await q;
        if (!res.error) { rows = res.data || []; lastErr = null; break; }
        lastErr = res.error;
        if (!/timeout|canceling statement|temporar|fetch failed|ECONN|network/i.test(String(res.error.message || ''))) break;
        await sleep(500 * (attempt + 1));
      }
      if (lastErr) throw new Error('load existing: ' + lastErr.message);
      for (const r of rows) map.set(`${r.country_id}|${r.service_id}`, r);
      if (rows.length < PAGE) break;
      lastId = rows[rows.length - 1].id;
    }
    return map;
  }

  async function runSync(force, cronMode) {
    const started = Date.now();
    // Manual admin requests return a bounded country batch before the Vercel gateway timeout.
    // Cron may use the larger configured budget.
    const budgetMs = cronMode ? SYNC_BUDGET_MS : Math.min(SYNC_BUDGET_MS, 25000);
    const deadline = started + budgetMs - 6000;
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

    // The supplier's all-country response is large and can exceed the Vercel gateway
    // timeout. Use it only for cron; manual admin sync always works in resumable country batches.
    const all = cronMode ? await call('getPrices', {}, 60000) : null;
    const seenAll = all && all.json && typeof all.json === 'object' ? collectPrices(all.json, entries) : 0;
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

    const existing = await loadExisting(processedAll ? null : [...processedCountries]);
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
      out = await runSync(force, isCron(req));
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
    let walletDebitId = null;
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

      // Central atomic debit. The database determines the NGN/USD split.
      const debit = await debitWallet(supabase, user_id, price);
      if (!debit.ok) {
        return res.status(402).json({
          success: false, message: debit.message || 'Insufficient combined wallet balance.',
          required: price, balance_ngn: debit.balance_ngn, balance_usd: debit.balance_usd
        });
      }
      walletDebitId = debit.wallet_debit_id;
      split = { ngn: debit.ngn_debited, usd: debit.usd_debited };
      const newBalance = debit.balance_ngn;
      const newBalanceUsd = debit.balance_usd;
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
        await restoreWallet(user_id, split, price, walletDebitId);
        deducted = false;
        const pub = publicFailure(failText);
        try {
          await supabase.from('transactions').insert({
            user_id, customer_id: customerId, type: 'purchase', category: 'MJ SMS', title: serviceName,
            subtitle: `Failed: ${pub === 'NO_STOCK' ? 'No stock' : 'Unavailable'}`, amount: `₦${price.toLocaleString()}`,
            amount_ngn: split.ngn, amount_usd: split.usd, external_reference: String(walletDebitId), status: 'failed', notes: String(failText || '').slice(0, 300)
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
        await restoreWallet(user_id, split, price, walletDebitId);
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
        phone_number: phone, price, wallet_debit_id: walletDebitId, supplier_price: costUsd, currency: 'NGN',
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
          amount: `₦${price.toLocaleString()}`, amount_ngn: split.ngn, amount_usd: split.usd, external_reference: String(walletDebitId), status: 'pending',
          notes: 'sms_order:' + activationId, supplier_order: r.json || { raw: r.text }
        });
      } catch (_) { /* optional */ }

      return res.status(200).json({ success: true, message: 'Number purchased successfully', data: {
        order_id: activationId, number: phone, status: 'waiting_for_code', service_name: serviceName,
        country_name: countryName, price, new_balance: newBalance, new_balance_usd: newBalanceUsd, wallet_debit_id: walletDebitId,
        ngn_debited: split.ngn, usd_debited: split.usd, created_at: new Date().toISOString(),
        source: SOURCE, cancel_cooldown_seconds: Math.round(CANCEL_COOLDOWN_MS / 1000)
      } });
    } catch (err) {
      console.error('hero order error:', err);
      if (deducted) { try { await restoreWallet(user_id, split, price, walletDebitId); } catch (e) { console.error('CRITICAL hero auto-restore failed', e); } }
      return res.status(500).json({ success: false, message: deducted ? 'Something went wrong. Your balance has been restored.' : 'Something went wrong. Please try again.' });
    }
  }

  // ------------------------------------------------------------ status / check / cancel
  async function findOrder(orderId, userId) {
    let q = supabase.from('number_orders')
      .select('id, user_id, order_id, status, phone_number, created_at, service_id, service_name, country_name, price, supplier_price, refunded, customer_id, code, source')
      .eq('source', SOURCE).eq('order_id', String(orderId));
    if (userId) q = q.eq('user_id', userId);
    const { data } = await q.maybeSingle();
    return data;
  }
  const view = (o, extra) => ({
    order_id: o.order_id, status: o.status, number: o.phone_number, code: o.code || null, created_at: o.created_at,
    service_name: o.service_name, country_name: o.country_name, price: o.price, refunded: !!o.refunded,
    source: o.source || SOURCE, cancel_cooldown_seconds: Math.round(CANCEL_COOLDOWN_MS / 1000),
    ...(extra || {})
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
        .eq('id', order.id).eq('refunded', false).is('code', null).select('id').maybeSingle();
      if (done) {
        await notifyOtpReceived(order, userId);
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
      if (re.recharged) await notifyOtpReceived(order, userId);
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
      const { data: reactivation } = await supabase.from('herosms_reactivations')
        .select('id,status').eq('new_activation_id', String(order.order_id)).eq('user_id', user_id).maybeSingle();
      if (reactivation && reactivation.status === 'succeeded') {
        try {
          const otpResponse = await fetch('https://hero-sms.com/api/v1/activations/' + encodeURIComponent(order.order_id) + '/otp/last', {
            method: 'GET', headers: { Authorization: 'ApiKey ' + apiKey(), Accept: 'application/json' },
            signal: AbortSignal.timeout(12000)
          });
          if (otpResponse.ok) {
            const otpPayload = await otpResponse.json().catch(() => null);
            const latestCode = extractOtp(otpPayload?.data || otpPayload);
            if (latestCode && latestCode !== String(order.code || '')) {
              const { data: saved } = await supabase.from('number_orders')
                .update({ status: 'completed', code: latestCode, updated_at: new Date().toISOString() })
                .eq('id', order.id).eq('user_id', user_id).eq('refunded', false)
                .or('code.is.null,code.neq.' + latestCode)
                .select('id').maybeSingle();
              if (saved) {
                order.code = latestCode; order.status = 'completed';
                await notifyOtpReceived(order, user_id);
              }
            }
          }
        } catch (otpError) {
          console.warn('[hero reactivation otp]', otpError?.message || otpError);
        }
        if (order.code) return res.status(200).json({ success: true, data: view(order) });
        return res.status(200).json({ success: true, data: view(order, { status: 'waiting_for_code', code: null }) });
      }
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
        const age2 = order.created_at ? Date.now() - new Date(order.created_at).getTime() : 0;
        const wait2 = Math.max(1, Math.ceil((CANCEL_COOLDOWN_MS - age2) / 1000));
        return res.status(400).json({ success: false, code: 'EARLY_CANCEL_DENIED', wait_seconds: wait2, message: `Cancel available in ${wait2}s. Please wait a moment.` });
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



  function extractOtp(value, depth = 0) {
    if (depth > 5 || value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') {
      const raw = String(value).trim();
      if (/^\d{4,8}$/.test(raw)) return raw;
      const match = raw.match(/(?:otp|code|verification)\D{0,12}(\d{4,8})/i);
      return match ? match[1] : '';
    }
    if (Array.isArray(value)) {
      for (const item of value) { const found = extractOtp(item, depth + 1); if (found) return found; }
      return '';
    }
    if (typeof value === 'object') {
      for (const key of ['otp','code','verificationCode','verification_code','text','message','sms','data','last','otpLast']) {
        if (value[key] != null) { const found = extractOtp(value[key], depth + 1); if (found) return found; }
      }
      for (const item of Object.values(value)) { const found = extractOtp(item, depth + 1); if (found) return found; }
    }
    return '';
  }

  async function supplierReactivationOptions(activationId) {
    const response = await fetch('https://hero-sms.com/api/v1/activations/' + encodeURIComponent(activationId) + '/reactivate/options', {
      method: 'GET',
      headers: { Authorization: 'ApiKey ' + apiKey(), Accept: 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    const payload = await response.json().catch(() => null);
    return { response, payload, options: Array.isArray(payload?.data?.options) ? payload.data.options : (Array.isArray(payload?.options) ? payload.options : []) };
  }

  function reactivationDurationHours(value, unit) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    const u = String(unit || 'hour').toLowerCase();
    const hours = u.startsWith('day') ? n * 24 : u.startsWith('minute') ? n / 60 : u.startsWith('second') ? n / 3600 : n;
    return Number.isInteger(hours) ? hours : 0;
  }

  function normalizePhone(value) {
    return String(value || '').replace(/\D/g, '');
  }

  function activationServiceValues(activation) {
    const service = activation?.service;
    const values = [
      activation?.serviceId, activation?.service_id, activation?.serviceCode, activation?.service_code,
      typeof service === 'string' ? service : null,
      service && typeof service === 'object' ? service.id : null,
      service && typeof service === 'object' ? service.code : null,
      service && typeof service === 'object' ? service.name : null,
      service && typeof service === 'object' ? service.title : null
    ];
    return values.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
  }

  function serviceMatchesOriginal(activation, order) {
    const returned = activationServiceValues(activation);
    const expected = [order.service_id, order.service_name]
      .map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
    return returned.length > 0 && expected.some((value) => returned.includes(value));
  }

  async function holdUnverifiedSupplierActivation(attemptId, userId, activationId, payload, reason) {
    const { error } = await supabase.from('herosms_reactivations').update({
      status: 'unknown',
      new_activation_id: activationId || null,
      supplier_response: payload || {},
      failure_reason: String(reason || 'Supplier activation identity could not be verified').slice(0, 500),
      updated_at: new Date().toISOString()
    }).eq('id', attemptId).eq('user_id', userId).eq('status', 'pending');
    if (error) {
      await supabase.rpc('mj_fail_herosms_reactivation', {
        p_attempt_id: attemptId, p_user_id: userId,
        p_reason: 'Supplier created an activation but identity verification or reconciliation failed',
        p_refund: false
      });
      console.error('[hero reactivation hold]', error.message);
    }
  }

  async function reactivate(req, res) {
    const b = bodyOf(req);
    const orderId = String(b.order_id || '').trim();
    const userId = String(b.user_id || '').trim();
    const idem = String(b.idempotency_key || '').trim();
    const duration = Number(b.duration);
    if (!orderId || !userId || !idem || idem.length < 16 || !Number.isInteger(duration) || duration <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid reactivation request.' });
    }
    if (!apiKey()) return res.status(503).json({ success: false, message: 'Reactivation is temporarily unavailable.' });

    let attemptId = null;
    try {
      const order = await findOrder(orderId, userId);
      if (!order || String(order.status || '').toLowerCase() !== 'completed' || !String(order.code || '').trim() || order.refunded) {
        return res.status(404).json({ success: false, message: 'The SIM card is offline.' });
      }
      const live = await supplierReactivationOptions(orderId);
      if (live.response.status === 404 || live.response.status === 422 || !live.response.ok) {
        return res.status(live.response.status === 404 || live.response.status === 422 ? 409 : 503).json({
          success: false, message: live.response.status === 404 || live.response.status === 422 ? 'The SIM card is offline.' : 'Reactivation is temporarily unavailable.'
        });
      }
      const requestedUnit = String(b.unit || 'hour').toLowerCase();
      const option = live.options.find((item) => Number(item?.duration?.value) === duration && String(item?.duration?.unit || 'hour').toLowerCase() === requestedUnit);
      if (!option) return res.status(409).json({ success: false, message: 'That reuse duration is no longer available. Refresh and try again.' });
      const supplierUsd = num(option.price);
      const customerPrice = Math.ceil(Number(order.price || 0) + 500);
      // The wallet RPC converts USD at 1,450 NGN/USD. Price against that exact rate.
      if (!(supplierUsd > 0) || supplierUsd * WALLET_USD_RATE > customerPrice) {
        return res.status(409).json({ success: false, message: 'Reactivation is currently unavailable at a safe price. Refresh and try again.' });
      }
      const unit = String(option.duration?.unit || 'hour').toLowerCase();
      const durationHours = reactivationDurationHours(duration, unit);
      if (!durationHours) return res.status(409).json({ success: false, message: 'That reuse duration is invalid. Refresh and try again.' });
      const { data: begun, error: beginError } = await supabase.rpc('mj_begin_herosms_reactivation', {
        p_user_id: userId, p_parent_order_id: order.id, p_idempotency_key: idem,
        p_duration_hours: durationHours, p_supplier_price_usd: supplierUsd, p_customer_price_ngn: customerPrice
      });
      if (beginError) {
        console.error('[hero reactivation debit]', beginError.message);
        return res.status(500).json({ success: false, message: 'Could not reserve the wallet payment safely. Please try again.' });
      }
      const begin = Array.isArray(begun) ? begun[0] : begun;
      if (!begin?.success || !begin?.attempt_id) {
        const msg = String(begin?.message || 'Could not start reactivation.');
        return res.status(msg.toLowerCase().includes('insufficient') ? 402 : 409).json({ success: false, message: msg });
      }
      attemptId = begin.attempt_id;
      if (begin.message === 'Request already exists') {
        const { data: existing } = await supabase.from('herosms_reactivations')
          .select('status,new_activation_id').eq('id', attemptId).eq('user_id', userId).maybeSingle();
        if (existing?.status === 'succeeded' && existing.new_activation_id) {
          return res.status(200).json({ success: true, replayed: true, data: { order_id: existing.new_activation_id, status: 'succeeded' } });
        }
        return res.status(409).json({ success: false, message: 'This reuse request is already being processed. Check your order history shortly.' });
      }

      let supplierResponse;
      let payload;
      try {
        supplierResponse = await fetch('https://hero-sms.com/api/v1/activations/' + encodeURIComponent(orderId) + '/reactivate', {
          method: 'POST',
          headers: { Authorization: 'ApiKey ' + apiKey(), Accept: 'application/json', 'Content-Type': 'application/json' },
          // HeroSMS reactivation POST accepts duration in hours. Convert the
          // exact live option selected by the customer into that API unit.
          body: JSON.stringify({ duration: durationHours }),
          signal: AbortSignal.timeout(25000)
        });
        payload = await supplierResponse.json().catch(() => null);
      } catch (networkError) {
        await supabase.rpc('mj_fail_herosms_reactivation', {
          p_attempt_id: attemptId, p_user_id: userId,
          p_reason: 'Supplier response timed out; activation outcome is uncertain', p_refund: false
        });
        return res.status(202).json({ success: false, pending: true, message: 'The supplier has not confirmed the result yet. Your payment is on hold because the supplier response is inconclusive. Contact support before retrying.' });
      }

      if (!supplierResponse.ok) {
        const uncertain = supplierResponse.status >= 500 || supplierResponse.status === 408 || supplierResponse.status === 429;
        await supabase.rpc('mj_fail_herosms_reactivation', {
          p_attempt_id: attemptId, p_user_id: userId,
          p_reason: 'Supplier rejected reactivation (HTTP ' + supplierResponse.status + ')',
          p_refund: !uncertain
        });
        if (uncertain) return res.status(202).json({ success: false, pending: true, message: 'The supplier has not confirmed the result yet. Your payment is on hold because the supplier response is inconclusive. Contact support before retrying.' });
        return res.status(409).json({ success: false, message: supplierResponse.status === 404 || supplierResponse.status === 422 ? 'The SIM card is offline.' : 'Reactivation failed. Your balance has been restored.' });
      }

      const activation = payload?.data || payload?.activation || payload;
      const newActivationId = String(activation?.id || activation?.activationId || activation?.activation_id || '').trim();
      if (!newActivationId) {
        await supabase.rpc('mj_fail_herosms_reactivation', {
          p_attempt_id: attemptId, p_user_id: userId,
          p_reason: 'Supplier returned success without an activation ID', p_refund: false
        });
        return res.status(202).json({ success: false, pending: true, message: 'The supplier accepted the request but has not returned an activation reference. Your payment is on hold because the supplier response is inconclusive. Contact support before retrying.' });
      }
      const code = extractOtp(activation?.otpLast || activation?.otp || activation?.code || '');
      const returnedPhone = String(activation?.phone || activation?.phoneNumber || activation?.phone_number || '').trim();
      const phoneMatches = !!normalizePhone(returnedPhone) &&
        normalizePhone(returnedPhone) === normalizePhone(order.phone_number);
      const serviceMatches = serviceMatchesOriginal(activation, order);

      // A successful HTTP response is not enough: do not expose a different
      // number or service as a successful reactivation. Keep the debit on hold
      // and retain the supplier payload/activation ID for manual reconciliation.
      if (!phoneMatches || !serviceMatches) {
        const reason = !phoneMatches
          ? 'Supplier returned a different or unverifiable phone number'
          : 'Supplier returned a different or unverifiable service';
        await holdUnverifiedSupplierActivation(attemptId, userId, newActivationId, payload, reason);
        return res.status(202).json({
          success: false, pending: true,
          message: 'HeroSMS returned an activation that MJ HUB could not verify as the same number and service. Your payment is on hold while support reconciles it. Do not retry.'
        });
      }

      const phone = returnedPhone;
      const completed = await supabase.rpc('mj_finish_herosms_reactivation', {
        p_attempt_id: attemptId, p_user_id: userId, p_new_activation_id: newActivationId,
        p_phone_number: phone, p_status: String(activation?.status || ''),
        p_code: code, p_supplier_response: payload || {}
      });
      const finished = Array.isArray(completed.data) ? completed.data[0] : completed.data;
      if (completed.error || !finished?.success) {
        console.error('[hero reactivation finalize]', completed.error?.message || finished?.message);
        return res.status(202).json({ success: false, pending: true, message: 'The supplier created the activation, but MJ HUB is still reconciling the order. Your payment has not been refunded or charged again.' });
      }
      if (code) await notifyOtpReceived({ phone_number: phone, service_name: order.service_name }, userId);
      return res.status(200).json({ success: true, data: {
        order_id: newActivationId, phone_number: phone, status: code ? 'completed' : 'waiting_for_code',
        code: code || null, price: customerPrice, duration, unit
      } });
    } catch (error) {
      console.error('[hero reactivation]', error?.message || error);
      if (attemptId) {
        await supabase.rpc('mj_fail_herosms_reactivation', {
          p_attempt_id: attemptId, p_user_id: userId,
          p_reason: 'Internal error after wallet reservation; outcome requires reconciliation', p_refund: false
        });
      }
      return res.status(500).json({ success: false, pending: !!attemptId, message: attemptId
        ? 'The reactivation is being reconciled. Do not submit another request.'
        : 'Reactivation is temporarily unavailable.' });
    }
  }

  // ------------------------------------------------------------ HeroSMS reactivation eligibility
  // This is deliberately separate from SMS-Bus reuse and from Rent session extension.
  async function reactivateOptions(req, res) {
    const b = bodyOf(req);
    const orderId = String(b.order_id || '').trim();
    const userId = String(b.user_id || '').trim();
    const traceId = randomUUID();
    const startedAt = Date.now();
    const log = (event, details = {}) => console.info('[hero reactivation options]', JSON.stringify({
      trace_id: traceId, event, elapsed_ms: Date.now() - startedAt, ...details
    }));
    const fail = (status, message, code) => res.status(status).json({
      success: false, message, code, reference: traceId
    });

    if (!orderId || !userId) {
      log('invalid_request');
      return res.status(400).json({ success: false, message: 'Order not found.' });
    }

    try {
      // Keep the database error separate from "order not found". A failed query
      // must never be misreported as an offline SIM.
      log('order_lookup_started');
      const { data: order, error: orderError } = await supabase.from('number_orders')
        .select('id, user_id, order_id, status, phone_number, price, refunded, code, source')
        .eq('source', SOURCE).eq('order_id', orderId).eq('user_id', userId).maybeSingle();
      if (orderError) {
        log('order_lookup_failed', { error_code: orderError.code || null, error: String(orderError.message || 'database query failed').slice(0, 180) });
        return fail(503, 'Reactivation is temporarily unavailable. Reference: ' + traceId, 'ORDER_LOOKUP_FAILED');
      }
      if (!order || String(order.status || '').toLowerCase() !== 'completed' || !String(order.code || '').trim() || order.refunded) {
        log('order_not_eligible');
        return res.status(200).json({ success: true, data: { available: false, message: 'The SIM card is offline.' } });
      }

      const key = apiKey();
      if (!key) {
        log('supplier_key_missing');
        return fail(503, 'Reactivation is temporarily unavailable. Reference: ' + traceId, 'SUPPLIER_NOT_CONFIGURED');
      }

      const url = 'https://hero-sms.com/api/v1/activations/' + encodeURIComponent(orderId) + '/reactivate/options';
      log('supplier_request_started');
      let response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: { Authorization: 'ApiKey ' + key, Accept: 'application/json' },
          signal: AbortSignal.timeout(15000)
        });
      } catch (networkError) {
        const timeout = networkError && (networkError.name === 'TimeoutError' || networkError.name === 'AbortError');
        log(timeout ? 'supplier_timeout' : 'supplier_network_error', {
          error_name: networkError && networkError.name || 'Error',
          error_code: networkError && networkError.cause && networkError.cause.code || networkError && networkError.code || null,
          error: String(networkError && networkError.message || 'supplier request failed').slice(0, 180)
        });
        return fail(503, 'Reactivation is temporarily unavailable. Reference: ' + traceId, timeout ? 'SUPPLIER_TIMEOUT' : 'SUPPLIER_NETWORK_ERROR');
      }

      const rawPayload = await response.text();
      let payload = null;
      try { payload = rawPayload ? JSON.parse(rawPayload) : null; }
      catch (_) {
        log('supplier_invalid_json', { upstream_status: response.status, content_type: response.headers.get('content-type') || null });
      }

      if (response.status === 404 || response.status === 422) {
        log('supplier_says_unavailable', { upstream_status: response.status });
        return res.status(200).json({ success: true, data: { available: false, message: 'The SIM card is offline.' } });
      }
      if (!response.ok) {
        const supplierErrorSource = payload && typeof payload === 'object'
          ? (payload.error && typeof payload.error === 'object' ? payload.error : payload)
          : {};
        const supplierErrorCode = String(
          supplierErrorSource.title || supplierErrorSource.code || supplierErrorSource.type || ''
        ).toUpperCase();
        // HeroSMS can return SIM_OFFLINE as HTTP 400. Treat this as a
        // normal availability result, not a temporary integration failure.
        if (supplierErrorCode === 'SIM_OFFLINE') {
          log('supplier_says_unavailable', { upstream_status: response.status, supplier_code: supplierErrorCode });
          return res.status(200).json({ success: true, data: { available: false, message: 'The SIM card is offline.' } });
        }
        const category = response.status === 401 || response.status === 403 ? 'SUPPLIER_AUTH_REJECTED'
          : response.status === 429 ? 'SUPPLIER_RATE_LIMITED'
          : response.status >= 500 ? 'SUPPLIER_SERVER_ERROR' : 'SUPPLIER_HTTP_ERROR';
        // Capture only whitelisted supplier error fields. Never log the raw body,
        // activation identifiers, phone numbers, OTPs, or credentials.
        let supplierError = null;
        if (payload && typeof payload === 'object') {
          const source = payload.error && typeof payload.error === 'object' ? payload.error : payload;
          const safe = {};
          for (const field of ['code', 'type', 'status', 'title', 'message', 'detail']) {
            const value = source[field];
            if (typeof value === 'string' || typeof value === 'number') safe[field] = String(value).slice(0, 180);
          }
          if (typeof payload.error === 'string') safe.error = payload.error.slice(0, 180);
          supplierError = Object.keys(safe).length ? JSON.stringify(safe)
            .replace(/ApiKey\s+[^\s"]+/gi, 'ApiKey [redacted]')
            .replace(/Bearer\s+[^\s"]+/gi, 'Bearer [redacted]')
            .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '[redacted-id]')
            .replace(/\+?\d[\d\s().-]{6,}\d/g, '[redacted-number]')
            .slice(0, 500) : null;
        } else if (rawPayload && !payload) {
          supplierError = 'non_json_error_response';
        }
        log('supplier_http_error', { upstream_status: response.status, category, supplier_error: supplierError });
        return fail(503, 'Reactivation is temporarily unavailable. Reference: ' + traceId, category);
      }
      if (!payload || typeof payload !== 'object') {
        log('supplier_payload_invalid', { upstream_status: response.status });
        return fail(503, 'Reactivation is temporarily unavailable. Reference: ' + traceId, 'SUPPLIER_INVALID_RESPONSE');
      }

      const block = payload && payload.data ? payload.data : payload;
      const options = Array.isArray(block && block.options) ? block.options : [];
      if (!options.length) {
        log('supplier_options_empty');
        return res.status(200).json({ success: true, data: { available: false, message: 'The SIM card is offline.' } });
      }

      const customerPrice = Math.ceil(Number(order.price || 0) + 500);
      const safeOptions = options.map((item) => {
        const duration = item && item.duration ? item.duration : {};
        const supplierUsd = num(item && item.price);
        const costNgn = supplierUsd * WALLET_USD_RATE;
        return {
          duration: Number(duration.value) || 0,
          unit: String(duration.unit || 'hour'),
          price: customerPrice,
          affordable: supplierUsd > 0 && customerPrice >= costNgn
        };
      }).filter((item) => item.duration > 0 && item.affordable)
        .map(({ duration, unit, price }) => ({ duration, unit, price }));

      if (!safeOptions.length) {
        log('options_rejected_by_existing_price_guard', { supplier_option_count: options.length });
        return res.status(200).json({ success: true, data: { available: false, message: 'Reactivation is currently unavailable at a safe price.' } });
      }
      log('availability_confirmed', { supplier_option_count: options.length, customer_option_count: safeOptions.length });
      return res.status(200).json({ success: true, data: { available: true, phone_number: order.phone_number, options: safeOptions, reference: traceId } });
    } catch (err) {
      log('unexpected_handler_error', {
        error_name: err && err.name || 'Error',
        error_code: err && err.code || null,
        error: String(err && err.message || err || 'unexpected error').slice(0, 180)
      });
      return fail(503, 'Reactivation is temporarily unavailable. Reference: ' + traceId, 'REACTIVATION_CHECK_FAILED');
    }
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
    // Buy-sheet helper: live operators (with pcs) + flash availability/prices
    try {
      if (!apiKey()) return res.status(503).json({ success: false, message: 'SMS pool offline' });
      const q = req.query || {};
      const country = String(q.country || q.country_id || '').trim();
      const service = String(q.service || q.service_id || '').trim();
      if (!country) return res.status(400).json({ success: false, message: 'country required' });

      const operators = []; // { name, count, cost_usd }
      function pushOp(name, count, costUsd) {
        const n = String(name || '').trim();
        if (!n || n.length > 48) return;
        const low = n.toLowerCase();
        if (['status', 'success', 'error', 'countryoperators', 'operators', 'data'].includes(low)) return;
        const c = Number(count);
        const cost = num(costUsd);
        const existing = operators.find((o) => o.name.toLowerCase() === low);
        if (existing) {
          if (Number.isFinite(c) && c >= 0) existing.count = c;
          if (cost > 0) existing.cost_usd = cost;
          return;
        }
        operators.push({
          name: n,
          count: Number.isFinite(c) && c >= 0 ? c : null,
          cost_usd: cost > 0 ? cost : null
        });
      }
      function ingestOpsValue(v, fallbackName) {
        if (v == null) return;
        if (typeof v === 'number') { pushOp(fallbackName, v, null); return; }
        if (typeof v === 'string') { pushOp(v, null, null); return; }
        if (Array.isArray(v)) { v.forEach((x) => ingestOpsValue(x)); return; }
        if (typeof v === 'object') {
          if ('count' in v || 'cost' in v || 'price' in v || 'quantity' in v || 'pcs' in v) {
            pushOp(fallbackName || v.name || v.operator, v.count ?? v.quantity ?? v.pcs, v.cost ?? v.price ?? v.rate);
            return;
          }
          for (const k of Object.keys(v)) ingestOpsValue(v[k], k);
        }
      }

      try {
        const r = await call('getOperators', { country }, 15000);
        const j = r.json;
        if (j && typeof j === 'object') {
          const block = j.countryOperators || j.operators || j.data || j;
          if (Array.isArray(block)) block.forEach((x) => ingestOpsValue(x));
          else if (block && typeof block === 'object') {
            const v = block[country] != null ? block[country]
              : (block[String(country)] != null ? block[String(country)] : null);
            if (v != null) ingestOpsValue(v);
            else {
              for (const k of Object.keys(block)) ingestOpsValue(block[k], k);
            }
          }
        }
      } catch (e) { console.warn('hero options operators', e); }

      let flashAvailable = false;
      let smsStock = 0;
      let unitUsd = null;
      let flashUsd = null;
      if (service) {
        try {
          const pr = await call('getPrices', { service, country }, 15000);
          const j = pr.json;
          let cell = null;
          if (j && typeof j === 'object') {
            const cBlock = j[country] || j[String(country)] || j;
            if (cBlock && typeof cBlock === 'object') {
              cell = cBlock[service] || cBlock[String(service)] || null;
              if (!cell) {
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
            if (callUsd > 0) { flashAvailable = true; flashUsd = callUsd; }
            if (cell.verification === true || cell.verification === 1 || cell.verification === '1') flashAvailable = true;
            if (cell.voice === true || cell.voice === 1 || cell.call === true || cell.call === 1) flashAvailable = true;
            if (Number(cell.physical_count || cell.physicalCount || 0) > 0) flashAvailable = true;
            if (cell.types && /call|flash/i.test(String(cell.types))) flashAvailable = true;
            // Per-operator stock nested under the price cell (common on Hero-style panels)
            const opNest = cell.operators || cell.operator || cell.ops || null;
            if (opNest) ingestOpsValue(opNest);
            if (flashAvailable && !(flashUsd > 0) && unitUsd > 0) flashUsd = unitUsd * 1.35;
          }
        } catch (e) { console.warn('hero options prices', e); }
      }

      // Sort: in-stock first, then by name
      operators.sort((a, b) => {
        const ac = a.count == null ? -1 : a.count;
        const bc = b.count == null ? -1 : b.count;
        if (ac !== bc) return bc - ac;
        return String(a.name).localeCompare(String(b.name));
      });

      // price_ngn_sms is informational only — buy sheet keeps the catalog SMS price.
      // price_ngn_flash is ONLY applied when the user picks Flash call + SMS.
      const priceSmsInfo = unitUsd > 0 ? sellFromUsd(unitUsd) : null;
      let priceFlash = null;
      if (flashAvailable) {
        const fUsd = (flashUsd > 0) ? flashUsd : (unitUsd > 0 ? unitUsd * 1.35 : 0);
        if (fUsd > 0) priceFlash = sellFromUsd(fUsd);
      }

      return res.status(200).json({
        success: true,
        data: {
          country,
          service: service || null,
          operators, // [{ name, count, cost_usd }]
          flash_available: flashAvailable && priceFlash != null,
          stock: smsStock,
          supplier_usd_sms: unitUsd,
          supplier_usd_flash: flashUsd,
          price_ngn_sms: priceSmsInfo, // do not force UI SMS total to this
          price_ngn_flash: priceFlash
        }
      });
    } catch (e) {
      console.error('hero options', e);
      return res.status(500).json({ success: false, message: 'Could not load options' });
    }
  }


  return { sync, probe, order, check, cancel, expireStale, orderIsHero, operators, options, reactivateOptions, reactivate };
}

