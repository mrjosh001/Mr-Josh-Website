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

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const action = (url.searchParams.get('action') || '').toLowerCase();
    const method = (req.method || 'GET').toUpperCase();

    if (!TOKEN) {
      return json(res, 503, {
        success: false,
        message: 'This server is temporarily unavailable'
      });
    }

    // ——— Public-ish catalog (still require auth so only customers hit supplier) ———
    if (method === 'GET' && action === 'balance') {
      const auth = await requireAuth(req);
      if (!auth.ok) return json(res, auth.status, { success: false, message: auth.message });
      const { data } = await smsbusGet(OTP_BASE, '/get/balance');
      if (!busOk(data)) return json(res, 400, { success: false, message: 'Unable to load balance' });
      return json(res, 200, { success: true, data: data.data });
    }

    if (method === 'GET' && action === 'countries') {
      const auth = await requireAuth(req);
      if (!auth.ok) return json(res, auth.status, { success: false, message: auth.message });
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
      const auth = await requireAuth(req);
      if (!auth.ok) return json(res, auth.status, { success: false, message: auth.message });
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
      const auth = await requireAuth(req);
      if (!auth.ok) return json(res, auth.status, { success: false, message: auth.message });
      const country_id = url.searchParams.get('country_id');
      if (!country_id) return json(res, 400, { success: false, message: 'country_id required' });

      const [priceRes, projRes] = await Promise.all([
        smsbusGet(OTP_BASE, '/list/prices', { country_id: String(country_id) }),
        smsbusGet(OTP_BASE, '/list/projects')
      ]);
      if (!busOk(priceRes.data)) {
        return json(res, 400, { success: false, message: 'Unable to load services for this country' });
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

      const list = Object.values(priceRes.data.data || {})
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
            supplier_usd: costUsd,
            price: priceNgn,
            price_ngn: priceNgn
          };
        })
        .filter((r) => r.project_id != null)
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

      const price = applyMarkup(costUsd || 0.5);
      const bal = Number(profile.balance) || 0;
      if (bal < price) {
        return json(res, 400, {
          success: false,
          message: `Insufficient balance. Need ₦${price.toLocaleString()}, you have ₦${bal.toLocaleString()}`
        });
      }

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
        return json(res, 502, { success: false, message: e.message || 'Supplier error' });
      }

      if (!busOk(bus.data) || !bus.data?.data?.request_id) {
        await supabase.from('profiles').update({ balance: originalBalance }).eq('id', auth.userId);
        return json(res, 400, {
          success: false,
          message: 'No number available right now. Try another service or country.'
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
        supplier_price: costUsd,
        currency: 'NGN',
        status: 'waiting_for_code',
        code: null,
        refunded: false
      };

      const { error: insErr } = await supabase.from('number_orders').insert(row);
      if (insErr) console.error('[sms-bus order] insert', insErr.message);

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
          status: 'completed'
        });
      } catch (_) {}

      return json(res, 200, {
        success: true,
        data: {
          order_id: requestId,
          number: phone,
          price,
          new_balance: newBalance,
          service_name: serviceName,
          country_name: countryName,
          source: 'smsbus'
        }
      });
    }

    if (method === 'POST' && action === 'check') {
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
        return json(res, 200, { success: true, data: { status: 'completed', code: order.code, number: order.phone_number } });
      }
      if (order.status === 'refunded') {
        return json(res, 200, { success: true, data: { status: 'refunded', code: null } });
      }

      const { data } = await smsbusGet(OTP_BASE, '/get/sms', { request_id: order_id });
      if (busOk(data) && data.data) {
        const code = String(data.data);
        await supabase
          .from('number_orders')
          .update({ status: 'completed', code })
          .eq('id', order.id);
        return json(res, 200, {
          success: true,
          data: { status: 'completed', code, number: order.phone_number }
        });
      }
      const msg = data.message || '';
      if (/released|timeout|50102/i.test(msg) || data.code === 50102) {
        return json(res, 200, { success: true, data: { status: 'expired', code: null, message: msg } });
      }
      return json(res, 200, {
        success: true,
        data: { status: 'waiting_for_code', code: null, message: msg || 'Not received yet' }
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
      if (order.status === 'completed') {
        return json(res, 400, { success: false, message: 'Already completed — cannot cancel' });
      }
      if (order.refunded || order.status === 'refunded') {
        return json(res, 200, { success: true, message: 'Already refunded' });
      }

      await smsbusGet(OTP_BASE, '/cancel', { request_id: order_id });

      const refund = Number(order.price) || 0;
      const { data: profile } = await supabase.from('profiles').select('balance').eq('id', auth.userId).single();
      const bal = Number(profile?.balance) || 0;
      await supabase.from('profiles').update({ balance: bal + refund }).eq('id', auth.userId);
      await supabase
        .from('number_orders')
        .update({ status: 'refunded', refunded: true })
        .eq('id', order.id);

      try {
        await supabase.from('transactions').insert({
          user_id: auth.userId,
          customer_id: order.customer_id,
          type: 'refund',
          category: 'MJ SMS',
          title: 'SMS cancel refund',
          subtitle: order.phone_number || order_id,
          amount: `₦${refund.toLocaleString()}`,
          amount_ngn: refund,
          status: 'refunded'
        });
      } catch (_) {}

      return json(res, 200, { success: true, message: 'Cancelled and refunded', refunded: refund });
    }

    if (method === 'POST' && action === 'reuse') {
      const auth = await requireAuth(req);
      if (!auth.ok) return json(res, auth.status, { success: false, message: auth.message });
      const body = await readBody(req);
      const country_id = body.country_id;
      const project_id = body.project_id;
      const mobile_number = String(body.mobile_number || body.phone_number || '').replace(/\D/g, '');
      if (!country_id || !project_id || !mobile_number) {
        return json(res, 400, {
          success: false,
          message: 'country_id, project_id and mobile_number required'
        });
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('id, balance, customer_id')
        .eq('id', auth.userId)
        .single();
      if (!profile) return json(res, 400, { success: false, message: 'Profile not found' });

      const { data: priceData } = await smsbusGet(OTP_BASE, '/list/prices', {
        country_id: String(country_id)
      });
      let costUsd = 0.3;
      let serviceName = 'SMS reuse';
      if (busOk(priceData)) {
        const hit = Object.values(priceData.data || {}).find(
          (r) => String(r.project_id) === String(project_id)
        );
        if (hit) {
          costUsd = Number(hit.cost || costUsd);
          serviceName = (hit.title || serviceName) + ' (reuse)';
        }
      }
      const price = applyMarkup(costUsd);
      const bal = Number(profile.balance) || 0;
      if (bal < price) {
        return json(res, 400, { success: false, message: `Need ₦${price.toLocaleString()} to reuse` });
      }

      const originalBalance = bal;
      await supabase.from('profiles').update({ balance: bal - price }).eq('id', auth.userId);

      const bus = await smsbusGet(OTP_BASE, '/reuse', {
        country_id: String(country_id),
        project_id: String(project_id),
        mobile_number
      });

      if (!busOk(bus.data) || !bus.data?.data?.request_id) {
        await supabase.from('profiles').update({ balance: originalBalance }).eq('id', auth.userId);
        return json(res, 400, {
          success: false,
          message:
            'This number cannot be reused right now. Try a new number.'
        });
      }

      const requestId = String(bus.data.data.request_id);
      const phone = String(bus.data.data.number || mobile_number);

      await supabase.from('number_orders').insert({
        source: 'smsbus',
        user_id: auth.userId,
        customer_id: profile.customer_id,
        order_id: requestId,
        country_id: Number(country_id) || null,
        country_name: String(country_id),
        service_id: String(project_id),
        service_name: serviceName,
        phone_number: phone,
        price,
        supplier_price: costUsd,
        currency: 'NGN',
        status: 'waiting_for_code',
        code: null,
        refunded: false
      });

      return json(res, 200, {
        success: true,
        data: {
          order_id: requestId,
          number: phone,
          price,
          new_balance: bal - price,
          message: 'Reuse started — wait for the new code'
        }
      });
    }

    // ——— Rentals ———
    if (method === 'GET' && action === 'rent_areas') {
      const auth = await requireAuth(req);
      if (!auth.ok) return json(res, auth.status, { success: false, message: auth.message });
      const { data } = await smsbusGet(RENT_BASE, '/v1/rent/list/area');
      if (!busOk(data)) {
        return json(res, 400, { success: false, message: 'Unable to load rental areas' });
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
          message: 'Rental unavailable for this area right now'
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
        return json(res, 400, { success: false, message: 'Renew failed. Try again later.' });
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
      const [bal, countries, projects, areas] = await Promise.all([
        smsbusGet(OTP_BASE, '/get/balance'),
        smsbusGet(OTP_BASE, '/list/countries'),
        smsbusGet(OTP_BASE, '/list/projects'),
        smsbusGet(RENT_BASE, '/v1/rent/list/area')
      ]);
      const countryCount = busOk(countries.data) ? Object.keys(countries.data.data || {}).length : 0;
      const projectCount = busOk(projects.data) ? Object.keys(projects.data.data || {}).length : 0;
      let areaCount = 0;
      if (busOk(areas.data)) {
        const d = areas.data.data;
        areaCount = Array.isArray(d) ? d.length : Object.keys(d || {}).length;
      }
      return json(res, 200, {
        success: true,
        data: {
          balance: busOk(bal.data) ? bal.data.data : null,
          countries: countryCount,
          projects: projectCount,
          rent_areas: areaCount,
          synced_at: new Date().toISOString()
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
