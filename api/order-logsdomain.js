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


function stripHtml(html) {
  if (!html) return '';
  let text = String(html)
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  text = text.replace(/<br\s*\/?>/gi, ' ').replace(/<\/(div|p|li)>/gi, ' ').replace(/<[^>]*>/g, '');
  return text.replace(/\s+/g, ' ').trim();
}

function applyLdMarkup(supplierPrice) {
  const rate = Number(process.env.USD_TO_NGN_RATE) || Number(process.env.USD_TO_NGN) || 1;
  // Logs Domain prices are often already NGN; if value looks like USD (< 50) convert
  let base = Number(supplierPrice) || 0;
  if (base > 0 && base < 80) base = base * (Number(process.env.USD_TO_NGN_RATE) || Number(process.env.USD_TO_NGN) || 1500);
  const percent = 50 + Math.random() * 50;
  const finalPrice = Math.ceil(base * (1 + percent / 100));
  return Math.max(Math.ceil(finalPrice / 50) * 50, 500);
}

function readLdStock(item) {
  const keys = ['stock', 'stock_quantity', 'quantity', 'available', 'qty', 'count'];
  for (const k of keys) {
    if (item[k] != null && !Number.isNaN(Number(item[k]))) return Math.max(0, Number(item[k]));
  }
  return 0;
}

async function fetchLdCategories() {
  if (!LD_KEY) throw new Error('LOGSDOMAIN_API_KEY not configured');
  const all = [];
  let page = 1;
  const perPage = 100;
  for (;;) {
    const url = `${LD_BASE}/categories?page=${page}&per_page=${perPage}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${LD_KEY}` }
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Logs Domain categories ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    const batch = Array.isArray(json.data)
      ? json.data
      : (json.data?.data || json.data?.items || json.data?.categories || []);
    if (!Array.isArray(batch) || !batch.length) break;
    all.push(...batch);
    const lastPage = Number(json.last_page || json.data?.last_page || json.meta?.last_page || 0);
    if (lastPage && page >= lastPage) break;
    if (!lastPage && batch.length < perPage) break;
    page += 1;
    if (page > 50) break;
  }
  return all;
}

async function handleLdSync(req, res) {
  try {
    if (!LD_KEY) {
      return res.status(503).json({ success: false, message: 'LOGSDOMAIN_API_KEY not configured' });
    }
    const categories = await fetchLdCategories();
    let newCount = 0, updatedCount = 0, withStock = 0;
    const keys = categories.map((c) => `ld_${c.id}`).filter(Boolean);
    const existingMap = new Map();
    if (keys.length) {
      for (let i = 0; i < keys.length; i += 100) {
        const chunk = keys.slice(i, i + 100);
        const { data } = await supabase
          .from('products')
          .select('id, product_key, price, price_source, category, admin_hidden, is_available')
          .eq('source', 'logsdomain')
          .in('product_key', chunk);
        for (const r of data || []) existingMap.set(String(r.product_key), r);
      }
    }
    const now = new Date().toISOString();
    for (const item of categories) {
      if (item.id == null) continue;
      const productKey = `ld_${item.id}`;
      const name = item.name || `Category ${item.id}`;
      const supplierPrice = Number(item.price) || 0;
      const stock = readLdStock(item);
      if (stock > 0) withStock += 1;
      const sell = applyLdMarkup(supplierPrice);
      const existing = existingMap.get(productKey);
      if (existing) {
        const patch = {
          name,
          supplier_price: supplierPrice,
          stock_quantity: stock,
          updated_at: now
        };
        if (existing.price_source === 'system' || existing.price_source == null) {
          patch.price = sell;
          patch.price_source = 'system';
        }
        if (!existing.admin_hidden) {
          patch.is_available = stock > 0;
        }
        const { error } = await supabase.from('products').update(patch).eq('id', existing.id);
        if (!error) updatedCount += 1;
      } else {
        const { error } = await supabase.from('products').insert({
          product_key: productKey,
          name,
          category: item.parent_category?.name || 'Logs Domain',
          price: sell,
          price_source: 'system',
          supplier_price: supplierPrice,
          stock_quantity: stock,
          is_available: stock > 0,
          source: 'logsdomain',
          description: stripHtml(item.description || '') || null,
          currency: 'NGN',
          updated_at: now
        });
        if (!error) newCount += 1;
      }
    }
    return res.status(200).json({
      success: true,
      message: 'Logs Domain sync complete',
      synced: categories.length,
      new_products: newCount,
      updated_products: updatedCount,
      with_stock: withStock
    });
  } catch (err) {
    console.error('[ld sync]', err);
    return res.status(500).json({ success: false, message: err.message || 'Logs Domain sync failed' });
  }
}

// ---------- BulkMail (same route — no extra Vercel function) ----------
const BM_BASE = 'https://bulkmail.shop/api/v2';
const BM_KEY = process.env.BULKMAIL_API_KEY || process.env.BULK_MAIL_API_KEY || '';

function bmProductIdFromKey(productKey) {
  const m = String(productKey || '').match(/^bm_(\d+)$/i);
  return m ? parseInt(m[1], 10) : null;
}

async function bmFetch(path, { method = 'GET', body } = {}) {
  if (!BM_KEY) return { ok: false, status: 503, data: { error: 'BULKMAIL_API_KEY not set' } };
  try {
    const res = await fetch(`${BM_BASE}${path}`, {
      method,
      headers: { 'X-API-Key': BM_KEY, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 502, data: { error: e.message || 'BulkMail unreachable' } };
  }
}

function bmSellPriceNgn(usd) {
  const rate = Number(process.env.USD_TO_NGN_RATE) || Number(process.env.USD_TO_NGN) || 1500;
  const supplierNgn = Number(usd || 0) * rate;
  const finalPrice = Math.max(Math.ceil(supplierNgn * 1.7), Math.ceil(supplierNgn + 500), 1000);
  return Math.ceil(finalPrice / 50) * 50;
}

async function handleBulkmailSync(req, res) {
  try {
    if (!BM_KEY) {
      return res.status(503).json({ success: false, message: 'BULKMAIL_API_KEY not configured' });
    }
    const all = [];
    let page = 1, lastPage = 1;
    do {
      const g = await bmFetch(`/products?page=${page}&per_page=100`);
      if (!g.ok) {
        return res.status(g.status || 400).json({
          success: false,
          message: g.data?.error || g.data?.message || 'BulkMail products failed'
        });
      }
      const batch = Array.isArray(g.data?.data) ? g.data.data : (Array.isArray(g.data) ? g.data : []);
      all.push(...batch);
      lastPage = Number(g.data?.meta?.total_pages || g.data?.meta?.last_page || 1);
      page += 1;
    } while (page <= lastPage && page <= 50);

    const stockMap = new Map();
    const ids = all.map((p) => p.id).filter(Boolean);
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const st = await bmFetch(`/stock/check?ids=${chunk.join(',')}`);
      if (st.ok && Array.isArray(st.data?.data)) {
        for (const row of st.data.data) stockMap.set(Number(row.product_id), row);
      }
    }

    let totalNew = 0, totalUpdated = 0;
    const now = new Date().toISOString();
    const keys = all.map((p) => `bm_${p.id}`);
    const existingMap = new Map();
    if (keys.length) {
      for (let i = 0; i < keys.length; i += 100) {
        const { data } = await supabase
          .from('products')
          .select('id, product_key, price, price_source, admin_hidden, category')
          .eq('source', 'bulkmail')
          .in('product_key', keys.slice(i, i + 100));
        for (const r of data || []) existingMap.set(String(r.product_key), r);
      }
    }

    for (const p of all) {
      if (p.id == null) continue;
      const productKey = `bm_${p.id}`;
      const usd = Number(p.price || 0);
      const st = stockMap.get(Number(p.id));
      const stockQty = st != null ? Number(st.stock_count || 0) : Number(p.stock_quantity || 0);
      const inStock = st != null ? !!st.in_stock : (p.in_stock !== false && stockQty > 0);
      const sell = bmSellPriceNgn(usd);
      const existing = existingMap.get(productKey);
      const name = String(p.name || p.sku || `BulkMail #${p.id}`).trim();
      if (existing) {
        const patch = { name, supplier_price: usd, stock_quantity: stockQty, updated_at: now };
        if (existing.price_source === 'system' || existing.price_source == null) {
          patch.price = sell;
          patch.price_source = 'system';
        }
        if (!existing.admin_hidden) patch.is_available = inStock && stockQty > 0;
        const { error } = await supabase.from('products').update(patch).eq('id', existing.id);
        if (!error) totalUpdated += 1;
      } else {
        const { error } = await supabase.from('products').insert({
          product_key: productKey,
          name,
          category: 'BulkMail',
          price: sell,
          price_source: 'system',
          supplier_price: usd,
          stock_quantity: stockQty,
          is_available: inStock && stockQty > 0,
          source: 'bulkmail',
          description: String(p.description || '').trim() || null,
          currency: 'NGN',
          updated_at: now
        });
        if (!error) totalNew += 1;
      }
    }

    return res.status(200).json({
      success: true,
      message: 'BulkMail sync complete',
      synced: all.length,
      new_products: totalNew,
      updated_products: totalUpdated
    });
  } catch (err) {
    console.error('[bulkmail sync]', err);
    return res.status(500).json({ success: false, message: err.message || 'BulkMail sync failed' });
  }
}

async function handleBulkmailOrder(req, res, body) {
  const product_key = String(body.product_key || '').trim();
  const productId = bmProductIdFromKey(product_key);
  if (!productId) {
    return res.status(400).json({ success: false, message: 'Invalid BulkMail product_key (bm_123)' });
  }
  if (!BM_KEY) {
    return res.status(503).json({ success: false, message: 'BulkMail is not configured' });
  }
  // Auth via user_id from body (legacy) — prefer JWT if present
  let user_id = body.user_id;
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token && !token.includes('service_role')) {
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user) user_id = user.id;
    }
  }
  if (!user_id) {
    return res.status(401).json({ success: false, message: 'Not signed in' });
  }
  const qty = Math.max(1, Math.min(50, parseInt(body.quantity, 10) || 1));
  const { data: product } = await supabase.from('products').select('*').eq('product_key', product_key).eq('source', 'bulkmail').maybeSingle();
  if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
  const unit = Number(product.price) || 0;
  const total = unit * qty;
  if (!(total > 0)) return res.status(400).json({ success: false, message: 'Invalid price' });

  const { data: debited, error: debErr } = await supabase.rpc('debit_balance_if_sufficient', {
    p_user_id: user_id,
    p_amount: total
  });
  if (debErr || debited === false || debited === null) {
    return res.status(400).json({ success: false, message: 'Insufficient balance' });
  }

  const orderRes = await bmFetch('/orders', { method: 'POST', body: { product_id: productId, quantity: qty } });
  if (!orderRes.ok || orderRes.data?.success === false) {
    try { await supabase.rpc('credit_balance', { p_user_id: user_id, p_amount: total }); } catch (_) {}
    return res.status(400).json({
      success: false,
      message: orderRes.data?.error || orderRes.data?.message || 'Supplier could not fulfill'
    });
  }
  const od = orderRes.data?.data || {};
  let stockItems = Array.isArray(od.stock_items) ? od.stock_items : [];
  if (!stockItems.length && od.id) {
    const det = await bmFetch(`/orders/${od.id}`);
    stockItems = Array.isArray(det.data?.data?.stock_items) ? det.data.data.stock_items : stockItems;
  }
  const lines = stockItems.map((s) => String(s || '').trim()).filter(Boolean);
  const detailsText = lines.join('\n') || 'Delivered';
  const { data: prof } = await supabase.from('profiles').select('balance, customer_id').eq('id', user_id).maybeSingle();
  const orderRef = body.external_order_id || `BM-${od.order_number || od.id || Date.now()}`;

  await supabase.from('orders').insert({
    user_id,
    customer_id: prof?.customer_id || null,
    product_key,
    product_name: product.name,
    quantity: qty,
    amount: total,
    status: 'completed',
    source: 'bulkmail',
    order_id: orderRef,
    login_credentials: detailsText,
    guide_url: 'https://t.me/mj_hub_tg'
  }).then(({ error }) => { if (error) console.error('[bulkmail] order insert', error.message); });

  try {
    await supabase.from('transactions').insert({
      user_id,
      customer_id: prof?.customer_id || null,
      type: 'purchase',
      category: product.name,
      title: product.name,
      subtitle: `Qty: ${qty} · BulkMail`,
      amount: `₦${total.toLocaleString()}`,
      amount_ngn: total,
      status: 'completed'
    });
  } catch (_) {}

  return res.status(200).json({
    success: true,
    message: 'Order fulfilled successfully',
    data: {
      items: lines.map((d, i) => ({ details: d, serial: String(i + 1) })),
      login_credentials: detailsText,
      total_amount: total,
      new_balance: prof?.balance,
      order_id: orderRef,
      source: 'bulkmail'
    }
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Parse query (Vercel + raw URL)
  const q = Object.assign({}, req.query || {});
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    u.searchParams.forEach((v, k) => { if (q[k] == null || q[k] === '') q[k] = v; });
  } catch (_) {}
  const action = String(q.action || '').toLowerCase();

  // GET (and POST with action) = catalog sync — same pattern as /api/sujan and /api/classy
  if (req.method === 'GET' || action === 'sync' || action === 'bulkmail_sync') {
    if (action === 'bulkmail_sync') return handleBulkmailSync(req, res);
    // default GET or ?action=sync → Logs Domain catalog
    if (req.method === 'GET' || action === 'sync') return handleLdSync(req, res);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

  // BulkMail purchase
  if (/^bm_/i.test(String(body.product_key || ''))) {
    return handleBulkmailOrder(req, res, body);
  }

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
