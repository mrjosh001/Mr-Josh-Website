import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/grizzly-check
 * Polls GrizzlySMS getStatus for code/status of one number order.
 *
 * - completed + code → mark number_orders completed; mark purchase tx completed
 * - STATUS_CANCEL / expired with no code → auto-refund wallet (no refund tx row)
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
const EXPIRY_MS = 20 * 60 * 1000;

async function refundOrderSilently(order, userId) {
  if (!order || order.refunded || order.status === 'refunded' || order.status === 'completed') {
    return { refunded: false, reason: 'already_final' };
  }

  const refundAmount = Number(order.price || 0);
  const { data: profile } = await supabase
    .from('profiles')
    .select('balance')
    .eq('id', userId)
    .single();

  if (profile && refundAmount > 0) {
    const restored = Number(profile.balance || 0) + refundAmount;
    await supabase.from('profiles').update({ balance: restored }).eq('id', userId);
  }

  await supabase
    .from('number_orders')
    .update({
      status: 'refunded',
      refunded: true,
      updated_at: new Date().toISOString()
    })
    .eq('id', order.id);

  // Mark original purchase cancelled — no separate refund transaction
  try {
    await supabase
      .from('transactions')
      .update({
        status: 'cancelled',
        subtitle: 'No SMS — balance restored'
      })
      .eq('user_id', userId)
      .eq('category', 'MJ SMS')
      .eq('type', 'purchase')
      .in('status', ['pending', 'completed'])
      .eq('amount_ngn', refundAmount);
  } catch (e) {
    console.warn('tx update on silent refund', e.message || e);
  }

  return {
    refunded: true,
    refunded_amount: refundAmount,
    new_balance: profile ? Number(profile.balance || 0) + refundAmount : null
  };
}

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
    const { data: existing, error: findErr } = await supabase
      .from('number_orders')
      .select(
        'id, status, phone_number, created_at, service_name, country_name, price, order_id, refunded, customer_id'
      )
      .eq('source', 'grizzlysms')
      .eq('order_id', String(order_id))
      .eq('user_id', user_id)
      .single();

    if (findErr || !existing) {
      return res.status(404).json({ success: false, message: 'Order not found for this account' });
    }

    if (existing.status === 'completed' || existing.status === 'refunded' || existing.refunded) {
      const { data: current } = await supabase
        .from('number_orders')
        .select('*')
        .eq('id', existing.id)
        .single();
      return res.status(200).json({ success: true, data: current });
    }

    const qs = new URLSearchParams({
      api_key: GRIZZLY_KEY,
      action: 'getStatusV2',
      id: String(order_id)
    });
    const supplierRes = await fetch(`${BASE}?${qs.toString()}`, { method: 'GET' });
    const raw = (await supplierRes.text()).trim();

    let newStatus = existing.status;
    let code = null;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* text */
    }

    if (parsed && parsed.sms && parsed.sms.code) {
      newStatus = 'completed';
      code = parsed.sms.code;
    } else if (parsed) {
      newStatus = 'waiting_for_code';
    } else if (raw === 'STATUS_WAIT_CODE' || raw === 'STATUS_WAIT_RESEND') {
      newStatus = 'waiting_for_code';
    } else if (raw.startsWith('STATUS_WAIT_RETRY')) {
      newStatus = 'waiting_for_code';
      code = raw.split(':')[1] || null;
    } else if (raw === 'STATUS_CANCEL') {
      newStatus = 'refunded';
    } else if (raw.startsWith('STATUS_OK')) {
      newStatus = 'completed';
      code = raw.split(':')[1] || null;
    } else if (raw === 'NO_ACTIVATION') {
      // Treat as expired/gone → refund if still open
      newStatus = 'refunded';
    } else if (raw === 'BAD_ACTION') {
      const v1Qs = new URLSearchParams({
        api_key: GRIZZLY_KEY,
        action: 'getStatus',
        id: String(order_id)
      });
      const v1Res = await fetch(`${BASE}?${v1Qs.toString()}`, { method: 'GET' });
      const v1Raw = (await v1Res.text()).trim();
      if (v1Raw === 'STATUS_WAIT_CODE' || v1Raw === 'STATUS_WAIT_RESEND') {
        newStatus = 'waiting_for_code';
      } else if (v1Raw.startsWith('STATUS_WAIT_RETRY')) {
        newStatus = 'waiting_for_code';
        code = v1Raw.split(':')[1] || null;
      } else if (v1Raw === 'STATUS_CANCEL') {
        newStatus = 'refunded';
      } else if (v1Raw.startsWith('STATUS_OK')) {
        newStatus = 'completed';
        code = v1Raw.split(':')[1] || null;
      } else {
        console.error('[grizzly-check] v1 unrecognized:', v1Raw, { order_id });
        return res.status(502).json({
          success: false,
          message: 'Unrecognized response from supplier',
          raw: v1Raw
        });
      }
    } else {
      // Local expiry fallback: if past 20 min and still waiting, refund
      const age = existing.created_at
        ? Date.now() - new Date(existing.created_at).getTime()
        : 0;
      if (age >= EXPIRY_MS) {
        newStatus = 'refunded';
      } else {
        console.error('[grizzly-check] unrecognized:', raw, { order_id });
        return res.status(502).json({
          success: false,
          message: 'Unrecognized response from supplier',
          raw
        });
      }
    }

    // Also force expiry if still waiting past window even when supplier says wait
    if (newStatus === 'waiting_for_code' && existing.created_at) {
      const age = Date.now() - new Date(existing.created_at).getTime();
      if (age >= EXPIRY_MS) {
        // Try supplier cancel then silent refund
        try {
          const cancelQs = new URLSearchParams({
            api_key: GRIZZLY_KEY,
            action: 'setStatus',
            id: String(order_id),
            status: '8'
          });
          await fetch(`${BASE}?${cancelQs.toString()}`, { method: 'GET' });
        } catch (_) {}
        newStatus = 'refunded';
      }
    }

    if (newStatus === 'refunded') {
      const result = await refundOrderSilently(existing, user_id);
      return res.status(200).json({
        success: true,
        data: {
          order_id,
          status: 'refunded',
          number: existing.phone_number,
          code: null,
          created_at: existing.created_at,
          service_name: existing.service_name,
          country_name: existing.country_name,
          price: existing.price,
          refunded: true,
          refunded_amount: result.refunded_amount,
          new_balance: result.new_balance,
          raw
        }
      });
    }

    const { error: updateErr } = await supabase
      .from('number_orders')
      .update({
        status: newStatus,
        code,
        refunded: false,
        updated_at: new Date().toISOString()
      })
      .eq('id', existing.id);

    if (updateErr) {
      console.error('[grizzly-check] update failed:', updateErr.message, { order_id });
    }

    // Code received → lock as completed on purchase transaction
    if (newStatus === 'completed' && code) {
      try {
        await supabase
          .from('transactions')
          .update({
            status: 'completed',
            subtitle: `${existing.country_name || ''} · code received`.trim()
          })
          .eq('user_id', user_id)
          .eq('category', 'MJ SMS')
          .eq('type', 'purchase')
          .eq('status', 'pending')
          .eq('amount_ngn', Number(existing.price || 0));
      } catch (e) {
        console.warn('tx complete update', e.message || e);
      }

      // Tell supplier activation finished (status 6) when supported
      try {
        const doneQs = new URLSearchParams({
          api_key: GRIZZLY_KEY,
          action: 'setStatus',
          id: String(order_id),
          status: '6'
        });
        await fetch(`${BASE}?${doneQs.toString()}`, { method: 'GET' });
      } catch (_) {}
    }

    return res.status(200).json({
      success: true,
      data: {
        order_id,
        status: newStatus,
        number: existing.phone_number,
        code,
        created_at: existing.created_at,
        service_name: existing.service_name,
        country_name: existing.country_name,
        price: existing.price,
        refunded: false,
        raw
      }
    });
  } catch (err) {
    console.error('grizzly-check error:', err);
    return res.status(500).json({
      success: false,
      message: 'Something went wrong checking this order.'
    });
  }
}
