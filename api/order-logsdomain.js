import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/order-logsdomain
 * Buys from Logs Domain after charging the customer wallet.
 * Body: { product_key, quantity, user_id, external_order_id? }
 * product_key format: ld_{category_id}  e.g. ld_12
 *
 * Env: LOGSDOMAIN_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const LD_BASE = 'https://logsdomain.com/api/v1';
const LD_KEY = process.env.LOGSDOMAIN_API_KEY;

function categoryIdFromKey(productKey) {
  if (!productKey) return null;
  const m = String(productKey).match(/^ld_(\d+)$/i);
  if (m) return parseInt(m[1], 10);
  const n = parseInt(productKey, 10);
  return Number.isFinite(n) ? n : null;
}

// NOTE: the "orders" table only has a single "login_credentials" text column —
// that's what api/order.js (Fadded) and api/order-manual.js (Manual) both write
// to, and it's the only column index.html and admin.html actually read from.
// This file used to insert into "credentials_id" / "credentials_pass" instead,
// which are not real columns on "orders". Supabase silently rejected those
// inserts (and the error was never checked), so every Logs Domain order was
// fulfilled and charged, but never actually saved — which is why it never
// showed up in "My Orders" or the admin Orders tab. Keeping this function
// around only to build one clean login_credentials string.
function formatCredentials(details) {
  if (!details) return '';
  const text = String(details);
  const userMatch = text.match(/(?:Username|User|ID|Email|Login)\s*[:=]\s*([^\s|]+)/i);
  const passMatch = text.match(/(?:Password|Pass)\s*[:=]\s*([^\s|]+)/i);
  const credId = userMatch ? userMatch[1].trim() : null;
  const credPass = passMatch ? passMatch[1].trim() : null;
  if (credId && credPass) return `${credId}:${credPass}`;
  return text;
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
  const {
    product_key,
    quantity = 1,
    external_order_id,
    user_id
  } = body;

  if (!product_key || !user_id) {
    return res.status(400).json({ success: false, message: 'product_key and user_id are required' });
  }

  if (!LD_KEY) {
    return res.status(500).json({ success: false, message: 'LOGSDOMAIN_API_KEY not configured' });
  }

  const categoryId = categoryIdFromKey(product_key);
  if (!categoryId) {
    return res.status(400).json({
      success: false,
      message: 'Invalid Logs Domain product_key (expected ld_123)'
    });
  }

  const qty = Math.max(1, Math.min(100, parseInt(quantity, 10) || 1));
  let originalBalance = 0;
  let total = 0;
  let productName = '';
  let customerId = null;
  let deducted = false;
  let balanceColumn = 'balance_ngn';

  try {
    // 1. Product from DB
    const { data: product, error: prodErr } = await supabase
      .from('products')
      .select('id, product_key, name, price, stock_quantity, source')
      .eq('product_key', product_key)
      .single();

    if (prodErr || !product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    total = Number(product.price) * qty;
    productName = product.name;

    // 2. User balance
    let profile = null;
    {
      const r1 = await supabase
        .from('profiles')
        .select('balance, customer_id')
        .eq('id', user_id)
        .single();
      if (r1.error || !r1.data) {
        console.error('[order-logsdomain] profile lookup failed:', r1.error);
        return res.status(400).json({ success: false, message: 'User profile not found' });
      }
      profile = r1.data;
      balanceColumn = 'balance';
      originalBalance = Number(profile.balance || 0);
      customerId = profile.customer_id;
    }

    if (originalBalance < total) {
      return res.status(402).json({
        success: false,
        message: 'Insufficient balance',
        required: total,
        available: originalBalance
      });
    }

    // 3. Debit customer
    const newBalance = originalBalance - total;
    const { error: deductErr } = await supabase
      .from('profiles')
      .update({ [balanceColumn]: newBalance })
      .eq('id', user_id);

    if (deductErr) {
      return res.status(500).json({
        success: false,
        message: 'Could not debit your balance. Please try again.'
      });
    }
    deducted = true;

    // 4. Call Logs Domain
    const orderRef = external_order_id || `MJ-LD-${String(user_id).slice(0, 8)}-${Date.now()}`;
    const supplierRes = await fetch(`${LD_BASE}/logs/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LD_KEY}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        category_id: categoryId,
        quantity: qty,
        idempotency_key: orderRef
      })
    });

    const orderData = await supplierRes.json().catch(() => ({}));

    // 5. Supplier failed → refund
    if (!supplierRes.ok || orderData.success === false) {
      await supabase
        .from('profiles')
        .update({ [balanceColumn]: originalBalance })
        .eq('id', user_id);

      await supabase.from('transactions').insert({
        user_id,
        customer_id: customerId,
        type: 'purchase_failed',
        category: productName,
        title: productName,
        subtitle: `Failed: ${orderData.message || orderData.code || 'Supplier error'}`,
        amount: `₦${total.toLocaleString()}`,
        amount_ngn: total,
        status: 'failed',
        notes: JSON.stringify(orderData)
      });

      await supabase.from('transactions').insert({
        user_id,
        customer_id: customerId,
        type: 'refund',
        category: productName,
        title: 'Automatic Refund',
        subtitle: 'Logs Domain order failed – balance restored',
        amount: `₦${total.toLocaleString()}`,
        amount_ngn: total,
        status: 'refunded'
      });

      return res.status(400).json({
        success: false,
        code: orderData.code || 'SUPPLIER_ERROR',
        message: orderData.message || 'Order failed at supplier. Your balance has been refunded.'
      });
    }

    // 6. Success → save orders
    const items = orderData.data?.items || [];
    const supplierOrderId = orderData.data?.order_id || orderRef;
    const detailsText = items.map((i) => i.details).filter(Boolean).join('\n\n');

    // Traceability for the "wrong product delivered" class of bug: log exactly
    // which category_id we asked Logs Domain for, against which local product
    // name/key it was supposed to be, plus whatever raw item data they sent
    // back. If a customer ever again reports getting the wrong log for what
    // they bought, this line in the Vercel logs (search by order_id) shows
    // whether we asked the supplier for the right category_id or not.
    console.log('[order-logsdomain] fulfilling', {
      order_id: supplierOrderId,
      product_key,
      category_id: categoryId,
      product_name: productName,
      supplier_items_raw: items
    });

    if (items.length) {
      for (const item of items) {
        const { error: insertErr } = await supabase.from('orders').insert({
          order_id: supplierOrderId,
          user_id,
          product_id: product.id,
          product_code: product_key,
          product_name: productName,
          product_type: 'log',
          description: (product.display_description || product.description || '').trim() || null,
          quantity: 1,
          amount: product.price,
          status: 'completed',
          login_credentials: formatCredentials(item.details),
          supplier_ref: String(item.serial || ''),
          guide_url: 'https://t.me/mj_hub_tg'
        });
        if (insertErr) {
          console.error('[order-logsdomain] FAILED to save order row — customer was charged and delivered credentials, but this will not appear in My Orders / admin Orders:', insertErr.message, { order_id: supplierOrderId, user_id, product_key });
        }
      }
    } else {
      // fallback single row if API returns no items array
      const { error: insertErr } = await supabase.from('orders').insert({
        order_id: supplierOrderId,
        user_id,
        product_id: product.id,
        product_code: product_key,
        product_name: productName,
        product_type: 'log',
        description: JSON.stringify(orderData.data || {}),
        quantity: qty,
        amount: total,
        status: 'completed',
        login_credentials: detailsText || 'Delivered — see order for details',
        guide_url: 'https://t.me/mj_hub_tg'
      });
      if (insertErr) {
        console.error('[order-logsdomain] FAILED to save order row (fallback branch):', insertErr.message, { order_id: supplierOrderId, user_id, product_key });
      }
    }

    await supabase.from('transactions').insert({
      user_id,
      customer_id: customerId,
      type: 'purchase',
      category: productName,
      title: productName,
      subtitle: `Qty: ${qty} · Logs Domain`,
      amount: `₦${total.toLocaleString()}`,
      amount_ngn: total,
      status: 'completed',
      product_details: detailsText,
      supplier_order: orderData.data
    });

    await supabase
      .from('products')
      .update({
        stock_quantity: Math.max(0, (product.stock_quantity || 0) - qty),
        is_available: (product.stock_quantity || 0) - qty > 0
      })
      .eq('product_key', product_key);

    return res.status(200).json({
      success: true,
      message: 'Order fulfilled successfully',
      data: {
        items: items.length
          ? items.map((i) => ({ details: i.details, serial: i.serial }))
          : [{ details: detailsText || 'Order completed' }],
        total_amount: total,
        new_balance: newBalance,
        order_id: supplierOrderId,
        source: 'logsdomain'
      }
    });
  } catch (err) {
    console.error('order-logsdomain error:', err);

    if (deducted) {
      try {
        await supabase
          .from('profiles')
          .update({ [balanceColumn]: originalBalance })
          .eq('id', user_id);

        await supabase.from('transactions').insert({
          user_id,
          customer_id: customerId,
          type: 'refund',
          category: productName || 'Unknown',
          title: 'Automatic Refund',
          subtitle: `System error – ${err.message}`,
          amount: `₦${total.toLocaleString()}`,
          amount_ngn: total,
          status: 'refunded',
          notes: err.message
        });
      } catch (refundErr) {
        console.error('CRITICAL: Auto-refund failed', refundErr);
      }
    }

    return res.status(500).json({
      success: false,
      message: deducted
        ? 'Something went wrong. Your balance has been refunded.'
        : 'Something went wrong. Please try again.'
    });
  }
}
