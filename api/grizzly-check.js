import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/grizzly-check
 * Polls GrizzlySMS getStatus for the latest code/status of one number order
 * and updates the matching number_orders row (source='grizzlysms').
 * Ownership verified against user_id before ever calling the supplier.
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
    const { data: existing, error: findErr } = await supabase
      .from('number_orders')
      .select('id, status, phone_number, created_at, service_name, country_name, price, order_id')
      .eq('source', 'grizzlysms')
      .eq('order_id', String(order_id))
      .eq('user_id', user_id)
      .single();

    if (findErr || !existing) {
      return res.status(404).json({ success: false, message: 'Order not found for this account' });
    }

    if (existing.status === 'completed' || existing.status === 'refunded') {
      const { data: current } = await supabase.from('number_orders').select('*').eq('id', existing.id).single();
      return res.status(200).json({ success: true, data: current });
    }

    // getStatusV2 — confirmed JSON shape when a code has arrived:
    //   { "verificationType": 2, "sms": { "dateTime", "code", "text" } }
    // The "still waiting" shape isn't documented anywhere we've seen, so
    // this is defensive: only treat it as JSON success if sms.code is
    // actually present; anything else — including a plain-text v1-style
    // response, in case Grizzly falls back to one — is handled below rather
    // than assumed.
    const qs = new URLSearchParams({ api_key: GRIZZLY_KEY, action: 'getStatusV2', id: String(order_id) });
    const supplierRes = await fetch(`${BASE}?${qs.toString()}`, { method: 'GET' });
    const raw = (await supplierRes.text()).trim();

    let newStatus = existing.status;
    let code = null;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* not JSON — fall through to text handling */ }

    if (parsed && parsed.sms && parsed.sms.code) {
      newStatus = 'completed';
      code = parsed.sms.code;
    } else if (parsed) {
      // Valid JSON but no sms.code yet — still waiting. Log the shape once
      // so if Grizzly's real "waiting" payload differs from this guess,
      // it's visible in Vercel logs instead of silently misreported.
      console.log('[grizzly-check] getStatusV2 waiting-state payload:', raw, { order_id });
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
      return res.status(404).json({ success: false, code: 'NO_ACTIVATION', message: 'Supplier has no record of this order.' });
    } else if (raw === 'BAD_ACTION') {
      // getStatusV2 rejected — fall back to v1 automatically so polling
      // still works even if V2 isn't enabled on this account/key.
      const v1Qs = new URLSearchParams({ api_key: GRIZZLY_KEY, action: 'getStatus', id: String(order_id) });
      const v1Res = await fetch(`${BASE}?${v1Qs.toString()}`, { method: 'GET' });
      const v1Raw = (await v1Res.text()).trim();
      if (v1Raw === 'STATUS_WAIT_CODE' || v1Raw === 'STATUS_WAIT_RESEND') newStatus = 'waiting_for_code';
      else if (v1Raw.startsWith('STATUS_WAIT_RETRY')) { newStatus = 'waiting_for_code'; code = v1Raw.split(':')[1] || null; }
      else if (v1Raw === 'STATUS_CANCEL') newStatus = 'refunded';
      else if (v1Raw.startsWith('STATUS_OK')) { newStatus = 'completed'; code = v1Raw.split(':')[1] || null; }
      else {
        console.error('[grizzly-check] v1 fallback also unrecognized:', v1Raw, { order_id });
        return res.status(502).json({ success: false, message: 'Unrecognized response from supplier', raw: v1Raw });
      }
    } else {
      console.error('[grizzly-check] unrecognized getStatusV2 response:', raw, { order_id });
      return res.status(502).json({ success: false, message: 'Unrecognized response from supplier', raw });
    }

    const { error: updateErr } = await supabase
      .from('number_orders')
      .update({
        status: newStatus,
        code,
        refunded: newStatus === 'refunded',
        updated_at: new Date().toISOString()
      })
      .eq('id', existing.id);

    if (updateErr) {
      console.error('[grizzly-check] failed to update number_orders row:', updateErr.message, { order_id });
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
        raw
      }
    });
  } catch (err) {
    console.error('grizzly-check error:', err);
    return res.status(500).json({ success: false, message: 'Something went wrong checking this order.' });
  }
}
