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
    const { id, ...fields } = body;

    if (!id) {
      return res.status(400).json({ success: false, message: 'User id is required' });
    }

    // Build payload â support both balance and balance_ngn column names
    const payload = {};
    if (fields.full_name !== undefined) payload.full_name = fields.full_name;
    if (fields.username !== undefined) payload.username = fields.username;
    if (fields.email !== undefined) payload.email = fields.email;
    if (fields.phone_number !== undefined) payload.phone_number = fields.phone_number;
    if (fields.is_admin !== undefined) payload.is_admin = !!fields.is_admin;

    if (fields.balance !== undefined) {
      const bal = Number(fields.balance) || 0;
      payload.balance = bal;
      payload.balance_ngn = bal; // keep both in sync if both columns exist
    }
    if (fields.balance_usd !== undefined && fields.balance_usd !== null && fields.balance_usd !== '') {
      payload.balance_usd = Number(fields.balance_usd);
    }

    payload.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('profiles')
      .update(payload)
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) {
      // Retry without balance_ngn if that column doesn't exist
      if (error.message && error.message.includes('balance_ngn')) {
        delete payload.balance_ngn;
        const retry = await supabase.from('profiles').update(payload).eq('id', id).select().maybeSingle();
        if (retry.error) {
          return res.status(400).json({ success: false, message: retry.error.message });
        }
        return res.status(200).json({ success: true, data: retry.data });
      }
      // Retry without balance if only balance_ngn exists
      if (error.message && error.message.includes('balance') && !error.message.includes('balance_ngn')) {
        delete payload.balance;
        const retry = await supabase.from('profiles').update(payload).eq('id', id).select().maybeSingle();
        if (retry.error) {
          return res.status(400).json({ success: false, message: retry.error.message });
        }
        return res.status(200).json({ success: true, data: retry.data });
      }
      return res.status(400).json({ success: false, message: error.message });
    }

    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error('admin-user error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
}
