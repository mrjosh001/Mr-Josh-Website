import { createClient } from '@supabase/supabase-js';
import { debitWallet, refundWalletDebit } from './wallet.js';
import { requireUser, requireAdminOrCron } from './secure.js';

const BM_BASE = 'https://bulkmail.shop/api/v2';
const BM_KEY = process.env.BULKMAIL_API_KEY || process.env.BULK_MAIL_API_KEY || '';
const CATEGORY = 'Residential Proxy';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

function responseData(data) {
  if (data && data.data && data.data.data != null) return data.data.data;
  if (data && data.data != null) return data.data;
  return data;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.data)) return value.data;
  if (value && value.data && Array.isArray(value.data.data)) return value.data.data;
  if (value && Array.isArray(value.categories)) return value.categories;
  if (value && Array.isArray(value.products)) return value.products;
  if (value && Array.isArray(value.variants)) return value.variants;
  return [];
}

async function bmFetch(path, options = {}) {
  if (!BM_KEY) return { ok: false, status: 503, networkError: false, data: { message: 'BULKMAIL_API_KEY not configured' } };
  try {
    const response = await fetch(BM_BASE + path, {
      method: options.method || 'GET',
      headers: {
        'X-API-Key': BM_KEY,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: options.body == null ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(25000)
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, networkError: false, data };
  } catch (error) {
    return { ok: false, status: 502, networkError: true, data: { message: error.message || 'BulkMail request failed' } };
  }
}

function sellPriceNgn(usd) {
  const supplierNgn = Math.max(0, Number(usd) || 0) * 1450;
  return Math.ceil(Math.max(supplierNgn * 1.7, supplierNgn + 500, 1000) / 50) * 50;
}

function firstNumber(object, keys, fallback = 0) {
  for (const key of keys) {
    const value = object && object[key];
    if (value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value))) {
      return Math.max(0, Number(value));
    }
  }
  return fallback;
}

function unwrapObject(value) {
  if (!value || typeof value !== 'object') return {};
  if (value.data && !Array.isArray(value.data) && typeof value.data === 'object') {
    if (value.data.data && typeof value.data.data === 'object') return value.data.data;
    return value.data;
  }
  return value;
}

function normalizeVariant(product, variant) {
  const id = variant && (variant.id ?? variant.variant_id);
  if (id === undefined || id === null || String(id).trim() === '') return null;
  const usd = firstNumber(variant, ['price', 'unit_price', 'cost'], firstNumber(product, ['price_from', 'price', 'unit_price', 'cost'], 0));
  const stock = Math.floor(firstNumber(variant, ['stock', 'stock_quantity', 'available_quantity', 'available'], variant && (variant.in_stock === true || variant.available === true) ? 1 : 0));
  const max = Math.max(1, Math.floor(firstNumber(variant, ['max_quantity', 'maximum_quantity'], stock || 1)));
  const dataGb = firstNumber(variant, ['data_gb', 'gb'], 0);
  const ipCount = firstNumber(variant, ['ip_count', 'ips', 'quantity_ips'], 0);
  const label = String(variant.name || variant.title || variant.label || variant.variant_name || variant.plan_name ||
    (dataGb ? dataGb + ' GB' : '') || (ipCount ? ipCount + ' IP' : '') || variant.description || ('Variant ' + id)).trim();
  return {
    variant_id: String(id),
    product_id: String(product.id ?? product.product_id ?? product.slug ?? ''),
    product_name: String(product.name || product.title || product.slug || 'Residential Proxy').trim(),
    variant_name: label,
    supplier_price_usd: usd,
    retail_price_ngn: sellPriceNgn(usd),
    stock_quantity: stock,
    max_quantity: Math.min(max, 1000),
    is_available: stock > 0,
    raw: variant
  };
}

async function fetchProxyProducts() {
  const categoriesResponse = await bmFetch('/proxy/categories');
  if (!categoriesResponse.ok) {
    throw new Error('BulkMail residential categories failed (' + categoriesResponse.status + '): ' +
      String(categoriesResponse.data && (categoriesResponse.data.message || categoriesResponse.data.error) || 'Unknown error').slice(0, 180));
  }
  const categories = asArray(responseData(categoriesResponse.data));
  const residential = categories.find((item) =>
    String(item.slug || '').toLowerCase() === 'residential' ||
    String(item.name || '').toLowerCase().includes('residential') ||
    String(item.id || item.category_id || '') === '13'
  );
  const categoryValue = residential ? (residential.slug || residential.id || residential.category_id || 'residential') : 'residential';
  const all = [];
  let page = 1;
  let lastPage = 1;
  do {
    const result = await bmFetch('/proxy/products?category=' + encodeURIComponent(String(categoryValue)) +
      '&in_stock=true&page=' + page + '&per_page=100');
    if (!result.ok) {
      throw new Error('BulkMail residential products failed (' + result.status + '): ' +
        String(result.data && (result.data.message || result.data.error) || 'Unknown error').slice(0, 180));
    }
    const batch = asArray(responseData(result.data));
    all.push(...batch);
    const meta = (result.data && result.data.meta) || (result.data && result.data.data && result.data.data.meta) || {};
    lastPage = Math.max(1, Number(meta.total_pages || meta.last_page || 1));
    if (!batch.length) break;
    page += 1;
  } while (page <= lastPage && page <= 30);

  const products = [];
  for (const item of all) {
    const productId = item.id ?? item.product_id ?? item.slug;
    if (productId === undefined || productId === null) continue;
    let product = item;
    let variants = asArray(item.variants || item.options || item.plans);
    if (!variants.length) {
      const lookup = item.slug || item.id || item.product_id;
      const detail = await bmFetch('/proxy/products/' + encodeURIComponent(String(lookup)));
      if (detail.ok) {
        product = unwrapObject(detail.data);
        variants = asArray(product.variants || product.options || product.plans);
      }
    }
    const normalized = variants.map((variant) => normalizeVariant(product, variant)).filter(Boolean);
    products.push({ product, productId: String(productId), variants: normalized });
  }
  return products;
}

async function handleSync(req, res) {
  if (!BM_KEY) return res.status(503).json({ success: false, message: 'BULKMAIL_API_KEY not configured' });
  try {
    const products = await fetchProxyProducts();
    let productsCreated = 0;
    let productsUpdated = 0;
    let variantsSaved = 0;
    let errors = 0;
    const samples = [];
    const now = new Date().toISOString();

    for (const entry of products) {
      const name = String(entry.product.name || entry.product.title || entry.product.slug || ('Residential Proxy ' + entry.productId))
        .replace(/bulkmail/ig, '').replace(/\\s+/g, ' ').trim();
      const productKey = 'bm_proxy_' + entry.productId.replace(/[^a-zA-Z0-9_-]/g, '');
      const activeVariants = entry.variants.filter((variant) => variant.is_available);
      const planNames = entry.variants.map((variant) => variant.variant_name).filter(Boolean);
      const displayName = [name, planNames.length ? planNames.join(' / ') : ''].filter(Boolean).join(' · ').slice(0, 240);
      const stock = activeVariants.reduce((sum, variant) => sum + variant.stock_quantity, 0);
      const lowest = activeVariants.slice().sort((a, b) => a.retail_price_ngn - b.retail_price_ngn)[0] ||
        entry.variants.slice().sort((a, b) => a.retail_price_ngn - b.retail_price_ngn)[0];
      const description = String(entry.product.description || entry.product.short_description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000) || null;
      if (!lowest) {
        await supabase.from('bulkmail_proxy_variants')
          .update({ is_available: false, stock_quantity: 0, updated_at: now })
          .eq('product_key', productKey);
        await supabase.from('products')
          .update({ stock_quantity: 0, is_available: false, updated_at: now })
          .eq('product_key', productKey);
        continue;
      }

      const { data: existing, error: lookupError } = await supabase.from('products')
        .select('id, product_key').eq('product_key', productKey).maybeSingle();
      if (lookupError) {
        errors++;
        if (samples.length < 3) samples.push(lookupError.message);
        continue;
      }
      const productPatch = {
        name: displayName,
        category: CATEGORY,
        price: lowest.retail_price_ngn,
        supplier_price: lowest.supplier_price_usd,
        stock_quantity: stock,
        is_available: stock > 0,
        admin_hidden: false,
        source: 'bulkmail',
        description,
        display_description: description,
        updated_at: now
      };
      const productWrite = existing
        ? await supabase.from('products').update(productPatch).eq('product_key', productKey)
        : await supabase.from('products').insert({ ...productPatch, product_key: productKey });
      if (productWrite.error) {
        errors++;
        if (samples.length < 3) samples.push(productWrite.error.message);
        continue;
      }
      if (existing) productsUpdated++; else productsCreated++;

      const { error: staleError } = await supabase.from('bulkmail_proxy_variants')
        .update({ is_available: false, stock_quantity: 0, updated_at: now })
        .eq('product_key', productKey);
      if (staleError) {
        errors++;
        if (samples.length < 3) samples.push(staleError.message);
      }

      for (const variant of entry.variants) {
        const row = { ...variant, product_key: productKey, updated_at: now };
        const { error } = await supabase.from('bulkmail_proxy_variants').upsert(row, { onConflict: 'variant_id' });
        if (error) {
          errors++;
          if (samples.length < 3) samples.push(error.message);
        } else variantsSaved++;
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Residential Proxy catalogue sync complete',
      products_seen: products.length,
      products_created: productsCreated,
      products_updated: productsUpdated,
      variants_saved: variantsSaved,
      write_errors: errors,
      error_samples: samples
    });
  } catch (error) {
    console.error('[bulkmail residential proxy sync]', error);
    return res.status(502).json({ success: false, message: error.message || 'Residential Proxy sync failed' });
  }
}

async function refreshOrderStatus(req, res) {
  const auth = await requireUser(req);
  if (auth.error) return res.status(auth.error.status).json({ success: false, message: auth.error.message });
  const orderRef = String((req.query && req.query.order_ref) || '').trim();
  if (!orderRef || orderRef.length > 100) return res.status(400).json({ success: false, message: 'Valid order reference is required' });

  const { data: order, error } = await supabase.from('bulkmail_proxy_orders')
    .select('*').eq('user_id', auth.user.id).eq('order_ref', orderRef).maybeSingle();
  if (error || !order) return res.status(404).json({ success: false, message: 'Proxy order not found' });
  if (order.status === 'completed') {
    return res.status(200).json({ success: true, data: { status: 'completed', order_id: orderRef,
      login_credentials: [order.credentials, order.activation_url ? 'Activation URL: ' + order.activation_url : ''].filter(Boolean).join('\n\n') } });
  }
  if (order.status === 'failed' || order.status === 'refund_pending') {
    return res.status(200).json({ success: true, data: { status: order.status, refunded: order.refunded === true, order_id: orderRef } });
  }
  if (!order.supplier_order_id) {
    return res.status(202).json({ success: true, pending: true, data: { status: order.status, order_id: orderRef } });
  }

  const supplier = await bmFetch('/proxy/orders/' + encodeURIComponent(order.supplier_order_id));
  if (supplier.networkError || supplier.status >= 500 || !supplier.ok) {
    return res.status(202).json({ success: true, pending: true, data: { status: order.status, order_id: orderRef } });
  }
  const payloadBase = unwrapObject(supplier.data);
  const payload = payloadBase.order && typeof payloadBase.order === 'object'
    ? { ...payloadBase, ...payloadBase.order }
    : payloadBase;
  const supplierStatus = String(payload.status || payload.order_status || '').toLowerCase();
  const credentials = credentialsFromSupplier(payload);
  const activationUrl = String(payload.activation_url || payload.activationUrl || payload.url || '');

  if (/complete|success|deliver|active/.test(supplierStatus) && (credentials || activationUrl)) {
    const patch = {
      status: 'completed',
      credentials: credentials || null,
      activation_url: activationUrl || null,
      supplier_response: supplier.data,
      updated_at: new Date().toISOString()
    };
    const { error: updateError } = await supabase.from('bulkmail_proxy_orders').update(patch).eq('id', order.id);
    if (updateError) return res.status(202).json({ success: true, pending: true, data: { status: 'pending_review', order_id: orderRef } });
    const completedText = [credentials, activationUrl ? 'Activation URL: ' + activationUrl : ''].filter(Boolean).join('\n\n');
    const myOrderError = await saveMyOrder(order, 'completed', completedText, order.supplier_order_id, activationUrl);
    if (myOrderError) console.error('[bulkmail proxy] order status refreshed but My Orders update failed', myOrderError.message);
    await supabase.from('transactions').update({
      status: 'completed',
      subtitle: 'Residential proxy delivered.',
      supplier_order: supplier.data
    }).eq('user_id', order.user_id).eq('external_reference', orderRef);
    return res.status(200).json({ success: true, data: { status: 'completed', order_id: orderRef, login_credentials: completedText } });
  }

  if (/fail|cancel|reject|declin|error/.test(supplierStatus)) {
    const refund = order.wallet_debit_id
      ? await refundWalletDebit(supabase, order.user_id, order.wallet_debit_id)
      : { ok: false };
    const status = refund.ok ? 'failed' : 'refund_pending';
    await supabase.from('bulkmail_proxy_orders').update({
      status,
      refunded: refund.ok,
      supplier_response: supplier.data,
      updated_at: new Date().toISOString()
    }).eq('id', order.id);
    await saveMyOrder(order, status, refund.ok ? 'BulkMail rejected the order. Wallet refunded.' : 'BulkMail rejected the order. Refund requires support review.', order.supplier_order_id, null);
    await supabase.from('transactions').update({
      status: refund.ok ? 'failed' : 'pending',
      subtitle: refund.ok ? 'Supplier rejected the order. Wallet refunded.' : 'Supplier rejected the order. Refund review required.',
      supplier_order: supplier.data
    }).eq('user_id', order.user_id).eq('external_reference', orderRef);
    return res.status(200).json({ success: true, data: { status, refunded: refund.ok, order_id: orderRef } });
  }

  return res.status(202).json({ success: true, pending: true, data: { status: order.status, order_id: orderRef } });
}

async function handleVariants(req, res) {
  const productKey = String(req.query.product_key || '');
  if (!/^bm_proxy_[a-zA-Z0-9_-]{1,100}$/.test(productKey)) {
    return res.status(400).json({ success: false, message: 'Valid residential proxy product_key is required' });
  }
  const { data, error } = await supabase.from('bulkmail_proxy_variants')
    .select('variant_id, variant_name, retail_price_ngn, stock_quantity, max_quantity')
    .eq('product_key', productKey).eq('is_available', true)
    .gt('stock_quantity', 0).order('retail_price_ngn', { ascending: true });
  if (error) return res.status(500).json({ success: false, message: 'Could not load proxy plans' });
  return res.status(200).json({ success: true, variants: data || [] });
}

function credentialsFromSupplier(payload) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const lines = items.map((item) => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    return item.details || item.proxy || item.credentials || item.value || JSON.stringify(item);
  }).filter(Boolean);
  if (lines.length) return lines.join('\n\n');
  if (typeof payload.credentials === 'string') return payload.credentials;
  if (typeof payload.proxy === 'string') return payload.proxy;
  if (typeof payload.value === 'string') return payload.value;
  return '';
}

async function recordTransaction(order, status, subtitle, debit) {
  const amount = Number(order.total_ngn || 0);
  const completed = status === 'completed';
  const pending = status === 'pending';
  const { error } = await supabase.from('transactions').insert({
    user_id: order.user_id,
    customer_id: order.customer_id || null,
    type: 'log',
    category: 'log',
    title: order.product_name + ' · ' + order.variant_name,
    subtitle,
    amount: '₦' + amount.toLocaleString('en-NG'),
    amount_ngn: debit ? Number(debit.ngn_debited || 0) : amount,
    amount_usd: debit ? Number(debit.usd_debited || 0) : 0,
    status: completed ? 'completed' : (pending ? 'pending' : 'failed'),
    external_reference: order.order_ref,
    supplier_order: order.supplier_response || null,
    notes: 'BulkMail Residential Proxy order ' + order.order_ref
  });
  if (error) console.error('[bulkmail proxy] transaction record failed', error.message);
}

async function saveMyOrder(order, status, credentials, supplierRef, activationUrl) {
  const row = {
    order_id: order.order_ref,
    user_id: order.user_id,
    product_id: order.product_id,
    product_code: order.product_key,
    product_name: order.product_name + ' · ' + order.variant_name,
    product_type: 'proxy',
    quantity: order.quantity,
    amount: order.total_ngn,
    wallet_debit_id: order.wallet_debit_id,
    status,
    description: 'BulkMail Residential Proxy',
    login_credentials: credentials || null,
    login_credentials_raw: credentials || null,
    supplier_ref: supplierRef || order.order_ref,
    guide_url: activationUrl || null
  };
  const { data: existing, error: lookupError } = await supabase.from('orders')
    .select('order_id').eq('order_id', order.order_ref).eq('user_id', order.user_id).maybeSingle();
  if (lookupError) return lookupError;
  if (existing) {
    const { error } = await supabase.from('orders').update(row).eq('order_id', order.order_ref).eq('user_id', order.user_id);
    return error;
  }
  const { error } = await supabase.from('orders').insert(row);
  return error;
}

async function handleOrder(req, res, body) {
  const auth = await requireUser(req);
  if (auth.error) return res.status(auth.error.status).json({ success: false, message: auth.error.message });
  const userId = auth.user.id;
  if (body.user_id && String(body.user_id) !== String(userId)) {
    return res.status(403).json({ success: false, message: 'You cannot place an order for another account' });
  }

  const productKey = String(body.product_key || '');
  const variantId = String(body.variant_id || '');
  const quantity = Math.floor(Number(body.quantity || 1));
  const orderRef = String(body.external_order_id || '').trim();
  if (!/^bm_proxy_[a-zA-Z0-9_-]{1,100}$/.test(productKey) || !variantId || variantId.length > 120) {
    return res.status(400).json({ success: false, message: 'Product and proxy plan are required' });
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    return res.status(400).json({ success: false, message: 'Quantity must be between 1 and 100' });
  }
  if (!orderRef || orderRef.length > 100) {
    return res.status(400).json({ success: false, message: 'A valid order reference is required' });
  }

  const { data: prior } = await supabase.from('bulkmail_proxy_orders')
    .select('*').eq('user_id', userId).eq('order_ref', orderRef).maybeSingle();
  if (prior) {
    if (prior.status === 'completed') {
      return res.status(200).json({ success: true, idempotent: true, data: {
        order_id: prior.order_ref, new_balance: null, login_credentials: prior.credentials || '',
        activation_url: prior.activation_url || '', status: prior.status
      } });
    }
    if (['created', 'processing', 'pending_review', 'refund_pending', 'debit_review'].includes(prior.status)) {
      return res.status(202).json({ success: true, pending: true, message: 'This order is already being processed. Do not submit it again.', data: { order_id: prior.order_ref, status: prior.status } });
    }
    return res.status(409).json({ success: false, message: 'This order reference has already been used. Refresh the page before retrying.' });
  }

  const { data: variant, error: variantError } = await supabase.from('bulkmail_proxy_variants')
    .select('*').eq('variant_id', variantId).eq('product_key', productKey).eq('is_available', true).gt('stock_quantity', 0).maybeSingle();
  if (variantError || !variant) return res.status(409).json({ success: false, message: 'This proxy plan is no longer available. Refresh the product and choose another plan.' });
  if (quantity > Number(variant.stock_quantity) || quantity > Number(variant.max_quantity)) {
    return res.status(409).json({ success: false, message: 'The selected plan does not have enough stock for this quantity.' });
  }

  const unitPrice = Number(variant.retail_price_ngn);
  const total = Math.round(unitPrice * quantity * 100) / 100;
  if (!(total > 0) || !Number.isFinite(total)) return res.status(400).json({ success: false, message: 'This proxy plan has an invalid price.' });
  const { data: product, error: productError } = await supabase.from('products')
    .select('id, product_key, name, stock_quantity').eq('product_key', productKey).eq('is_available', true).maybeSingle();
  if (productError || !product) return res.status(409).json({ success: false, message: 'This proxy product is no longer available.' });
  const { data: profile, error: profileError } = await supabase.from('profiles')
    .select('customer_id').eq('id', userId).single();
  if (profileError || !profile) return res.status(400).json({ success: false, message: 'User profile not found' });

  const orderSeed = {
    order_ref: orderRef,
    user_id: userId,
    customer_id: profile.customer_id || null,
    product_key: productKey,
    product_id: product.id,
    product_name: variant.product_name,
    variant_id: variantId,
    variant_name: variant.variant_name,
    quantity,
    unit_price_ngn: unitPrice,
    total_ngn: total,
    supplier_price_usd: Number(variant.supplier_price_usd || 0),
    status: 'created',
    refunded: false
  };
  const { data: order, error: createError } = await supabase.from('bulkmail_proxy_orders')
    .insert(orderSeed).select('*').single();
  if (createError || !order) {
    return res.status(409).json({ success: false, message: 'Could not reserve this order reference. Refresh and try again.' });
  }

  const debit = await debitWallet(supabase, userId, total);
  if (!debit.ok) {
    const uncertain = !debit.insufficient;
    await supabase.from('bulkmail_proxy_orders').update({
      status: uncertain ? 'debit_review' : 'failed',
      updated_at: new Date().toISOString()
    }).eq('id', order.id);
    return res.status(uncertain ? 503 : 402).json({
      success: false,
      pending: uncertain,
      message: uncertain
        ? 'We could not confirm the wallet debit response. This order is locked for reconciliation; do not submit it again.'
        : (debit.message || 'Insufficient wallet balance.'),
      balance_ngn: debit.balance_ngn,
      balance_usd: debit.balance_usd,
      order_id: orderRef
    });
  }

  const { error: debitLinkError } = await supabase.from('bulkmail_proxy_orders')
    .update({ wallet_debit_id: debit.wallet_debit_id, status: 'processing', updated_at: new Date().toISOString() }).eq('id', order.id);
  if (debitLinkError) {
    const refund = await refundWalletDebit(supabase, userId, debit.wallet_debit_id);
    await supabase.from('bulkmail_proxy_orders').update({
      status: refund.ok ? 'failed' : 'refund_pending',
      refunded: refund.ok,
      updated_at: new Date().toISOString()
    }).eq('id', order.id);
    return res.status(503).json({ success: false, message: refund.ok
      ? 'Order could not be started. Your wallet has been refunded.'
      : 'We could not confirm the refund automatically. Contact support with order reference ' + orderRef });
  }

  const supplier = await bmFetch('/proxy/buy', {
    method: 'POST',
    body: { variant_id: /^\d+$/.test(variantId) ? Number(variantId) : variantId, quantity }
  });

  if (supplier.networkError || supplier.status >= 500) {
    await supabase.from('bulkmail_proxy_orders').update({
      status: 'pending_review',
      supplier_response: supplier.data,
      updated_at: new Date().toISOString()
    }).eq('id', order.id);
    const pendingOrder = { ...order, wallet_debit_id: debit.wallet_debit_id };
    await saveMyOrder(pendingOrder, 'processing', 'Supplier response is being verified. Do not purchase again.', null, null);
    await recordTransaction({ ...pendingOrder, supplier_response: supplier.data }, 'pending', 'Supplier response is being verified.', debit);
    return res.status(202).json({ success: true, pending: true, message: 'The supplier response is not yet conclusive. Your order is being checked; please do not purchase again.', data: { order_id: orderRef, status: 'pending_review' } });
  }

  const supplierPayloadBase = unwrapObject(supplier.data);
  const supplierPayload = supplierPayloadBase.order && typeof supplierPayloadBase.order === 'object'
    ? { ...supplierPayloadBase, ...supplierPayloadBase.order }
    : supplierPayloadBase;
  if (!supplier.ok || supplier.data.success === false || supplierPayload.success === false) {
    const refund = await refundWalletDebit(supabase, userId, debit.wallet_debit_id);
    const failedStatus = refund.ok ? 'failed' : 'refund_pending';
    await supabase.from('bulkmail_proxy_orders').update({
      status: failedStatus,
      refunded: refund.ok,
      supplier_response: supplier.data,
      updated_at: new Date().toISOString()
    }).eq('id', order.id);
    if (refund.ok) await recordTransaction({ ...order, supplier_response: supplier.data }, 'failed',
      'Supplier rejected the proxy order. Wallet refunded.', debit);
    return res.status(refund.ok ? 400 : 503).json({
      success: false,
      message: refund.ok
        ? (supplier.data.message || supplierPayload.message || 'Supplier rejected the order. Your wallet has been refunded.')
        : 'Supplier rejected the order, but the wallet refund needs support review. Order reference: ' + orderRef
    });
  }

  const supplierOrderId = String(supplierPayload.order_id || supplierPayload.id || supplierPayload.order?.id || '');
  const credentials = credentialsFromSupplier(supplierPayload);
  const activationUrl = String(supplierPayload.activation_url || supplierPayload.activationUrl || supplierPayload.url || '');
  if (!credentials && !activationUrl) {
    await supabase.from('bulkmail_proxy_orders').update({
      status: 'pending_review',
      supplier_order_id: supplierOrderId || null,
      supplier_response: supplier.data,
      updated_at: new Date().toISOString()
    }).eq('id', order.id);
    const pendingOrder = { ...order, wallet_debit_id: debit.wallet_debit_id };
    await saveMyOrder(pendingOrder, 'processing', 'Supplier accepted the order. Delivery details are being verified; do not purchase again.', supplierOrderId, activationUrl);
    await recordTransaction({ ...pendingOrder, supplier_response: supplier.data }, 'pending', 'Supplier accepted the order. Delivery is being verified.', debit);
    return res.status(202).json({ success: true, pending: true, message: 'Supplier accepted the order. Delivery details are being verified; do not submit another purchase.', data: { order_id: orderRef, status: 'pending_review' } });
  }

  const completedPatch = {
    status: 'completed',
    supplier_order_id: supplierOrderId || null,
    credentials: credentials || null,
    activation_url: activationUrl || null,
    supplier_response: supplier.data,
    updated_at: new Date().toISOString()
  };
  const { error: completeError } = await supabase.from('bulkmail_proxy_orders').update(completedPatch).eq('id', order.id);
  if (completeError) {
    console.error('[bulkmail proxy] supplier accepted but local completion write failed', { orderRef, error: completeError.message });
    return res.status(202).json({ success: true, pending: true, message: 'Supplier accepted the order. Delivery is being reconciled; do not submit another purchase.', data: { order_id: orderRef, status: 'pending_review' } });
  }

  const completedOrder = { ...order, wallet_debit_id: debit.wallet_debit_id };
  const myOrderError = await saveMyOrder(completedOrder, 'completed', credentials || ('Activation URL: ' + activationUrl), supplierOrderId, activationUrl);
  if (myOrderError) {
    console.error('[bulkmail proxy] supplier completed but My Orders write failed', { orderRef, error: myOrderError.message });
    await supabase.from('bulkmail_proxy_orders').update({ status: 'pending_review', updated_at: new Date().toISOString() }).eq('id', order.id);
    return res.status(202).json({ success: true, pending: true, message: 'Supplier accepted the order. Delivery is being reconciled; do not submit another purchase.', data: { order_id: orderRef, status: 'pending_review' } });
  }

  await supabase.from('bulkmail_proxy_variants').update({
    stock_quantity: Math.max(0, Number(variant.stock_quantity) - quantity),
    is_available: Number(variant.stock_quantity) - quantity > 0,
    updated_at: new Date().toISOString()
  }).eq('variant_id', variantId);
  await supabase.from('products').update({
    stock_quantity: Math.max(0, Number(product.stock_quantity || 0) - quantity),
    updated_at: new Date().toISOString()
  }).eq('product_key', productKey);

  await recordTransaction({ ...order, supplier_response: supplier.data }, 'completed', 'Residential proxy delivered.', debit);
  const delivery = [credentials, activationUrl ? 'Activation URL: ' + activationUrl : ''].filter(Boolean).join('\n\n');
  return res.status(200).json({ success: true, data: {
    order_id: orderRef,
    supplier_order_id: supplierOrderId || null,
    login_credentials: delivery,
    activation_url: activationUrl || '',
    new_balance: debit.balance_ngn,
    status: 'completed'
  } });
}

async function handleAdminCatalog(req,res){
 const gate=await requireAdminOrCron(req);
 if(gate.error)return res.status(gate.error.status).json({success:false,message:gate.error.message});
 const [pr,vr]=await Promise.all([
  supabase.from('products').select('product_key,name').eq('category',CATEGORY).order('name',{ascending:true}),
  supabase.from('bulkmail_proxy_variants').select('variant_id,product_key,product_name,variant_name,supplier_price_usd,retail_price_ngn,stock_quantity,max_quantity,is_available,updated_at').order('product_name',{ascending:true}).order('retail_price_ngn',{ascending:true})
 ]);
 if(pr.error)return res.status(500).json({success:false,message:'Could not load proxy products: '+pr.error.message});
 if(vr.error)return res.status(500).json({success:false,message:'Could not load proxy plans: '+vr.error.message});
 const variants=vr.data||[],last=variants.reduce((latest,row)=>!latest||String(row.updated_at)>latest?String(row.updated_at):latest,null);
 return res.status(200).json({success:true,products:pr.data||[],variants,last_synced_at:last});
}

export async function handleBulkmailProxyAction(req, res, action, body = {}) {
  if (action === 'sync') {
    const gate = await requireAdminOrCron(req);
    if (gate.error) return res.status(gate.error.status).json({ success: false, message: gate.error.message });
    return handleSync(req, res);
  }
  if (action === 'admin_catalog') return handleAdminCatalog(req,res);
  if (action === 'variants') return handleVariants(req, res);
  if (action === 'refresh_order') return refreshOrderStatus(req, res);
  if (action === 'order') return handleOrder(req, res, body);
  return res.status(400).json({ success: false, message: 'Unknown BulkMail Residential Proxy action' });
}
