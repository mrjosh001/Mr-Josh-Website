/**
 * /api/classy — ClassyTee Logs supplier, ONE file (same pattern as /api/sujan).
 *
 *   GET  /api/classy            → sync categories + products into Supabase
 *   POST /api/classy            → purchase (JWT) → format credentials → save order
 *
 * Product keys: ct_{product_id}  e.g. ct_101
 * source column: classy
 *
 * Env:
 *   CLASSYTEE_API_KEY   (required)
 *   CLASSYTEE_BASE_URL  (optional, default https://classyteelogs.com.ng)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Auth to supplier: Authorization: Bearer KEY  or  ?api_key=
 */

import { createClient } from '@supabase/supabase-js';
import { formatCredentials, formatMultiLogCredentials, joinRawLogDetails } from '../lib/formatCredentials.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BASE = (process.env.CLASSYTEE_BASE_URL || 'https://classyteelogs.com.ng').replace(/\/$/, '');
const API_KEY = process.env.CLASSYTEE_API_KEY;

function supplierHeaders() {
  return {
    Authorization: 'Bearer ' + API_KEY,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
}

function applyRandomMarkup(supplierPrice) {
  const percent = 50 + Math.random() * 50;
  const finalPrice = Math.ceil(Number(supplierPrice) * (1 + percent / 100));
  return Math.ceil(finalPrice / 50) * 50;
}

function categorize(name) {
  const n = (name || '').toUpperCase();
  if (n.includes('PROXY')) return '9PROXY (IPS)';
  if (n.includes('VPN') && n.includes('PHONE')) return 'PREMIUM VPN FOR PHONE';
  if (n.includes('VPN')) return 'PREMIUM VPN FOR PC';
  if (n.includes('CHATGPT') || n.includes('CHAT GPT') || n.includes('DEEPSEEK') || n.includes('DEEP SEEK') || n.includes('AI ACCOUNT')) return 'AI';
  if (n.includes('ONLYFANS') || n.includes('ONLY FANS')) return 'SOCIAL NETWORKS ACCOUNTS';
  if (n.includes('INSTAGRAM') && n.includes('FOLLOWER')) return 'INSTAGRAM / HIGH FOLLOWERS';
  if (n.includes('INSTAGRAM')) return 'ALL COUNTRIES INSTAGRAM';
  if (n.includes('TIKTOK') || n.includes('TITKOK') || n.includes('TIK TOK')) {
    if (n.includes('FOLLOWER')) return 'TIKTOK/HIGH FOLLOWERS';
    return 'ALL COUNTRIES TIKTOK';
  }
  if (n.includes('DATING')) return 'DATING SITES';
  if (n.includes('FACEBOOK') || n.includes('MARKETPLACE')) {
    if (n.includes('RANDOM')) return 'RANDOM COUNTRY FACEBOOK';
    return 'COUNTRIES FACEBOOK (30+ FRIENDS)';
  }
  if (n.includes('TWITTER') || n.includes(' X ') || n.startsWith('X ')) return 'X / TWITTER';
  if (n.includes('GMAIL') || n.includes('HOTMAIL') || n.includes('OUTLOOK') || n.includes('MAIL')) return 'MAILS';
  if (n.includes('NETFLIX') || n.includes('DISNEY') || n.includes('PRIME')) return 'STREAMING SITE';
  return 'OTHER';
}

function productIdFromKey(productKey) {
  if (!productKey) return null;
  const m = String(productKey).match(/^ct_(\d+)$/i);
  if (m) return parseInt(m[1], 10);
  const n = parseInt(productKey, 10);
  return Number.isFinite(n) ? n : null;
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

async function insertLogOrder(row) {
  let { error } = await supabase.from('orders').insert(row);
  if (error && /login_credentials_raw|schema cache|column/i.test(String(error.message || ''))) {
    const { login_credentials_raw, ...rest } = row;
    ({ error } = await supabase.from('orders').insert(rest));
  }
  return error;
}

// ---------------------------------------------------------------------------
// GET — catalog sync
// ---------------------------------------------------------------------------

/** Pull human-readable description from supplier product + category. */
function supplierDescription(product, category) {
  if (!product || typeof product !== 'object') product = {};
  const candidates = [
    product.description,
    product.product_description,
    product.desc,
    product.details,
    product.detail,
    product.info,
    product.information,
    product.about,
    product.note,
    product.notes,
    product.content,
    product.long_description,
    product.short_description,
    product.product_info,
    product.spec,
    product.specs
  ];
  for (const c of candidates) {
    if (c == null) continue;
    const s = String(c).trim();
    if (s && s.toLowerCase() !== 'null' && s.toLowerCase() !== 'undefined') return s;
  }
  if (category && typeof category === 'object') {
    for (const c of [category.description, category.category_description, category.details]) {
      if (c == null) continue;
      const s = String(c).trim();
      if (s) return s;
    }
  }
  return '';
}

async function handleSync(req, res) {
  if (!API_KEY) {
    return res.status(500).json({ success: false, message: 'CLASSYTEE_API_KEY not configured' });
  }

  // Categories (optional enrichment)
  let categories = [];
  try {
    const catRes = await fetch(BASE + '/api/v1/categories', { headers: supplierHeaders() });
    if (catRes.ok) {
      const catJson = await catRes.json();
      categories = catJson.data || catJson.categories || [];
    }
  } catch (e) {
    console.warn('[classy sync] categories', e.message);
  }
  const catById = new Map();
  for (const c of categories) {
    const id = c.category_id ?? c.id;
    if (id != null) catById.set(Number(id), c);
  }

  const prodRes = await fetch(BASE + '/api/v1/products', { headers: supplierHeaders() });
  if (!prodRes.ok) {
    const t = await prodRes.text();
    return res.status(prodRes.status).json({
      success: false,
      message: 'ClassyTee products error: ' + prodRes.status,
      details: t.slice(0, 500)
    });
  }
  const prodJson = await prodRes.json();
  const products = prodJson.products || prodJson.data || [];
  if (!Array.isArray(products)) {
    return res.status(400).json({ success: false, message: 'Unexpected products payload', raw: prodJson });
  }

  let newCount = 0;
  let updatedCount = 0;
  const keys = products.map((p) => 'ct_' + (p.product_id ?? p.id)).filter(Boolean);

  const { data: existingRows } = await supabase
    .from('products')
    .select('product_key, price, is_available, category, name')
    .in('product_key', keys.length ? keys : ['__none__']);

  const existing = new Map((existingRows || []).map((r) => [r.product_key, r]));

  // Log first raw product once so we can see real description field names in Vercel logs
  if (products.length > 0) {
    try {
      console.log('[classy sync] raw first product keys:', Object.keys(products[0] || {}));
      console.log('[classy sync] raw first product sample:', JSON.stringify(products[0]).slice(0, 800));
    } catch (_) {}
  }

  for (const p of products) {
    const pid = p.product_id ?? p.id;
    if (pid == null) continue;
    const product_key = 'ct_' + pid;
    const name = String(p.name || p.product_name || 'Product ' + pid).trim();
    const supplierPrice = Number(p.price || 0);
    const stock = Number(p.stock_count ?? p.stock ?? 0);
    const inStock = p.in_stock != null ? !!p.in_stock : stock > 0;
    const cat = catById.get(Number(p.category_id));
    const category = categorize(name + ' ' + (cat && cat.category_name ? cat.category_name : ''));
    // Supplier-facing text only — never invent a credential format string as the product description
    const desc = supplierDescription(p, cat) || null;
    const prev = existing.get(product_key);

    if (prev) {
      // EXISTING: never touch admin customer-facing fields (price, category, name, descriptions).
      // Only refresh supplier cost + stock so orders still work.
      const patch = {
        supplier_price: supplierPrice,
        stock_quantity: stock,
        source: 'classy',
        updated_at: new Date().toISOString()
      };
      // 0 stock hidden. In stock visible again.
      if (!inStock || stock <= 0) patch.is_available = false; else if (!adminHiddenSet.has(product_key)) patch.is_available = true;
      const { error } = await supabase
        .from('products')
        .update(patch)
        .eq('product_key', product_key);
      if (!error) updatedCount++;
    } else {
      const sellPrice = applyRandomMarkup(supplierPrice || 100);
      const { error } = await supabase.from('products').insert({
        product_key,
        name,
        category,
        price: sellPrice,
        supplier_price: supplierPrice,
        stock_quantity: stock,
        is_available: inStock,
        source: 'classy',
        description: desc,
        display_description: desc,
        updated_at: new Date().toISOString()
      });
      if (!error) newCount++;
    }
  }

  return res.status(200).json({
    success: true,
    source: 'classy',
    synced: products.length,
    new_products: newCount,
    updated_products: updatedCount,
    base: BASE
  });
}

// ---------------------------------------------------------------------------
// POST — purchase
// ---------------------------------------------------------------------------
async function handleOrder(req, res) {
  if (!API_KEY) {
    return res.status(500).json({ success: false, message: 'CLASSYTEE_API_KEY not configured' });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ success: false, message: auth.error.message });
  }
  const user_id = auth.user.id;

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { product_key, quantity = 1, external_order_id } = body;
  const qty = Math.max(1, Math.min(10, parseInt(quantity, 10) || 1));
  const productId = productIdFromKey(product_key);
  if (!productId) {
    return res.status(400).json({ success: false, message: 'Invalid ClassyTee product_key (expected ct_{id})' });
  }

  const { data: product, error: pErr } = await supabase
    .from('products')
    .select('*')
    .eq('product_key', product_key)
    .maybeSingle();

  if (pErr || !product) {
    return res.status(404).json({ success: false, message: 'Product not found' });
  }

  const unitPrice = Number(product.price || 0);
  const total = unitPrice * qty;
  const productName = product.name || 'ClassyTee product';

  // Balance column: prefer balance_ngn, fall back to balance
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, balance, balance_ngn, customer_id')
    .eq('id', user_id)
    .maybeSingle();

  if (!profile) {
    return res.status(400).json({ success: false, message: 'Profile not found' });
  }

  const balanceColumn = profile.balance_ngn != null ? 'balance_ngn' : 'balance';
  const originalBalance = Number(profile[balanceColumn] || 0);
  if (originalBalance < total) {
    return res.status(400).json({ success: false, message: 'Insufficient balance' });
  }

  let deducted = false;
    if (external_order_id) {
      const existing = await findExistingLogOrder(user_id, external_order_id);
      if (existing) {
        const { data: balRow } = await supabase.from('profiles').select('balance').eq('id', user_id).maybeSingle();
        return res.status(200).json({
          success: true,
          replayed: true,
          message: 'Order already completed',
          data: {
            order_id: existing.order_id,
            login_credentials: existing.login_credentials,
            items: existing.login_credentials ? [{ details: existing.login_credentials }] : [],
            quantity: existing.quantity,
            new_balance: Number(balRow?.balance || 0)
          }
        });
      }
    }

  let newBalance = originalBalance - total;
  const customerId = profile.customer_id || null;

  try {
    const { error: debitErr } = await supabase
      .from('profiles')
      .update({ [balanceColumn]: newBalance })
      .eq('id', user_id);
    if (debitErr) throw new Error(debitErr.message);
    deducted = true;

    const orderRef = external_order_id || ('CT-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));

    const purchaseRes = await fetch(BASE + '/api/v1/purchase', {
      method: 'POST',
      headers: supplierHeaders(),
      body: JSON.stringify({ product_id: productId, quantity: qty })
    });
    const purchaseJson = await purchaseRes.json().catch(() => ({}));

    if (!purchaseRes.ok || (purchaseJson.status && purchaseJson.status !== 'success')) {
      throw new Error(
        purchaseJson.message || purchaseJson.error || ('ClassyTee purchase failed: ' + purchaseRes.status)
      );
    }

    const delivered = purchaseJson.delivered_items || purchaseJson.items || [];
    const items = (Array.isArray(delivered) ? delivered : []).map((it, idx) => ({
      details: String(it.credentials || it.details || it.credential || it.log || '').trim(),
      serial: String(it.log_id || it.id || idx + 1)
    })).filter((it) => it.details);

    // Prefer real supplier text only if it looks like a field layout hint (contains : separators).
    // Otherwise leave empty so formatCredentials auto-detects email:pass / multi-part lines.
    const rawHint = String(product.display_description || product.description || '').trim();
    const formatHint = /:/.test(rawHint) && rawHint.length < 120 ? rawHint : '';
    const combinedCreds =
      formatMultiLogCredentials(items, formatHint) ||
      (items[0] ? formatCredentials(items[0].details, formatHint) || items[0].details : null);
    const combinedRaw = joinRawLogDetails(items) || items.map((i) => i.details).join('\n\n') || null;
    const supplierOrderId =
      (purchaseJson.order_details && purchaseJson.order_details.order_id) ||
      purchaseJson.order_id ||
      orderRef;

    const insertErr = await insertLogOrder({
      order_id: String(orderRef),
      user_id,
      product_id: product.id,
      product_code: product_key,
      product_name: productName,
      product_type: 'log',
      description: (product.display_description || product.description || '').trim() || null,
      quantity: items.length || qty,
      amount: total,
      status: 'completed',
      login_credentials: combinedCreds,
      login_credentials_raw: combinedRaw,
      supplier_ref: String(supplierOrderId),
      guide_url: 'https://t.me/mj_hub_tg'
    });
    if (insertErr) {
      console.error('[classy] insert order failed', insertErr.message);
    }

    await supabase.from('transactions').insert({
      user_id,
      customer_id: customerId,
      type: 'purchase',
      category: productName,
      title: productName,
      subtitle: 'Qty: ' + qty + ' · ClassyTee',
      amount: '₦' + total.toLocaleString(),
      amount_ngn: total,
      status: 'completed'
    });

    // Local stock (best-effort)
    const left = Math.max(0, Number(product.stock_quantity || 0) - qty);
    await supabase
      .from('products')
      .update({ stock_quantity: left, is_available: left > 0 && product.is_available !== false })
      .eq('product_key', product_key);

    const remaining =
      purchaseJson.order_details && purchaseJson.order_details.remaining_balance != null
        ? purchaseJson.order_details.remaining_balance
        : null;

    return res.status(200).json({
      success: true,
      message: 'Order fulfilled successfully',
      data: {
        items: items.map((i) => ({
          details: formatCredentials(i.details, formatHint) || i.details,
          serial: i.serial
        })),
        login_credentials: combinedCreds,
        total_amount: total,
        new_balance: newBalance,
        order_id: orderRef,
        supplier_order_id: supplierOrderId,
        supplier_wallet_remaining: remaining,
        source: 'classy'
      }
    });
  } catch (err) {
    console.error('[classy order]', err);
    if (deducted) {
      try {
        await supabase.from('profiles').update({ [balanceColumn]: originalBalance }).eq('id', user_id);
        await supabase.from('transactions').insert({
          user_id,
          customer_id: customerId,
          type: 'refund',
          category: productName || 'Unknown',
          title: 'Automatic Refund',
          subtitle: 'System error – ' + (err.message || 'classy'),
          amount: '₦' + total.toLocaleString(),
          amount_ngn: total,
          status: 'refunded',
          notes: String(err.message || err)
        });
      } catch (refundErr) {
        console.error('[classy] CRITICAL refund failed', refundErr);
      }
    }
    return res.status(500).json({
      success: false,
      message: deducted
        ? 'Something went wrong. Your balance has been refunded.'
        : err.message || 'Something went wrong. Please try again.'
    });
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      success: false,
      message: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'
    });
  }

  try {
    if (req.method === 'GET') return await handleSync(req, res);
    if (req.method === 'POST') return await handleOrder(req, res);
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  } catch (error) {
    console.error('[classy]', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
}
