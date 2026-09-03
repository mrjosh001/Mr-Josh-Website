import { createClient } from '@supabase/supabase-js';
import { formatCredentials, formatMultiLogCredentials, joinRawLogDetails } from '../lib/formatCredentials.js';

/**
 * POST /api/order-manual
 * Manual / shared stock products → always write to `orders`
 * (same table My Orders + admin LOGS read).
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
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

async function claimInventoryRows(productKey, qty, userId, orderRef) {
  const { data: candidates, error } = await supabase
    .from('product_inventory')
    .select('id, credential')
    .eq('product_key', productKey)
    .eq('status', 'available')
    .order('id', { ascending: true })
    .limit(qty + 10);

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
      .eq('status', 'available')
      .select('id, credential')
      .maybeSingle();

    if (!updErr && updated) claimed.push(updated);
  }
  return claimed;
}

async function releaseClaims(rows) {
  if (!rows || !rows.length) return;
  const ids = rows
    .filter((r) => r && !r.shared && r.id != null && !String(r.id).startsWith('shared-'))
    .map((r) => r.id);
  if (!ids.length) return;
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

async function requireAuthUser(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token || token.includes('service_role')) {
    return { error: { status: 401, message: 'Not signed in' } };
  }
  const {
    data: { user },
    error
  } = await supabase.auth.getUser(token);
  if (error || !user) {
    return { error: { status: 401, message: 'Invalid or expired session' } };
  }
  return { user };
}

/**
 * Insert into orders using only columns that exist on THIS project.
 * login_credentials_raw is saved when the column exists (true supplier payload for admin).
 */
async function insertLogOrder(row) {
  const optional = [
    'login_credentials_raw',
    'supplier_ref',
    'guide_url',
    'product_type',
    'description',
    'product_id',
    'product_code'
  ];

  let attempt = { ...row };
    if (!attempt.created_at) attempt.created_at = new Date().toISOString();

  let lastErr = null;
  for (let i = 0; i <= optional.length; i++) {
    const { error } = await supabase.from('orders').insert(attempt);
    if (!error) return null;
    lastErr = error;
    const msg = String(error.message || '');
    if (!/column|schema cache|Could not find/i.test(msg)) return error;
    if (i >= optional.length) break;
    const drop = optional[i];
    if (Object.prototype.hasOwnProperty.call(attempt, drop)) {
      const { [drop]: _removed, ...rest } = attempt;
      attempt = rest;
    }
  }

  // Minimal row — matches what your successful SQL repairs used
  const minimal = {
    order_id: row.order_id,
    user_id: row.user_id,
    product_name: row.product_name || row.product_code || 'Manual product',
    quantity: row.quantity || 1,
    amount: row.amount || 0,
    status: 'completed',
    login_credentials: row.login_credentials || null,
    created_at: row.created_at || new Date().toISOString()
  };
  const { error: minErr } = await supabase.from('orders').insert(minimal);
  if (minErr) {
    console.error('[order-manual] minimal orders insert failed', minErr.message);
    return minErr;
  }
  return null;
}


/** Idempotency: same external_order_id for same user → return existing order, no second charge/delivery */
async function findExistingLogOrder(userId, orderRef) {
  if (!orderRef || !userId) return null;
  try {
    const { data } = await supabase
      .from('orders')
      .select('order_id, product_name, quantity, amount, status, login_credentials, supplier_ref, created_at')
      .eq('order_id', String(orderRef))
      .eq('user_id', userId)
      .maybeSingle();
    if (data && String(data.status || '').toLowerCase() !== 'failed') return data;
  } catch (_) {}
  return null;
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

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ success: false, message: auth.error.message });
  }
  const user_id = auth.user.id;

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const { product_key, quantity = 1, external_order_id } = body;

  if (!product_key) {
    return res.status(400).json({ success: false, message: 'product_key is required' });
  }

  const qty = Math.max(1, Math.min(10, parseInt(quantity, 10) || 1));
  let originalBalance = 0;
  let total = 0;
  let productName = '';
  let customerId = null;
  let deducted = false;
  let balanceColumn = 'balance';
  let claimedRows = [];

  try {
    const { data: product, error: prodErr } = await supabase
      .from('products')
      .select(
        'id, product_key, name, price, stock_quantity, source, display_description, description, is_shared, shared_credential, is_available'
      )
      .eq('product_key', product_key)
      .single();

    if (prodErr || !product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    if (!isManualProduct(product)) {
      return res.status(400).json({ success: false, message: 'This product is not a manual product' });
    }

    total = Number(product.price) * qty;
    productName = product.name;

    let { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('customer_id, balance')
      .eq('id', user_id)
      .maybeSingle();

    if (profileErr || !profile) {
      const email = auth.user.email || null;
      const name =
        auth.user.user_metadata?.full_name ||
        auth.user.user_metadata?.name ||
        (email ? String(email).split('@')[0] : 'User');
      const customer_id = 'MJ' + String(Date.now()).slice(-8) + Math.random().toString(36).slice(2, 5).toUpperCase();
      const { error: upErr } = await supabase.from('profiles').upsert({
        id: user_id,
        email,
        full_name: name,
        customer_id,
        balance: 0,
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' });
      if (upErr) {
        console.error('[order-manual] profile upsert', upErr.message || profileErr?.message);
        return res.status(400).json({ success: false, message: 'User profile not found' });
      }
      const again = await supabase
        .from('profiles')
        .select('customer_id, balance')
        .eq('id', user_id)
        .maybeSingle();
      profile = again.data;
      if (!profile) {
        return res.status(400).json({ success: false, message: 'User profile not found' });
      }
    }

    customerId = profile.customer_id;

    const orderRefEarly = external_order_id || null;
    if (orderRefEarly) {
      const existing = await findExistingLogOrder(user_id, orderRefEarly);
      if (existing) {
        const { data: balRow } = await supabase.from('profiles').select('balance').eq('id', user_id).maybeSingle();
        return res.status(200).json({
          success: true,
          replayed: true,
          message: 'Order already completed',
          data: {
            order_id: existing.order_id,
            login_credentials: existing.login_credentials,
            items: existing.login_credentials
              ? [{ details: existing.login_credentials }]
              : [],
            quantity: existing.quantity,
            new_balance: Number(balRow?.balance || 0)
          }
        });
      }
    }

    // Atomic check-and-debit: the database re-verifies balance at write
    // time under a row lock, so two near-simultaneous requests (e.g. a
    // double-click) can't both read the same starting balance and both
    // succeed — the second one correctly sees the already-reduced balance
    // and fails with insufficient funds instead of silently overcharging.
    const { data: debitResult, error: debitRpcErr } = await supabase
      .rpc('debit_balance_if_sufficient', { p_user_id: user_id, p_amount: total })
      .single();

    if (debitRpcErr) {
      return res.status(500).json({ success: false, message: 'Could not debit your balance. Please try again.' });
    }

    if (!debitResult || !debitResult.success) {
      return res.status(402).json({
        success: false,
        message: 'Insufficient balance',
        required: total,
        available: debitResult ? Number(debitResult.new_balance || 0) : 0
      });
    }

    originalBalance = Number(debitResult.new_balance) + total;
    const newBalance = Number(debitResult.new_balance);
    balanceColumn = 'balance';
    deducted = true;

    const orderRef = external_order_id || `MJ-MAN-${String(user_id).slice(0, 8)}-${Date.now()}`;
    const isShared =
      product.is_shared === true || product.is_shared === 'true' || product.is_shared === 1;
    const sharedCred = (product.shared_credential || '').trim();

    if (isShared) {
      if (!sharedCred) {
        await supabase.rpc('credit_balance', { p_user_id: user_id, p_amount: total });
        deducted = false;
        return res.status(400).json({
          success: false,
          message: 'This shared product has no content set. Ask admin to add the shared credential.'
        });
      }
      claimedRows = Array.from({ length: qty }, (_, i) => ({
        id: `shared-${product.id}-${i}`,
        credential: sharedCred,
        shared: true
      }));
    } else {
      claimedRows = await claimInventoryRows(product_key, qty, user_id, orderRef);
    }

    if (claimedRows.length < qty) {
      if (!isShared) await releaseClaims(claimedRows);
      claimedRows = [];
      await supabase.rpc('credit_balance', { p_user_id: user_id, p_amount: total });
      if (!isShared) await syncStockCount(product_key);

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
        message:
          'Not enough stock available right now. Your balance has been refunded — please try a smaller quantity.'
      });
    }

    const orderDescription =
      (product.display_description || product.description || '').trim() || null;
    const formatHint = product.display_description || product.description || product.name || '';
    const itemsForFmt = claimedRows.map((r) => ({ details: r.credential }));
    const detailsText =
      joinRawLogDetails(itemsForFmt) ||
      claimedRows
        .map((r) => r.credential)
        .filter(Boolean)
        .join('\n\n');
    const combinedCreds =
      formatMultiLogCredentials(itemsForFmt, formatHint) ||
      (claimedRows[0]
        ? formatCredentials(claimedRows[0].credential, formatHint) || claimedRows[0].credential
        : null);
    const supplierRefs = claimedRows
      .map((r) => r.id)
      .filter(Boolean)
      .map(String)
      .join(', ');

    // Write to orders — NO login_credentials_raw
    const insertErr = await insertLogOrder({
      order_id: orderRef,
      user_id,
      product_id: product.id,
      product_code: product_key,
      product_name: productName,
      product_type: 'log',
      description: orderDescription,
      quantity: claimedRows.length || qty,
      amount: total,
      status: 'completed',
      login_credentials: combinedCreds || detailsText,
      supplier_ref: supplierRefs || orderRef,
      guide_url: 'https://t.me/mj_hub_tg',
      created_at: new Date().toISOString()
    });

    if (insertErr) {
      console.error('[order-manual] orders insert failed after retries', insertErr.message, {
        order_id: orderRef,
        product_key
      });
    }

    await supabase.from('transactions').insert({
      user_id,
      customer_id: customerId,
      type: 'log',
      category: 'log',
      title: productName,
      subtitle: isShared ? `Qty: ${qty} · Shared` : `Qty: ${qty} · Manual`,
      amount: `₦${total.toLocaleString()}`,
      amount_ngn: total,
      status: 'completed',
      product_details: detailsText
    });

    if (isShared) {
      await supabase
        .from('products')
        .update({ stock_quantity: 99999, is_available: true })
        .eq('product_key', product_key);
    } else {
      await syncStockCount(product_key);
    }

    return res.status(200).json({
      success: true,
      message: 'Order fulfilled successfully',
      data: {
        items: claimedRows.map((r) => ({
          details:
            formatCredentials(
              r.credential,
              product.display_description || product.description || product.name
            ) || r.credential
        })),
        login_credentials: combinedCreds || detailsText,
        total_amount: total,
        new_balance: newBalance,
        order_id: orderRef,
        source: 'manual'
      }
    });
  } catch (err) {
    console.error('order-manual error:', err);
    try {
      if (claimedRows.length) await releaseClaims(claimedRows);
      if (deducted) {
        await supabase.rpc('credit_balance', { p_user_id: user_id, p_amount: total });
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
