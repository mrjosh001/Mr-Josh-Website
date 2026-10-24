import { createClient } from '@supabase/supabase-js';

/**
 * /api/order-logsdomain
 * GET  ?action=sync            → Logs Domain catalog sync
 * GET  ?action=bulkmail_sync   → BulkMail catalog sync
 * GET  ?action=accszone_sync   → AccsZone catalog sync (hidden until admin enables)
 * POST                         → buy Logs Domain product
 *
 * Env: LOGSDOMAIN_API_KEY, BULKMAIL_API_KEY, ACCSZONE_API_KEY,
 *      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const LD_BASE = 'https://logsdomain.com/api/v1';
const LD_KEY = process.env.LOGSDOMAIN_API_KEY;
const BM_BASE = 'https://bulkmail.shop/api/v2';
const BM_KEY = process.env.BULKMAIL_API_KEY || process.env.BULK_MAIL_API_KEY || '';
const AZ_BASE = 'https://accszone.com/api/v1';
const AZ_KEY = process.env.ACCSZONE_API_KEY || process.env.ACCS_ZONE_API_KEY || '';

function categoryIdFromKey(productKey) {
  if (!productKey) return null;
  const m = String(productKey).match(/^ld_(\d+)$/i);
  if (m) return parseInt(m[1], 10);
  const n = parseInt(productKey, 10);
  return Number.isFinite(n) ? n : null;
}

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
  return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function applyLdMarkup(p) {
  const base = Number(p) || 0;
  const finalPrice = Math.ceil(base * (1 + (50 + Math.random() * 50) / 100));
  return Math.max(Math.ceil(finalPrice / 50) * 50, 500);
}

function readLdStock(item) {
  for (const k of ['available_quantity', 'stock', 'stock_quantity', 'quantity', 'available']) {
    if (item[k] != null && !Number.isNaN(Number(item[k]))) return Math.max(0, Number(item[k]));
  }
  return 0;
}

async function handleLdSync(req, res) {
  try {
    if (!LD_KEY) return res.status(503).json({ success: false, message: 'LOGSDOMAIN_API_KEY not configured' });
    const all = [];
    let page = 1;
    for (;;) {
      const r = await fetch(LD_BASE + '/logs/categories?per_page=100&page=' + page, {
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + LD_KEY }
      });
      if (!r.ok) {
        const text = await r.text();
        return res.status(r.status).json({ success: false, message: 'Logs Domain categories ' + r.status + ': ' + text.slice(0, 300) });
      }
      const json = await r.json();
      const batch = Array.isArray(json.data) ? json.data : (json.data && json.data.data) || [];
      if (!Array.isArray(batch) || !batch.length) break;
      all.push.apply(all, batch);
      const last = Number((json.meta && (json.meta.last_page || json.meta.total_pages)) || (json.data && json.data.last_page) || page);
      if (page >= last || batch.length < 100) break;
      page += 1;
      if (page > 50) break;
    }

    let totalNew = 0, totalUpdated = 0, writeErrors = 0;
    const errorSamples = [];
    const now = new Date().toISOString();

    for (const item of all) {
      const id = item.id ?? item.category_id;
      if (id == null) continue;
      const productKey = 'ld_' + id;
      const name = String(item.name || item.title || ('Logs Domain #' + id)).trim();
      const stock = readLdStock(item);
      const supplierPrice = Number(item.price ?? item.unit_price ?? item.cost ?? 0) || 0;
      const sell = applyLdMarkup(supplierPrice);

      const { data: existing } = await supabase
        .from('products')
        .select('product_key, price, is_available')
        .eq('product_key', productKey)
        .maybeSingle();

      if (existing) {
        const patch = {
          name,
          supplier_price: supplierPrice,
          stock_quantity: stock,
          source: 'logsdomain',
          updated_at: now
        };
        // Do not overwrite admin sell price if already set
        if (!(Number(existing.price) > 0)) patch.price = sell;
        // Stock 0 → hide; stock > 0 does not force show if admin hid it
        if (stock <= 0) patch.is_available = false;
        else if (existing.is_available == null) patch.is_available = true;
        const { error } = await supabase.from('products').update(patch).eq('product_key', productKey);
        if (error) { writeErrors++; if (errorSamples.length < 3) errorSamples.push(error.message); }
        else totalUpdated++;
      } else {
        const { error } = await supabase.from('products').insert({
          product_key: productKey,
          name,
          price: sell,
          supplier_price: supplierPrice,
          stock_quantity: stock,
          is_available: stock > 0,
          source: 'logsdomain',
          description: stripHtml(item.description || '') || null,
          updated_at: now
        });
        if (error) { writeErrors++; if (errorSamples.length < 3) errorSamples.push(error.message); }
        else totalNew++;
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Logs Domain sync complete',
      synced: all.length,
      new_products: totalNew,
      updated_products: totalUpdated,
      write_errors: writeErrors,
      error_samples: errorSamples
    });
  } catch (err) {
    console.error('[logsdomain sync]', err);
    return res.status(500).json({ success: false, message: err.message || 'Logs Domain sync failed' });
  }
}

async function bmFetch(path, opts) {
  opts = opts || {};
  try {
    const res = await fetch(BM_BASE + path, {
      method: opts.method || 'GET',
      headers: { 'X-API-Key': BM_KEY, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: opts.body != null ? JSON.stringify(opts.body) : undefined
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(function () { return {}; }) };
  } catch (e) {
    return { ok: false, status: 502, data: { error: e.message } };
  }
}

function bmSellPriceNgn(usd) {
  const rate = Number(process.env.USD_TO_NGN_RATE) || Number(process.env.USD_TO_NGN) || 1500;
  const supplierNgn = Number(usd || 0) * rate;
  return Math.ceil(Math.max(supplierNgn * 1.7, supplierNgn + 500, 1000) / 50) * 50;
}

async function handleBulkmailSync(req, res) {
  try {
    if (!BM_KEY) return res.status(503).json({ success: false, message: 'BULKMAIL_API_KEY not configured' });
    const all = [];
    let page = 1, lastPage = 1;
    do {
      const g = await bmFetch('/products?page=' + page + '&per_page=100');
      if (!g.ok) return res.status(g.status || 400).json({ success: false, message: (g.data && (g.data.error || g.data.message)) || 'BulkMail products failed' });
      const batch = Array.isArray(g.data && g.data.data) ? g.data.data : (Array.isArray(g.data) ? g.data : []);
      all.push.apply(all, batch);
      lastPage = Number((g.data && g.data.meta && (g.data.meta.total_pages || g.data.meta.last_page)) || 1);
      if (!batch.length) break;
      page += 1;
    } while (page <= lastPage && page <= 50);

    let totalNew = 0, totalUpdated = 0, writeErrors = 0;
    const errorSamples = [];
    const now = new Date().toISOString();

    for (let i = 0; i < all.length; i++) {
      const p = all[i];
      if (p.id == null) continue;
      const productKey = 'bm_' + p.id;
      const usd = Number(p.price || 0) || 0;
      const stockQty = Number(p.stock_quantity || p.stock || 0) || 0;
      const sell = bmSellPriceNgn(usd);
      const name = String(p.name || p.sku || ('BulkMail #' + p.id)).trim();

      const { data: existing } = await supabase.from('products').select('product_key, price, is_available').eq('product_key', productKey).maybeSingle();
      if (existing) {
        const patch = { name: name, supplier_price: usd, stock_quantity: stockQty, source: 'bulkmail', category: 'BulkMail', updated_at: now };
        if (stockQty <= 0) patch.is_available = false;
        if (!(Number(existing.price) > 0)) patch.price = sell;
        const { error } = await supabase.from('products').update(patch).eq('product_key', productKey);
        if (error) { writeErrors++; if (errorSamples.length < 3) errorSamples.push(error.message); } else totalUpdated++;
      } else {
        const { error } = await supabase.from('products').insert({
          product_key: productKey, name: name, price: sell, supplier_price: usd, stock_quantity: stockQty,
          is_available: false, category: 'BulkMail', source: 'bulkmail',
          description: String(p.description || '').trim() || null, updated_at: now
        });
        if (error) { writeErrors++; if (errorSamples.length < 3) errorSamples.push(error.message); } else totalNew++;
      }
    }
    return res.status(200).json({ success: true, message: 'BulkMail sync complete', synced: all.length, new_products: totalNew, updated_products: totalUpdated, write_errors: writeErrors, error_samples: errorSamples });
  } catch (err) {
    console.error('[bulkmail sync]', err);
    return res.status(500).json({ success: false, message: err.message || 'BulkMail sync failed' });
  }
}

function azSellPriceNgn(usd) {
  const rate = Number(process.env.USD_TO_NGN_RATE) || Number(process.env.USD_TO_NGN) || 1500;
  const supplierNgn = Number(usd || 0) * rate;
  return Math.ceil(Math.max(supplierNgn * 1.8, supplierNgn + 500, 1000) / 50) * 50;
}

async function azFetch(path) {
  if (!AZ_KEY) return { ok: false, status: 503, data: { message: 'ACCSZONE_API_KEY not configured' } };
  try {
    const res = await fetch(AZ_BASE + path, {
      method: 'GET',
      headers: { 'X-API-Key': AZ_KEY, Accept: 'application/json' }
    });
    const data = await res.json().catch(function () { return {}; });
    return { ok: res.ok, status: res.status, data: data };
  } catch (e) {
    return { ok: false, status: 502, data: { message: e.message || 'AccsZone fetch failed' } };
  }
}

async function handleAccszoneSync(req, res) {
  try {
    if (!AZ_KEY) return res.status(503).json({ success: false, message: 'ACCSZONE_API_KEY not configured' });
    const all = [];
    let page = 1;
    let lastPage = 1;
    while (page <= lastPage && page <= 80) {
      const g = await azFetch('/listings?page=' + page + '&include=description');
      if (!g.ok || g.data.success === false) {
        const msg = (g.data && (g.data.message || g.data.error_code)) || ('HTTP ' + g.status);
        if (page === 1) return res.status(g.status || 400).json({ success: false, message: 'AccsZone listings failed: ' + msg });
        break;
      }
      const batch = Array.isArray(g.data && g.data.data) ? g.data.data : [];
      all.push.apply(all, batch);
      const meta = (g.data && g.data.meta) || {};
      lastPage = Number(meta.last_page || meta.total_pages || 1) || 1;
      if (!batch.length) break;
      page += 1;
      if (page % 25 === 0) await new Promise(function (r) { setTimeout(r, 2100); });
    }

    let totalNew = 0, totalUpdated = 0, writeErrors = 0;
    const errorSamples = [];
    const now = new Date().toISOString();

    for (let i = 0; i < all.length; i++) {
      const item = all[i];
      const id = item.id != null ? item.id : item.ad_id;
      if (id == null) continue;
      const productKey = 'az_' + id;
      const usd = Number(item.price != null ? item.price : (item.unit_price != null ? item.unit_price : 0)) || 0;
      let stockQty = 0;
      for (const k of ['stock', 'stock_quantity', 'available', 'available_quantity', 'quantity']) {
        if (item[k] != null && !Number.isNaN(Number(item[k]))) { stockQty = Math.max(0, Number(item[k])); break; }
      }
      const sell = azSellPriceNgn(usd);
      const name = String(item.name || item.title || item.slug || ('AccsZone #' + id)).trim();
      const category = String(
        (item.category && (item.category.name || item.category.title)) ||
        item.category_name || item.subcategory_name || 'AccsZone'
      ).trim() || 'AccsZone';
      const description = stripHtml(item.description || item.short_description || '') || null;

      const { data: existing } = await supabase
        .from('products')
        .select('product_key, price, is_available, category')
        .eq('product_key', productKey)
        .maybeSingle();

      if (existing) {
        const patch = { name: name, supplier_price: usd, stock_quantity: stockQty, source: 'accszone', updated_at: now };
        if (!(Number(existing.price) > 0)) patch.price = sell;
        if (stockQty <= 0) patch.is_available = false;
        const { error } = await supabase.from('products').update(patch).eq('product_key', productKey);
        if (error) { writeErrors++; if (errorSamples.length < 3) errorSamples.push(error.message); }
        else totalUpdated++;
      } else {
        const { error } = await supabase.from('products').insert({
          product_key: productKey, name: name, price: sell, supplier_price: usd, stock_quantity: stockQty,
          is_available: false, category: category, source: 'accszone', description: description, updated_at: now
        });
        if (error) { writeErrors++; if (errorSamples.length < 3) errorSamples.push(error.message); }
        else totalNew++;
      }
    }

    return res.status(200).json({
      success: true,
      message: 'AccsZone sync complete (products stay hidden until you enable them)',
      synced: all.length, new_products: totalNew, updated_products: totalUpdated,
      write_errors: writeErrors, error_samples: errorSamples
    });
  } catch (err) {
    console.error('[accszone sync]', err);
    return res.status(500).json({ success: false, message: err.message || 'AccsZone sync failed' });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = Object.assign({}, req.query || {});
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    u.searchParams.forEach(function (v, k) { if (q[k] == null || q[k] === '') q[k] = v; });
  } catch (e) {}
  const action = String(q.action || '').toLowerCase();

  // Admin catalog sync (GET)
  if (req.method === 'GET' || action === 'sync' || action === 'bulkmail_sync' || action === 'accszone_sync') {
    if (action === 'bulkmail_sync') return handleBulkmailSync(req, res);
    if (action === 'accszone_sync') return handleAccszoneSync(req, res);
    if (action === 'sync' || req.method === 'GET') return handleLdSync(req, res);
  }

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
