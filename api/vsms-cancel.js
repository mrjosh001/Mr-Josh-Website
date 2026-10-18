import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const VS_REST = 'https://virtualsms.io/api/v1';
const VS_KEY = String(process.env.VIRTUALSMS_API_KEY || process.env.VIRTUAL_SMS_API_KEY || '').trim();
const CANCEL_COOLDOWN_MS = 120000;

function send(res, status, body) { res.status(status).json(body); }

async function requireUser(req) {
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Bearer ')) return null;
  const token = h.slice(7).trim();
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  return error || !user ? null : user;
}

async function supplier(path, options = {}) {
  const headers = {
    Authorization: `Bearer ${VS_KEY}`,
    'X-API-Key': VS_KEY,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 20000);
  try {
    const response = await fetch(`${VS_REST}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) {}
    return { ok: response.ok, status: response.status, json, text };
  } finally { clearTimeout(timer); }
}

function supplierState(j) {
  const root = j && typeof j === 'object' ? j : {};
  const order = root.order && typeof root.order === 'object' ? root.order : root;
  return {
    status: String(order.status || root.status || '').toLowerCase(),
    code: order.code || root.code || order.sms_code || root.sms_code || null
  };
}

function supplierConfirmsAlreadyCancelled(result) {
  const text = String(result.text || '').toLowerCase();
  const state = supplierState(result.json);
  return /already\s*(cancelled|canceled)|cancelled|canceled|expired|order[_ -]?not[_ -]?found/.test(text)
    || ['cancelled', 'canceled', 'expired', 'refunded'].includes(state.status);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { success: false, message: 'Method not allowed' });
  if (!VS_KEY) return send(res, 500, { success: false, message: 'VirtualSMS is not configured.' });

  const user = await requireUser(req);
  if (!user) return send(res, 401, { success: false, message: 'Your session has expired. Please sign in again.' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const orderId = String(body.order_id || '').trim();
  if (!orderId) return send(res, 400, { success: false, message: 'order_id is required' });

  try {
    const { data: order, error } = await supabase.from('number_orders').select('*')
      .eq('id', orderId).eq('user_id', user.id).eq('source', 'virtualsms').maybeSingle();
    if (error || !order) return send(res, 404, { success: false, message: 'Order not found for this account.' });

    const localStatus = String(order.status || '').toLowerCase();
    if (localStatus === 'completed') return send(res, 409, { success: false, code: 'NUMBER_CODE_ALREADY_RECEIVED', message: 'A code was already received. This order cannot be cancelled.' });
    if (order.refunded || ['refunded', 'expired', 'cancelled', 'canceled'].includes(localStatus)) return send(res, 409, { success: false, code: 'ALREADY_REFUNDED', message: 'This order has already been refunded.' });

    const age = order.created_at ? Date.now() - new Date(order.created_at).getTime() : CANCEL_COOLDOWN_MS;
    if (age < CANCEL_COOLDOWN_MS) {
      const wait = Math.ceil((CANCEL_COOLDOWN_MS - age) / 1000);
      return send(res, 400, { success: false, code: 'EARLY_CANCEL_DENIED', wait_seconds: wait, message: `Cancel available in ${wait}s. Please wait a moment.` });
    }

    const live = await supplier(`/customer/order/${encodeURIComponent(order.order_id)}`);
    if (live.ok) {
      const state = supplierState(live.json);
      if (state.code || ['completed', 'received'].includes(state.status)) {
        return send(res, 409, { success: false, code: 'NUMBER_CODE_ALREADY_RECEIVED', message: 'A code was already received. This order cannot be cancelled.' });
      }
    } else if (!supplierConfirmsAlreadyCancelled(live)) {
      return send(res, 502, { success: false, message: 'Could not verify the supplier order. No refund was issued.' });
    }

    const cancelled = await supplier(`/customer/cancel/${encodeURIComponent(order.order_id)}`, { method: 'POST' });
    if (!cancelled.ok && !supplierConfirmsAlreadyCancelled(cancelled)) {
      return send(res, 502, { success: false, code: 'CANCEL_FAILED', message: 'The supplier did not confirm cancellation. Your balance was not changed.' });
    }

    const { data: refund, error: refundError } = await supabase.rpc('refund_number_order_once', {
      p_order_id: order.id,
      p_user_id: user.id,
      p_status: 'refunded',
      p_subtitle: 'Cancelled — balance restored'
    });
    if (refundError) {
      console.error('[vsms-cancel] refund RPC failed', refundError);
      return send(res, 500, { success: false, code: 'REFUND_COMMIT_FAILED', message: 'The supplier cancelled the order, but the wallet refund could not be committed. Please contact support with order ' + order.order_id + '.' });
    }

    const result = Array.isArray(refund) ? refund[0] : refund;
    if (!result?.ok) {
      if (result?.reason === 'already_final') return send(res, 409, { success: false, code: 'ALREADY_REFUNDED', message: 'This order has already been refunded.' });
      console.error('[vsms-cancel] refund guard rejected', result);
      return send(res, 409, { success: false, code: 'REFUND_GUARD_BLOCKED', message: 'Cancellation was confirmed, but the wallet refund guard did not find the matching purchase debit. No extra balance was created. Please contact support with order ' + order.order_id + '.' });
    }

    return send(res, 200, { success: true, data: {
      order_id: order.order_id, status: 'refunded', refunded: true,
      refunded_amount: Number(result.refunded_amount || order.price || 0),
      new_balance: Number(result.new_balance || 0)
    }});
  } catch (err) {
    console.error('[vsms-cancel] error', err);
    return send(res, 500, { success: false, message: 'Something went wrong cancelling this order. No wallet credit was issued unless the refund guard completed successfully.' });
  }
}
