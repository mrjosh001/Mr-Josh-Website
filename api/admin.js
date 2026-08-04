import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/admin
 * Single consolidated admin endpoint. Folds together what used to be 5
 * separate files (admin-ban-user, admin-delete-user, admin-inventory,
 * admin-product, admin-update-user) — Vercel's Hobby plan caps a
 * deployment at 12 serverless functions, and each api/*.js file counts as
 * one, so 19 files across the whole api/ folder was over budget. This file
 * does exactly what those 5 did, unchanged, just routed by a `resource`
 * field instead of by filename.
 *
 * Body shape: { resource: 'user' | 'product' | 'inventory', action: '...', ...fields }
 *
 *   resource: 'user'
 *     action: 'ban'     — { user_id, banned }
 *     action: 'delete'  — { user_id }
 *     action: 'update'  — { user_id, full_name, username, email, phone_number, balance, balance_usd, is_admin }
 *
 *   resource: 'product'
 *     action: 'update' | 'insert' | 'delete' — same fields as the old admin-product.js
 *
 *   resource: 'inventory'
 *     action: 'bulk_upload' | 'stock_count' — same fields as the old admin-inventory.js
 *
 *   resource: 'sms'
 *     action: 'update' — { id, price, is_available } — GrizzlySMS number_services
 *     pricing only. Supplier fields (country/service/supplier_price/stock)
 *     are read-only here and only ever change via /api/grizzly-sync.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PERMANENT_BAN_DURATION = '876000h';

async function requireAdmin(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, message: 'Missing admin session' };

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return { ok: false, status: 401, message: 'Invalid session' };

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', user.id)
    .maybeSingle();

  const isAdmin = profile && (profile.is_admin === true || profile.is_admin === 'true' || profile.is_admin === 1);
  if (!isAdmin) return { ok: false, status: 403, message: 'Admin privileges required' };

  return { ok: true, adminId: user.id };
}

// ---------- resource: user ----------

async function userBan(body, adminId) {
  const { user_id, banned } = body;
  if (!user_id) return { status: 400, body: { success: false, message: 'user_id is required' } };
  if (typeof banned !== 'boolean') return { status: 400, body: { success: false, message: 'banned (true/false) is required' } };
  if (user_id === adminId) return { status: 400, body: { success: false, message: 'You cannot ban your own account.' } };

  const { error: banError } = await supabase.auth.admin.updateUserById(user_id, {
    ban_duration: banned ? PERMANENT_BAN_DURATION : 'none'
  });
  if (banError) return { status: 500, body: { success: false, message: 'Ban update failed: ' + banError.message } };

  const { error: profileError } = await supabase.from('profiles').update({ is_banned: banned }).eq('id', user_id);
  if (profileError) {
    return {
      status: 200,
      body: { success: true, warning: `User ${banned ? 'banned' : 'unbanned'} successfully, but the profile flag failed to update: ${profileError.message}. (Does profiles.is_banned exist?)` }
    };
  }
  return { status: 200, body: { success: true } };
}

async function userDelete(body, adminId) {
  const { user_id } = body;
  if (!user_id) return { status: 400, body: { success: false, message: 'user_id is required' } };
  if (user_id === adminId) return { status: 400, body: { success: false, message: 'You cannot delete your own account.' } };

  const { error: profileError } = await supabase.from('profiles').delete().eq('id', user_id);
  if (profileError) return { status: 500, body: { success: false, message: 'Profile delete failed: ' + profileError.message } };

  const { error: authDeleteError } = await supabase.auth.admin.deleteUser(user_id);
  if (authDeleteError) {
    return { status: 200, body: { success: true, warning: `Profile deleted, but removing the login credentials failed: ${authDeleteError.message}` } };
  }
  return { status: 200, body: { success: true } };
}

async function userUpdate(body) {
  const { user_id, full_name, username, email, phone_number, balance, balance_usd, is_admin } = body;
  if (!user_id) return { status: 400, body: { success: false, message: 'user_id is required' } };
  if (balance == null || isNaN(Number(balance))) {
    return { status: 400, body: { success: false, message: 'A valid balance is required' } };
  }

  const { data: existing, error: fetchErr } = await supabase
    .from('profiles')
    .select('balance, customer_id')
    .eq('id', user_id)
    .single();
  if (fetchErr || !existing) return { status: 404, body: { success: false, message: 'Customer not found' } };

  const prevBalance = Number(existing.balance || 0);
  const newBalance = Number(balance);
  const amountAdded = newBalance - prevBalance;

  const payload = {
    full_name: full_name ?? null,
    username: username ?? null,
    email: email || null,
    phone_number: phone_number || null,
    balance: newBalance,
    is_admin: !!is_admin
  };
  if (balance_usd !== undefined && balance_usd !== null && !isNaN(Number(balance_usd))) {
    payload.balance_usd = Number(balance_usd);
  }

  const { error: updateErr } = await supabase.from('profiles').update(payload).eq('id', user_id);
  if (updateErr) return { status: 500, body: { success: false, message: 'Profile update failed: ' + updateErr.message } };

  let depositRecorded = false;
  if (amountAdded > 0) {
    const { error: txErr } = await supabase.from('transactions').insert({
      user_id,
      customer_id: existing.customer_id || null,
      type: 'deposit',
      category: 'deposit',
      title: 'Manual Deposit',
      subtitle: 'Funded by admin',
      amount: '₦' + amountAdded.toLocaleString(),
      amount_ngn: amountAdded,
      status: 'completed',
      channel: 'Manual Deposit',
      payment_provider: 'Admin'
    });
    if (txErr) {
      return {
        status: 200,
        body: { success: true, warning: `Balance updated, but the deposit record failed to save: ${txErr.message}`, data: { amount_added: amountAdded, deposit_recorded: false } }
      };
    }
    depositRecorded = true;
  }

  return { status: 200, body: { success: true, data: { amount_added: amountAdded, deposit_recorded: depositRecorded } } };
}

// ---------- resource: sms (number_services / GrizzlySMS) ----------
// Deliberately narrow: this is the ONLY write path for number_services
// besides grizzly-sync.js. It only ever touches `price` and `is_available`
// — the two fields the admin controls. Every other column (country_name,
// service_name, supplier_price, available_quantity, providers_raw) is
// supplier-owned and only changes via a sync, never through this endpoint,
// so an admin's pricing decision can never be silently overwritten and a
// sync can never accidentally touch pricing.
async function smsUpdate(body) {
  const { id, price, is_available } = body;
  if (!id) return { status: 400, body: { success: false, message: 'id is required' } };
  if (price == null || isNaN(Number(price)) || Number(price) < 0) {
    return { status: 400, body: { success: false, message: 'A valid selling price is required' } };
  }

  const payload = { price: Number(price) };
  if (is_available !== undefined) payload.is_available = !!is_available;

  const { data, error } = await supabase.from('number_services').update(payload).eq('id', id).select().maybeSingle();
  if (error) return { status: 500, body: { success: false, message: 'Update failed: ' + error.message } };
  if (!data) return { status: 404, body: { success: false, message: 'SMS number listing not found' } };

  return { status: 200, body: { success: true, data } };
}

// ---------- resource: product ----------

async function productUpdate(body) {
  const { id, product_key, ...fields } = body;
  if (!id && !product_key) return { status: 400, body: { success: false, message: 'id or product_key required' } };

  const payload = {};
  if (fields.name !== undefined) payload.name = fields.name;
  if (fields.category !== undefined) payload.category = String(fields.category).trim();
  if (fields.description !== undefined) payload.description = fields.description;
  if (fields.display_description !== undefined) payload.display_description = fields.display_description;
  if (fields.price !== undefined) payload.price = Number(fields.price);
  if (fields.stock_quantity !== undefined) payload.stock_quantity = Number(fields.stock_quantity);
  if (fields.is_available !== undefined) payload.is_available = !!fields.is_available;
  payload.updated_at = new Date().toISOString();

  let error = null, data = null;
  if (id) {
    const result = await supabase.from('products').update(payload).eq('id', id).select().maybeSingle();
    error = result.error; data = result.data;
  }
  if ((!data || error) && product_key) {
    const result = await supabase.from('products').update(payload).eq('product_key', product_key).select().maybeSingle();
    error = result.error; data = result.data;
  }
  if ((!data || error) && id) {
    const result = await supabase.from('products').update(payload).eq('product_key', id).select().maybeSingle();
    error = result.error; data = result.data;
  }

  if (error) return { status: 400, body: { success: false, message: error.message } };
  return { status: 200, body: { success: true, data } };
}

async function productInsert(body) {
  const fields = body;
  const productKey = fields.product_key || `manual_${Date.now()}`;
  const payload = {
    name: fields.name,
    category: fields.category ? String(fields.category).trim() : 'OTHER',
    description: fields.description || null,
    display_description: fields.display_description || fields.description || null,
    price: Number(fields.price) || 0,
    supplier_price: Number(fields.supplier_price) || 0,
    stock_quantity: Number(fields.stock_quantity) || 0,
    is_available: fields.is_available !== false,
    product_key: productKey,
    source: String(productKey).startsWith('manual_') ? 'manual' : (fields.source || null),
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase.from('products').insert([payload]).select().maybeSingle();
  if (error) return { status: 400, body: { success: false, message: error.message } };
  return { status: 200, body: { success: true, data } };
}

async function productDelete(body) {
  const { id, product_key } = body;
  if (!id && !product_key) return { status: 400, body: { success: false, message: 'id or product_key required' } };

  let resolvedKey = product_key || null;
  if (!resolvedKey && id) {
    const { data: lookup } = await supabase.from('products').select('product_key').eq('id', id).maybeSingle();
    resolvedKey = lookup?.product_key || null;
  }

  if (resolvedKey) {
    await supabase.from('product_inventory').delete().eq('product_key', resolvedKey).eq('status', 'available');
  }

  let query = supabase.from('products').delete();
  query = id ? query.eq('id', id) : query.eq('product_key', product_key);
  const { error, count } = await query.select();

  if (error) {
    const isFkError = /foreign key|violates|constraint/i.test(error.message || '');
    return {
      status: 400,
      body: {
        success: false,
        message: isFkError
          ? 'This product has past orders attached to it, so it can\'t be deleted (that would break customer order history). Set it to "Hidden" instead to stop selling it.'
          : error.message
      }
    };
  }
  return { status: 200, body: { success: true, deleted: Array.isArray(count) ? count.length : 1 } };
}

// ---------- resource: inventory ----------

async function inventorySyncStockCount(productKey) {
  const { count } = await supabase
    .from('product_inventory')
    .select('id', { count: 'exact', head: true })
    .eq('product_key', productKey)
    .eq('status', 'available');

  const available = count || 0;
  await supabase.from('products').update({ stock_quantity: available, is_available: available > 0 }).eq('product_key', productKey);
  return available;
}

async function inventoryHandle(body) {
  const { action, product_key } = body;
  if (!product_key) return { status: 400, body: { success: false, message: 'product_key is required' } };

  const { data: product, error: prodErr } = await supabase
    .from('products')
    .select('id, product_key, name')
    .eq('product_key', product_key)
    .maybeSingle();

  if (prodErr || !product) {
    return { status: 404, body: { success: false, message: `No product found with product_key "${product_key}". Create it first (Stage 2).` } };
  }

  if (action === 'stock_count') {
    const available = await inventorySyncStockCount(product_key);
    return { status: 200, body: { success: true, data: { product_key, available } } };
  }

  if (action === 'bulk_upload') {
    const text = String(body.text || '');
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return { status: 400, body: { success: false, message: 'No credential lines found in the pasted text.' } };

    const { data: existingRows } = await supabase.from('product_inventory').select('credential').eq('product_key', product_key);
    const existingSet = new Set((existingRows || []).map(r => r.credential));
    const newLines = lines.filter(l => !existingSet.has(l));
    const skippedDuplicates = lines.length - newLines.length;

    if (newLines.length) {
      const rows = newLines.map(credential => ({ product_key, credential, status: 'available' }));
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const { error: insErr } = await supabase.from('product_inventory').insert(rows.slice(i, i + CHUNK));
        if (insErr) return { status: 500, body: { success: false, message: 'Insert failed partway through: ' + insErr.message } };
      }
    }

    const available = await inventorySyncStockCount(product_key);
    return {
      status: 200,
      body: { success: true, data: { product_key, product_name: product.name, inserted: newLines.length, skipped_duplicates: skippedDuplicates, available_stock: available } }
    };
  }

  return { status: 400, body: { success: false, message: 'Unknown action. Use "bulk_upload" or "stock_count".' } };
}

// ---------- resource: supplier_balances ----------
// Fetches your account balance from each supplier so you can see who needs
// a top-up without logging into each one separately. Folded into this file
// (rather than its own api/*.js) because Vercel's Hobby plan caps a
// deployment at 12 Serverless Functions and this project is already there.

/** Recursively hunt a parsed JSON object for a plausible balance field. */
function findBalance(obj, depth = 0) {
  if (obj == null || depth > 4) return null;
  if (typeof obj === 'number') return obj;
  if (typeof obj === 'string' && /^-?\d+(\.\d+)?$/.test(obj.trim())) return Number(obj);
  if (typeof obj !== 'object') return null;

  const keys = ['balance', 'wallet_balance', 'walletBalance', 'account_balance', 'credit', 'credits', 'funds', 'amount'];
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && typeof obj[k] !== 'object') {
      const n = Number(obj[k]);
      if (!Number.isNaN(n)) return n;
    }
  }
  for (const k of ['data', 'account', 'wallet', 'profile', 'result', 'user']) {
    if (obj[k] && typeof obj[k] === 'object') {
      const found = findBalance(obj[k], depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

async function tryJsonEndpoints(urls, headers, currencyGuess) {
  let lastRaw = null;
  let lastStatus = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: 'GET', headers });
      const text = await res.text();
      lastRaw = text.slice(0, 300);
      lastStatus = res.status;
      if (!res.ok) continue;
      let json;
      try { json = JSON.parse(text); } catch { continue; }
      const balance = findBalance(json);
      if (balance !== null) return { ok: true, balance, currency: currencyGuess, source_url: url };
    } catch (err) {
      lastRaw = String(err.message || err).slice(0, 300);
    }
  }
  return { ok: false, error: `No balance field found (last status ${lastStatus})`, raw: lastRaw };
}

async function getFaddedBalance() {
  const apiKey = process.env.FADDED_API_KEY;
  if (!apiKey) return { ok: false, error: 'Missing FADDED_API_KEY' };
  const base = 'https://fadded.net/api/v1/reseller';
  return tryJsonEndpoints(
    [`${base}/balance`, `${base}/profile`, `${base}/me`, `${base}/account`],
    { 'X-Api-Key': apiKey, Accept: 'application/json' },
    'NGN'
  );
}

async function getLogsDomainBalance() {
  const apiKey = process.env.LOGSDOMAIN_API_KEY;
  if (!apiKey) return { ok: false, error: 'Missing LOGSDOMAIN_API_KEY' };
  const base = 'https://logsdomain.com/api/v1';
  return tryJsonEndpoints(
    [`${base}/wallet`],
    { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    'NGN'
  );
}

async function getGrizzlyBalance() {
  const apiKey = process.env.GRIZZLYSMS_API_KEY;
  if (!apiKey) return { ok: false, error: 'Missing GRIZZLYSMS_API_KEY' };
  const base = 'https://api.grizzlysms.com/stubs/handler_api.php';

  try {
    const qs = new URLSearchParams({ api_key: apiKey, action: 'getBalanceV2' });
    const res = await fetch(`${base}?${qs.toString()}`, { method: 'GET' });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    if (json) {
      const balance = findBalance(json);
      if (balance !== null) return { ok: true, balance, currency: 'USD', source_url: 'getBalanceV2' };
    }
  } catch (err) {
    // fall through to legacy
  }

  try {
    const qs = new URLSearchParams({ api_key: apiKey, action: 'getBalance' });
    const res = await fetch(`${base}?${qs.toString()}`, { method: 'GET' });
    const text = (await res.text()).trim();
    if (text.startsWith('ACCESS_BALANCE:')) {
      const balance = Number(text.split(':')[1]);
      if (!Number.isNaN(balance)) return { ok: true, balance, currency: 'USD', source_url: 'getBalance' };
    }
    return { ok: false, error: text || `HTTP ${res.status}`, raw: text.slice(0, 300) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

async function supplierBalancesFetch() {
  const [fadded, logsdomain, grizzly] = await Promise.all([
    getFaddedBalance(),
    getLogsDomainBalance(),
    getGrizzlyBalance()
  ]);
  return {
    status: 200,
    body: { success: true, suppliers: { fadded, logsdomain, grizzly }, fetched_at: new Date().toISOString() }
  };
}

// ---------- router ----------

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const admin = await requireAdmin(req);
  if (!admin.ok) return res.status(admin.status).json({ success: false, message: admin.message });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { resource, action } = body;

    let result;
    if (resource === 'user') {
      if (action === 'ban') result = await userBan(body, admin.adminId);
      else if (action === 'delete') result = await userDelete(body, admin.adminId);
      else if (action === 'update') result = await userUpdate(body);
      else result = { status: 400, body: { success: false, message: 'Unknown user action. Use "ban", "delete", or "update".' } };
    } else if (resource === 'product') {
      if (action === 'update') result = await productUpdate(body);
      else if (action === 'insert') result = await productInsert(body);
      else if (action === 'delete') result = await productDelete(body);
      else result = { status: 400, body: { success: false, message: 'Unknown product action. Use "update", "insert", or "delete".' } };
    } else if (resource === 'inventory') {
      result = await inventoryHandle(body);
    } else if (resource === 'sms') {
      if (action === 'update') result = await smsUpdate(body);
      else result = { status: 400, body: { success: false, message: 'Unknown sms action. Use "update".' } };
    } else if (resource === 'supplier_balances') {
      result = await supplierBalancesFetch();
    } else {
      result = { status: 400, body: { success: false, message: 'Unknown resource. Use "user", "product", "inventory", "sms", or "supplier_balances".' } };
    }

    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('admin error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
}
