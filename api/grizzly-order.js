import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/grizzly-order
 * Buys one phone number from GrizzlySMS (getNumberV2) after charging the
 * customer wallet. Separate pipeline from order-numbers.js (LogsDomain) —
 * different protocol, different response shapes, own refund handling.
 * Never writes to "orders" or "products".
 *
 * Body: { country_id, service_id, user_id, external_order_id? }
 * Env: GRIZZLYSMS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BASE = 'https://api.grizzlysms.com/stubs/handler_api.php';
const GRIZZLY_KEY = process.env.GRIZZLYSMS_API_KEY;

const KNOWN_ERRORS = new Set(['BAD_KEY', 'NO_BALANCE', 'NO_NUMBERS', 'SERVICE_UNAVAILABLE_REGION', 'BAD_SERVICE']);

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
  const { country_id, service_id, external_order_id, user_id } = body;

  const countryId = parseInt(country_id, 10);
  const serviceId = service_id != null ? String(service_id) : null;

  if (!Number.isFinite(countryId) || !serviceId || !user_id) {
    return res.status(400).json({ success: false, message: 'country_id, service_id and user_id are required' });
  }
  if (!GRIZZLY_KEY) {
    return res.status(500).json({ success: false, message: 'GRIZZLYSMS_API_KEY not configured' });
  }

  let originalBalance = 0;
  let price = 0;
  let serviceName = '';
  let countryName = '';
  let customerId = null;
  let deducted = false;

  try {
    // 1. Our cached resale price (what the customer actually gets charged)
    const { data: svc, error: svcErr } = await supabase
      .from('number_services')
      .select('service_name, country_name, price, is_available')
      .eq('source', 'grizzlysms')
      .eq('country_id', countryId)
      .eq('service_id', serviceId)
      .single();

    if (svcErr || !svc) {
      return res.status(404).json({ success: false, message: 'This service is no longer available. Please refresh and try another.' });
    }
    if (!svc.is_available) {
      return res.status(409).json({ success: false, message: 'This number service is currently out of stock.' });
    }

    price = Number(svc.price) || 0;
    serviceName = svc.service_name;
    countryName = svc.country_name;

    // 2. Customer balance
    const { data: profile, error: profErr } = await supabase
      .from('profiles')
      .select('balance, customer_id')
      .eq('id', user_id)
      .single();

    if (profErr || !profile) {
      return res.status(400).json({ success: false, message: 'User profile not found' });
    }
    originalBalance = Number(profile.balance || 0);
    customerId = profile.customer_id;

    if (originalBalance < price) {
      return res.status(402).json({ success: false, message: 'Insufficient balance', required: price, available: originalBalance });
    }

    // 3. Debit customer wallet up front
    const newBalance = originalBalance - price;
    const { error: deductErr } = await supabase.from('profiles').update({ balance: newBalance }).eq('id', user_id);
    if (deductErr) {
      return res.status(500).json({ success: false, message: 'Could not debit your balance. Please try again.' });
    }
    deducted = true;

    // 4. Call GrizzlySMS getNumberV2 (JSON response, unlike v1's colon-delimited string)
    const idempotencyKey = external_order_id || `MJ-GZ-${String(user_id).slice(0, 8)}-${Date.now()}`;
    const qs = new URLSearchParams({
      api_key: GRIZZLY_KEY,
      action: 'getNumberV2',
      service: serviceId,
      country: String(countryId)
    });

    const supplierRes = await fetch(`${BASE}?${qs.toString()}`, { method: 'GET' });
    const rawText = await supplierRes.text();

    let orderData = null;
    let failureReason = null;
    if (KNOWN_ERRORS.has(rawText.trim())) {
      failureReason = rawText.trim();
    } else {
      try {
        orderData = JSON.parse(rawText);
      } catch {
        failureReason = `Unrecognized response: ${rawText.slice(0, 200)}`;
      }
    }

    // 5. Supplier failed → refund customer, log both entries
    if (!supplierRes.ok || failureReason || !orderData?.activationId) {
      await supabase.from('profiles').update({ balance: originalBalance }).eq('id', user_id);

      await supabase.from('transactions').insert({
        user_id,
        customer_id: customerId,
        type: 'purchase_failed',
        category: 'MJ SMS',
        title: serviceName,
        subtitle: `Failed: ${humanizeGrizzlyError(failureReason) || 'Unknown error'}`,
        amount: `₦${price.toLocaleString()}`,
        amount_ngn: price,
        status: 'failed',
        notes: rawText.slice(0, 500)
      });

      await supabase.from('transactions').insert({
        user_id,
        customer_id: customerId,
        type: 'refund',
        category: 'MJ SMS',
        title: 'Automatic Refund',
        subtitle: 'Purchase failed – balance restored',
        amount: `₦${price.toLocaleString()}`,
        amount_ngn: price,
        status: 'refunded'
      });

      return res.status(400).json({
        success: false,
        code: failureReason || 'SUPPLIER_ERROR',
        message: humanizeGrizzlyError(failureReason) || 'Purchase failed. Your balance has been refunded.'
      });
    }

    // 6. Success → save to number_orders
    const { error: insertErr } = await supabase.from('number_orders').insert({
      source: 'grizzlysms',
      user_id,
      customer_id: customerId,
      order_id: String(orderData.activationId),
      idempotency_key: idempotencyKey,
      country_id: countryId,
      country_name: countryName,
      service_id: serviceId,
      service_name: serviceName,
      phone_number: orderData.phoneNumber || null,
      price,
      currency: 'NGN',
      status: 'waiting_for_code',
      code: null,
      time_left: null,
      refunded: false
    });

    if (insertErr) {
      console.error('[grizzly-order] FAILED to save number_orders row — customer charged and number reserved:',
        insertErr.message, { activationId: orderData.activationId, user_id, country_id: countryId, service_id: serviceId });
    }

    await supabase.from('transactions').insert({
      user_id,
      customer_id: customerId,
      type: 'purchase',
      category: 'MJ SMS',
      title: serviceName,
      subtitle: `${countryName} · MJ SMS`,
      amount: `₦${price.toLocaleString()}`,
      amount_ngn: price,
      status: 'completed',
      supplier_order: orderData
    });

    return res.status(200).json({
      success: true,
      message: 'Number purchased successfully',
      data: {
        order_id: orderData.activationId,
        number: orderData.phoneNumber,
        status: 'waiting_for_code',
        service_name: serviceName,
        country_name: countryName,
        price,
        new_balance: newBalance
      }
    });
  } catch (err) {
    console.error('grizzly-order error:', err);

    if (deducted) {
      try {
        await supabase.from('profiles').update({ balance: originalBalance }).eq('id', user_id);
        await supabase.from('transactions').insert({
          user_id,
          customer_id: customerId,
          type: 'refund',
          category: 'MJ SMS',
          title: 'Automatic Refund',
          subtitle: `System error – ${err.message}`,
          amount: `₦${price.toLocaleString()}`,
          amount_ngn: price,
          status: 'refunded',
          notes: err.message
        });
      } catch (refundErr) {
        console.error('CRITICAL: Auto-refund failed (grizzly-order)', refundErr);
      }
    }

    return res.status(500).json({
      success: false,
      message: deducted ? 'Something went wrong. Your balance has been refunded.' : 'Something went wrong. Please try again.'
    });
  }
}

function humanizeGrizzlyError(code) {
  const map = {
    BAD_KEY: 'This service is temporarily unavailable. Please try again shortly.',
    NO_BALANCE: 'This service is temporarily unavailable. Please try again later or contact support.',
    NO_NUMBERS: 'No numbers available for this service/country right now. Try another country or service.',
    SERVICE_UNAVAILABLE_REGION: 'This service is temporarily restricted right now. Please try another service.',
    BAD_SERVICE: 'This service is temporarily unavailable. Please try again shortly.'
  };
  return map[code] || null;
}
