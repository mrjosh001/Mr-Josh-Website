import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/admin-ban-user
 * Admin-only. Bans or unbans a customer account.
 *
 * This does two things, both required:
 *  1. Calls Supabase's native auth ban (`ban_duration`) via the admin API.
 *     This is enforced by Supabase itself — a banned user's sign-in
 *     attempts are rejected at the auth layer, and any existing session
 *     is invalidated on its next refresh. This is the real enforcement.
 *  2. Mirrors the flag onto profiles.is_banned so the admin dashboard can
 *     show "Banned" status instantly without a second lookup, and so the
 *     app's own client-side check (belt-and-suspenders, in case a session
 *     is still live) has something to read.
 *
 * Body: { user_id, banned }  (banned: true to ban, false to unban)
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// A very long ban duration functions as "permanent" — Supabase does not
// have a dedicated permanent-ban value, so 100 years is the documented
// convention. Passing 'none' lifts a ban.
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
    const { user_id, banned } = body;

    if (!user_id) return res.status(400).json({ success: false, message: 'user_id is required' });
    if (typeof banned !== 'boolean') {
      return res.status(400).json({ success: false, message: 'banned (true/false) is required' });
    }
    if (user_id === admin.adminId) {
      return res.status(400).json({ success: false, message: 'You cannot ban your own account.' });
    }

    // 1. Real enforcement: Supabase auth-level ban.
    const { error: banError } = await supabase.auth.admin.updateUserById(user_id, {
      ban_duration: banned ? PERMANENT_BAN_DURATION : 'none'
    });

    if (banError) {
      return res.status(500).json({ success: false, message: 'Ban update failed: ' + banError.message });
    }

    // 2. Mirror onto the profile row. If the profiles table doesn't have
    // an is_banned column yet, don't fail the whole request over it — the
    // real ban above already succeeded — but do tell the admin so they
    // know the dashboard badge won't reflect it until the column exists.
    const { error: profileError } = await supabase
      .from('profiles')
      .update({ is_banned: banned })
      .eq('id', user_id);

    if (profileError) {
      return res.status(200).json({
        success: true,
        warning: `User ${banned ? 'banned' : 'unbanned'} successfully, but the profile flag failed to update: ${profileError.message}. (Does profiles.is_banned exist?)`
      });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('admin-ban-user error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
}
