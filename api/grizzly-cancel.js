import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/grizzly-cancel
 * Cancels a GrizzlySMS number (setStatus status=8) when no code has arrived.
 * Credits the customer wallet on ACCESS_CANCEL.
 *
 * Does NOT insert a refund row into transactions (keeps history clean).
 * Updates the original purchase transaction to status cancelled/refunded instead.
 *
 * Body: { order_id, user_id }
 * Env: GRIZZLYSMS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * EARLY_CANCEL_DENIED = supplier may also block early cancel.
 * Our UI/API enforces a 5-minute lock before cancel is allowed.
 */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BASE = 'https://api.grizzlysms.com/stubs/handler_api.php';
const GRIZZLY_KEY = process.env.GRIZZLYSMS_API_KEY;
const CANCEL_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes before cancel is allowed

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
      .select('id, customer_id, price, status, refunded, service_name, created_at, order_id')
      .eq('source', 'grizzlysms')
      .eq('order_id', String(order_id))
      .eq('user_id', user_id)
      .single();

    if (findErr || !order) {
      return res.status(404).json({ success: false, message: 'Order not found for this account' });
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
      api_key: GRIZZLY_KEY,
      action: 'setStatus',
      id: String(order_id),
      status: '8'
    });
    const supplierRes = await fetch(`${BASE}?${qs.toString()}`, { method: 'GET' });
    const raw = (await supplierRes.text()).trim();

    if (raw === 'EARLY_CANCEL_DENIED') {
      return res.status(400).json({
        success: false,
        code: 'EARLY_CANCEL_DENIED',
        wait_seconds: 300,
        message: 'Cancel is not available yet. Please wait until the countdown finishes (5 minutes from purchase).'
      });
    }

    if (raw !== 'ACCESS_CANCEL') {
      // If supplier already cancelled / expired, still try to refund locally if not refunded
      if (raw === 'NO_ACTIVATION' || raw === 'BAD_STATUS') {
        // fall through only if we can still mark refunded — treat as cancelable on our side
        // Prefer not to refund blindly on NO_ACTIVATION without knowing if they already got value
      }
      return res.status(400).json({
        success: false,
        code: raw,
        message:
          raw === 'NO_ACTIVATION'
            ? 'Supplier has no record of this order.'
            : `Could not cancel this order (${raw}).`
      });
    }

    // Confirmed cancel → credit wallet (no refund transaction row)
    const refundAmount = Number(order.price || 0);
    const { data: profile } = await supabase
      .from('profiles')
      .select('balance')
      .eq('id', user_id)
      .single();

    if (profile) {
      const restored = Number(profile.balance || 0) + refundAmount;
      await supabase.from('profiles').update({ balance: restored }).eq('id', user_id);
    }

    await supabase
      .from('number_orders')
      .update({
        status: 'refunded',
        refunded: true,
        updated_at: new Date().toISOString()
      })
      .eq('id', order.id);

    // Flip original purchase tx to cancelled — do NOT insert a separate refund row
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
        .eq('status', 'pending')
        .ilike('title', order.service_name || '%');
    } catch (e) {
      console.warn('tx status update skipped', e.message || e);
    }

    // Broader match: any pending MJ SMS purchase for this user around this order price
    try {
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
        refunded_amount: refundAmount,
        new_balance: profile ? Number(profile.balance || 0) + refundAmount : null
      }
    });
  } catch (err) {
    console.error('grizzly-cancel error:', err);
    return res.status(500).json({
      success: false,
      message: 'Something went wrong cancelling this order.'
    });
  }
}
