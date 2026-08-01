import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/order-manual
 * Fulfills a "manual" product (one you stocked yourself in Supabase via
 * Stage 3 bulk upload) instead of calling an outside supplier.
 * Body: { product_key, quantity, user_id, external_order_id? }
 *
 * A product is treated as manual if its `source` column is 'manual', or
 * (fallback, for products created before that column existed) its
 * product_key starts with "manual_".
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Table this depends on (Stage 1): product_inventory
 *   id           bigint / identity primary key
 *   product_key  text        -- matches products.product_key
 *   credential   text        -- the raw pasted line, e.g. "user1@mail.com:pass1"
 *   status       text        -- 'available' | 'sold'
 *   sold_to      uuid        -- user_id who bought it (set on sale)
 *   order_id     text        -- order ref that claimed it (set on sale)
 *   sold_at      timestamptz -- set on sale
 *   created_at   timestamptz default now()
 * See supabase/manual-logs-schema.sql in this repo for the exact SQL
 * (safe to re-run — it only creates what's missing).
 */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function isManualProduct(product) {
  if (!product) return false;
  if (product.source && String(product.source).trim().toLowerCase() === 'manual') return true;
  return String(product.product_key || '').startsWith('manual_');
}

// Claims up to `qty` available inventory rows for a product, one at a time,
// using a conditional UPDATE per row (`.eq('status','available')`).
// That WHERE clause makes each claim attempt an atomic, all-or-nothing
// operation at the database level: if two purchases race for the same row,
// only the update that reaches Postgres first actually matches and changes
// it — the loser gets back zero rows and just moves on to the next
// candidate. This is what guarantees the same log is never handed out
// twice, even with simultaneous buyers, without needing a special SQL
// function.
async function claimInventoryRows(productKey, qty, userId, orderRef) {
  const { data: candidates, error } = await supabase
    .from('product_inventory')
    .select('id, credential')
    .eq('product_key', productKey)
    .eq('status', 'available')
    .order('id', { ascending: true })
    .limit(qty + 10); // small buffer in case a few are lost to a concurrent race

  if (error) throw new Error('Could not read inventory: ' + error.message);
  if (!candidates || !candidates.length) return [];

  const claimed = [];
  for (const row of candidates) {
    if (claimed.length >= qty) break;
    const { data: updated, error: updErr } = await supabase
      .from('product_inventory')
      .update({
        status: 'sold',
        sold_to: userId,
        order_id: orderRef,
        sold_at: new Date().toISOString()
      })
      .eq('id', row.id)
      .eq('status', 'available') // <-- the atomic guard described above
      .select('id, credential')
      .maybeSingle();

    if (!updErr && updated) claimed.push(updated);
  }
  return claimed;
}

// If we couldn't claim the full quantity requested (stock ran out from
// under us in a race, or drifted from reality), give back whatever partial
// rows we DID claim rather than leaving the order half-fulfilled.
async function releaseClaims(rows) {
  if (!rows || !rows.length) return;
  const ids = rows.map(r => r.id);
  await supabase
    .from('product_inventory')
    .update({ status: 'available', sold_to: null, order_id: null, sold_at: null })
    .in('id', ids);
}

async function syncStockCount(productKey) {
  const { count } = await supabase
    .from('product_inventory')
    .select('id', { count: 'exact', head: true })
    .eq('product_key', productKey)
    .eq('status', 'available');

  const available = count || 0;
  await supabase
    .from('products')
    .update({ stock_quantity: available, is_available: available > 0 })
    .eq('product_key', productKey);

  return available;
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
  const { product_key, quantity = 1, external_order_id, user_id } = body;

  if (!product_key || !user_id) {
    return res.status(400).json({ success: false, message: 'product_key and user_id are required' });
  }

  const qty = Math.max(1, Math.min(100, parseInt(quantity, 10) || 1));
  let originalBalance = 0;
  let total = 0;
  let productName = '';
  let customerId = null;
  let deducted = false;
  let balanceColumn = 'balance_ngn';
  let claimedRows = [];

  try {
    // 1. Product from DB
    const { data: product, error: prodErr } = await supabase
      .from('products')
      .select('id, product_key, name, price, stock_quantity, source, display_description, description')
      .eq('product_key', product_key)
      .single();

    if (prodErr || !product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    if (!isManualProduct(product)) {
      // Safety net in case this endpoint gets called for the wrong product
      // (e.g. a routing mistake on the frontend).
      return res.status(400).json({ success: false, message: 'This product is not a manual product' });
    }

    total = Number(product.price) * qty;
    productName = product.name;

    // 2. User balance (support balance_ngn or balance, whichever this project uses)
    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('balance_ngn, balance, customer_id')
      .eq('id', user_id)
      .single();

    if (profileErr || !profile) {
      return res.status(400).json({ success: false, message: 'User profile not found' });
    }

    if (profile.balance_ngn != null) {
      balanceColumn = 'balance_ngn';
      originalBalance = Number(profile.balance_ngn || 0);
    } else {
      balanceColumn = 'balance';
      originalBalance = Number(profile.balance || 0);
    }
    customerId = profile.customer_id;

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
      return res.status(500).json({ success: false, message: 'Could not debit your balance. Please try again.' });
    }
    deducted = true;

    // 4. Claim `qty` credentials from product_inventory
    const orderRef = external_order_id || `MJ-MAN-${String(user_id).slice(0, 8)}-${Date.now()}`;
    claimedRows = await claimInventoryRows(product_key, qty, user_id, orderRef);

    if (claimedRows.length < qty) {
      // Couldn't fully fulfill — give back any partial claims, refund, fail cleanly.
      await releaseClaims(claimedRows);
      claimedRows = [];

      await supabase.from('profiles').update({ [balanceColumn]: originalBalance }).eq('id', user_id);

      await syncStockCount(product_key); // reflect true remaining stock after the failed attempt

      await supabase.from('transactions').insert({
        user_id,
        customer_id: customerId,
        type: 'purchase_failed',
        category: productName,
        title: productName,
        subtitle: 'Failed: not enough stock available',
        amount: `₦${total.toLocaleString()}`,
        amount_ngn: total,
        status: 'failed'
      });

      await supabase.from('transactions').insert({
        user_id,
        customer_id: customerId,
        type: 'refund',
        category: productName,
        title: 'Automatic Refund',
        subtitle: 'Not enough stock available – balance restored',
        amount: `₦${total.toLocaleString()}`,
        amount_ngn: total,
        status: 'refunded'
      });

      return res.status(400).json({
        success: false,
        code: 'OUT_OF_STOCK',
        message: 'Not enough stock available right now. Your balance has been refunded — please try a smaller quantity.'
      });
    }

    // 5. Success → save one order row per credential delivered
    const orderDescription = (product.display_description || product.description || '').trim() || null;
    const detailsText = claimedRows.map(r => r.credential).filter(Boolean).join('\n\n');

    for (const row of claimedRows) {
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
        login_credentials: row.credential,
        supplier_ref: String(row.id),
        guide_url: 'https://t.me/mj_hub_tg'
      });
    }

    await supabase.from('transactions').insert({
      user_id,
      customer_id: customerId,
      type: 'log',
      category: 'log',
      title: productName,
      subtitle: `Qty: ${qty} · Manual`,
      amount: `₦${total.toLocaleString()}`,
      amount_ngn: total,
      status: 'completed',
      product_details: detailsText
    });

    // 6. Stock: recount actual remaining available rows rather than just
    // subtracting, so it self-heals against any drift.
    await syncStockCount(product_key);

    // 7. Return credentials to the customer
    return res.status(200).json({
      success: true,
      message: 'Order fulfilled successfully',
      data: {
        items: claimedRows.map(r => ({ details: r.credential })),
        total_amount: total,
        new_balance: newBalance,
        order_id: orderRef,
        source: 'manual'
      }
    });

  } catch (err) {
    console.error('order-manual error:', err);

    // Safety net: undo whatever we can if something blew up mid-flight.
    try {
      if (claimedRows.length) await releaseClaims(claimedRows);
      if (deducted) {
        await supabase.from('profiles').update({ [balanceColumn]: originalBalance }).eq('id', user_id);
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
      }
    } catch (refundErr) {
      console.error('CRITICAL: Auto-refund failed', refundErr);
    }

    return res.status(500).json({
      success: false,
      message: deducted
        ? 'Something went wrong. Your balance has been refunded.'
        : 'Something went wrong. Please try again.'
    });
  }
}
