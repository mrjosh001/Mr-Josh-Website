import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const LD_BASE = 'https://logsdomain.com/api/v1';
const LD_KEY = process.env.LOGSDOMAIN_API_KEY;
const BM_BASE = 'https://bulkmail.shop/api/v2';
const BM_KEY = process.env.BULKMAIL_API_KEY || process.env.BULK_MAIL_API_KEY || '';

function categoryIdFromKey(pk) {
  if (!pk) return null;
  const m = String(pk).match(/^ld_(\d+)$/i);
  if (m) return parseInt(m[1], 10);
  const n = parseInt(pk, 10);
  return Number.isFinite(n) ? n : null;
}
function formatCredentials(details) {
  if (!details) return '';
  const text = String(details);
  const u = text.match(/(?:Username|User|ID|Email|Login)\s*[:=]\s*([^\s|]+)/i);
  const p = text.match(/(?:Password|Pass)\s*[:=]\s*([^\s|]+)/i);
  if (u && p) return u[1].trim() + ':' + p[1].trim();
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
      const batch = Array.isArray(json.data) ? json.data : (json.data && json.data.data) || (json.data && json.data.items) || [];
      if (!batch.length) break;
      all.push(...batch);
      if (batch.length < 100) break;
      page += 1;
      if (page > 50) break;
    }
    let newCount = 0, updatedCount = 0;
    const now = new Date().toISOString();
    for (const item of all) {
      if (item.id == null) continue;
      const productKey = 'ld_' + item.id;
      const name = item.name || ('Category ' + item.id);
      const supplierPrice = Number(item.price) || 0;
      const stock = readLdStock(item);
      const sell = applyLdMarkup(supplierPrice);
      const { data: existing } = await supabase.from('products').select('product_key, price').eq('product_key', productKey).maybeSingle();
      if (existing) {
        const patch = { name, supplier_price: supplierPrice, stock_quantity: stock, is_available: stock > 0, source: 'logsdomain', updated_at: now };
        if (!(Number(existing.price) > 0)) patch.price = sell;
        const { error } = await supabase.from('products').update(patch).eq('product_key', productKey);
        if (!error) updatedCount += 1;
      } else {
        const { error } = await supabase.from('products').insert({
          product_key: productKey, name, category: (item.parent_category && item.parent_category.name) || 'Logs Domain',
          price: sell, supplier_price: supplierPrice, stock_quantity: stock, is_available: stock > 0,
          source: 'logsdomain', description: stripHtml(item.description || '') || null, updated_at: now
        });
        if (!error) newCount += 1;
      }
    }
    return res.status(200).json({ success: true, message: 'Logs Domain sync complete', synced: all.length, new_products: newCount, updated_products: updatedCount });
  } catch (err) {
    console.error('[ld sync]', err);
    return res.status(500).json({ success: false, message: err.message || 'Logs Domain sync failed' });
  }
}
async function bmFetch(path, opts) {
  opts = opts || {};
  if (!BM_KEY) return { ok: false, status: 503, data: { error: 'BULKMAIL_API_KEY not set' } };
  try {
    const res = await fetch(BM_BASE + path, {
      method: opts.method || 'GET',
      headers: { 'X-API-Key': BM_KEY, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: opts.body != null ? JSON.stringify(opts.body) : undefined
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(function(){ return {}; }) };
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = Object.assign({}, req.query || {});
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    u.searchParams.forEach(function(v, k) { if (q[k] == null || q[k] === '') q[k] = v; });
  } catch (e) {}
  const action = String(q.action || '').toLowerCase();

  if (req.method === 'GET' || action === 'sync' || action === 'bulkmail_sync') {
    if (action === 'bulkmail_sync') return handleBulkmailSync(req, res);
    return handleLdSync(req, res);
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const product_key = body.product_key;
  const quantity = body.quantity || 1;
  const external_order_id = body.external_order_id;
  const user_id = body.user_id;

  if (!product_key || !user_id) {
    return res.status(400).json({ success: false, message: 'product_key and user_id are required' });
  }
  if (!LD_KEY) {
    return res.status(500).json({ success: false, message: 'LOGSDOMAIN_API_KEY not configured' });
  }
  const categoryId = categoryIdFromKey(product_key);
  if (!categoryId) {
    return res.status(400).json({ success: false, message: 'Invalid Logs Domain product_key (expected ld_123)' });
  }

  const qty = Math.max(1, Math.min(100, parseInt(quantity, 10) || 1));
  let originalBalance = 0, total = 0, productName = '', customerId = null, deducted = false;

  try {
    const { data: product, error: prodErr } = await supabase
      .from('products').select('id, product_key, name, price, stock_quantity, source, description, display_description')
      .eq('product_key', product_key).single();
    if (prodErr || !product) return res.status(404).json({ success: false, message: 'Product not found' });
    total = Number(product.price) * qty;
    productName = product.name;

    const r1 = await supabase.from('profiles').select('balance, customer_id').eq('id', user_id).single();
    if (r1.error || !r1.data) return res.status(400).json({ success: false, message: 'User profile not found' });
    originalBalance = Number(r1.data.balance || 0);
    customerId = r1.data.customer_id;
    if (originalBalance < total) {
      return res.status(402).json({ success: false, message: 'Insufficient balance', required: total, available: originalBalance });
    }

    const newBalance = originalBalance - total;
    const { error: deductErr } = await supabase.from('profiles').update({ balance: newBalance }).eq('id', user_id);
    if (deductErr) return res.status(500).json({ success: false, message: 'Could not debit your balance. Please try again.' });
    deducted = true;

    const orderRef = external_order_id || ('MJ-LD-' + String(user_id).slice(0, 8) + '-' + Date.now());
    const supplierRes = await fetch(LD_BASE + '/logs/orders', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + LD_KEY, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ category_id: categoryId, quantity: qty, idempotency_key: orderRef })
    });
    const orderData = await supplierRes.json().catch(function(){ return {}; });

    if (!supplierRes.ok || orderData.success === false) {
      await supabase.from('profiles').update({ balance: originalBalance }).eq('id', user_id);
      await supabase.from('transactions').insert({
        user_id: user_id, customer_id: customerId, type: 'refund', category: productName, title: 'Automatic Refund',
        subtitle: 'Logs Domain order failed – balance restored', amount: '₦' + total.toLocaleString(), amount_ngn: total, status: 'refunded'
      });
      return res.status(400).json({ success: false, message: orderData.message || 'Order failed at supplier. Your balance has been refunded.' });
    }

    const items = (orderData.data && orderData.data.items) || [];
    const supplierOrderId = (orderData.data && orderData.data.order_id) || orderRef;
    const detailsText = items.map(function(it){ return it.details; }).filter(Boolean).join('\n\n');

    if (items.length) {
      for (let j = 0; j < items.length; j++) {
        const item = items[j];
        await supabase.from('orders').insert({
          order_id: supplierOrderId, user_id: user_id, product_id: product.id, product_code: product_key, product_name: productName,
          product_type: 'log', description: ((product.display_description || product.description || '') + '').trim() || null,
          quantity: 1, amount: product.price, status: 'completed',
          login_credentials: formatCredentials(item.details), supplier_ref: String(item.serial || ''), guide_url: 'https://t.me/mj_hub_tg'
        });
      }
    } else {
      await supabase.from('orders').insert({
        order_id: supplierOrderId, user_id: user_id, product_id: product.id, product_code: product_key, product_name: productName,
        product_type: 'log', quantity: qty, amount: total, status: 'completed',
        login_credentials: detailsText || 'Delivered', guide_url: 'https://t.me/mj_hub_tg'
      });
    }

    await supabase.from('transactions').insert({
      user_id: user_id, customer_id: customerId, type: 'purchase', category: productName, title: productName,
      subtitle: 'Qty: ' + qty + ' · Logs Domain', amount: '₦' + total.toLocaleString(), amount_ngn: total, status: 'completed',
      product_details: detailsText
    });
    await supabase.from('products').update({
      stock_quantity: Math.max(0, (product.stock_quantity || 0) - qty),
      is_available: (product.stock_quantity || 0) - qty > 0
    }).eq('product_key', product_key);

    return res.status(200).json({
      success: true, message: 'Order fulfilled successfully',
      data: {
        items: items.length ? items.map(function(it){ return { details: it.details, serial: it.serial }; }) : [{ details: detailsText || 'Order completed' }],
        total_amount: total, new_balance: newBalance, order_id: supplierOrderId, source: 'logsdomain'
      }
    });
  } catch (err) {
    console.error('order-logsdomain error:', err);
    if (deducted) {
      try {
        await supabase.from('profiles').update({ balance: originalBalance }).eq('id', user_id);
        await supabase.from('transactions').insert({
          user_id: user_id, customer_id: customerId, type: 'refund', category: productName || 'Unknown', title: 'Automatic Refund',
          subtitle: 'System error – ' + err.message, amount: '₦' + total.toLocaleString(), amount_ngn: total, status: 'refunded'
        });
      } catch (e2) {}
    }
    return res.status(500).json({
      success: false,
      message: deducted ? 'Something went wrong. Your balance has been refunded.' : 'Something went wrong. Please try again.'
    });
  }
}
