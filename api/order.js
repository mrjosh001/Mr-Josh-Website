import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FADDED_BASE = 'https://fadded.net/api/v1/reseller';
const FADDED_KEY  = process.env.FADDED_API_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const {
    product_key,
    quantity = 1,
    external_order_id,
    user_id,
    customer_info
  } = req.body;

  if (!product_key || !user_id) {
    return res.status(400).json({ success: false, message: 'product_key and user_id are required' });
  }

  let originalBalance = 0;
  let total = 0;
  let productName = '';
  let customerId = null;
  let deducted = false;

  try {
    // -------------------------------------------------
    // 1. Get product from your database
    // -------------------------------------------------
    const { data: product, error: prodErr } = await supabase
      .from('products')
      .select('id, product_key, name, price, stock_quantity')
      .eq('product_key', product_key)
      .single();

    if (prodErr || !product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    total = Number(product.price) * Number(quantity);
    productName = product.name;

    // -------------------------------------------------
    // 2. Get user profile + balance
    // -------------------------------------------------
    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('balance_ngn, customer_id')
      .eq('id', user_id)
      .single();

    if (profileErr || !profile) {
      return res.status(400).json({ success: false, message: 'User profile not found' });
    }

    originalBalance = Number(profile.balance_ngn || 0);
    customerId = profile.customer_id;

    if (originalBalance < total) {
      return res.status(402).json({
        success: false,
        message: 'Insufficient balance',
        required: total,
        available: originalBalance
      });
    }

    // -------------------------------------------------
    // 3. Debit user immediately
    // -------------------------------------------------
    const newBalance = originalBalance - total;

    const { error: deductErr } = await supabase
      .from('profiles')
      .update({ balance_ngn: newBalance })
      .eq('id', user_id);

    if (deductErr) {
      return res.status(500).json({
        success: false,
        message: 'Could not debit your balance. Please try again.'
      });
    }

    deducted = true;

    // -------------------------------------------------
    // 4. Call supplier (Faded)
    // -------------------------------------------------
    const orderRef = external_order_id || `MJ-${user_id.slice(0, 8)}-${Date.now()}`;

    const supplierRes = await fetch(`${FADDED_BASE}/order`, {
      method: 'POST',
      headers: {
        'X-Api-Key': FADDED_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        product_key,
        quantity,
        external_order_id: orderRef,
        customer_info: customer_info || {}
      })
    });

    const orderData = await supplierRes.json();

    // -------------------------------------------------
    // 5. Supplier failed → automatic refund
    // -------------------------------------------------
    if (!orderData.success) {
      // Refund user
      await supabase
        .from('profiles')
        .update({ balance_ngn: originalBalance })
        .eq('id', user_id);

      // Record failed purchase
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

      // Record refund
      await supabase.from('transactions').insert({
        user_id,
        customer_id: customerId,
        type: 'refund',
        category: productName,
        title: 'Automatic Refund',
        subtitle: 'Order failed at supplier – balance restored',
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

    // -------------------------------------------------
    // 6. Supplier succeeded → save everything
    // -------------------------------------------------
    const items = orderData.data?.items || [];
    const detailsText = items.map(i => i.details).join('\n\n');

    // Save into orders table (one row per item is cleaner)
    for (const item of items) {
      // Try to split "Username: xxx | Password: yyy" if possible
      let credId = null;
      let credPass = null;
      if (item.details) {
        const userMatch = item.details.match(/Username:\s*([^|]+)/i);
        const passMatch = item.details.match(/Password:\s*(.+)/i);
        if (userMatch) credId = userMatch[1].trim();
        if (passMatch) credPass = passMatch[1].trim();
      }

      await supabase.from('orders').insert({
        order_id: orderRef,
        user_id,
        product_id: product.id,
        product_code: product_key,
        product_name: productName,
        product_type: 'log',
        description: item.details,
        quantity: 1,
        amount: product.price,
        status: 'completed',
        credentials_id: credId,
        credentials_pass: credPass,
        supplier_ref: String(item.product_detail_id || ''),
        guide_url: 'https://t.me/faddedsocialsgroup/1030'
      });
    }

    // Save money movement in transactions
    await supabase.from('transactions').insert({
      user_id,
      customer_id: customerId,
      type: 'purchase',
      category: productName,
      title: productName,
      subtitle: `Qty: ${quantity}`,
      amount: `₦${total.toLocaleString()}`,
      amount_ngn: total,
      status: 'completed',
      product_details: detailsText,
      supplier_order: orderData.data
    });

    // Reduce local stock
    await supabase
      .from('products')
      .update({
        stock_quantity: Math.max(0, (product.stock_quantity || 0) - quantity),
        is_available: (product.stock_quantity || 0) - quantity > 0
      })
      .eq('product_key', product_key);

    // -------------------------------------------------
    // 7. Return product to customer
    // -------------------------------------------------
    return res.status(200).json({
      success: true,
      message: 'Order fulfilled successfully',
      data: {
        items: orderData.data.items,
        total_amount: total,
        new_balance: newBalance,
        order_id: orderRef
      }
    });

  } catch (err) {
    console.error('Order handler error:', err);

    // Safety net: refund if we already debited
    if (deducted) {
      try {
        await supabase
          .from('profiles')
          .update({ balance_ngn: originalBalance })
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
