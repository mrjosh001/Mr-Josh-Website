import { createClient } from '@supabase/supabase-js';
import { applyMarkup } from '../lib/pricing.js';
import { rateLimit, applyRateLimitHeaders } from '../lib/rateLimit.js';
import { rejectClientSuppliedSecrets, applyApiCors, handleOptions, setNoStore } from '../lib/secure.js';
import { sendError } from '../lib/errors.js';

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
 * Body shape: { resource: 'user' | 'product' | 'inventory' | 'secrets_status' | ..., action: '...', ...fields }
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
 *     action: 'bulk_reprice' — { mode: 'unpriced_only' | 'all' } — applies
 *     the standard markup (lib/pricing.js) across many rows at once instead
 *     of editing them one at a time in the table.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/** 2% lifetime referral on deposits — shared logic (kept here so no extra serverless file) */
async function payReferralCommission(refereeUserId, depositAmountNgn, depositReference) {
  const COMMISSION_RATE = 0.02;
  const amount = Number(depositAmountNgn) || 0;
  if (amount < 1 || !refereeUserId) return { paid: false, reason: 'skip' };

  const { data: referee } = await supabase
    .from('profiles')
    .select('id, referred_by, customer_id')
    .eq('id', refereeUserId)
    .maybeSingle();
  if (!referee?.referred_by) return { paid: false, reason: 'no_referrer' };

  const commission = Math.floor(amount * COMMISSION_RATE * 100) / 100;
  if (commission < 0.01) return { paid: false, reason: 'too_small' };

  if (depositReference) {
    const { data: existing } = await supabase
      .from('referral_earnings')
      .select('id')
      .eq('deposit_reference', String(depositReference))
      .maybeSingle();
    if (existing) return { paid: false, reason: 'already_paid' };
  }

  const referrerId = referee.referred_by;
  const { data: refProf } = await supabase
    .from('profiles')
    .select('id, balance, customer_id')
    .eq('id', referrerId)
    .maybeSingle();
  if (!refProf) return { paid: false, reason: 'referrer_missing' };

  const nextBal = (Number(refProf.balance) || 0) + commission;
  const { error: balErr } = await supabase
    .from('profiles')
    .update({ balance: nextBal })
    .eq('id', referrerId);
  if (balErr) {
    console.error('[referral] balance update', balErr.message);
    return { paid: false, reason: balErr.message };
  }

  try {
    await supabase.from('referral_earnings').insert({
      referrer_id: referrerId,
      referee_id: refereeUserId,
      deposit_reference: depositReference ? String(depositReference) : null,
      deposit_amount_ngn: amount,
      commission_ngn: commission
    });
  } catch (e) {
    console.warn('[referral] earnings insert', e?.message || e);
  }

  // Must appear under Deposit in user transaction history
  try {
    await supabase.from('transactions').insert({
      user_id: referrerId,
      customer_id: refProf.customer_id || null,
      type: 'deposit',
      category: 'deposit',
      title: 'Referral bonus',
      subtitle: `2% of friend's deposit · ₦${amount.toLocaleString()}`,
      amount: '₦' + commission.toLocaleString(),
      amount_ngn: commission,
      status: 'completed',
      channel: 'Referral',
      payment_provider: 'Referral',
      created_at: new Date().toISOString()
    });
  } catch (e) {
    console.warn('[referral] tx insert', e?.message || e);
  }

  return { paid: true, commission, referrer_id: referrerId, new_balance: nextBal };
}


const PERMANENT_BAN_DURATION = '876000h';

function truthyFlag(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

async function requireAdmin(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, message: 'Missing admin session' };

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return { ok: false, status: 401, message: 'Invalid session' };

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin, is_sub_admin, customer_id, full_name, email, username')
    .eq('id', user.id)
    .maybeSingle();

  const isAdmin = profile && truthyFlag(profile.is_admin);
  if (!isAdmin) return { ok: false, status: 403, message: 'Admin privileges required' };

  return { ok: true, adminId: user.id, isAdmin: true, isSubAdmin: false, profile, email: (profile && profile.email) || user.email || '' };
}

/** Main admin OR sub-admin (vendor) */
async function requireStaff(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, message: 'Missing session' };

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return { ok: false, status: 401, message: 'Invalid session' };

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin, is_sub_admin, customer_id, full_name, email, username')
    .eq('id', user.id)
    .maybeSingle();

  const isAdmin = profile && truthyFlag(profile.is_admin);
  const isSubAdmin = profile && truthyFlag(profile.is_sub_admin);
  if (!isAdmin && !isSubAdmin) {
    return { ok: false, status: 403, message: 'Staff privileges required' };
  }

  return {
    ok: true,
    adminId: user.id,
    userId: user.id,
    isAdmin,
    isSubAdmin,
    profile
  };
}

// ---------- resource: sub_admin (main admin only) ----------

async function subAdminAssign(body) {
  const email = (body.email || '').toString().trim().toLowerCase();
  const customerId = (body.customer_id || body.customerId || '').toString().trim();
  if (!email && !customerId) {
    return { status: 400, body: { success: false, message: 'Provide email or customer_id' } };
  }

  let q = supabase.from('profiles').select('id, email, customer_id, full_name, username, is_admin, is_sub_admin');
  if (customerId) q = q.eq('customer_id', customerId);
  else q = q.ilike('email', email);

  const { data: row, error } = await q.maybeSingle();
  if (error) return { status: 500, body: { success: false, message: error.message } };
  if (!row) return { status: 404, body: { success: false, message: 'User not found' } };
  if (truthyFlag(row.is_admin)) {
    return { status: 400, body: { success: false, message: 'Cannot convert a main admin into sub-admin' } };
  }

  const { error: upErr } = await supabase
    .from('profiles')
    .update({ is_sub_admin: true })
    .eq('id', row.id);
  if (upErr) {
    // column missing
    if (/is_sub_admin|column/i.test(upErr.message || '')) {
      return {
        status: 500,
        body: {
          success: false,
          message: 'Run sql/sub_admin.sql in Supabase first (is_sub_admin column missing)'
        }
      };
    }
    return { status: 500, body: { success: false, message: upErr.message } };
  }

  return {
    status: 200,
    body: {
      success: true,
      message: 'Sub-admin assigned',
      data: { id: row.id, email: row.email, customer_id: row.customer_id, full_name: row.full_name }
    }
  };
}

async function subAdminRevoke(body) {
  const userId = body.user_id || body.id;
  const email = (body.email || '').toString().trim().toLowerCase();
  const customerId = (body.customer_id || '').toString().trim();
  if (!userId && !email && !customerId) {
    return { status: 400, body: { success: false, message: 'Provide user_id, email, or customer_id' } };
  }

  let q = supabase.from('profiles').update({ is_sub_admin: false });
  if (userId) q = q.eq('id', userId);
  else if (customerId) q = q.eq('customer_id', customerId);
  else q = q.ilike('email', email);

  const { error } = await q;
  if (error) return { status: 500, body: { success: false, message: error.message } };
  return { status: 200, body: { success: true, message: 'Sub-admin access revoked' } };
}

async function subAdminList() {
  // profiles may not have created_at — select only columns that exist on this project
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, customer_id, full_name, username, is_sub_admin')
    .eq('is_sub_admin', true);
  if (error) return { status: 500, body: { success: false, message: error.message } };
  const rows = data || [];
  rows.sort((a, b) => String(a.email || '').localeCompare(String(b.email || '')));
  return { status: 200, body: { success: true, data: rows } };
}

// ---------- resource: vendor (sub-admin portal) ----------

async function vendorProductsList(staff) {
  const ownerId = staff.userId;
  let q = supabase
    .from('products')
    .select('id, product_key, name, description, display_description, price, supplier_price, stock_quantity, is_available, category, source, owner_id, updated_at')
    .order('updated_at', { ascending: false })
    .limit(500);
  if (!staff.isAdmin) q = q.eq('owner_id', ownerId);
  else q = q.not('owner_id', 'is', null); // main admin: all vendor-owned
  const { data, error } = await q;
  if (error) {
    if (/owner_id|column/i.test(error.message || '')) {
      return { status: 500, body: { success: false, message: 'Run sql/sub_admin.sql (owner_id on products)' } };
    }
    return { status: 500, body: { success: false, message: error.message } };
  }
  return { status: 200, body: { success: true, data: data || [] } };
}



async function assertVendorOwnsProduct(staff, productKey) {
  const { data: product, error } = await supabase
    .from('products')
    .select('id, product_key, name, owner_id, source, is_shared')
    .eq('product_key', productKey)
    .maybeSingle();
  if (error || !product) {
    return { ok: false, status: 404, message: 'Product not found' };
  }
  if (!staff.isAdmin && product.owner_id !== staff.userId) {
    return { ok: false, status: 403, message: 'You can only manage inventory for your own products' };
  }
  return { ok: true, product };
}

async function vendorInventory(body, staff) {
  const action = body.inventory_action || body.action_detail || body.inv_action;
  const product_key = String(body.product_key || '').trim();
  if (!product_key) {
    return { status: 400, body: { success: false, message: 'product_key is required' } };
  }

  const owned = await assertVendorOwnsProduct(staff, product_key);
  if (!owned.ok) return { status: owned.status, body: { success: false, message: owned.message } };
  const product = owned.product;

  // stock counts
  if (action === 'stock_count' || action === 'status') {
    const { count: available } = await supabase
      .from('product_inventory')
      .select('id', { count: 'exact', head: true })
      .eq('product_key', product_key)
      .eq('status', 'available');
    const { count: sold } = await supabase
      .from('product_inventory')
      .select('id', { count: 'exact', head: true })
      .eq('product_key', product_key)
      .eq('status', 'sold');
    await supabase
      .from('products')
      .update({
        stock_quantity: available || 0,
        is_available: (available || 0) > 0,
        is_shared: false,
        source: 'manual',
        updated_at: new Date().toISOString()
      })
      .eq('product_key', product_key);
    return {
      status: 200,
      body: {
        success: true,
        data: {
          product_key,
          product_name: product.name,
          available: available || 0,
          sold: sold || 0
        }
      }
    };
  }

  if (action === 'bulk_upload') {
    const text = String(body.text || '');
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) {
      return { status: 400, body: { success: false, message: 'Paste at least one credential line' } };
    }

    const { data: existingRows } = await supabase
      .from('product_inventory')
      .select('credential')
      .eq('product_key', product_key);
    const existingSet = new Set((existingRows || []).map((r) => r.credential));
    const newLines = lines.filter((l) => !existingSet.has(l));
    const skippedDuplicates = lines.length - newLines.length;

    if (newLines.length) {
      const rows = newLines.map((credential) => ({
        product_key,
        credential,
        status: 'available'
      }));
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const { error: insErr } = await supabase
          .from('product_inventory')
          .insert(rows.slice(i, i + CHUNK));
        if (insErr) {
          return {
            status: 500,
            body: { success: false, message: 'Upload failed: ' + insErr.message }
          };
        }
      }
    }

    const { count: available } = await supabase
      .from('product_inventory')
      .select('id', { count: 'exact', head: true })
      .eq('product_key', product_key)
      .eq('status', 'available');

    await supabase
      .from('products')
      .update({
        stock_quantity: available || 0,
        is_available: (available || 0) > 0,
        is_shared: false,
        source: 'manual',
        updated_at: new Date().toISOString()
      })
      .eq('product_key', product_key);

    return {
      status: 200,
      body: {
        success: true,
        data: {
          product_key,
          product_name: product.name,
          inserted: newLines.length,
          skipped_duplicates: skippedDuplicates,
          available_stock: available || 0,
          message: 'Each line is one unique log. Sold lines cannot be sold again.'
        }
      }
    };
  }

  return {
    status: 400,
    body: { success: false, message: 'Unknown inventory action. Use bulk_upload or stock_count.' }
  };
}

async function vendorCategoriesList() {
  // Distinct categories already on the platform (all products)
  const { data, error } = await supabase
    .from('products')
    .select('category')
    .not('category', 'is', null)
    .limit(2000);
  if (error) return { status: 500, body: { success: false, message: error.message } };
  const set = new Set();
  for (const row of data || []) {
    const c = String(row.category || '').trim();
    if (c) set.add(c);
  }
  const list = Array.from(set).sort((a, b) => a.localeCompare(b));
  return { status: 200, body: { success: true, data: list } };
}

async function vendorProductUpsert(body, staff) {
  const fields = body.fields || body;
  const productKey = (fields.product_key || body.product_key || '').toString().trim();
  if (!productKey && !body.id) {
    return { status: 400, body: { success: false, message: 'product_key or id required' } };
  }

  // Load existing if any
  let existing = null;
  if (body.id) {
    const { data } = await supabase.from('products').select('*').eq('id', body.id).maybeSingle();
    existing = data;
  } else if (productKey) {
    const { data } = await supabase.from('products').select('*').eq('product_key', productKey).maybeSingle();
    existing = data;
  }

  if (existing && !staff.isAdmin && existing.owner_id !== staff.userId) {
    return { status: 403, body: { success: false, message: 'You can only edit your own products' } };
  }

  const payload = {};
  if (fields.name != null) payload.name = String(fields.name).trim();
  if (fields.description != null) payload.description = fields.description;
  if (fields.display_description != null) payload.display_description = fields.display_description;
  if (fields.price != null) payload.price = Number(fields.price) || 0;
  if (fields.stock_quantity != null) payload.stock_quantity = Number(fields.stock_quantity) || 0;
  if (fields.is_available != null) { payload.is_available = !!fields.is_available; payload.admin_hidden = !payload.is_available; }
  if (fields.category != null) {
    const cat = String(fields.category).trim();
    if (!staff.isAdmin && cat) {
      const { data: cats } = await supabase.from('products').select('category').not('category', 'is', null).limit(2000);
      const allowed = new Set((cats || []).map((r) => String(r.category || '').trim()).filter(Boolean));
      if (allowed.size && !allowed.has(cat)) {
        return { status: 400, body: { success: false, message: 'Category must be one of the existing site categories' } };
      }
    }
    payload.category = cat;
  }
  if (fields.login_format != null || fields.credential_format != null) {
    // store format hint in display_description prefix if empty description
    const fmt = fields.login_format || fields.credential_format;
    if (fmt && !payload.display_description) payload.display_description = String(fmt);
  }
  payload.updated_at = new Date().toISOString();

  if (!existing) {
    // Create manual product owned by this vendor
    const key = productKey || ('manual_v_' + staff.userId.slice(0, 8) + '_' + Date.now());
    const insertRow = {
      product_key: key,
      name: payload.name || 'Manual product',
      description: payload.description || null,
      display_description: payload.display_description || fields.credential_format || null,
      price: payload.price != null ? payload.price : 1000,
      supplier_price: 0,
      stock_quantity: payload.stock_quantity != null ? payload.stock_quantity : 0,
      is_available: payload.is_available != null ? payload.is_available : true,
      category: payload.category || 'MANUAL',
      source: 'manual',
      owner_id: staff.userId,
      updated_at: payload.updated_at
    };
    const { data, error } = await supabase.from('products').insert(insertRow).select('*').maybeSingle();
    if (error) {
      if (/owner_id|column/i.test(error.message || '')) {
        return { status: 500, body: { success: false, message: 'Run sql/sub_admin.sql (owner_id on products)' } };
      }
      return { status: 500, body: { success: false, message: error.message } };
    }
    return { status: 200, body: { success: true, data, message: 'Product created' } };
  }

  const { data, error } = await supabase
    .from('products')
    .update(payload)
    .eq('id', existing.id)
    .select('*')
    .maybeSingle();
  if (error) return { status: 500, body: { success: false, message: error.message } };
  return { status: 200, body: { success: true, data, message: 'Product updated' } };
}

async function vendorProductDelete(body, staff) {
  const id = body.id;
  const productKey = body.product_key;
  if (!id && !productKey) {
    return { status: 400, body: { success: false, message: 'id or product_key required' } };
  }
  let q = supabase.from('products').select('id, owner_id, product_key');
  if (id) q = q.eq('id', id);
  else q = q.eq('product_key', productKey);
  const { data: row, error } = await q.maybeSingle();
  if (error || !row) return { status: 404, body: { success: false, message: 'Product not found' } };
  if (!staff.isAdmin && row.owner_id !== staff.userId) {
    return { status: 403, body: { success: false, message: 'You can only delete your own products' } };
  }
  const { error: delErr } = await supabase.from('products').delete().eq('id', row.id);
  if (delErr) return { status: 500, body: { success: false, message: delErr.message } };
  return { status: 200, body: { success: true, message: 'Product deleted' } };
}

async function vendorStats(staff) {
  const ownerId = staff.isAdmin && staff.bodyOwnerId ? staff.bodyOwnerId : staff.userId;
  const { data: products, error: pErr } = await supabase
    .from('products')
    .select('id, product_key, name, price')
    .eq('owner_id', ownerId);
  if (pErr) {
    if (/owner_id|column/i.test(pErr.message || '')) {
      return { status: 500, body: { success: false, message: 'Run sql/sub_admin.sql first' } };
    }
    return { status: 500, body: { success: false, message: pErr.message } };
  }
  const ids = (products || []).map((p) => p.id).filter(Boolean);
  const keys = (products || []).map((p) => p.product_key).filter(Boolean);
  if (!ids.length && !keys.length) {
    return {
      status: 200,
      body: {
        success: true,
        data: { products: 0, orders: 0, revenue_ngn: 0, recent_orders: [] }
      }
    };
  }

  let orders = [];
  // Match by product_id or product_code
  const { data: byId } = await supabase
    .from('orders')
    .select('id, order_id, product_id, product_code, product_name, quantity, amount, status, created_at, login_credentials')
    .in('product_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(200);
  const { data: byKey } = keys.length
    ? await supabase
        .from('orders')
        .select('id, order_id, product_id, product_code, product_name, quantity, amount, status, created_at, login_credentials')
        .in('product_code', keys)
        .eq('status', 'completed')
        .order('created_at', { ascending: false })
        .limit(200)
    : { data: [] };

  const map = new Map();
  for (const o of [...(byId || []), ...(byKey || [])]) {
    map.set(o.id || o.order_id, o);
  }
  orders = Array.from(map.values());
  const revenue = orders.reduce((s, o) => s + (Number(o.amount) || 0), 0);
  const units = orders.reduce((s, o) => s + (Number(o.quantity) || 1), 0);

  return {
    status: 200,
    body: {
      success: true,
      data: {
        products: (products || []).length,
        orders: orders.length,
        units_sold: units,
        revenue_ngn: revenue,
        recent_orders: orders.slice(0, 50).map((o) => ({
          order_id: o.order_id,
          product_name: o.product_name,
          quantity: o.quantity,
          amount: o.amount,
          status: o.status,
          created_at: o.created_at
          // credentials intentionally omitted from list (privacy)
        }))
      }
    }
  };
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

  // Sever referral links before deleting — see the matching comment in
  // api/delete-account.js. This is the same fix applied on the admin side,
  // since admins were hitting the identical foreign-key block.
  const { error: unlinkErr } = await supabase.from('profiles').update({ referred_by: null }).eq('referred_by', user_id);
  if (unlinkErr) console.warn('admin userDelete: could not unlink referred users', unlinkErr.message);

  const { error: earningsErr } = await supabase.from('referral_earnings').delete().or(`referrer_id.eq.${user_id},referee_id.eq.${user_id}`);
  if (earningsErr) console.warn('admin userDelete: could not clear referral_earnings', earningsErr.message);

  const { error: profileError } = await supabase.from('profiles').delete().eq('id', user_id);
  if (profileError) return { status: 500, body: { success: false, message: 'Profile delete failed: ' + profileError.message } };

  const { error: authDeleteError } = await supabase.auth.admin.deleteUser(user_id);
  if (authDeleteError) {
    return { status: 200, body: { success: true, warning: `Profile deleted, but removing the login credentials failed: ${authDeleteError.message}` } };
  }
  return { status: 200, body: { success: true } };
}

async function userUpdate(body) {
  // balance changes only allowed here (admin JWT already verified)
  if (body.balance != null) {
    const b = Number(body.balance);
    if (!Number.isFinite(b) || b < 0 || b > 50_000_000) {
      return { status: 400, body: { success: false, message: 'Invalid balance value' } };
    }
  }
  if (body.balance_usd != null) {
    const b = Number(body.balance_usd);
    if (!Number.isFinite(b) || b < 0 || b > 1_000_000) {
      return { status: 400, body: { success: false, message: 'Invalid USD balance' } };
    }
  }

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
      status: 'Success',
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
    // Lifetime 2% to referrer when admin manually funds a referred user
    try {
      const refKey = 'manual_' + user_id + '_' + Date.now();
      const r = await payReferralCommission(user_id, amountAdded, refKey);
      if (r?.paid) console.log('[referral] manual deposit commission', r.commission);
    } catch (e) {
      console.warn('[referral] manual deposit', e?.message || e);
    }
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

  // Editing a price by hand here means "keep this exact price" — tag it so
  // Reprice All (and the daily sync) never overwrites it again.
  const payload = { price: Number(price), price_source: 'manual' };
  if (is_available !== undefined) payload.is_available = !!is_available;

  const { data, error } = await supabase.from('number_services').update(payload).eq('id', id).select().maybeSingle();
  if (error) return { status: 500, body: { success: false, message: 'Update failed: ' + error.message } };
  if (!data) return { status: 404, body: { success: false, message: 'SMS number listing not found' } };

  return { status: 200, body: { success: true, data } };
}

/**
 * Bulk-apply the standard markup to number_services rows in one pass —
 * for when there are too many country/service combos to reprice by hand.
 *
 * Both modes now behave the same way the daily sync already does: a price
 * set by hand via smsUpdate (price_source = 'manual') is never touched,
 * no matter which mode is used.
 *
 * mode: 'unpriced_only' (default) — only rows with price 0 or null.
 * mode: 'all' — reprices every system-priced row (price_source = 'system'),
 *       i.e. every row that hasn't been manually overridden. Use this to
 *       reroll margins across the board without disturbing manual edits.
 */
async function smsBulkReprice(body) {
  const mode = body.mode === 'all' ? 'all' : 'unpriced_only';
  const usdToNgn = Number(process.env.USD_TO_NGN_RATE) || 1500;

  // Manual overrides are off-limits in every mode — this is what makes
  // bulk reprice behave like the daily sync, which already never touches
  // customer selling price on existing rows.
  let query = supabase.from('number_services').select('id, supplier_price, price').neq('price_source', 'manual');
  if (mode === 'unpriced_only') query = query.or('price.is.null,price.eq.0');

  const { data: rows, error } = await query;
  if (error) return { status: 500, body: { success: false, message: 'Fetch failed: ' + error.message } };
  if (!rows || !rows.length) {
    return {
      status: 200,
      body: { success: true, updated: 0, total: 0, message: mode === 'unpriced_only' ? 'Nothing to do — every row already has a price.' : 'No system-priced listings to reprice (everything left is manually priced).' }
    };
  }

  const CONCURRENCY = 20;
  let updated = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (row) => {
      const newPrice = applyMarkup(Number(row.supplier_price || 0), usdToNgn);
      const { error: updErr } = await supabase.from('number_services').update({ price: newPrice, price_source: 'system' }).eq('id', row.id);
      if (updErr) errors.push(`${row.id}: ${updErr.message}`);
      else updated += 1;
    }));
  }

  return { status: 200, body: { success: true, updated, total: rows.length, errors: errors.slice(0, 10) } };
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
  if (fields.is_shared !== undefined) payload.is_shared = !!fields.is_shared;
  if (fields.shared_credential !== undefined) payload.shared_credential = fields.shared_credential || null;
  // Shared products stay listed as in stock
  if (payload.is_shared) {
    // Do not force is_available — admin may hide a shared product from the storefront.
    if (payload.is_available !== false) payload.stock_quantity = 99999;
  }
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
    stock_quantity: (fields.is_shared && fields.is_available !== false) ? 99999 : (Number(fields.stock_quantity) || 0),
    is_available: fields.is_available !== false,
    is_shared: !!fields.is_shared,
    shared_credential: fields.shared_credential || null,
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

  // Never auto-unhide products. Admin "Hidden" must stick.
  // Shared listings keep infinite stock display; unique inventory only updates quantity.
  const { data: prod } = await supabase
    .from('products')
    .select('is_shared, is_available')
    .eq('product_key', productKey)
    .maybeSingle();

  if (prod?.is_shared) {
    await supabase.from('products').update({
      stock_quantity: 99999,
      updated_at: new Date().toISOString()
    }).eq('product_key', productKey);
    return available;
  }

  const upd = {
    stock_quantity: available,
    updated_at: new Date().toISOString()
  };
  // Only auto-hide when stock hits 0. Do not force is_available true when stock > 0.
  if (available === 0) upd.is_available = false;
  await supabase.from('products').update(upd).eq('product_key', productKey);
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

  // Shared mode: same credential for every buyer, no inventory rows consumed
  if (action === 'set_shared') {
    const credential = String(body.credential || body.text || '').trim();
    if (!credential) {
      return { status: 400, body: { success: false, message: 'Paste the content every buyer should receive.' } };
    }
    const { error } = await supabase.from('products').update({
      is_shared: true,
      shared_credential: credential,
      stock_quantity: 99999,
      is_available: true,
      source: 'manual',
      updated_at: new Date().toISOString()
    }).eq('product_key', product_key);
    if (error) return { status: 400, body: { success: false, message: error.message } };
    return {
      status: 200,
      body: {
        success: true,
        data: { product_key, mode: 'shared', message: 'Shared content saved. Every buyer of this product will receive the same details.' }
      }
    };
  }

  if (action === 'clear_shared') {
    const { error } = await supabase.from('products').update({
      is_shared: false,
      shared_credential: null,
      updated_at: new Date().toISOString()
    }).eq('product_key', product_key);
    if (error) return { status: 400, body: { success: false, message: error.message } };
    const available = await inventorySyncStockCount(product_key);
    return { status: 200, body: { success: true, data: { product_key, mode: 'unique', available } } };
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

  return { status: 400, body: { success: false, message: 'Unknown action. Use "bulk_upload", "stock_count", "set_shared", or "clear_shared".' } };
}


async function listProfilesHandle() {
  // Service role — bypasses RLS so admin always sees every customer + live balances
  let { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, email, phone, phone_number, customer_id, is_admin, is_banned, balance, balance_usd, updated_at, avatar_url, username')
    .order('full_name', { ascending: true })
    .limit(5000);
  if (error && /column|schema cache|Could not find/i.test(error.message || '')) {
    ({ data, error } = await supabase.from('profiles').select('*').order('full_name', { ascending: true }).limit(5000));
  }
  if (error) {
    return { status: 500, body: { success: false, message: 'Could not load profiles: ' + error.message } };
  }
  return { status: 200, body: { success: true, data: data || [] } };
}

async function listOrdersHandle() {
  // Service role: every log sale including manual_ / restock products
  let { data, error } = await supabase
    .from('orders')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) {
    return { status: 500, body: { success: false, message: 'Could not load orders: ' + error.message } };
  }
  const rows = data || [];
  const userIds = [...new Set(rows.map((o) => o.user_id).filter(Boolean))];
  let profileMap = new Map();
  if (userIds.length) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, email, full_name, customer_id')
      .in('id', userIds);
    for (const p of profiles || []) profileMap.set(p.id, p);
  }
  const enriched = rows.map((o) => {
    const p = profileMap.get(o.user_id) || {};
    const code = String(o.product_code || o.product_key || '');
    const isManual =
      String(o.source || '').toLowerCase() === 'manual' ||
      code.startsWith('manual_');
    return {
      ...o,
      customer_email: p.email || o.customer_email || null,
      customer_name: p.full_name || o.customer_name || null,
      customer_id: p.customer_id || o.customer_id || null,
      source: o.source || (isManual ? 'manual' : o.source || null),
      is_manual: isManual
    };
  });
  return { status: 200, body: { success: true, data: enriched } };
}

async function listSmsOrdersHandle() {
  let { data, error } = await supabase
    .from('number_orders')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) {
    return { status: 500, body: { success: false, message: 'Could not load SMS orders: ' + error.message } };
  }
  return { status: 200, body: { success: true, data: data || [] } };
}

async function listBoosterOrdersHandle() {
  let { data, error } = await supabase
    .from('booster_orders')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) {
    return { status: 500, body: { success: false, message: 'Could not load booster orders: ' + error.message } };
  }
  return { status: 200, body: { success: true, data: data || [] } };
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

/**
 * String.prototype.slice() cuts by UTF-16 code unit, not by character. If a
 * multi-byte character (emoji, unusual symbol, whatever a third-party
 * supplier's raw response happens to contain right at that boundary) sits
 * across the cut point, slice() can chop it in half, leaving an orphaned
 * surrogate half in the string. That's invalid Unicode on its own, and
 * while Node happily JSON.stringifies it anyway, Safari's strict native
 * JSON/body parser throws an opaque "The string did not match the expected
 * pattern" TypeError when the browser hits one — Chrome is more lenient,
 * which is why this only ever showed up on iPhone. This never surfaces
 * from our own data, only from raw text we're echoing back from Fadded /
 * LogsDomain / GrizzlySMS for debugging, so strip any orphaned surrogate
 * left over from truncation before it ever reaches the response body.
 */
function safeSlice(str, max) {
  if (typeof str !== 'string') return str;
  return str
    .slice(0, max)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/g, '');
}

async function tryJsonEndpoints(urls, headers, currencyGuess) {
  let lastRaw = null;
  let lastStatus = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: 'GET', headers });
      const text = await res.text();
      lastRaw = safeSlice(text, 300);
      lastStatus = res.status;
      if (!res.ok) continue;
      let json;
      try { json = JSON.parse(text); } catch { continue; }
      const balance = findBalance(json);
      if (balance !== null) return { ok: true, balance, currency: currencyGuess, source_url: url };
    } catch (err) {
      lastRaw = safeSlice(String(err.message || err), 300);
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


async function getSmsBusBalance() {
  const apiKey = process.env.SMSBUS_API_TOKEN || process.env.SMS_BUS_TOKEN;
  if (!apiKey) return { ok: false, error: 'Missing SMSBUS_API_TOKEN' };
  const url = `https://sms-bus.com/api/control/get/balance?token=${encodeURIComponent(apiKey)}`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const raw = await r.text();
    let data = {};
    try { data = JSON.parse(raw); } catch (_) {}
    if (!(data.code === 200 || data.code === '200')) {
      return { ok: false, error: data.message || 'SMS-Bus balance error', raw: safeSlice(raw, 200) };
    }
    let bal = data.data;
    if (bal && typeof bal === 'object') bal = bal.balance ?? bal.amount ?? bal.credit ?? bal;
    return { ok: true, balance: bal, currency: 'USD', raw: safeSlice(raw, 120) };
  } catch (e) {
    return { ok: false, error: e.message || 'SMS-Bus fetch failed' };
  }
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
    return { ok: false, error: text || `HTTP ${res.status}`, raw: safeSlice(text, 300) };
  } catch (err) {
    return { ok: false, error: safeSlice(String(err.message || err), 500) };
  }
}

async function getSujanBalance() {
  const apiKey = process.env.SUJAN_API_KEY;
  if (!apiKey) return { ok: false, error: 'Missing SUJAN_API_KEY' };
  const base = 'https://api.sujandepartment.com/reseller/v1';
  // Same situation as Fadded: Sujan's docs don't spell out a balance
  // endpoint (see api/sujan.js's header comment), so this tries the same
  // handful of conventional paths and lets findBalance() pull whatever
  // numeric field looks like a balance out of whichever one responds.
  return tryJsonEndpoints(
    [`${base}/balance`, `${base}/profile`, `${base}/me`, `${base}/account`, `${base}/wallet`],
    { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    'NGN'
  );
}


async function fetchOwletBalance() {
  const key = process.env.OWLET_API_KEY;
  if (!key) return { ok: false, error: 'OWLET_API_KEY not set', balance: null };
  try {
    const body = new URLSearchParams({ key, action: 'balance' });
    const res = await fetch('https://theowlet.com/api/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString()
    });
    const json = await res.json();
    if (json?.error) return { ok: false, error: String(json.error), balance: null, currency: 'USD' };
    return { ok: true, balance: json.balance, currency: json.currency || 'USD', raw: json };
  } catch (e) {
    return { ok: false, error: e.message || String(e), balance: null };
  }
}


async function getClassyBalance() {
  const apiKey = process.env.CLASSYTEE_API_KEY;
  if (!apiKey) return { ok: false, error: 'Missing CLASSYTEE_API_KEY' };
  const base = (process.env.CLASSYTEE_BASE_URL || 'https://classyteelogs.com.ng').replace(/\/$/, '');
  // Docs: GET /api/v1/balance — Authorization: Bearer KEY
  return tryJsonEndpoints(
    [`${base}/api/v1/balance`, `${base}/api/v1/wallet`, `${base}/api/v1/profile`],
    { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    'NGN'
  );
}

async function supplierBalancesFetch() {
  const [fadded, logsdomain, grizzly, sujan, owlet, classy, smsbus] = await Promise.all([
    getFaddedBalance(),
    getLogsDomainBalance(),
    getGrizzlyBalance(),
    getSujanBalance(),
    fetchOwletBalance(),
    getClassyBalance(),
    getSmsBusBalance()
  ]);
  return {
    status: 200,
    body: { success: true, suppliers: { fadded, logsdomain, grizzly, sujan, owlet, classy, smsbus }, fetched_at: new Date().toISOString() }
  };
}

const PERIOD_DAYS = { today: 1, '7days': 7, month: 30, '3months': 90, '6months': 180, '12months': 365 };

/**
 * Real account signup dates, for the admin Customers table's "Joined"
 * column. Deliberately NOT reading profiles.created_at — that column is
 * either missing or unpopulated for existing accounts (confirmed: showed
 * "—" for every user in the dashboard). Supabase Auth's own created_at is
 * the authoritative signup timestamp for every account regardless of
 * whether/when anything was added to the profiles table, so this reads
 * from there instead via the admin API (requires the service-role client,
 * which is why this can't just be a client-side query against `profiles`).
 */
async function getUserJoinDates() {
  const joinDates = {};
  let page = 1;
  const perPage = 1000;
  // Paginate defensively — listUsers defaults to 50/page; loop until a page
  // comes back short of a full page, so this keeps working correctly as
  // the user base grows past 1000 without silently truncating.
  for (let i = 0; i < 20; i++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) return { status: 500, body: { success: false, message: 'listUsers failed: ' + error.message } };
    const users = data?.users || [];
    for (const u of users) {
      if (u.id && u.created_at) joinDates[u.id] = u.created_at;
    }
    if (users.length < perPage) break;
    page += 1;
  }
  return { status: 200, body: { success: true, join_dates: joinDates } };
}

/**
 * Overview stats for the admin dashboard. Computed with SQL aggregation
 * (count/sum) rather than pulling raw rows to the client, so it's accurate
 * regardless of how many orders exist — the existing client-side "Revenue"
 * panel for logs only looks at the 200 most-recently-cached orders, which
 * quietly under-counts once there are more than 200 in the selected period.
 *
 * Adds what wasn't tracked here before: how many logs have been sold, and
 * SMS number order count / amount spent / profit — SMS numbers previously
 * weren't reflected in the overview at all.
 */
async function getOverviewStats(body) {
  const period = PERIOD_DAYS[body.period] ? body.period : 'month';
  const cutoff = new Date(Date.now() - PERIOD_DAYS[period] * 86400000).toISOString();
  const usdToNgn = Number(process.env.USD_TO_NGN_RATE) || 1500;

  let logsRes = await supabase.from('orders')
    .select('amount, quantity, product_key, product_code, product_name, product_id, status')
    .in('status', ['completed', 'paid', 'success', 'delivered', 'complete', 'fulfilled'])
    .gte('created_at', cutoff);
  if (logsRes.error && /column|schema cache/i.test(logsRes.error.message || '')) {
    logsRes = await supabase.from('orders')
      .select('amount, quantity, product_name, status')
      .in('status', ['completed', 'paid', 'success', 'delivered', 'complete', 'fulfilled'])
      .gte('created_at', cutoff);
  }

  const [smsRes, boostRes, productsRes] = await Promise.all([
    supabase.from('number_orders')
      .select('price, supplier_price, source, status, refunded')
      .gte('created_at', cutoff),
    supabase.from('booster_orders')
      .select('price_ngn, charge_usd, quantity, status, created_at')
      .gte('created_at', cutoff),
    supabase.from('products')
      .select('id, product_key, name, supplier_price')
  ]);

  if (logsRes.error) return { status: 500, body: { success: false, message: 'Logs stats failed: ' + logsRes.error.message } };
  if (smsRes.error) return { status: 500, body: { success: false, message: 'SMS stats failed: ' + smsRes.error.message } };

  // ----- SMS: Grizzly (Server 1) + SMS-Bus (Server 2) completed orders -----
  // supplier_price is USD for grizzly + smsbus; legacy logsdomain numbers may be NGN.
  const smsRows = (smsRes.data || []).filter((r) => {
    const st = String(r.status || '').toLowerCase();
    return st === 'completed' || st === 'complete' || st === 'success';
  });
  const smsAmountSpent = smsRows.reduce((s, r) => s + Number(r.price || 0), 0);
  const smsProfit = smsRows.reduce((s, r) => {
    const paid = Number(r.price || 0);
    const sp = Number(r.supplier_price || 0);
    if (!(sp > 0)) return s + paid;
    const source = String(r.source || '').toLowerCase();
    let cost = 0;
    if (source.includes('grizzly') || source.includes('smsbus')) {
      cost = sp * usdToNgn; // USD → NGN
    } else if (source.includes('logsdomain') || source.includes('logdomain') || source.includes('ld')) {
      cost = sp; // already NGN
    } else {
      const asUsd = sp * usdToNgn;
      cost = (sp < 50 && asUsd <= paid * 1.5) ? asUsd : sp;
    }
    return s + (paid - cost);
  }, 0);

  // ----- LOGS (product orders): customer paid (amount) minus product supplier_price -----
  const logRows = logsRes.data || [];
  const productList = productsRes.error ? [] : (productsRes.data || []);
  const productByKey = new Map();
  const productById = new Map();
  const productByName = new Map();
  for (const p of productList) {
    if (p.product_key) productByKey.set(String(p.product_key), p);
    if (p.id != null) productById.set(String(p.id), p);
    if (p.name) productByName.set(String(p.name).toLowerCase(), p);
  }
  // Units sold (sum quantity). One order with qty 3 counts as 3.
  const logsSoldCount = logRows.reduce((s, r) => s + Math.max(1, Number(r.quantity) || 1), 0);
  const logsAmountSpent = logRows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const logsProfit = logRows.reduce((s, r) => {
    const paid = Number(r.amount || 0);
    const qty = Math.max(1, Number(r.quantity) || 1);
    const key = r.product_key || r.product_code;
    let product = null;
    if (key) product = productByKey.get(String(key));
    if (!product && r.product_id != null) product = productById.get(String(r.product_id));
    if (!product && r.product_name) product = productByName.get(String(r.product_name).toLowerCase());
    // products.supplier_price is NGN (Fadded / LogsDomain / Sujan catalog)
    const unitCost = product ? Number(product.supplier_price || 0) : 0;
    // amount on order rows is usually the line total (or unit price for qty=1)
    // Prefer unit cost × qty; if amount looks like a multi-qty total, cost scales with qty
    const cost = unitCost * qty;
    return s + (paid - cost);
  }, 0);

  // Boosters: never fail the whole overview if this table is missing/empty
  let boostRows = [];
  if (boostRes.error) {
    console.warn('[overview] booster_orders:', boostRes.error.message);
    // Retry with minimal columns
    const retry = await supabase.from('booster_orders').select('price_ngn, status, created_at').gte('created_at', cutoff);
    if (!retry.error) boostRows = retry.data || [];
  } else {
    boostRows = boostRes.data || [];
  }
  boostRows = boostRows.filter(r => {
    const st = String(r.status || '').toLowerCase();
    return !['failed', 'cancelled', 'canceled', 'refunded'].includes(st);
  });
  const boostOrderCount = boostRows.length;
  const boostAmountSpent = boostRows.reduce((s, r) => s + Number(r.price_ngn || 0), 0);
  // Profit = customer paid (price_ngn) minus supplier charge.
  // Owlet status "charge" is stored in charge_usd but is often already NGN
  // (Naira panel). Only convert when the value clearly looks like USD.
  const boostProfit = boostRows.reduce((s, r) => {
    const paid = Number(r.price_ngn || 0);
    const charge = Number(r.charge_usd);
    let cost = 0;
    if (Number.isFinite(charge) && charge > 0) {
      const asUsd = charge * usdToNgn;
      // Small values that stay within revenue when converted → USD
      if (charge < 100 && asUsd <= paid * 1.5) {
        cost = asUsd;
      } else {
        // Already NGN (or would explode if treated as USD)
        cost = charge;
      }
    }
    // No invented markup. If supplier charge is unknown yet, cost stays 0
    // until Owlet status fills charge_usd.
    return s + (paid - cost);
  }, 0);

  return {
    status: 200,
    body: {
      success: true,
      period,
      logs_sold_count: logsSoldCount,
      logs_amount_spent: Math.round(logsAmountSpent),
      logs_profit: Math.round(logsProfit),
      sms_order_count: smsRows.length,
      sms_amount_spent: Math.round(smsAmountSpent),
      sms_profit: Math.round(smsProfit),
      boost_order_count: boostOrderCount,
      boost_amount_spent: Math.round(boostAmountSpent),
      boost_profit: Math.round(boostProfit)
    }
  };
}


// ---------- resource: secrets_status (booleans only — never secret values) ----------
function secretsStatusHandle() {
  const names = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'GRIZZLYSMS_API_KEY',
    'LOGSDOMAIN_API_KEY',
    'FADDED_API_KEY',
    'OWLET_API_KEY',
    'SUJAN_API_KEY',
    'POCKETFI_SECRET_KEY',
    'POCKETFI_PUBLIC_KEY',
    'POCKETFI_BUSINESS_ID',
    'POCKETFI_WEBHOOK_SECRET',
    'CRON_SECRET',
    'APP_URL',
    'SITE_URL',
  ];
  const secrets = {};
  for (const name of names) {
    const v = process.env[name];
    const prev = process.env[`${name}_PREVIOUS`];
    secrets[name] = {
      configured: !!(v && String(v).trim()),
      hasPrevious: !!(prev && String(prev).trim()),
    };
  }
  return {
    status: 200,
    body: {
      success: true,
      env: process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown',
      secrets,
      note: 'Values are never returned. Configure keys in Vercel → Settings → Environment Variables.',
    },
  };
}

// ---------- router ----------

/* ===========================================================================
 * EMAIL BROADCAST — resource: 'email_broadcast'
 *   action: 'preview' — no fields — returns { would_send, sample: [5 emails] }
 *   action: 'send'    — { subject, body } — actually sends via Resend
 *
 * Recipients: pages through profiles (1000 at a time), keeps rows with a
 * plausible email (contains '@'), skips email_unsubscribed = true, dedupes
 * by lowercased email. Same eligibility rule the existing nudge-email system
 * in api/order.js already uses, so "who's subscribed" means one consistent
 * thing everywhere in this codebase.
 *
 * Sending: Resend's /emails/batch endpoint, 50 emails per call (well under
 * their 100/call cap, leaves headroom), with a short pause between batches
 * so this function has less chance of hitting Vercel's execution time limit
 * on a large customer list. After a real send, logs one row to
 * "notifications" as "[Email] {subject}" with user_id: null — a record for
 * the admin's own "Recently Sent" list, NOT a real broadcast notification
 * (dashboard.html's bell/popup query explicitly excludes type:'email_log'
 * so customers never see this row as an in-app notification — see
 * loadAdminNotifications() in dashboard.html).
 *
 * Env: RESEND_API_KEY, RESEND_FROM_EMAIL (or RESEND_FROM), APP_URL
 * ========================================================================= */

async function fetchBroadcastRecipients() {
  const seen = new Set();
  const recipients = [];
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('profiles')
      .select('email, full_name')
      .or('email_unsubscribed.is.null,email_unsubscribed.eq.false')
      .range(from, from + pageSize - 1);

    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;

    for (const row of data) {
      const email = String(row.email || '').trim();
      if (!email || !email.includes('@')) continue;
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      recipients.push({ email, full_name: String(row.full_name || '').trim() });
    }

    if (data.length < pageSize) break;
    from += pageSize;
  }

  return recipients;
}

function escapeHtmlForEmail(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Same brand template as the deposit-notification email (pocketfi.js) —
 * dark/light adaptive, logo, blue CTA — with the admin's plain-text body
 * dropped in (HTML-escaped, line breaks kept) instead of an amount card. */
function buildBroadcastEmailHtml({ name, subject, message }) {
  const safeName = escapeHtmlForEmail(String(name || '').trim() || 'there');
  const paragraphs = escapeHtmlForEmail(message)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split(/\n{2,}/)
    .map((p) => `<p class="text-body" style="margin:0 0 14px;font-size:16px;line-height:1.65;color:#1e293b;">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
  const appUrl = (process.env.APP_URL || process.env.SITE_URL || 'https://www.mjhub.store').replace(/\/$/, '');
  const year = new Date().getFullYear();
  const unsubUrl = `${appUrl}/dashboard.html?unsubscribe=1`;
  const LOGO_LIGHT = 'https://atczodlljmlayvldxfmv.supabase.co/storage/v1/object/public/avatars/IMG_2796.jpeg';
  const LOGO_DARK = 'https://atczodlljmlayvldxfmv.supabase.co/storage/v1/object/public/avatars/mjhub-logo-dark-clear.png';

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  :root { color-scheme: light dark; }
  @media (prefers-color-scheme: dark) {
    .page { background-color:#0b1220 !important; }
    .card { background-color:#111827 !important; border-color:#1e293b !important; }
    .text-body { color:#e2e8f0 !important; }
    .text-muted { color:#94a3b8 !important; }
    .logo-light { display:none !important; width:0 !important; height:0 !important; overflow:hidden !important; }
    .logo-dark { display:block !important; }
    .brand-word { color:#ffffff !important; }
    .rule { border-color:#1e293b !important; }
  }
  @media (prefers-color-scheme: light) {
    .page { background-color:#e8eef8 !important; }
    .card { background-color:#ffffff !important; border-color:#dbe4f0 !important; }
    .text-body { color:#1e293b !important; }
    .text-muted { color:#64748b !important; }
    .logo-dark { display:none !important; width:0 !important; height:0 !important; overflow:hidden !important; }
    .logo-light { display:block !important; }
    .brand-word { color:#0f172a !important; }
    .rule { border-color:#e2e8f0 !important; }
  }
</style>
</head>
<body class="page" style="margin:0;padding:0;background-color:#e8eef8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="page" style="background-color:#e8eef8;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" class="card" style="max-width:560px;width:100%;background-color:#ffffff;border:1px solid #dbe4f0;border-radius:20px;">
        <tr>
          <td align="center" style="padding:32px 24px 12px;background:transparent;">
            <img src="https://atczodlljmlayvldxfmv.supabase.co/storage/v1/object/public/avatars/mjhub-mark-only.png" alt="MJ Hub" width="120" style="display:block;height:44px;width:auto;border:0;outline:none;background:transparent;">
            <div class="brand-word" style="margin-top:6px;font-size:13px;font-weight:800;letter-spacing:0.14em;color:#0f172a;">MJ HUB</div>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 32px 6px;">
            <p class="text-body" style="margin:0 0 16px;font-size:18px;font-weight:700;color:#0f172a;">Hi ${safeName},</p>
            ${paragraphs}
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:8px 32px 28px;">
            <a href="${appUrl}/dashboard.html" style="display:inline-block;background-color:#2563eb;color:#ffffff;font-weight:700;font-size:15px;text-decoration:none;padding:14px 28px;border-radius:12px;">Open MJ Hub</a>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 28px;">
            <hr class="rule" style="border:none;border-top:1px solid #e2e8f0;margin:0 0 16px;">
            <p class="text-muted" style="margin:0;font-size:12px;line-height:1.5;color:#64748b;text-align:center;">
              You received this because you have an MJ Hub account.
              <a href="${unsubUrl}" style="color:#2563eb;text-decoration:none;">Unsubscribe</a><br>© ${year} MJ Hub
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}


async function emailBroadcastTest(body, admin) {
  const subject = String(body.subject || '').trim();
  const message = String(body.body || '').trim();
  if (!subject) return { status: 400, body: { success: false, message: 'Subject is required' } };
  if (!message) return { status: 400, body: { success: false, message: 'Body is required' } };

  const to = String((admin && admin.email) || (admin && admin.profile && admin.profile.email) || '').trim();
  if (!to || !to.includes('@')) {
    return { status: 400, body: { success: false, message: 'Your admin profile has no email. Add it on your profile first.' } };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { status: 500, body: { success: false, message: 'Missing RESEND_API_KEY' } };
  }
  const from = process.env.RESEND_FROM_EMAIL || process.env.RESEND_FROM || 'MJ Hub <onboarding@resend.dev>';
  const name = (admin && admin.profile && admin.profile.full_name) || 'Admin';

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: '[TEST] ' + subject,
        html: buildBroadcastEmailHtml({ name, subject, message })
      })
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { status: 500, body: { success: false, message: json.message || json.error || ('Resend ' + resp.status) } };
    }
    return { status: 200, body: { success: true, sent: 1, failed: 0, to, id: json.id || null } };
  } catch (e) {
    return { status: 500, body: { success: false, message: e.message || 'Test send failed' } };
  }
}

async function emailBroadcastPreview() {
  try {
    const recipients = await fetchBroadcastRecipients();
    return {
      status: 200,
      body: {
        success: true,
        would_send: recipients.length,
        sample: recipients.slice(0, 5).map((r) => r.email)
      }
    };
  } catch (e) {
    return { status: 500, body: { success: false, message: 'Could not load recipients: ' + e.message } };
  }
}

async function emailBroadcastSend(body) {
  const subject = String(body.subject || '').trim();
  const message = String(body.body || '').trim();
  if (!subject) return { status: 400, body: { success: false, message: 'Subject is required' } };
  if (!message) return { status: 400, body: { success: false, message: 'Body is required' } };

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { status: 500, body: { success: false, message: 'Missing RESEND_API_KEY' } };
  }
  const from = process.env.RESEND_FROM_EMAIL || process.env.RESEND_FROM || 'MJ Hub <onboarding@resend.dev>';

  let recipients;
  try {
    recipients = await fetchBroadcastRecipients();
  } catch (e) {
    return { status: 500, body: { success: false, message: 'Could not load recipients: ' + e.message } };
  }

  if (recipients.length === 0) {
    return { status: 200, body: { success: true, sent: 0, failed: 0, total: 0 } };
  }

  let sent = 0;
  let failed = 0;
  const BATCH_SIZE = 50;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const chunk = recipients.slice(i, i + BATCH_SIZE);
    const payload = chunk.map((r) => ({
      from,
      to: [r.email],
      subject,
      html: buildBroadcastEmailHtml({ name: r.full_name, subject, message })
    }));

    try {
      const resp = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const json = await resp.json().catch(() => ({}));
      if (resp.ok && Array.isArray(json.data)) {
        sent += json.data.length;
        failed += chunk.length - json.data.length;
      } else {
        failed += chunk.length;
        console.error('[email_broadcast] batch failed', json?.error || json || resp.status);
      }
    } catch (e) {
      failed += chunk.length;
      console.error('[email_broadcast] batch request error', e.message);
    }

    // Short pause between batches so the function does not time out as easily
    if (i + BATCH_SIZE < recipients.length) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  try {
    await supabase.from('notifications').insert({
      user_id: null,
      title: `[Email] ${subject}`,
      body: null,
      type: 'email_log'
    });
  } catch (e) {
    console.warn('[email_broadcast] history log insert failed', e.message);
  }

  return { status: 200, body: { success: true, sent, failed, total: recipients.length } };
}

export default async function handler(req, res) {
  applyApiCors(req, res, { methods: 'POST, OPTIONS' });
  setNoStore(res);
  res.setHeader('Content-Type', 'application/json');
  if (handleOptions(req, res)) return;
  if (!rejectClientSuppliedSecrets(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }
  const rl = rateLimit(req, { limit: 60, windowMs: 60_000, suffix: 'admin' });
  applyRateLimitHeaders(res, rl);
  if (!rl.ok) return res.status(429).json({ success: false, message: rl.message });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { resource, action } = body;

    // Vendor portal: sub-admin OR main admin
    if (resource === 'vendor') {
      const staff = await requireStaff(req);
      if (!staff.ok) return res.status(staff.status).json({ success: false, message: staff.message });
      let result;
      if (action === 'products') result = await vendorProductsList(staff);
      else if (action === 'categories') result = await vendorCategoriesList();
      else if (action === 'inventory') result = await vendorInventory(body, staff);
      else if (action === 'product_save') result = await vendorProductUpsert(body, staff);
      else if (action === 'product_delete') result = await vendorProductDelete(body, staff);
      else if (action === 'stats') {
        staff.bodyOwnerId = body.user_id || null;
        result = await vendorStats(staff);
      } else {
        result = { status: 400, body: { success: false, message: 'Unknown vendor action' } };
      }
      return res.status(result.status).json(result.body);
    }

    // Everything else: main admin only
    const admin = await requireAdmin(req);
    if (!admin.ok) return res.status(admin.status).json({ success: false, message: admin.message });

    let result;
    if (resource === 'sub_admin') {
      if (action === 'assign') result = await subAdminAssign(body);
      else if (action === 'revoke') result = await subAdminRevoke(body);
      else if (action === 'list') result = await subAdminList();
      else result = { status: 400, body: { success: false, message: 'Unknown sub_admin action' } };
    } else if (resource === 'user') {
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
      else if (action === 'bulk_reprice') result = await smsBulkReprice(body);
      else result = { status: 400, body: { success: false, message: 'Unknown sms action. Use "update" or "bulk_reprice".' } };
    } else if (resource === 'profiles' && (action === 'list' || !action)) {
      result = await listProfilesHandle();
    } else if (resource === 'orders' && (action === 'list' || !action)) {
      result = await listOrdersHandle();
    } else if (resource === 'sms_orders' && (action === 'list' || !action)) {
      result = await listSmsOrdersHandle();
    } else if (resource === 'booster_orders' && (action === 'list' || !action)) {
      result = await listBoosterOrdersHandle();
    } else if (resource === 'supplier_balances') {
      result = await supplierBalancesFetch();
    } else if (resource === 'overview') {
      result = await getOverviewStats(body);
    } else if (resource === 'user_join_dates') {
      result = await getUserJoinDates();
    } else if (resource === 'secrets_status') {
      result = secretsStatusHandle();
    } else if (resource === 'email_broadcast') {
      if (action === 'preview') result = await emailBroadcastPreview();
      else if (action === 'send') result = await emailBroadcastSend(body);
      else if (action === 'test') result = await emailBroadcastTest(body, admin);
      else result = { status: 400, body: { success: false, message: 'Unknown email_broadcast action. Use "preview", "test", or "send".' } };
    } else {
      result = { status: 400, body: { success: false, message: 'Unknown resource. Use "user", "product", "inventory", "sms", "profiles", "orders", "sms_orders", "booster_orders", "supplier_balances", "overview", "user_join_dates", "secrets_status", "sub_admin", "email_broadcast", or "vendor".' } };
    }

    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('admin error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
}
