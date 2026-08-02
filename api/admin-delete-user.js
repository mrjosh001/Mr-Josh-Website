import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/admin-delete-user
 * Admin-only. Permanently deletes a customer's account: removes the
 * Supabase auth user (so the email/phone is freed up and they can no
 * longer sign in) and their profiles row. Intended for cleaning up
 * duplicate or unwanted accounts. This cannot be undone.
 *
 * Body: { user_id }
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

  return { ok: true, adminId: user.id };
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
    const { user_id } = body;

    if (!user_id) return res.status(400).json({ success: false, message: 'user_id is required' });
    if (user_id === admin.adminId) {
      return res.status(400).json({ success: false, message: 'You cannot delete your own account.' });
    }

    // Delete the profile row first. If a foreign key ties transactions/orders
    // to this id, leave those rows alone (order history stays intact for
    // records) — only the profile and the auth identity are removed.
    const { error: profileError } = await supabase
      .from('profiles')
      .delete()
      .eq('id', user_id);

    if (profileError) {
      return res.status(500).json({ success: false, message: 'Profile delete failed: ' + profileError.message });
    }

    const { error: authDeleteError } = await supabase.auth.admin.deleteUser(user_id);
    if (authDeleteError) {
      // The profile row is already gone at this point — tell the admin so
      // they know the auth identity may still exist rather than assuming
      // full success.
      return res.status(200).json({
        success: true,
        warning: `Profile deleted, but removing the login credentials failed: ${authDeleteError.message}`
      });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('admin-delete-user error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
}
