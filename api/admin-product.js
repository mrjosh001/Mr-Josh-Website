import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    // Optional: verify caller is an admin via JWT (client sends Authorization: Bearer <token>)
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (token) {
      const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
      if (authErr || !user) {
        return res.status(401).json({ success: false, message: 'Invalid session' });
      }
      const { data: profile } = await supabase
        .from('profiles')
        .select('is_admin')
        .eq('id', user.id)
        .maybeSingle();
      const isAdmin = profile && (profile.is_admin === true || profile.is_admin === 'true' || profile.is_admin === 1);
      if (!isAdmin) {
        return res.status(403).json({ success: false, message: 'Admin privileges required' });
      }
    }

    const body = req.body || {};
    const { action, id, product_key, ...fields } = body;

    if (action === 'update') {
      if (!id && !product_key) {
        return res.status(400).json({ success: false, message: 'id or product_key required' });
      }

      const payload = {};
      if (fields.name !== undefined) payload.name = fields.name;
      if (fields.category !== undefined) payload.category = String(fields.category).trim();
      if (fields.description !== undefined) payload.description = fields.description;
      if (fields.display_description !== undefined) payload.display_description = fields.display_description;
      if (fields.price !== undefined) payload.price = Number(fields.price);
      if (fields.stock_quantity !== undefined) payload.stock_quantity = Number(fields.stock_quantity);
      if (fields.is_available !== undefined) payload.is_available = !!fields.is_available;
      payload.updated_at = new Date().toISOString();

      let error = null;
      let data = null;

      if (id) {
        const result = await supabase.from('products').update(payload).eq('id', id).select().maybeSingle();
        error = result.error;
        data = result.data;
      }
      if ((!data || error) && product_key) {
        const result = await supabase.from('products').update(payload).eq('product_key', product_key).select().maybeSingle();
        error = result.error;
        data = result.data;
      }
      // Also try matching id against product_key column (admin sometimes stores key in the hidden field)
      if ((!data || error) && id) {
        const result = await supabase.from('products').update(payload).eq('product_key', id).select().maybeSingle();
        error = result.error;
        data = result.data;
      }

      if (error) {
        return res.status(400).json({ success: false, message: error.message });
      }
      return res.status(200).json({ success: true, data });
    }

    if (action === 'insert') {
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
      if (error) {
        return res.status(400).json({ success: false, message: error.message });
      }
      return res.status(200).json({ success: true, data });
    }

    if (action === 'delete') {
      if (!id && !product_key) {
        return res.status(400).json({ success: false, message: 'id or product_key required' });
      }

      // Resolve the real product_key even if only "id" was passed, so the
      // inventory cleanup below always targets the right rows.
      let resolvedKey = product_key || null;
      if (!resolvedKey && id) {
        const { data: lookup } = await supabase.from('products').select('product_key').eq('id', id).maybeSingle();
        resolvedKey = lookup?.product_key || null;
      }

      // If this was a manual product, clear out its unsold credentials too —
      // otherwise they'd sit in product_inventory forever with no product
      // to belong to. Sold rows are left alone; they're the delivery record
      // for a real customer order and should never be removed here.
      if (resolvedKey) {
        await supabase
          .from('product_inventory')
          .delete()
          .eq('product_key', resolvedKey)
          .eq('status', 'available');
      }

      let query = supabase.from('products').delete();
      query = id ? query.eq('id', id) : query.eq('product_key', product_key);
      const { error, count } = await query.select();

      if (error) {
        // Most likely cause: this product has rows in "orders" referencing
        // it via a foreign key, so the database is refusing to delete it —
        // that's actually the correct, safe behavior (it protects existing
        // customer order history from breaking). Give a clear message
        // instead of a raw DB error.
        const isFkError = /foreign key|violates|constraint/i.test(error.message || '');
        return res.status(400).json({
          success: false,
          message: isFkError
            ? 'This product has past orders attached to it, so it can\'t be deleted (that would break customer order history). Set it to "Hidden" instead to stop selling it.'
            : error.message
        });
      }

      return res.status(200).json({ success: true, deleted: Array.isArray(count) ? count.length : 1 });
    }

    return res.status(400).json({ success: false, message: 'Unknown action. Use "update", "insert", or "delete".' });
  } catch (err) {
    console.error('admin-product error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
}
