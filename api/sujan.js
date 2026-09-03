import { createClient } from '@supabase/supabase-js';
import { formatCredentials, formatMultiLogCredentials, joinRawLogDetails } from '../lib/formatCredentials.js';
import { readSupplierStock } from '../lib/supplierStock.js';

/**
 * /api/sujan — everything for the Sujan Department supplier, one file.
 *
 * GET  /api/sujan   → sync catalog into Supabase products (was products-sujan.js, admin button)
 * POST /api/sujan   → buy a product / deliver credentials (was order-sujan.js)
 *
 * LIVE ON THE STOREFRONT: is_available now follows real stock (stock > 0),
 * the same convention as Fadded and Logs Domain — Sujan products can appear
 * on index.html / mj-logs.html as soon as they sync in with stock. (Earlier
 * versions of this file force-hid every Sujan product regardless of stock;
 * that gate has been removed.)
 *
 * Docs only say:
 *  - GET /reseller/v1/products → "list all active catalog products" (exact
 *    field names, and whether stock is included in the list vs. only via the
 *    separate /reseller/v1/products/{id}/stock endpoint, aren't documented)
 *  - POST /reseller/v1/orders → "credentials delivered atomically" (no
 *    documented response schema)
 * Both sides below read several likely field names defensively. Worth
 * spot-checking against real responses once SUJAN_API_KEY is set, and before
 * ever pointing real customer traffic at the order side.
 *
 * Env: SUJAN_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const BASE = 'https://api.sujandepartment.com';
const SUJAN_KEY = process.env.SUJAN_API_KEY;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ===========================================================================
// SYNC (was products-sujan.js) — unchanged
// ===========================================================================

function stripHtml(html) {
  if (!html) return '';
  let text = String(html);
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  text = text.replace(/<br\s*\/?>/gi, ' ').replace(/<\/(div|p|li)>/gi, ' ');
  text = text.replace(/<[^>]*>/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

/** Match Fadded/Logs Domain-style markup: 50–100%, rounded up to nearest 50 */
function applyRandomMarkup(supplierPrice) {
  const percent = 50 + Math.random() * 50;
  const finalPrice = Math.ceil(Number(supplierPrice) * (1 + percent / 100));
  return Math.ceil(finalPrice / 50) * 50;
}

// Kept in sync with api/products.js (Fadded) and api/products-logsdomain.js —
// all three suppliers must sort a given kind of product into the SAME
// category name, or the storefront ends up with duplicate near-identical
// categories (e.g. "SOCIAL NETWORKS ACCOUNTS" from one supplier and
// products silently falling to "OTHER" from another for the exact same
// kind of item). If you add a rule here, add it to the other two as well.
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
  const isFacebookStyle = n.includes('FACEBOOK') || n.includes('MARKETPLACE') || n.includes('2FA') || n.includes('FRIENDS') || n.includes('PROFILE & COVER') || n.includes('REGISTERED FROM');
  if (isFacebookStyle) {
    if (n.includes('RANDOM')) return 'RANDOM COUNTRY FACEBOOK';
    if (n.includes('0-5') || n.includes('0-30') || n.includes('MARKETPLACE + 2FA') || (n.includes('MARKETPLACE') && !n.includes('30+'))) {
      return 'COUNTRIES FACEBOOK (0-5 FRIENDS)';
    }
    return 'COUNTRIES FACEBOOK (30+ FRIENDS)';
  }
  if (n.includes('TWITTER') || n.includes(' X ') || n.startsWith('X ')) return 'X / TWITTER';
  if (n.includes('REDDIT')) return 'REDDIT';
  if (n.includes('SNAPCHAT')) return 'SNAPCHAT';
  if (n.includes('LINKEDIN')) return 'LINKEDIN';
  if (n.includes('GMAIL') || n.includes('HOTMAIL') || n.includes('GMX') || n.includes('MAIL.RU') || n.includes('TEXPLUS')) return 'MAILS';
  if (n.includes('NETFLIX') || n.includes('DISNEY') || n.includes('PRIME VIDEO') || n.includes('APPLE MUSIC')) return 'STREAMING SITE';
  if (n.includes('STEAM')) return 'GAME ACCOUNTS';
  if (n.includes('GOOGLE VOICE') || n.includes('TEXT FREE') || n.includes('TALKATONE')) return 'TEXTING APP';
  if (n.includes('TWITCH') || n.includes('DISCORD') || n.includes('PINTEREST') || n.includes('QUORA') || n.includes('CANVA')) return 'SOCIAL NETWORKS ACCOUNTS';
  return 'OTHER';
}

async function handleSync(req, res) {
  if (!process.env.SUJAN_API_KEY) {
    return res.status(500).json({ success: false, message: 'Missing SUJAN_API_KEY' });
  }

  const products = [];
  for (let page = 1; page <= 30; page++) {
    const apiRes = await fetch(`${BASE}/reseller/v1/products?page=${page}&per_page=100`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${process.env.SUJAN_API_KEY}`,
        Accept: 'application/json'
      }
    });

    if (!apiRes.ok) {
      const errorText = await apiRes.text();
      if (page === 1) {
        return res.status(apiRes.status).json({
          success: false,
          message: `Sujan Department API error: ${apiRes.status}`,
          details: errorText
        });
      }
      break;
    }

    const json = await apiRes.json();
    const batch = Array.isArray(json) ? json : (json.data || json.products || json.data?.data || []);
    if (!Array.isArray(batch) || !batch.length) break;
    products.push(...batch);
    if (batch.length < 100) break;
  }

  // Sujan's docs don't list exact field names (see file header). Log the
  // very first raw product object once per sync so the real field names
  // are visible in Vercel logs — if `price`/`unit_price`/`cost` below are
  // all wrong guesses, every product silently prices at ₦0 with no error
  // anywhere, which is exactly the kind of thing that's otherwise
  // invisible until someone notices the storefront numbers looking wrong.
  if (products.length > 0) {
    console.log('[sujan sync] raw first product (for field-name verification):', JSON.stringify(products[0]));
  }

  let newCount = 0;
  let updatedCount = 0;
  let zeroPriceCount = 0;

  for (const item of products) {
    const id = item.id ?? item.product_id ?? item.productId;
    if (id == null) continue;

    const productKey = `sj_${id}`;
    const name = item.name || item.title || `Product ${id}`;
    const cleanDescription = stripHtml(item.description || '');
    // Confirmed via the debug log below: Sujan's real field is price_minor,
    // in minor currency units (kobo) — e.g. "120000" = ₦1,200.00. The
    // earlier price/unit_price/cost guesses never matched, so every
    // product synced at ₦0. Guesses kept as a fallback only in case some
    // product lacks price_minor.
    const supplierPrice = Number(
      item.price_minor != null ? Number(item.price_minor) / 100 : (item.price ?? item.unit_price ?? item.cost ?? 0)
    ) || 0;
    if (supplierPrice === 0) zeroPriceCount++;
    // Confirmed via the debug log below: Sujan's real field is
    // available_stock, not stock/in_stock/available_quantity/quantity.
    const stock = readSupplierStock(item);

    const { data: existing } = await supabase
      .from('products')
      .select('product_key, admin_hidden')
      .eq('product_key', productKey)
      .maybeSingle();

    if (existing) {
      // EXISTING: refresh name/description + supplier cost + stock, same as
      // Fadded/Logs Domain sync. Resale price and category are never touched
      // here — only ever changed in the admin panel. is_available now
      // follows real stock (matches Fadded/Logs Domain) — Sujan products
      // are live on the storefront as of this sync, no longer force-hidden.
      // `source` IS re-set here (same fix applied to Fadded/Logs Domain) so
      // it stays tagged correctly on every sync, not just the first insert.
      // EXISTING: never overwrite admin price, category, name, or display text.
      updatedCount++;
      const patch = {
        supplier_price: supplierPrice,
        stock_quantity: stock,
        source: 'sujandepartment',
        updated_at: new Date().toISOString()
      };
      if (stock <= 0) patch.is_available = false;
      else if (existing.admin_hidden) { /* admin hid — stay hidden */ }
      else patch.is_available = true;
      const { error } = await supabase
        .from('products')
        .update(patch)
        .eq('product_key', productKey);

      if (error) {
        console.error(`Sujan Department update ${productKey}:`, error.message);
      }
    } else {
      // NEW: full insert with markup + category. is_available follows real
      // stock, same as the update branch above.
      const { error } = await supabase
        .from('products')
        .insert({
          product_key: productKey,
          name,
          description: cleanDescription,
          display_description: cleanDescription,
          supplier_price: supplierPrice,
          price: applyRandomMarkup(supplierPrice),
          stock_quantity: stock,
          is_available: stock > 0,
          category: categorize(name),
          source: 'sujandepartment',
          updated_at: new Date().toISOString()
        });

      if (error) {
        console.error(`Sujan Department insert ${productKey}:`, error.message);
      } else {
        newCount++;
      }
    }
  }

  return res.status(200).json({
    success: true,
    synced: products.length,
    new_products: newCount,
    updated_products: updatedCount,
    zero_price_count: zeroPriceCount,
    in_stock_from_api: products.filter((p) => readSupplierStock(p) > 0).length,
    source: 'sujandepartment'
  });
}

// ===========================================================================
// ORDER (was order-sujan.js) — unchanged
// ===========================================================================

function productIdFromKey(productKey) {
  if (!productKey) return null;
  const m = String(productKey).match(/^sj_(\d+)$/i);
  if (m) return parseInt(m[1], 10);
  const n = parseInt(productKey, 10);
  return Number.isFinite(n) ? n : null;
}

function buildDetailsFromObject(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (typeof obj === 'string') return obj;
  const email = String(obj.email || obj.mail || obj.Email || '').trim();
  const username = String(obj.username || obj.user || obj.account || '').trim();
  const login = String(obj.login || obj.Login || '').trim();
  const password = String(obj.password || obj.pass || obj.pwd || obj.Password || '').trim();
  const emailPassword = String(obj.email_password || obj.emailPassword || '').trim();
  const token = String(obj.token || obj['2fa'] || obj.otp || '').trim();
  let details = String(obj.details || obj.credentials || obj.credential || obj.log || obj.content || '').trim();
  if (!details) {
    const lines = [];
    const idEmail = email || (login.includes('@') ? login : '');
    const idUser = username || (login && !login.includes('@') ? login : '');
    if (idEmail) lines.push('Email: ' + idEmail);
    if (idUser && idUser !== idEmail) lines.push('Username: ' + idUser);
    if (password) lines.push('Password: ' + password);
    if (emailPassword) lines.push('Email Password: ' + emailPassword);
    if (token) lines.push('2FA / Token: ' + token);
    details = lines.join('\n');
  } else if (password && !/password/i.test(details)) {
    details = details + '\nPassword: ' + password;
  }
  if (!details) {
    try { details = JSON.stringify(obj); } catch (_) { details = ''; }
  }
  return details;
}

function extractItems(orderData) {
  const d = orderData?.data ?? orderData;
  if (Array.isArray(d?.items)) {
    return d.items.map((i) => ({
      details: buildDetailsFromObject(i) || String(i.details || i.credentials || i.credential || JSON.stringify(i)),
      ref: String(i.id || i.serial || i.product_detail_id || '')
    }));
  }
  if (Array.isArray(d)) {
    return d.map((i, idx) => ({
      details: typeof i === 'string' ? i : buildDetailsFromObject(i),
      ref: String((i && (i.id || i.serial)) || idx + 1)
    }));
  }
  if (d?.credentials) {
    return [{ details: typeof d.credentials === 'string' ? d.credentials : buildDetailsFromObject(d.credentials) || JSON.stringify(d.credentials), ref: '' }];
  }
  if (d && typeof d === 'object') {
    const built = buildDetailsFromObject(d);
    return [{ details: built || JSON.stringify(d), ref: '' }];
  }
  return [{ details: 'Delivered — see order for details', ref: '' }];
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
  // Prefer storing supplier raw for admin; fall back if column not migrated yet
  let { error } = await supabase.from('orders').insert(row);
  if (error && /login_credentials_raw|schema cache|column/i.test(error.message || '')) {
    const { login_credentials_raw, ...rest } = row;
    ({ error } = await supabase.from('orders').insert(rest));
  }
  return error;
}

async function handleOrder(req, res) {
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

  if (!SUJAN_KEY) {
    return res.status(500).json({ success: false, message: 'SUJAN_API_KEY not configured' });
  }

  const productId = productIdFromKey(product_key);
  if (!productId) {
    return res.status(400).json({
      success: false,
      message: 'Invalid Sujan Department product_key (expected sj_123)'
    });
  }

  const qty = Math.max(1, Math.min(10, parseInt(quantity, 10) || 1));
  let originalBalance = 0;
  let total = 0;
  let productName = '';
  let customerId = null;
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

    total = Number(product.price) * qty;
    productName = product.name;

    // 2. User balance
    const { data: profile, error: profErr } = await supabase
      .from('profiles')
      .select('balance, customer_id')
      .eq('id', user_id)
      .single();

    if (profErr || !profile) {
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

    // 3. Debit customer
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

    // 4. Call Sujan Department
    const orderRef = external_order_id || `MJ-SJ-${String(user_id).slice(0, 8)}-${Date.now()}`;
    const supplierRes = await fetch(`${BASE}/reseller/v1/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUJAN_KEY}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ product_id: productId, quantity: qty })
    });

    const orderData = await supplierRes.json().catch(() => ({}));

    // 5. Supplier failed → refund
    if (!supplierRes.ok || orderData.success === false) {
      await supabase
        .from('profiles')
        .update({ balance: originalBalance })
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
        subtitle: 'Sujan Department order failed – balance restored',
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
    const items = extractItems(orderData);
    const supplierOrderId = orderData.data?.order_id || orderData.order_id || orderRef;
    const detailsText = items.map((i) => i.details).filter(Boolean).join('\n\n');

    console.log('[sujan order] fulfilling', {
      order_id: supplierOrderId,
      product_key,
      product_id: productId,
      product_name: productName,
      supplier_response_raw: orderData
    });

    // ONE row for the full qty — numbered logs under one order_id
    const formatHint = product.display_description || product.description || productName || '';
    const combinedCreds =
      formatMultiLogCredentials(items, formatHint) ||
      (items[0]
        ? formatCredentials(items[0].details, formatHint) || items[0].details
        : null) ||
      detailsText ||
      null;
    const combinedRaw = joinRawLogDetails(items) || detailsText || null;
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
      supplier_ref: items.map((it) => it.ref).filter(Boolean).join(', ') || String(supplierOrderId),
      guide_url: 'https://t.me/mj_hub_tg'
    });
    if (insertErr) {
      console.error('[sujan order] FAILED to save order row:', insertErr.message, { order_id: supplierOrderId, user_id, product_key });
    }

    await supabase.from('transactions').insert({
      user_id,
      customer_id: customerId,
      type: 'purchase',
      category: productName,
      title: productName,
      subtitle: `Qty: ${qty} · Sujan Department`,
      amount: `₦${total.toLocaleString()}`,
      amount_ngn: total,
      status: 'completed',
      product_details: detailsText,
      supplier_order: orderData.data || orderData
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
        items: (items || []).map((i) => ({
          details: formatCredentials(i.details, formatHint) || String(i.details || '').trim(),
          ref: i.ref
        })),
        login_credentials: combinedCreds || null,
        total_amount: total,
        new_balance: newBalance,
        order_id: orderRef,
        supplier_order_id: supplierOrderId,
        source: 'sujandepartment'
      }
    });
  } catch (err) {
    console.error('sujan order error:', err);

    if (deducted) {
      try {
        await supabase
          .from('profiles')
          .update({ balance: originalBalance })
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

// ===========================================================================
// DISPATCHER
// ===========================================================================


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
    console.error('sujan handler error:', error);
    return res.status(error.httpStatus || 500).json({
      success: false,
      message: error.message || 'Internal server error'
    });
  }
}
