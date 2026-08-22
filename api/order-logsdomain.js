import { createClient } from '@supabase/supabase-js';
import { formatCredentials } from '../lib/formatCredentials.js';

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


/** Normalize one supplier item → { details, serial } */
function normalizeLdItem(raw, index = 0) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const details = raw.trim();
    return details ? { details, serial: String(index + 1) } : null;
  }
  if (typeof raw !== 'object') return null;
  const details = String(
    raw.details || raw.credentials || raw.log || raw.login || raw.data || raw.content || ''
  ).trim();
  if (!details) return null;
  const serial = raw.serial != null ? String(raw.serial) : (raw.id != null ? String(raw.id) : String(index + 1));
  return { details, serial };
}

/**
 * Logs Domain sometimes returns:
 *  - data.items[]
 *  - data as array
 *  - data.logs / data.accounts
 *  - a single details blob with multiple accounts separated by blank lines
 */
function extractLdItems(orderData) {
  const d = orderData && orderData.data;
  let rawList = [];
  if (!d) {
    // rare: top-level items
    if (Array.isArray(orderData?.items)) rawList = orderData.items;
  } else if (Array.isArray(d)) {
    rawList = d;
  } else if (Array.isArray(d.items)) {
    rawList = d.items;
  } else if (Array.isArray(d.logs)) {
    rawList = d.logs;
  } else if (Array.isArray(d.accounts)) {
    rawList = d.accounts;
  } else if (d.details || d.credentials || d.log) {
    rawList = [d];
  }

  const normalized = [];
  rawList.forEach((raw, i) => {
    const n = normalizeLdItem(raw, i);
    if (n) normalized.push(n);
  });

  // Split multi-account blobs (blank-line separated) into separate logs
  const expanded = [];
  for (const item of normalized) {
    const parts = String(item.details)
      .split(/\n\s*\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 8);
    if (parts.length > 1) {
      parts.forEach((p, j) => {
        expanded.push({
          details: p,
          serial: `${item.serial || 'x'}-${j + 1}`
        });
      });
    } else {
      expanded.push(item);
    }
  }
  return expanded;
}

async function fetchLdOrderById(orderId) {
  if (!orderId || !LD_KEY) return null;
  try {
    // Try direct GET by id (some panels support this)
    let res = await fetch(`${LD_BASE}/logs/orders/${encodeURIComponent(orderId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${LD_KEY}`, Accept: 'application/json' }
    });
    if (res.ok) {
      const json = await res.json().catch(() => null);
      if (json) return json;
    }
    // Fallback: list recent orders and find match
    res = await fetch(`${LD_BASE}/logs/orders?per_page=50`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${LD_KEY}`, Accept: 'application/json' }
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const list = Array.isArray(json?.data) ? json.data : (json?.data?.data || []);
    const hit = list.find((o) => String(o.order_id || o.id) === String(orderId));
    if (hit) return { success: true, data: hit };
  } catch (e) {
    console.warn('[order-logsdomain] fetchLdOrderById', e.message || e);
  }
  return null;
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
/* formatCredentials from lib */


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


async function insertLogOrder(row) {
  let { error } = await supabase.from('orders').insert(row);
  if (error && /login_credentials_raw|schema cache|column/i.test(String(error.message || ''))) {
    const { login_credentials_raw, ...rest } = row;
    ({ error } = await supabase.from('orders').insert(rest));
  }
  return error;
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
    external_order_id
  } = body;

  if (!product_key) {
    return res.status(400).json({ success: false, message: 'product_key is required' });
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
      .select('id, product_key, name, price, stock_quantity, source, description, display_description')
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
    let newBalance = originalBalance - total;
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

    // 6. Success → save orders (normalize every response shape)
    let items = extractLdItems(orderData);
    const supplierOrderId = orderData.data?.order_id || orderData.data?.id || orderRef;
    const supplierQty = Number(orderData.data?.quantity) || qty;

    // If supplier says qty>1 but we only got 1 item blob, try re-fetch order
    if (items.length < supplierQty || items.length < qty) {
      const refetch = await fetchLdOrderById(supplierOrderId);
      if (refetch) {
        const more = extractLdItems(refetch);
        if (more.length > items.length) items = more;
      }
    }

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

    // Each delivered log must be its own orders row with a UNIQUE order_id.
    // Reusing the same supplier order_id for every line caused duplicate-key
    // failures on the 2nd+ insert — only the first log appeared in My Orders / admin.
    const deliveredCount = items.length;
    let savedCount = 0;

    if (deliveredCount > 0) {
      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const lineOrderId = `${supplierOrderId}-${idx + 1}`;
        const insertErr = await insertLogOrder({
          order_id: lineOrderId,
          user_id,
          product_id: product.id,
          product_code: product_key,
          product_name: productName,
          product_type: 'log',
          description: (product.display_description || product.description || '').trim() || null,
          quantity: 1,
          amount: product.price,
          status: 'completed',
          login_credentials: formatCredentials(item.details, product.display_description || product.description || product.name),
          login_credentials_raw: item.details || null,
          supplier_ref: String(item.serial || item.id || `${supplierOrderId}-${idx + 1}`),
          guide_url: 'https://t.me/mj_hub_tg'
        });
        if (insertErr) {
          console.error('[order-logsdomain] FAILED to save order row:', insertErr.message, {
            order_id: lineOrderId, user_id, product_key, idx
          });
          // Retry once with unique suffix (duplicate order_id race)
          const retryId = `${lineOrderId}-${Date.now().toString(36)}`;
          const retryErr = await insertLogOrder({
            order_id: retryId,
            user_id,
            product_id: product.id,
            product_code: product_key,
            product_name: productName,
            product_type: 'log',
            description: (product.display_description || product.description || '').trim() || null,
            quantity: 1,
            amount: product.price,
            status: 'completed',
            login_credentials: formatCredentials(item.details, product.display_description || product.description || product.name),
            login_credentials_raw: item.details || null,
            supplier_ref: String(item.serial || item.id || retryId),
            guide_url: 'https://t.me/mj_hub_tg'
          });
          if (!retryErr) savedCount += 1;
          else console.error('[order-logsdomain] retry also failed', retryErr.message);
        } else {
          savedCount += 1;
        }
      }
    } else {
      // fallback single row if API returns no items array
      const insertErr = await insertLogOrder({
        order_id: `${supplierOrderId}-1`,
        user_id,
        product_id: product.id,
        product_code: product_key,
        product_name: productName,
        product_type: 'log',
        description: JSON.stringify(orderData.data || {}),
        quantity: qty,
        amount: total,
        status: 'completed',
        login_credentials: formatCredentials(detailsText, product.display_description || product.description || product.name) || detailsText || 'Delivered — see order for details',
        login_credentials_raw: detailsText || null,
        guide_url: 'https://t.me/mj_hub_tg'
      });
      if (insertErr) {
        console.error('[order-logsdomain] FAILED to save order row (fallback branch):', insertErr.message, { order_id: supplierOrderId, user_id, product_key });
      } else {
        savedCount = 1;
      }
    }

    // If supplier delivered fewer items than paid quantity, refund the shortfall
    const shortfall = Math.max(0, qty - Math.max(deliveredCount, savedCount > 0 && deliveredCount === 0 ? 1 : deliveredCount));
    let refundedShortfall = 0;
    if (shortfall > 0) {
      refundedShortfall = shortfall * Number(product.price || 0);
      const balanceAfterShortfall = Number(newBalance) + refundedShortfall;
      await supabase
        .from('profiles')
        .update({ [balanceColumn]: balanceAfterShortfall })
        .eq('id', user_id);
      newBalance = balanceAfterShortfall;
      await supabase.from('transactions').insert({
        user_id,
        customer_id: customerId,
        type: 'refund',
        category: productName,
        title: 'Automatic Refund',
        subtitle: `Partial delivery: paid qty ${qty}, received ${deliveredCount} — shortfall refunded`,
        amount: `₦${refundedShortfall.toLocaleString()}`,
        amount_ngn: refundedShortfall,
        status: 'refunded',
        notes: JSON.stringify({ requested: qty, delivered: deliveredCount, supplierOrderId })
      });
      console.warn('[order-logsdomain] partial delivery refund', { qty, deliveredCount, refundedShortfall, supplierOrderId });
    }

    const chargedQty = Math.max(deliveredCount, savedCount > 0 && deliveredCount === 0 ? 1 : deliveredCount);
    const chargedTotal = Math.max(0, total - refundedShortfall);

    await supabase.from('transactions').insert({
      user_id,
      customer_id: customerId,
      type: 'purchase',
      category: productName,
      title: productName,
      subtitle: `Qty: ${chargedQty}${shortfall ? ` of ${qty} requested` : ''} · Logs Domain`,
      amount: `₦${chargedTotal.toLocaleString()}`,
      amount_ngn: chargedTotal,
      status: 'completed',
      product_details: detailsText,
      supplier_order: orderData.data
    });

    await supabase
      .from('products')
      .update({
        stock_quantity: Math.max(0, (product.stock_quantity || 0) - chargedQty),
        is_available: (product.stock_quantity || 0) - chargedQty > 0
      })
      .eq('product_key', product_key);

    return res.status(200).json({
      success: true,
      message: shortfall > 0
        ? `Delivered ${deliveredCount} of ${qty}. Shortfall of ${shortfall} was refunded to your wallet.`
        : 'Order fulfilled successfully',
      data: {
        items: items.length
          ? items.map((i) => ({ details: formatCredentials(i.details, product.display_description || product.description || product.name), serial: i.serial }))
          : [{ details: detailsText || 'Order completed' }],
        total_amount: chargedTotal,
        new_balance: newBalance,
        order_id: supplierOrderId,
        quantity_requested: qty,
        quantity_delivered: deliveredCount,
        quantity_saved: savedCount,
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
