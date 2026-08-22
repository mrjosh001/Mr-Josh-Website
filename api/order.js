import { createClient } from '@supabase/supabase-js';
import { formatCredentials } from '../lib/formatCredentials.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// -------------------------------------------------------------------------
// SUPPLIER ROUTING
// -------------------------------------------------------------------------
// Every product is tagged with product.supplier (defaults to "faded" when
// the column doesn't exist or is empty, so this is 100% backward-compatible
// with the current single-supplier setup).
//
// To add a new supplier later:
//   1. In Supabase, add a text column "supplier" to "products" (default 'faded').
//   2. Add an entry below with that supplier's base URL + API key env var.
//   3. Create a new /api/products-<name>.js sync file (copy api/products.js)
//      that upserts products with supplier: '<name>'.
//   4. That's it — this file already knows how to route orders to whichever
//      supplier a product belongs to.
const SUPPLIERS = {
  faded: {
    baseUrl: 'https://fadded.net/api/v1/reseller',
    apiKey: process.env.FADDED_API_KEY
  }
  // example second supplier:
  // newsupplier: {
  //   baseUrl: 'https://newsupplier.example.com/api/v1/reseller',
  //   apiKey: process.env.NEWSUPPLIER_API_KEY
  // }
};

function getSupplierConfig(product) {
  const key = (product && product.supplier) ? String(product.supplier).trim().toLowerCase() : 'faded';
  return SUPPLIERS[key] || SUPPLIERS.faded;
}


async function requireAuthUser(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token || token.includes('service_role')) {
    return { error: { status: 401, message: 'Not signed in' } };
  }
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return { error: { status: 401, message: 'Invalid or expired session' } };
  }
  return { user };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  // IDOR protection: never trust body.user_id — bind to JWT only
  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ success: false, message: auth.error.message });
  }
  const user_id = auth.user.id;

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const {
    product_key,
    quantity = 1,
    external_order_id,
    customer_info
  } = body;

  if (!product_key) {
    return res.status(400).json({ success: false, message: 'product_key is required' });
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
      .select('*')
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
      .select('balance, customer_id')
      .eq('id', user_id)
      .single();

    if (profileErr || !profile) {
      return res.status(400).json({ success: false, message: 'User profile not found' });
    }

    originalBalance = Number(profile.balance || 0);
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
      .update({ balance: newBalance })
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
    const supplierConfig = getSupplierConfig(product);

    const supplierRes = await fetch(`${supplierConfig.baseUrl}/order`, {
      method: 'POST',
      headers: {
        'X-Api-Key': supplierConfig.apiKey,
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
        .update({ balance: originalBalance })
        .eq('id', user_id);

      // Record failed purchase → Log Orders tab
      await supabase.from('transactions').insert({
        user_id,
        customer_id: customerId,
        type: 'log',
        category: 'log',
        title: productName,
        subtitle: `Failed: ${orderData.message || orderData.code || 'Supplier error'}`,
        amount: `₦${total.toLocaleString()}`,
        amount_ngn: total,
        status: 'failed',
        notes: JSON.stringify(orderData)
      });

      // Record refund → Deposits tab
      await supabase.from('transactions').insert({
        user_id,
        customer_id: customerId,
        type: 'deposit',
        category: 'deposit',
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

    // Whatever the product's own description is (if it has one) is stored on
    // every order for that product. If the product has no description, this
    // is left blank rather than guessing/filling in something else.
    const orderDescription = (product.display_description || product.description || '').trim() || null;

    // Save into orders table (one row per item is cleaner)
    // Whatever format the supplier sends (Username/Password labels, email:pass,
    // JSON, etc.) is stored as-is in a single login_credentials column so
    // nothing gets silently dropped or misrouted into "description".
    for (const item of items) {
      await supabase.from('orders').insert({
        order_id: orderRef,
        user_id,
        product_id: product.id,
        product_code: product_key,
        product_name: productName,
        product_type: 'log',
        description: orderDescription,
        quantity: 1,
        amount: product.price,
        status: 'completed',
        login_credentials: formatCredentials(item.details, product.display_description || product.description || product.name || product.product_name) || null,
        supplier_ref: String(item.product_detail_id || ''),
        guide_url: 'https://t.me/mj_hub_tg'
      });
    }

    // Save money movement in transactions → Log Orders tab
    await supabase.from('transactions').insert({
      user_id,
      customer_id: customerId,
      type: 'log',
      category: 'log',
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
          .update({ balance: originalBalance })
          .eq('id', user_id);

        await supabase.from('transactions').insert({
          user_id,
          customer_id: customerId,
          type: 'deposit',
          category: 'deposit',
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
