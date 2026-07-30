// api/order.js
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

  let deducted = false;          // tracks whether we already took money
  let originalBalance = 0;
  let total = 0;
  let productName = '';

  try {
    // -------------------------------------------------
    // 1. Get product
    // -------------------------------------------------
    const { data: product, error: prodErr } = await supabase
      .from('products')
      .select('price, name, stock_quantity')
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
      .from('profiles')                     // change if your table is named differently
      .select('balance_ngn, customer_id')
      .eq('id', user_id)
      .single();

    if (profileErr || !profile) {
      return res.status(400).json({ success: false, message: 'User profile not found' });
    }

    originalBalance = Number(profile.balance_ngn);

    if (originalBalance < total) {
      return res.status(402).json({
        success: false,
        message: 'Insufficient balance',
        required: total,
        available: originalBalance
      });
    }

    // -------------------------------------------------
    // 3. Call supplier FIRST (balance still untouched)
    // -------------------------------------------------
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
        external_order_id: external_order_id || `MJ-${user_id}-${Date.now()}`,
        customer_info: customer_info || {}
      })
    });

    const orderData = await supplierRes.json();

    // Supplier failed → user keeps their money
    if (!orderData.success) {
      // Record the failed attempt (optional but useful)
      await supabase.from('transactions').insert({
        user_id,
        customer_id: profile.customer_id,
        type: 'purchase_failed',
        category: productName,
        title: productName,
        subtitle: `Failed: ${orderData.message || orderData.code || 'Supplier error'}`,
        amount: `₦${total.toLocaleString()}`,
        amount_ngn: total,
        status: 'failed',
        notes: JSON.stringify(orderData)
      });

      return res.status(400).json({
        success: false,
        code: orderData.code || 'SUPPLIER_ERROR',
        message: orderData.message || 'Order failed at supplier. Your balance was not charged.'
      });
    }

    // -------------------------------------------------
    // 4. Supplier succeeded → now deduct balance
    // -------------------------------------------------
    const newBalance = originalBalance - total;

    const { error: deductErr } = await supabase
      .from('profiles')
      .update({ balance_ngn: newBalance })
      .eq('id', user_id);

    if (deductErr) {
      // Extremely rare: supplier gave us the product but we couldn't deduct.
      // In this case we still return the product (user got it) and log the issue.
      console.error('CRITICAL: Could not deduct balance after successful supplier order', deductErr);

      await supabase.from('transactions').insert({
        user_id,
        customer_id: profile.customer_id,
        type: 'purchase',
        category: productName,
        title: productName,
        subtitle: 'Balance deduction failed – manual review needed',
        amount: `₦${total.toLocaleString()}`,
        amount_ngn: total,
        status: 'completed_but_balance_error',
        product_details: (orderData.data.items || []).map(i => i.details).join('\n\n'),
        supplier_order: orderData.data
      });

      return res.status(200).json({
        success: true,
        warning: 'Order fulfilled but balance update failed. Support has been notified.',
        data: {
          items: orderData.data.items,
          total_amount: total,
          new_balance: originalBalance   // still show old balance
        }
      });
    }

    deducted = true;

    // -------------------------------------------------
    // 5. Save successful transaction + product details
    // -------------------------------------------------
    const items = orderData.data.items || [];
    const detailsText = items.map(i => i.details).join('\n\n');

    await supabase.from('transactions').insert({
      user_id,
      customer_id: profile.customer_id,
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

    // Optional: reduce local stock
    await supabase
      .from('products')
      .update({
        stock_quantity: Math.max(0, (product.stock_quantity || 0) - quantity),
        is_available: (product.stock_quantity || 0) - quantity > 0
      })
      .eq('product_key', product_key);

    return res.status(200).json({
      success: true,
      message: 'Order fulfilled successfully',
      data: {
        items: orderData.data.items,
        total_amount: total,
        new_balance: newBalance
      }
    });

  } catch (err) {
    console.error('Order handler error:', err);

    // -------------------------------------------------
    // Automatic refund if we already deducted
    // -------------------------------------------------
    if (deducted) {
      try {
        await supabase
          .from('profiles')
          .update({ balance_ngn: originalBalance })
          .eq('id', user_id);

        await supabase.from('transactions').insert({
          user_id,
          type: 'refund',
          category: productName || 'Unknown',
          title: 'Automatic Refund',
          subtitle: `Refund for failed order – ${err.message}`,
          amount: `₦${total.toLocaleString()}`,
          amount_ngn: total,
          status: 'refunded'
        });

        console.log(`Auto-refunded ₦${total} to user ${user_id}`);
      } catch (refundErr) {
        console.error('CRITICAL: Auto-refund also failed', refundErr);
        // You should also send yourself an alert here (email / Discord / etc.)
      }
    }

    return res.status(500).json({
      success: false,
      message: deducted
        ? 'Something went wrong after payment. Your balance has been refunded.'
        : 'Something went wrong. Your balance was not charged.'
    });
  }
}
