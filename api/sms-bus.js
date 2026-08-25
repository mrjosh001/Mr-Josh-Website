import { createClient } from '@supabase/supabase-js';
import { applyMarkup } from '../lib/pricing.js';

/**
 * SMS-BUS integration — OTP (with reuse) + long-term rentals.
 *
 * Env: SMSBUS_API_TOKEN (or SMS_BUS_TOKEN), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * OTP (https://sms-bus.com/api/control):
 *   GET  ?action=balance
 *   GET  ?action=countries
 *   GET  ?action=projects
 *   GET  ?action=prices&country_id=
 *   POST ?action=order   { country_id, project_id, reuse? }
 *   POST ?action=check   { order_id }          // request_id
 *   POST ?action=cancel  { order_id }
 *   POST ?action=reuse   { country_id, project_id, mobile_number }
 *
 * Rent (https://api.sms-bus.com):
 *   GET  ?action=rent_areas
 *   GET  ?action=rent_prices&area_code=
 *   POST ?action=rent_order  { area_code, time }  // time = months
 *   GET  ?action=rent_sms&order_id= | mobile_number=
 *   POST ?action=rent_renew  { area_code, mobile_number, time }
 */

const OTP_BASE = 'https://sms-bus.com/api/control';
const RENT_BASE = 'https://api.sms-bus.com';
const TOKEN = process.env.SMSBUS_API_TOKEN || process.env.SMS_BUS_TOKEN || '';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}


/** Fields safe to send to the browser — never cost, tokens, or provider names */
function publicOrderPayload(data) {
  if (!data || typeof data !== 'object') return data;
  const out = { ...data };
  delete out.supplier_price;
  delete out.supplier_usd;
  delete out.cost;
  delete out.cost_usd;
  delete out.token;
  delete out.api_key;
  return out;
}

async function requireAuth(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, message: 'Please sign in to continue' };
  const {
    data: { user },
    error
  } = await supabase.auth.getUser(token);
  if (error || !user) return { ok: false, status: 401, message: 'Session expired. Sign in again.' };
  return { ok: true, userId: user.id };
}

async function smsbusGet(base, path, params = {}) {
  if (!TOKEN) throw new Error('SMSBUS_API_TOKEN is not configured');
  const q = new URLSearchParams({ token: TOKEN, ...params });
  const url = `${base}${path}?${q.toString()}`;
  const r = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  const data = await r.json().catch(() => ({}));
  return { http: r.status, data };
}

function busOk(data) {
  return data && (data.code === 200 || data.code === '200');
}


/**
 * Claim order for refund once, then credit wallet (idempotent).
 * Prevents double-credit when Cancel + auto-expiry race.
 */
async function claimAndRefundSmsBusOrder(order, userId, opts = {}) {
  if (!order || !order.id) return { refunded: false, reason: 'missing_order' };
  if (order.refunded || order.status === 'refunded' || order.status === 'completed') {
    return { refunded: false, reason: 'already_final' };
  }

  const subtitle = opts.subtitle || 'No SMS — balance restored';
  // Only refund open orders (not completed with a code)
  if (order.status === 'completed' && order.code) {
    return { refunded: false, reason: 'already_final' };
  }
  const { data: claimed, error: claimErr } = await supabase
    .from('number_orders')
    .update({
      status: 'refunded',
      refunded: true,
      updated_at: new Date().toISOString()
    })
    .eq('id', order.id)
    .neq('status', 'completed')
    .select('id, price')
    .maybeSingle();

  if (claimErr) {
    console.error('[smsbus claimAndRefund]', claimErr.message);
    return { refunded: false, reason: 'claim_error', error: claimErr.message };
  }
  if (!claimed) return { refunded: false, reason: 'already_final' };

  const refundAmount = Number(order.price != null ? order.price : claimed.price) || 0;
  let newBalance = null;
  if (refundAmount > 0) {
    const { data: profile } = await supabase.from('profiles').select('balance, customer_id').eq('id', userId).single();
    if (profile) {
      newBalance = Number(profile.balance || 0) + refundAmount;
      await supabase.from('profiles').update({ balance: newBalance }).eq('id', userId);
      try {
        await supabase.from('transactions').insert({
          user_id: userId,
          customer_id: profile.customer_id || order.customer_id,
          type: 'refund',
          category: 'MJ SMS',
          title: 'SMS cancel refund',
          subtitle: subtitle,
          amount: `₦${refundAmount.toLocaleString()}`,
          amount_ngn: refundAmount,
          status: 'refunded'
        });
      } catch (_) {}
    }
  }
  try {
    await markTxStatus(userId, order.order_id, order.phone_number, 'cancelled');
  } catch (_) {}
  return { refunded: true, amount: refundAmount, new_balance: newBalance };
}

function parseSupplierBalance(data) {
  if (data == null) return null;
  if (typeof data === 'number') return data;
  if (typeof data === 'string' && /^-?\d+(\.\d+)?$/.test(data.trim())) return Number(data);
  if (typeof data === 'object') {
    const v = data.balance ?? data.amount ?? data.credit ?? data.funds ?? data.money;
    if (v != null) return Number(v);
  }
  return null;
}

const SMSBUS_CANCEL_COOLDOWN_MS = 60 * 1000; // 1 minute (supplier min is ~30s)
const SMSBUS_EXPIRY_MS = 5 * 60 * 1000; // Server 2 numbers last 5 minutes


/** Persist Server 2 catalog. Never overwrites admin selling price or forced hide. */
async function syncSmsBusCatalog() {
  const usdToNgn = Number(process.env.USD_TO_NGN) || 1500;
  const [countriesRes, projectsRes] = await Promise.all([
    smsbusGet(OTP_BASE, '/list/countries'),
    smsbusGet(OTP_BASE, '/list/projects')
  ]);
  if (!busOk(countriesRes.data)) {
    throw new Error(countriesRes.data?.message || 'Could not load countries');
  }
  if (!busOk(projectsRes.data)) {
    throw new Error(projectsRes.data?.message || 'Could not load projects');
  }

  const countries = Object.values(countriesRes.data.data || {}).map((c) => ({
    id: String(c.id),
    name: c.title || c.name || String(c.id)
  }));
  const nameById = {};
  Object.values(projectsRes.data.data || {}).forEach((pr) => {
    nameById[String(pr.id)] = pr.title || pr.name || String(pr.id);
  });

  let newCount = 0;
  let updatedCount = 0;
  let errors = 0;

  // Concurrency-limited country price pulls
  const queue = 4;
  for (let i = 0; i < countries.length; i += queue) {
    const slice = countries.slice(i, i + queue);
    await Promise.all(
      slice.map(async (country) => {
        try {
          const { data: priceData } = await smsbusGet(OTP_BASE, '/list/prices', {
            country_id: country.id
          });
          if (!busOk(priceData)) return;

          const entries = Object.values(priceData.data || {});
          if (!entries.length) return;

          const { data: existingRows } = await supabase
            .from('number_services')
            .select('id, service_id, price, is_available, price_source')
            .eq('source', 'smsbus')
            .eq('country_id', country.id);

          const existingMap = new Map(
            (existingRows || []).map((r) => [String(r.service_id), r])
          );
          const now = new Date().toISOString();
          const toInsert = [];
          const toUpdate = [];

          for (const row of entries) {
            const sid = String(row.project_id);
            if (!sid || sid === 'undefined') continue;
            const costUsd = Number(row.cost || row.price || 0);
            const stock = Number(row.total_count || row.count || 0);
            const serviceName =
              nameById[sid] ||
              (row.title && !/united|russia|state|country/i.test(String(row.title))
                ? row.title
                : '') ||
              `Service ${sid}`;
            const prev = existingMap.get(sid);

            if (prev) {
              // NEVER touch price (admin selling price). Preserve is_available when admin hid.
              const fields = {
                country_name: country.name,
                service_name: serviceName,
                available_quantity: stock,
                updated_at: now
              };
              if (prev.is_available === false) {
                // keep hidden
                fields.is_available = false;
              } else {
                fields.is_available = stock > 0;
              }
              toUpdate.push({ id: prev.id, ...fields });
            } else {
              toInsert.push({
                source: 'smsbus',
                country_id: country.id,
                country_name: country.name,
                service_id: sid,
                service_name: serviceName,
                price: applyMarkup(costUsd || 0.01, usdToNgn),
                price_source: 'system',
                currency: 'NGN',
                available_quantity: stock,
                is_available: stock > 0,
                updated_at: now
              });
            }
          }

          for (const u of toUpdate) {
            const { id, ...fields } = u;
            const { error } = await supabase.from('number_services').update(fields).eq('id', id);
            if (error) errors += 1;
            else updatedCount += 1;
          }
          if (toInsert.length) {
            const { error } = await supabase.from('number_services').insert(toInsert);
            if (error) {
              // fallback one-by-one
              for (const row of toInsert) {
                const { error: e2 } = await supabase.from('number_services').insert(row);
                if (e2) errors += 1;
                else newCount += 1;
              }
            } else {
              newCount += toInsert.length;
            }
          }
        } catch (e) {
          console.error('[smsbus catalog]', country.id, e.message);
          errors += 1;
        }
      })
    );
  }

  return { newCount, updatedCount, errors, countries: countries.length };
}




async function insertNumberOrder(row) {
  const lastErrors = [];

  // idempotency_key is NOT NULL with a UNIQUE(source, idempotency_key)
  // index — every insert attempt below was missing it entirely, so every
  // single one was failing that constraint silently. Derive a stable,
  // per-order value from order_id (already unique per purchase from the
  // supplier) so this can never collide across real orders.
  const idemKey = row.idempotency_key || `${row.source || 'smsbus'}-${row.order_id}`;
  row = { ...row, idempotency_key: idemKey };

  // Build progressive payloads — strip fields that often break older schemas
  const variants = [];
  const full = { ...row };
  variants.push(full);

  const asStringCountry = { ...row, country_id: row.country_id != null ? String(row.country_id) : null };
  variants.push(asStringCountry);

  const noOptional = { ...row };
  for (const k of ['supplier_price', 'currency', 'refunded', 'time_left', 'customer_id', 'code']) {
    delete noOptional[k];
  }
  variants.push(noOptional);
  variants.push({ ...noOptional, country_id: row.country_id != null ? String(row.country_id) : null });

  // Without source (if CHECK constraint only allows grizzlysms)
  const noSource = { ...noOptional };
  delete noSource.source;
  variants.push(noSource);

  // Absolute minimum
  variants.push({
    user_id: row.user_id,
    order_id: String(row.order_id),
    idempotency_key: idemKey,
    phone_number: row.phone_number || null,
    status: row.status || 'waiting_for_code',
    price: row.price != null ? row.price : null,
    service_name: row.service_name || null,
    country_name: row.country_name || null,
    source: row.source || 'smsbus'
  });
  variants.push({
    user_id: row.user_id,
    order_id: String(row.order_id),
    idempotency_key: idemKey,
    phone_number: row.phone_number || null,
    status: 'waiting_for_code',
    price: row.price
  });

  for (const attempt of variants) {
    // drop undefined keys
    const payload = {};
    for (const [k, v] of Object.entries(attempt)) {
      if (v !== undefined) payload[k] = v;
    }
    const { data, error } = await supabase.from('number_orders').insert(payload).select('id, order_id').maybeSingle();
    if (!error) return { error: null, row: payload, id: data && data.id };
    const msg = String(error.message || error.code || '');
    lastErrors.push(msg);
    if (/duplicate|unique/i.test(msg)) {
      return { error: null, row: payload, duplicate: true };
    }
  }

  return {
    error: { message: lastErrors.filter(Boolean).slice(-3).join(' | ') || 'insert failed' }
  };
}

async function markTxStatus(userId, orderId, phone, status) {
  try {
    const { data } = await supabase
      .from('transactions')
      .select('id, subtitle, notes, status')
      .eq('user_id', userId)
      .eq('category', 'MJ SMS')
      .order('created_at', { ascending: false })
      .limit(15);
    const hit = (data || []).find((tx) => {
      const blob = `${tx.subtitle || ''} ${tx.notes || ''}`;
      return blob.includes(String(orderId)) || (phone && blob.includes(String(phone)));
    });
    if (hit) await supabase.from('transactions').update({ status }).eq('id', hit.id);
  } catch (_) {}
}


export default async function handler(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(res, 500, {
      success: false,
      message: 'Something went wrong on our side. Please contact support.'
    });
  }

  try {
    const url = new URL(req.url, 'http://localhost');
    const action = (url.searchParams.get('action') || '').toLowerCase();
    const method = (req.method || 'GET').toUpperCase();

    if (!TOKEN) {
      return json(res, 503, {
        success: false,
        message: 'This server is temporarily unavailable. Contact support if it keeps happening.'
      });
    }

    // ——— Public-ish catalog (still require auth so only customers hit supplier) ———
    // Supplier wallet balance is never exposed to customers
    if (method === 'GET' && action === 'balance') {
      return json(res, 403, {
        success: false,
        message: 'Not available'
      });
    }

    if (method === 'GET' && action === 'countries') {
      const { data } = await smsbusGet(OTP_BASE, '/list/countries');
      if (!busOk(data)) return json(res, 400, { success: false, message: data.message || 'Countries error' });
      const list = Object.values(data.data || {}).map((c) => ({
        id: c.id,
        title: c.title || c.name || String(c.id),
        code: c.code || ''
      }));
      return json(res, 200, { success: true, data: list });
    }

    if (method === 'GET' && action === 'projects') {
      const { data } = await smsbusGet(OTP_BASE, '/list/projects');
      if (!busOk(data)) return json(res, 400, { success: false, message: data.message || 'Projects error' });
      const list = Object.values(data.data || {}).map((p) => ({
        id: p.id,
        title: p.title || p.name || String(p.id),
        code: p.code || ''
      }));
      return json(res, 200, { success: true, data: list });
    }

    if (method === 'GET' && action === 'prices') {
      const country_id = url.searchParams.get('country_id');
      if (!country_id) return json(res, 400, { success: false, message: 'country_id required' });

      const [priceRes, projRes] = await Promise.all([
        smsbusGet(OTP_BASE, '/list/prices', { country_id: String(country_id) }),
        smsbusGet(OTP_BASE, '/list/projects')
      ]);
      if (!busOk(priceRes.data)) {
        return json(res, 400, { success: false, message: 'Unable to load services for this country. Try again or contact support.' });
      }

      // Map project_id → real service name (WhatsApp, Telegram, …)
      const nameById = {};
      const codeById = {};
      if (busOk(projRes.data)) {
        Object.values(projRes.data.data || {}).forEach((p) => {
          nameById[String(p.id)] = p.title || p.name || '';
          codeById[String(p.id)] = p.code || '';
        });
      }

      const live = Object.values(priceRes.data.data || {})
        .map((row) => {
          const pid = String(row.project_id);
          const costUsd = Number(row.cost || row.price || 0);
          const priceNgn = applyMarkup(costUsd);
          const title =
            nameById[pid] ||
            (row.title && !/united|russia|state|country/i.test(String(row.title)) ? row.title : '') ||
            codeById[pid] ||
            '';
          return {
            country_id: row.country_id,
            project_id: row.project_id,
            title: title || `Service ${pid}`,
            code: codeById[pid] || row.code || '',
            stock: Number(row.total_count || row.count || 0),
            // never expose supplier cost to clients
            price: priceNgn,
            price_ngn: priceNgn
          };
        })
        .filter((r) => r.project_id != null);

      // Overlay admin prices / hide flags from DB
      try {
        const { data: dbRows } = await supabase
          .from('number_services')
          .select('service_id, price, is_available')
          .eq('source', 'smsbus')
          .eq('country_id', String(country_id));
        const bySid = new Map((dbRows || []).map((r) => [String(r.service_id), r]));
        for (const item of live) {
          const db = bySid.get(String(item.project_id));
          if (!db) continue;
          if (db.is_available === false) item._hidden = true;
          if (Number(db.price) > 0) {
            item.price = Number(db.price);
            item.price_ngn = Number(db.price);
          }
        }
      } catch (_) {}

      const list = live
        .filter((r) => !r._hidden)
        .sort((a, b) => String(a.title).localeCompare(String(b.title)));

      return json(res, 200, { success: true, data: list });
    }

    // ——— OTP order / check / cancel / reuse ———
    if (method === 'POST' && action === 'order') {
      const auth = await requireAuth(req);
      if (!auth.ok) return json(res, auth.status, { success: false, message: auth.message });
      const body = await readBody(req);
      const country_id = body.country_id;
      const project_id = body.project_id;
      const wantReuse = body.reuse === true || body.reuse === 'true' || body.reuse === 1;
      if (!country_id || !project_id) {
        return json(res, 400, { success: false, message: 'country_id and project_id required' });
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('id, balance, customer_id, full_name')
        .eq('id', auth.userId)
        .single();
      if (!profile) return json(res, 400, { success: false, message: 'Profile not found' });

      // Price from live list
      const { data: priceData } = await smsbusGet(OTP_BASE, '/list/prices', {
        country_id: String(country_id)
      });
      let costUsd = 0;
      let serviceName = 'SMS';
      let countryName = '';
      if (busOk(priceData)) {
        const hit = Object.values(priceData.data || {}).find(
          (r) => String(r.project_id) === String(project_id)
        );
        if (hit) {
          costUsd = Number(hit.cost || 0);
          serviceName = hit.title || serviceName;
          countryName = hit.title || countryName;
        }
      }
      // Better names
      try {
        const [cRes, pRes] = await Promise.all([
          smsbusGet(OTP_BASE, '/list/countries'),
          smsbusGet(OTP_BASE, '/list/projects')
        ]);
        if (busOk(cRes.data)) {
          const c = Object.values(cRes.data.data || {}).find((x) => String(x.id) === String(country_id));
          if (c) countryName = c.title || countryName;
        }
        if (busOk(pRes.data)) {
          const p = Object.values(pRes.data.data || {}).find((x) => String(x.id) === String(project_id));
          if (p) serviceName = p.title || serviceName;
        }
      } catch (_) {}

      // Prefer admin-controlled selling price from DB (never reset by sync)
      let price = applyMarkup(costUsd || 0.5);
      try {
        const { data: dbSvc } = await supabase
          .from('number_services')
          .select('price, is_available')
          .eq('source', 'smsbus')
          .eq('country_id', String(country_id))
          .eq('service_id', String(project_id))
          .maybeSingle();
        if (dbSvc && dbSvc.is_available === false) {
          return json(res, 400, { success: false, message: 'This service is not available. Try another or contact support.' });
        }
        if (dbSvc && Number(dbSvc.price) > 0) price = Number(dbSvc.price);
      } catch (_) {}
      const bal = Number(profile.balance) || 0;
      if (bal < price) {
        return json(res, 400, {
          success: false,
          message: `Insufficient balance. Need ₦${price.toLocaleString()}, you have ₦${bal.toLocaleString()}`
        });
      }

      // Block purchase when supplier wallet cannot cover cost
      try {
        const { data: sBal } = await smsbusGet(OTP_BASE, '/get/balance');
        if (busOk(sBal)) {
          const supplierUsd = parseSupplierBalance(sBal.data);
          if (supplierUsd != null && costUsd > 0 && supplierUsd < costUsd) {
            return json(res, 503, {
              success: false,
              code: 'SERVER_BUSY',
              message: 'This SMS server is temporarily unavailable. Try the other server, or contact support.'
            });
          }
        }
      } catch (_) {}

      const originalBalance = bal;
      const newBalance = bal - price;
      await supabase.from('profiles').update({ balance: newBalance }).eq('id', auth.userId);

      const params = {
        country_id: String(country_id),
        project_id: String(project_id)
      };
      if (wantReuse) params.reuse = 'true';

      let bus;
      try {
        bus = await smsbusGet(OTP_BASE, '/get/number', params);
      } catch (e) {
        await supabase.from('profiles').update({ balance: originalBalance }).eq('id', auth.userId);
        return json(res, 502, { success: false, message: 'This SMS server is busy. Try again in a moment, or contact support.' });
      }

      if (!busOk(bus.data) || !bus.data?.data?.request_id) {
        await supabase.from('profiles').update({ balance: originalBalance }).eq('id', auth.userId);
        const code = bus.data?.code;
        const msg = String(bus.data?.message || '');
        if (code === 50201 || /balance not enough/i.test(msg)) {
          return json(res, 503, {
            success: false,
            code: 'SERVER_BUSY',
            message: 'This SMS server is temporarily unavailable. Try the other server, or contact support.'
          });
        }
        return json(res, 400, {
          success: false,
          message: 'No number available right now. Try another service or country, or contact support.'
        });
      }

      const requestId = String(bus.data.data.request_id);
      const phone = String(bus.data.data.number || '');

      const row = {
        source: 'smsbus',
        user_id: auth.userId,
        customer_id: profile.customer_id || null,
        order_id: requestId,
        country_id: Number(country_id) || null,
        country_name: countryName || String(country_id),
        service_id: String(project_id),
        service_name: serviceName,
        phone_number: phone,
        price,
        currency: 'NGN',
        status: 'waiting_for_code',
        code: null,
        refunded: false,
        // User checked "Prefer reusable number" at buy time
        is_reusable: !!wantReuse
      };

      const ins = await insertNumberOrder(row);
      if (ins.error) {
        console.error('[sms-bus order] insert failed after retries:', ins.error.message, {
          requestId,
          user_id: auth.userId,
          phone,
          columns: Object.keys(row)
        });
        // CRITICAL: supplier already issued a number. Do NOT cancel yet and do NOT
        // block the number page — return success so the client can open the waiting
        // screen. Persist a soft recovery row via raw SQL-like minimal retry once more.
        const emergency = {
          user_id: auth.userId,
          order_id: String(requestId),
          idempotency_key: `smsbus-${requestId}`,
          phone_number: phone || null,
          service_name: serviceName || 'SMS',
          country_name: countryName || null,
          price,
          status: 'waiting_for_code',
          source: 'smsbus',
          is_reusable: !!wantReuse
        };
        const { error: emErr } = await supabase.from('number_orders').insert(emergency);
        if (emErr) {
          console.error('[sms-bus order] emergency insert also failed:', emErr.message);
          // Still send user to number page with supplier ids — check API can use request_id
        }
        try {
          await supabase.from('transactions').insert({
            user_id: auth.userId,
            customer_id: profile.customer_id,
            type: 'purchase',
            category: 'MJ SMS',
            title: serviceName,
            subtitle: `OTP · ${phone || requestId}`,
            amount: `₦${price.toLocaleString()}`,
            amount_ngn: price,
            status: 'pending',
            notes: `order_id:${requestId}`
          });
        } catch (_) {}

        return json(res, 200, {
        success: true,
        data: {
            order_id: requestId,
            number: phone,
            phone_number: phone,
            price,
            new_balance: newBalance,
            service_name: serviceName,
            country_name: countryName,
            source: 'smsbus',
            status: 'waiting_for_code',
            warning: emErr
              ? 'Number ready. Open the waiting page to get your code.'
              : null
          }
        });
      }

      try {
        await supabase.from('transactions').insert({
          user_id: auth.userId,
          customer_id: profile.customer_id,
          type: 'purchase',
          category: 'MJ SMS',
          title: serviceName,
          subtitle: `OTP · ${phone || requestId}`,
          amount: `₦${price.toLocaleString()}`,
          amount_ngn: price,
          status: 'pending', // pending until SMS code arrives
          notes: `order_id:${requestId}`
        });
      } catch (_) {}

      return json(res, 200, {
        success: true,
        data: {
          order_id: requestId,
          number: phone,
          phone_number: phone,
          price,
          new_balance: newBalance,
          service_name: serviceName,
          country_name: countryName,
          source: 'smsbus',
          status: 'waiting_for_code'
        }
      });
    }

    if (method === 'POST' && action === 'check') {
      const auth = await requireAuth(req);
      if (!auth.ok) return json(res, auth.status, { success: false, message: auth.message });
      const body = await readBody(req);
      const order_id = String(body.order_id || '');
      if (!order_id) return json(res, 400, { success: false, message: 'order_id required' });

      let { data: order } = await supabase
        .from('number_orders')
        .select('*')
        .eq('order_id', order_id)
        .eq('user_id', auth.userId)
        .eq('source', 'smsbus')
        .maybeSingle();
      if (!order) {
        const r2 = await supabase
          .from('number_orders')
          .select('*')
          .eq('order_id', String(order_id))
          .eq('user_id', auth.userId)
          .maybeSingle();
        order = r2.data;
      }
      if (!order) {
        // supplier request_id may be stored differently
        const r3 = await supabase
          .from('number_orders')
          .select('*')
          .eq('user_id', auth.userId)
          .eq('source', 'smsbus')
          .order('created_at', { ascending: false })
          .limit(5);
        order = (r3.data || []).find((o) => String(o.order_id) === String(order_id)) || null;
      }

      if (!order) {
        // Order row may be missing (insert race) but supplier still has request_id —
        // poll supplier and still return a waiting payload so the number page works.
        const { data: live } = await smsbusGet(OTP_BASE, '/get/sms', { request_id: order_id });
        if (busOk(live) && live.data) {
          const code = String(live.data);
          // Best-effort save completed row
          try {
            await supabase.from('number_orders').insert({
              source: 'smsbus',
              user_id: auth.userId,
              order_id: order_id,
              idempotency_key: `smsbus-${order_id}`,
              status: 'completed',
              code,
              phone_number: null
            });
          } catch (_) {}
          return json(res, 200, {
        success: true,
        data: { status: 'completed', code, number: null, phone_number: null, order_id }
          });
        }
        return json(res, 200, {
        success: true,
        data: {
            status: 'waiting_for_code',
            code: null,
            message: 'Not received yet',
            number: null,
            phone_number: null,
            order_id,
            orphan: true
          }
        });
      }
      if (order.status === 'completed' && order.code) {
        return json(res, 200, {
        success: true,
        data: {
            status: 'completed',
            code: order.code,
            number: order.phone_number,
            phone_number: order.phone_number,
            service_name: order.service_name,
            country_name: order.country_name,
            price: order.price,
            created_at: order.created_at
          }
        });
      }
      if (order.status === 'refunded') {
        return json(res, 200, {
        success: true,
        data: {
            status: 'refunded',
            code: null,
            number: order.phone_number,
            message: 'Already refunded'
          }
        });
      }

      const { data } = await smsbusGet(OTP_BASE, '/get/sms', { request_id: order_id });
      if (busOk(data) && data.data) {
        const code = String(data.data);
        await supabase
          .from('number_orders')
          .update({ status: 'completed', code })
          .eq('id', order.id);
        await markTxStatus(auth.userId, order_id, order.phone_number, 'completed');
        return json(res, 200, {
        success: true,
        data: { status: 'completed', code, number: order.phone_number }
        });
      }
      const msg = data.message || '';
      if (/released|timeout|50102/i.test(msg) || data.code === 50102) {
        // Supplier released — refund once if still open
        const refundResult = await claimAndRefundSmsBusOrder(order, auth.userId, {
          subtitle: 'Expired — no SMS, balance restored'
        });
        if (refundResult.refunded) {
          return json(res, 200, {
        success: true,
        data: {
              status: 'refunded',
              code: null,
              message: 'Time expired — balance restored',
              refunded: true,
              new_balance: refundResult.new_balance
            }
          });
        }
        return json(res, 200, {
        success: true,
        data: { status: 'expired', code: null, message: msg } });
      }

      // Local 20-minute expiry (matches Server 1 UX)
      if (order.created_at) {
        const age = Date.now() - new Date(order.created_at).getTime();
        if (age >= SMSBUS_EXPIRY_MS) {
          try {
            await smsbusGet(OTP_BASE, '/cancel', { request_id: order_id });
          } catch (_) {}
          const refundResult = await claimAndRefundSmsBusOrder(order, auth.userId, {
            subtitle: 'Expired — no SMS, balance restored'
          });
          if (refundResult.refunded) {
            return json(res, 200, {
        success: true,
        data: {
                status: 'refunded',
                code: null,
                message: 'Time expired — balance restored',
                refunded: true,
                new_balance: refundResult.new_balance
              }
            });
          }
        }
      }

      return json(res, 200, {
        success: true,
        data: {
          status: 'waiting_for_code',
          code: null,
          message: msg || 'Not received yet',
          number: order.phone_number,
          phone_number: order.phone_number,
          service_name: order.service_name,
          country_name: order.country_name,
          price: order.price,
          created_at: order.created_at,
          time_left: order.created_at
            ? Math.max(0, Math.floor((SMSBUS_EXPIRY_MS - (Date.now() - new Date(order.created_at).getTime())) / 1000))
            : null
        }
      });
    }

    if (method === 'POST' && action === 'cancel') {
      const auth = await requireAuth(req);
      if (!auth.ok) return json(res, auth.status, { success: false, message: auth.message });
      const body = await readBody(req);
      const order_id = String(body.order_id || '');
      if (!order_id) return json(res, 400, { success: false, message: 'order_id required' });

      const { data: order } = await supabase
        .from('number_orders')
        .select('*')
        .eq('order_id', order_id)
        .eq('user_id', auth.userId)
        .eq('source', 'smsbus')
        .maybeSingle();
      if (!order) return json(res, 404, { success: false, message: 'Order not found' });
      if (order.status === 'completed' && order.code) {
        return json(res, 400, {
          success: false,
          code: 'CODE_ALREADY_RECEIVED',
          message: 'A code was already received — this order cannot be cancelled.'
        });
      }
      if (order.refunded || order.status === 'refunded') {
        return json(res, 200, { success: true, message: 'Already refunded', refunded: 0 });
      }

      // 1-minute cancel cooldown (above supplier 30s minimum)
      if (order.created_at) {
        const age = Date.now() - new Date(order.created_at).getTime();
        if (age < SMSBUS_CANCEL_COOLDOWN_MS) {
          const waitSec = Math.ceil((SMSBUS_CANCEL_COOLDOWN_MS - age) / 1000);
          return json(res, 400, {
            success: false,
            code: 'EARLY_CANCEL_DENIED',
            wait_seconds: waitSec,
            message: `Cancel available in ${waitSec}s. Please wait a moment.`
          });
        }
      }

      // Ask supplier first
      let cancelOk = false;
      let cancelMsg = '';
      try {
        const cancelRes = await smsbusGet(OTP_BASE, '/cancel', { request_id: order_id });
        cancelOk = busOk(cancelRes.data);
        cancelMsg = String(cancelRes.data?.message || cancelRes.data?.code || '');
        const code = cancelRes.data?.code;
        // Already closed / released — safe to refund if we never completed
        if (!cancelOk && (code === 50103 || /already closed|closed|timeout|released/i.test(cancelMsg))) {
          cancelOk = true;
          cancelMsg = cancelMsg || 'request closed';
        }
      } catch (e) {
        cancelMsg = 'Could not cancel right now';
      }

      if (!cancelOk) {
        // Last look: if SMS arrived, never refund
        try {
          const smsRes = await smsbusGet(OTP_BASE, '/get/sms', { request_id: order_id });
          if (busOk(smsRes.data) && smsRes.data.data) {
            const code = String(smsRes.data.data);
            await supabase.from('number_orders').update({ status: 'completed', code }).eq('id', order.id);
            return json(res, 400, {
              success: false,
              code: 'CODE_ALREADY_RECEIVED',
              message: 'A code was received — cancel is not available.'
            });
          }
        } catch (_) {}
        return json(res, 400, {
          success: false,
          message: 'Could not cancel right now. Wait for the timer, try again, or contact support.'
        });
      }

      const refundResult = await claimAndRefundSmsBusOrder(order, auth.userId, {
        subtitle: 'Cancelled — balance restored'
      });
      if (!refundResult.refunded && refundResult.reason === 'already_final') {
        return json(res, 200, { success: true, message: 'Already refunded', refunded: 0 });
      }
      if (!refundResult.refunded) {
        return json(res, 500, { success: false, message: 'Cancel was recorded but the refund failed. Please contact support.' });
      }
      return json(res, 200, {
        success: true,
        message: 'Cancelled and refunded',
        refunded: refundResult.amount,
        new_balance: refundResult.new_balance
      });
    }

    if (method === 'POST' && action === 'reuse') {
      // SMS-Bus: reuse same mobile for same country/project within ~20 min of a successful SMS.
      // GET /api/control/reuse?country_id&project_id&mobile_number
      const auth = await requireAuth(req);
      if (!auth.ok) return json(res, auth.status, { success: false, message: auth.message });
      const body = await readBody(req);
      const country_id = body.country_id;
      const project_id = body.project_id || body.service_id;
      let mobile_number = String(body.mobile_number || body.phone_number || '').replace(/\D/g, '');
      const countryNameHint = body.country_name || '';
      const serviceNameHint = body.service_name || '';
      if (!country_id || !project_id || !mobile_number) {
        return json(res, 400, {
          success: false,
          message: 'country, service and number are required to reuse'
        });
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('id, balance, customer_id')
        .eq('id', auth.userId)
        .single();
      if (!profile) return json(res, 400, { success: false, message: 'Profile not found' });

      // Selling price: prefer DB catalog, else supplier + markup (same as order)
      let costUsd = 0.3;
      let serviceName = serviceNameHint || 'SMS';
      let countryName = countryNameHint || String(country_id);
      let price = 0;
      try {
        const { data: dbSvc } = await supabase
          .from('number_services')
          .select('price, supplier_price, service_name, country_name')
          .eq('source', 'smsbus')
          .eq('country_id', String(country_id))
          .eq('service_id', String(project_id))
          .maybeSingle();
        if (dbSvc && Number(dbSvc.price) > 0) {
          price = Number(dbSvc.price);
          costUsd = Number(dbSvc.supplier_price) || costUsd;
          serviceName = dbSvc.service_name || serviceName;
          countryName = dbSvc.country_name || countryName;
        }
      } catch (_) {}
      if (!(price > 0)) {
        try {
          const { data: priceData } = await smsbusGet(OTP_BASE, '/list/prices', {
            country_id: String(country_id)
          });
          if (busOk(priceData)) {
            const hit = Object.values(priceData.data || {}).find(
              (r) => String(r.project_id) === String(project_id)
            );
            if (hit) {
              costUsd = Number(hit.cost || costUsd);
              serviceName = hit.title || serviceName;
              price = applyMarkup(costUsd);
            }
          }
        } catch (_) {}
      }
      if (!(price > 0)) price = applyMarkup(costUsd);

      const bal = Number(profile.balance) || 0;
      if (bal < price) {
        return json(res, 400, {
          success: false,
          message: `Need ₦${price.toLocaleString()} to reuse this number`,
          required: price,
          available: bal
        });
      }

      const originalBalance = bal;
      const newBalance = bal - price;
      await supabase.from('profiles').update({ balance: newBalance }).eq('id', auth.userId);

      let bus;
      try {
        bus = await smsbusGet(OTP_BASE, '/reuse', {
          country_id: String(country_id),
          project_id: String(project_id),
          mobile_number
        });
      } catch (e) {
        await supabase.from('profiles').update({ balance: originalBalance }).eq('id', auth.userId);
        return json(res, 502, { success: false, message: 'Could not reach the SMS server. Try again or contact support.' });
      }

      if (!busOk(bus.data) || !bus.data?.data?.request_id) {
        await supabase.from('profiles').update({ balance: originalBalance }).eq('id', auth.userId);
        const code = bus.data?.code;
        const msg = String(bus.data?.message || '');
        if (code === 50109 || /expired/i.test(msg)) {
          return json(res, 400, {
            success: false,
            message: 'Reuse window ended. Buy a new number, or contact support if you need help.'
          });
        }
        if (code === 50107 || code === 50108 || /cannot be reused/i.test(msg)) {
          return json(res, 400, {
            success: false,
            message: 'This number cannot be reused right now. Contact support if you need help.'
          });
        }
        return json(res, 400, {
          success: false,
          message: 'This number cannot be reused right now. Try a new number or contact support.'
        });
      }

      const dNum = bus.data.data || {};
      const requestId = String(dNum.request_id || '');
      const phone = String(dNum.number || dNum.phone || mobile_number).replace(/\D/g, '') || mobile_number;

      const row = {
        source: 'smsbus',
        user_id: auth.userId,
        customer_id: profile.customer_id != null ? String(profile.customer_id) : null,
        order_id: requestId,
        country_id: String(country_id),
        country_name: countryName,
        service_id: String(project_id),
        service_name: serviceName,
        phone_number: phone,
        price,
        currency: 'NGN',
        status: 'waiting_for_code',
        code: null,
        refunded: false,
        is_reusable: true
      };
      let { error: insertErr } = await supabase.from('number_orders').insert(row);
      if (insertErr) {
        const slim = {
          source: 'smsbus',
          user_id: auth.userId,
          order_id: requestId,
          phone_number: phone,
          service_name: serviceName,
          country_name: countryName,
          service_id: String(project_id),
          country_id: String(country_id),
          price,
          status: 'waiting_for_code'
        };
        ({ error: insertErr } = await supabase.from('number_orders').insert(slim));
      }
      if (insertErr) {
        console.error('[sms-bus reuse] insert failed', insertErr.message);
      }

      try {
        await supabase.from('transactions').insert({
          user_id: auth.userId,
          customer_id: profile.customer_id,
          type: 'purchase',
          category: 'MJ SMS',
          title: serviceName,
          subtitle: `${countryName} · reuse · waiting for SMS`,
          amount: `₦${price.toLocaleString()}`,
          amount_ngn: price,
          status: 'pending',
          notes: `order_id:${requestId}`
        });
      } catch (_) {}

      return json(res, 200, {
        success: true,
        message: 'Number reused successfully',
        data: {
          order_id: requestId,
          number: phone,
          phone_number: phone,
          price,
          new_balance: newBalance,
          service_name: serviceName,
          country_name: countryName,
          source: 'smsbus',
          status: 'waiting_for_code',
          created_at: new Date().toISOString()
        }
      });
    }

    // ——— Rentals ———
    if (method === 'GET' && action === 'rent_areas') {
      const auth = await requireAuth(req);
      if (!auth.ok) return json(res, auth.status, { success: false, message: auth.message });
      const { data } = await smsbusGet(RENT_BASE, '/v1/rent/list/area');
      if (!busOk(data)) {
        return json(res, 400, { success: false, message: 'Unable to load rental areas. Try again or contact support.' });
      }
      const raw = data.data;
      const list = Array.isArray(raw) ? raw : Object.values(raw || {});
      // unit_price is monthly price in cents (API docs)
      const normalized = list.map((a) => {
        const unitCents = Number(a.unit_price || 0);
        const unitUsd = unitCents / 100;
        const minMonth = Number(a.min_month || 1);
        return {
          area_code: a.area_code,
          title: a.area_title || a.area_name || a.area_code,
          unit_usd: unitUsd,
          min_month: minMonth,
          stock: Number(a.total || 0),
          // customer price for 1 month (marked up NGN)
          price_1mo: applyMarkup(unitUsd)
        };
      });
      return json(res, 200, { success: true, data: normalized });
    }

    if (method === 'GET' && action === 'rent_prices') {
      const auth = await requireAuth(req);
      if (!auth.ok) return json(res, auth.status, { success: false, message: auth.message });
      const area_code = url.searchParams.get('area_code');
      if (!area_code) return json(res, 400, { success: false, message: 'area_code required' });
      // Try common path — docs vary; attempt list
      const { data } = await smsbusGet(RENT_BASE, '/v1/rent/list/area');
      return json(res, 200, { success: true, data: data.data, area_code });
    }

    if (method === 'POST' && action === 'rent_order') {
      const auth = await requireAuth(req);
      if (!auth.ok) return json(res, auth.status, { success: false, message: auth.message });
      const body = await readBody(req);
      const area_code = String(body.area_code || '').toUpperCase();
      const time = Number(body.time || 1); // months
      if (!area_code || !time) {
        return json(res, 400, { success: false, message: 'area_code and time (months) required' });
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('id, balance, customer_id')
        .eq('id', auth.userId)
        .single();
      if (!profile) return json(res, 400, { success: false, message: 'Profile not found' });

      // Live monthly unit from area list (cents → USD × months)
      let unitUsd = Number(body.quoted_usd || 0);
      if (!unitUsd) {
        try {
          const areasRes = await smsbusGet(RENT_BASE, '/v1/rent/list/area');
          if (busOk(areasRes.data)) {
            const list = Array.isArray(areasRes.data.data)
              ? areasRes.data.data
              : Object.values(areasRes.data.data || {});
            const hit = list.find((a) => String(a.area_code).toUpperCase() === area_code);
            if (hit) unitUsd = Number(hit.unit_price || 0) / 100;
          }
        } catch (_) {}
      }
      if (!unitUsd) unitUsd = 3.5;
      const supplierUsd = unitUsd * time;
      const price = applyMarkup(supplierUsd);
      const bal = Number(profile.balance) || 0;
      if (bal < price) {
        return json(res, 400, {
          success: false,
          message: `Insufficient balance. Need ₦${price.toLocaleString()}`
        });
      }

      const originalBalance = bal;
      await supabase.from('profiles').update({ balance: bal - price }).eq('id', auth.userId);

      const bus = await smsbusGet(RENT_BASE, '/v1/rent/get/number', {
        area_code,
        time: String(time)
      });

      if (!busOk(bus.data) || !bus.data?.data) {
        await supabase.from('profiles').update({ balance: originalBalance }).eq('id', auth.userId);
        return json(res, 400, {
          success: false,
          message: 'Rental is unavailable for this area right now. Contact support if you need help.'
        });
      }

      const d = bus.data.data;
      const orderId = String(d.order_id || d.id || `RENT-${Date.now()}`);
      const phone = String(d.mobile_number || d.number || '');
      const dial = String(d.dialing_code || '');
      const fullPhone = dial && phone && !phone.startsWith(dial) ? `${dial}${phone}` : phone;

      await supabase.from('number_orders').insert({
        source: 'smsbus_rent',
        user_id: auth.userId,
        customer_id: profile.customer_id,
        order_id: orderId,
        idempotency_key: `smsbus_rent-${orderId}`,
        country_id: null,
        country_name: d.area_code || area_code,
        service_id: 'rent',
        service_name: `Rental ${time} mo · ${area_code}`,
        phone_number: fullPhone || phone,
        price,
        supplier_price: supplierUsd,
        currency: 'NGN',
        status: 'completed',
        code: d.expire_at || d.keep_at || null,
        refunded: false
      });

      try {
        await supabase.from('transactions').insert({
          user_id: auth.userId,
          customer_id: profile.customer_id,
          type: 'purchase',
          category: 'MJ SMS',
          title: `Number rental ${area_code}`,
          subtitle: `${fullPhone || phone} · ${time} month(s)`,
          amount: `₦${price.toLocaleString()}`,
          amount_ngn: price,
          status: 'completed'
        });
      } catch (_) {}

      return json(res, 200, {
        success: true,
        data: {
          order_id: orderId,
          number: fullPhone || phone,
          area_code: d.area_code || area_code,
          expire_at: d.expire_at,
          keep_at: d.keep_at,
          price,
          new_balance: bal - price,
          source: 'smsbus_rent'
        }
      });
    }

    if (method === 'POST' && action === 'rent_renew') {
      const auth = await requireAuth(req);
      if (!auth.ok) return json(res, auth.status, { success: false, message: auth.message });
      const body = await readBody(req);
      const area_code = String(body.area_code || '').toUpperCase();
      const mobile_number = String(body.mobile_number || '').replace(/\D/g, '');
      const time = Number(body.time || 1);
      if (!area_code || !mobile_number) {
        return json(res, 400, { success: false, message: 'area_code and mobile_number required' });
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('balance, customer_id')
        .eq('id', auth.userId)
        .single();
      const supplierUsd = Number(body.quoted_usd || 3.5) * time;
      const price = applyMarkup(supplierUsd);
      const bal = Number(profile?.balance) || 0;
      if (bal < price) return json(res, 400, { success: false, message: 'Insufficient balance' });

      await supabase.from('profiles').update({ balance: bal - price }).eq('id', auth.userId);
      const bus = await smsbusGet(RENT_BASE, '/v1/rent/renew/number', {
        area_code,
        mobile_number,
        time: String(time)
      });
      if (!busOk(bus.data)) {
        await supabase.from('profiles').update({ balance: bal }).eq('id', auth.userId);
        return json(res, 400, { success: false, message: 'Renew failed. Try again later or contact support.' });
      }
      return json(res, 200, { success: true, data: bus.data.data, price });
    }

    
    if ((method === 'GET' || method === 'POST') && action === 'sync') {
      const cronSecret = process.env.CRON_SECRET;
      const authHeader = req.headers.authorization || '';
      const isCron =
        (cronSecret && authHeader === `Bearer ${cronSecret}`) ||
        req.headers['x-vercel-cron'] === '1';
      if (!isCron) {
        const auth = await requireAuth(req);
        if (!auth.ok) return json(res, auth.status, { success: false, message: auth.message });
        const { data: prof } = await supabase.from('profiles').select('is_admin').eq('id', auth.userId).maybeSingle();
        if (!prof?.is_admin) {
          return json(res, 403, { success: false, message: 'Admin only' });
        }
      }
      const [bal, areas] = await Promise.all([
        smsbusGet(OTP_BASE, '/get/balance'),
        smsbusGet(RENT_BASE, '/v1/rent/list/area')
      ]);
      let areaCount = 0;
      if (busOk(areas.data)) {
        const d = areas.data.data;
        areaCount = Array.isArray(d) ? d.length : Object.keys(d || {}).length;
      }
      let catalog = { newCount: 0, updatedCount: 0, errors: 0, countries: 0 };
      try {
        catalog = await syncSmsBusCatalog();
      } catch (e) {
        console.error('[smsbus] catalog sync failed', e);
        return json(res, 500, { success: false, message: e.message || 'Catalog sync failed' });
      }
      return json(res, 200, {
        success: true,
        data: {
          balance: busOk(bal.data) ? bal.data.data : null,
          countries: catalog.countries,
          projects: catalog.newCount + catalog.updatedCount,
          new_products: catalog.newCount,
          updated_products: catalog.updatedCount,
          errors: catalog.errors,
          rent_areas: areaCount,
          synced_at: new Date().toISOString(),
          saved_to_db: true
        }
      });
    }

    return json(res, 400, {
      success: false,
      message: `Unknown action: ${action}`,
      actions: [
        'balance',
        'countries',
        'projects',
        'prices',
        'order',
        'check',
        'cancel',
        'reuse',
        'rent_areas',
        'rent_prices',
        'rent_order',
        'rent_renew',
        'sync'
      ]
    });
  } catch (err) {
    console.error('sms-bus error', err);
    return json(res, 500, { success: false, message: err.message || 'Server error' });
  }
}
