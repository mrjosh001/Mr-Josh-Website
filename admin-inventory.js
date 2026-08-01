import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/admin-inventory
 * Admin-only. Bulk-uploads pasted manual credentials into product_inventory
 * for one product, then syncs products.stock_quantity to match.
 *
 * Body: {
 *   action: 'bulk_upload',
 *   product_key: 'manual_mail_com',
 *   text: "user1@mail.com:pass1\nuser2@mail.com:pass2\n..."
 * }
 *
 * Also supports action: 'stock_count' to just report current available
 * count for a product without uploading anything.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

  return { ok: true };
}

async function syncStockCount(productKey) {
  const { count } = await supabase
    .from('product_inventory')
    .select('id', { count: 'exact', head: true })
    .eq('product_key', productKey)
    .eq('status', 'available');

  const available = count || 0;
  await supabase
    .from('products')
    .update({ stock_quantity: available, is_available: available > 0 })
    .eq('product_key', productKey);

  return available;
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

  const admin = await requireAdmin(req);
  if (!admin.ok) return res.status(admin.status).json({ success: false, message: admin.message });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { action, product_key } = body;

    if (!product_key) {
      return res.status(400).json({ success: false, message: 'product_key is required' });
    }

    // Confirm the product exists so a typo'd key doesn't silently create
    // orphaned inventory nothing will ever sell.
    const { data: product, error: prodErr } = await supabase
      .from('products')
      .select('id, product_key, name')
      .eq('product_key', product_key)
      .maybeSingle();

    if (prodErr || !product) {
      return res.status(404).json({ success: false, message: `No product found with product_key "${product_key}". Create it first (Stage 2).` });
    }

    if (action === 'stock_count') {
      const available = await syncStockCount(product_key);
      return res.status(200).json({ success: true, data: { product_key, available } });
    }

    if (action === 'bulk_upload') {
      const text = String(body.text || '');
      const lines = text
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean);

      if (!lines.length) {
        return res.status(400).json({ success: false, message: 'No credential lines found in the pasted text.' });
      }

      // Skip lines that are already sitting in inventory for this product
      // (available OR sold) so pasting the same batch twice doesn't
      // duplicate stock.
      const { data: existingRows } = await supabase
        .from('product_inventory')
        .select('credential')
        .eq('product_key', product_key);

      const existingSet = new Set((existingRows || []).map(r => r.credential));
      const newLines = lines.filter(l => !existingSet.has(l));
      const skippedDuplicates = lines.length - newLines.length;

      if (newLines.length) {
        const rows = newLines.map(credential => ({
          product_key,
          credential,
          status: 'available'
        }));

        // Insert in chunks so a very large paste (thousands of lines)
        // doesn't hit a single request size/row limit.
        const CHUNK = 500;
        for (let i = 0; i < rows.length; i += CHUNK) {
          const { error: insErr } = await supabase.from('product_inventory').insert(rows.slice(i, i + CHUNK));
          if (insErr) {
            return res.status(500).json({ success: false, message: 'Insert failed partway through: ' + insErr.message });
          }
        }
      }

      const available = await syncStockCount(product_key);

      return res.status(200).json({
        success: true,
        data: {
          product_key,
          product_name: product.name,
          inserted: newLines.length,
          skipped_duplicates: skippedDuplicates,
          available_stock: available
        }
      });
    }

    return res.status(400).json({ success: false, message: 'Unknown action. Use "bulk_upload" or "stock_count".' });
  } catch (err) {
    console.error('admin-inventory error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
}
