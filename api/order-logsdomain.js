/**
 * /api/order-logsdomain — everything for Logs Domain in ONE file (Sujan-style).
 *
 *   GET  /api/order-logsdomain           → sync categories/products into Supabase
 *   GET  /api/order-logsdomain?action=sync
 *   POST /api/order-logsdomain           → purchase (JWT) — body unchanged
 *
 * Backward compatible: vercel rewrite /api/products-logsdomain → this file GET sync.
 *
 * Env: LOGSDOMAIN_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js';
import { formatCredentials, formatMultiLogCredentials, joinRawLogDetails } from '../lib/formatCredentials.js';

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


/** Normalize one supplier item → { details, serial } with full email + password */
function normalizeLdItem(raw, index = 0) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const details = raw.trim();
    return details ? { details, serial: String(index + 1) } : null;
  }
  if (typeof raw !== 'object') return null;

  const email = String(
    raw.email || raw.mail || raw.Email || raw.e_mail || ''
  ).trim();
  const username = String(
    raw.username || raw.user || raw.account || raw.Username || raw.User || ''
  ).trim();
  // "login" is often the email/username only — never treat it as the full credential blob alone
  const loginOnly = String(raw.login || raw.Login || '').trim();
  const password = String(
    raw.password || raw.pass || raw.pwd || raw.Password || raw.pass_word || raw.passwd || ''
  ).trim();
  const emailPassword = String(
    raw.email_password || raw.emailPassword || raw.mail_password || ''
  ).trim();
  const token = String(
    raw.token || raw['2fa'] || raw.otp || raw.cookie || raw.auth || ''
  ).trim();

  let details = String(
    raw.details || raw.credentials || raw.credential || raw.log || raw.content || raw.data || ''
  ).trim();
  // Avoid treating a bare login/email field as the entire log
  if (!details && typeof raw.data === 'object' && raw.data) {
    try { details = ''; } catch (_) {}
  }

  if (!details) {
    const lines = [];
    const idEmail = email || (loginOnly.includes('@') ? loginOnly : '');
    const idUser = username || (loginOnly && !loginOnly.includes('@') ? loginOnly : '');
    if (idEmail) lines.push('Email: ' + idEmail);
    if (idUser && idUser !== idEmail) lines.push('Username: ' + idUser);
    if (password) lines.push('Password: ' + password);
    if (emailPassword) lines.push('Email Password: ' + emailPassword);
    if (token) lines.push('2FA / Token: ' + token);
    details = lines.join('\n');
  } else {
    // Blob present but password only in sibling fields — append so nothing is lost
    const hasPassInBlob = /password\s*[:=]/i.test(details) || /\|[^|\n]{4,}/.test(details);
    if (password && !hasPassInBlob) {
      details = details + '\nPassword: ' + password;
    }
    if (email && !/@/.test(details)) {
      details = 'Email: ' + email + '\n' + details;
    }
  }

  if (!details) {
    try {
      const copy = { ...raw };
      details = JSON.stringify(copy);
    } catch (_) {
      details = '';
    }
  }
  if (!details || details === '{}' || details === 'null') return null;

  const serial =
    raw.serial != null
      ? String(raw.serial)
      : raw.id != null
        ? String(raw.id)
        : String(index + 1);
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


// ===== Catalog sync (formerly products-logsdomain.js) =====

/**
 * Sync Logs Domain categories into Supabase products.
 * Manual trigger: GET /api/products-logsdomain (from Admin button)
 *
 * Env: LOGSDOMAIN_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const BASE = 'https://logsdomain.com/api/v1';

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

/** Match Fadded-style markup: 50–100%, rounded up to nearest 50 */
function applyRandomMarkup(supplierPrice) {
  const percent = 50 + Math.random() * 50;
  const finalPrice = Math.ceil(Number(supplierPrice) * (1 + percent / 100));
  return Math.ceil(finalPrice / 50) * 50;
}

// Kept in sync with api/products.js (Fadded) and api/sujan.js — all three
// suppliers must sort a given kind of product into the SAME category name.
// If you add a rule here, add it to the other two as well. The parentName
// fallback below is LogsDomain-specific (their own category hierarchy) and
// only applies after every shared rule has already had a chance to match.
function categorize(name, parentName) {
  const n = `${name || ''} ${parentName || ''}`.toUpperCase();
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
  if (parentName) return String(parentName).toUpperCase();
  return 'OTHER';
}

async function fetchAllCategories(apiKey) {
  const all = [];
  let page = 1;
  const perPage = 100;

  // API may return a flat array or paginated object — handle both
  while (page <= 50) {
    const url = `${BASE}/logs/categories?per_page=${perPage}&page=${page}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`
      }
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Logs Domain categories error ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = await res.json();
    if (!json.success) {
      throw new Error(json.message || 'Logs Domain reported failure');
    }

    const batch = Array.isArray(json.data)
      ? json.data
      : (json.data?.data || json.data?.items || []);

    if (!batch.length) break;
    all.push(...batch);

    // Stop if fewer than a full page (no more pages)
    if (batch.length < perPage) break;
    page += 1;
  }

  return all;
}


async function handleLogsDomainSync(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({
        success: false,
        message: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'
      });
    }
    if (!process.env.LOGSDOMAIN_API_KEY) {
      return res.status(500).json({
        success: false,
        message: 'Missing LOGSDOMAIN_API_KEY'
      });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const categories = await fetchAllCategories(process.env.LOGSDOMAIN_API_KEY);
    let newCount = 0;
    let updatedCount = 0;

    for (const item of categories) {
      const id = item.id;
      if (id == null) continue;

      const productKey = `ld_${id}`;
      const name = item.name || `Category ${id}`;
      const parentName = item.parent_category?.name || '';
      const cleanDescription = stripHtml(item.description || '');
      const supplierPrice = Number(item.price) || 0;
      const stock = Number(item.available_quantity) || 0;

      const { data: existing } = await supabase
        .from('products')
        .select('product_key, price, name')
        .eq('product_key', productKey)
        .maybeSingle();

      if (existing) {
        // Logs Domain's numeric category id is what actually gets ordered
        // (see api/order-logsdomain.js), so if they ever reassign/recycle an
        // id to a different category, the ONLY way to stay correct is to keep
        // this product's name/description in lockstep with whatever that id
        // currently means to them — otherwise the storefront shows one thing
        // while orders fulfill as another. This log line is kept so a rename
        // is still visible in the sync output, even though it's now applied
        // automatically instead of silently going stale.
        if (existing.name && name && existing.name.trim() !== String(name).trim()) {
          console.warn(
            `[products-logsdomain] ${productKey} renamed by supplier: "${existing.name}" → "${name}". Catalog updated to match.`
          );
        }
        // EXISTING: refresh name/description + supplier cost + stock.
        // Your resale price and category are still never touched here — those
        // stay exactly as you set them in the admin panel. `source` IS
        // re-set here (even though it never changes) specifically to
        // backfill it on rows synced before this field existed — without
        // this, only brand-new products ever got tagged and the admin
        // dashboard's supplier badge silently stayed blank for the rest of
        // an existing catalog forever.
        updatedCount += 1;
        const { error } = await supabase
          .from('products')
          .update({
            name,
            description: cleanDescription,
            display_description: cleanDescription,
            supplier_price: supplierPrice,
            stock_quantity: stock,
            is_available: stock > 0,
            source: 'logsdomain',
            updated_at: new Date().toISOString()
          })
          .eq('product_key', productKey);

        if (error) {
          console.error(`Logs Domain update ${productKey}:`, error.message);
        }
      } else {
        // NEW: full insert with markup + category
        newCount += 1;
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
            category: categorize(name, parentName),
            source: 'logsdomain',
            updated_at: new Date().toISOString()
          });

        if (error) {
          console.error(`Logs Domain insert ${productKey}:`, error.message);
        }
      }
    }

    return res.status(200).json({
      success: true,
      synced: categories.length,
      new_products: newCount,
      updated_products: updatedCount,
      source: 'logsdomain'
    });
  } catch (error) {
    console.error('products-logsdomain error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Internal server error'
    });
  }
}

// ===== Order dispatcher =====
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Catalog sync (formerly api/products-logsdomain.js)
  // GET /api/order-logsdomain  |  GET/POST ?action=sync
  const q = req.query || {};
  let bodyPeek = {};
  try {
    if (req.method === 'POST' && req.body) {
      bodyPeek = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    }
  } catch (_) {}
  const action = String(q.action || bodyPeek.action || '').toLowerCase();
  if (req.method === 'GET' || action === 'sync') {
    return handleLogsDomainSync(req, res);
  }

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

    // ONE orders row for the whole purchase — all logs under supplierOrderId.
    // Numbered 1. 2. 3. … so user/admin see every log without N database rows.
    const deliveredCount = items.length;
    const formatHint = product.display_description || product.description || product.name || '';
    let savedCount = 0;

    if (deliveredCount > 0) {
      const combinedCreds =
        formatMultiLogCredentials(items, formatHint) ||
        formatCredentials(items[0].details, formatHint) ||
        String(items[0].details || '').trim() ||
        null;
      const combinedRaw = joinRawLogDetails(items) || detailsText || null;
      const supplierRefs = items
        .map((it) => it.serial || it.id)
        .filter(Boolean)
        .map(String)
        .join(', ');
      const insertErr = await insertLogOrder({
        // Customer-facing MJ id — never the supplier's logs-api-… id
        order_id: String(orderRef),
        user_id,
        product_id: product.id,
        product_code: product_key,
        product_name: productName,
        product_type: 'log',
        description: (product.display_description || product.description || '').trim() || null,
        quantity: deliveredCount,
        amount: total,
        status: 'completed',
        login_credentials: combinedCreds,
        login_credentials_raw: combinedRaw,
        supplier_ref: [String(supplierOrderId), supplierRefs].filter(Boolean).join(' | ') || String(supplierOrderId),
        guide_url: 'https://t.me/mj_hub_tg'
      });
      if (insertErr) {
        console.error('[order-logsdomain] FAILED to save order row:', insertErr.message, {
          order_id: orderRef,
        supplier_order_id: supplierOrderId, user_id, product_key, qty: deliveredCount
        });
      } else {
        savedCount = deliveredCount;
      }
    } else {
      // fallback single row if API returns no items array
      const insertErr = await insertLogOrder({
        order_id: String(orderRef),
        user_id,
        product_id: product.id,
        product_code: product_key,
        product_name: productName,
        product_type: 'log',
        description: (product.display_description || product.description || '').trim() || null,
        quantity: qty,
        amount: total,
        status: 'completed',
        login_credentials: formatCredentials(detailsText, formatHint) || detailsText || 'Delivered — see order for details',
        login_credentials_raw: detailsText || null,
        supplier_ref: String(supplierOrderId),
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

    const formattedItems = items.length
      ? items.map((i) => ({
          details: formatCredentials(i.details, formatHint) || String(i.details || '').trim(),
          serial: i.serial
        }))
      : [{ details: formatCredentials(detailsText, formatHint) || detailsText || 'Order completed' }];
    const loginCredentials =
      formatMultiLogCredentials(items.length ? items : [{ details: detailsText }], formatHint) ||
      formattedItems.map((i) => i.details).filter(Boolean).join('\n\n') ||
      detailsText ||
      '';

    return res.status(200).json({
      success: true,
      message: shortfall > 0
        ? `Delivered ${deliveredCount} of ${qty}. Shortfall of ${shortfall} was refunded to your wallet.`
        : 'Order fulfilled successfully',
      data: {
        items: formattedItems,
        login_credentials: loginCredentials,
        total_amount: chargedTotal,
        new_balance: newBalance,
        order_id: orderRef,
        supplier_order_id: supplierOrderId,
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
