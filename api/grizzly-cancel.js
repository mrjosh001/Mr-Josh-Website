import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/grizzly-cancel
 * Cancels a GrizzlySMS number order (setStatus, status=8) when no code has
 * arrived yet. Per GrizzlySMS's own policy: if no code reached the number,
 * balance is refunded — that refund lands on OUR reseller balance with
 * them, not the customer's Supabase wallet, so this endpoint credits the
 * customer's wallet itself on confirmed cancellation.
 *
 * Body: { order_id, user_id }
 * Env: GRIZZLYSMS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BASE = 'https://api.grizzlysms.com/stubs/handler_api.php';
const GRIZZLY_KEY = process.env.GRIZZLYSMS_API_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { order_id, user_id } = body;

  if (!order_id || !user_id) {
    return res.status(400).json({ success: false, message: 'order_id and user_id are required' });
  }
  if (!GRIZZLY_KEY) {
    return res.status(500).json({ success: false, message: 'GRIZZLYSMS_API_KEY not configured' });
  }

  try {
    const { data: order, error: findErr } = await supabase
      .from('number_orders')
      .select('id, customer_id, price, status, refunded, service_name')
      .eq('source', 'grizzlysms')
      .eq('order_id', String(order_id))
      .eq('user_id', user_id)
      .single();

    if (findErr || !order) {
      return res.status(404).json({ success: false, message: 'Order not found for this account' });
    }
    if (order.refunded || order.status === 'refunded') {
      return res.status(409).json({ success: false, message: 'This order was already refunded.' });
    }
    if (order.status === 'completed') {
      return res.status(409).json({
        success: false,
        code: 'NUMBER_CODE_ALREADY_RECEIVED',
        message: 'A code was already received — this order cannot be cancelled once a code has arrived.'
      });
    }

    const qs = new URLSearchParams({ api_key: GRIZZLY_KEY, action: 'setStatus', id: String(order_id), status: '8' });
    const supplierRes = await fetch(`${BASE}?${qs.toString()}`, { method: 'GET' });
    const raw = (await supplierRes.text()).trim();

    // Expected: ACCESS_CANCEL on success. NO_ACTIVATION / BAD_ACTION /
    // BAD_STATUS / ERROR_SQL are documented failure responses.
    if (raw !== 'ACCESS_CANCEL') {
      await supabase.from('number_orders').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', order.id);
      return res.status(400).json({
        success: false,
        code: raw,
        message: raw === 'NO_ACTIVATION'
          ? 'Supplier has no record of this order.'
          : `Could not cancel this order (${raw}).`
      });
    }

    // Confirmed cancel → credit customer's own wallet.
    const { data: profile, error: profErr } = await supabase.from('profiles').select('balance').eq('id', user_id).single();
    if (!profErr && profile) {
      const restored = Number(profile.balance || 0) + Number(order.price || 0);
      await supabase.from('profiles').update({ balance: restored }).eq('id', user_id);
    }

    await supabase
      .from('number_orders')
      .update({ status: 'refunded', refunded: true, updated_at: new Date().toISOString() })
      .eq('id', order.id);

    await supabase.from('transactions').insert({
      user_id,
      customer_id: order.customer_id,
      type: 'refund',
      category: 'MJ SMS',
      title: 'Number Cancelled & Refunded',
      subtitle: `${order.service_name || 'Number order'} · MJ SMS`,
      amount: `₦${Number(order.price || 0).toLocaleString()}`,
      amount_ngn: Number(order.price || 0),
      status: 'refunded'
    });

    return res.status(200).json({ success: true, data: { order_id, status: 'refunded', refunded: true } });
  } catch (err) {
    console.error('grizzly-cancel error:', err);
    return res.status(500).json({ success: false, message: 'Something went wrong cancelling this order.' });
  }
}
