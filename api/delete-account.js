import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/delete-account
 * Self-service. A signed-in user permanently deletes their own account:
 * removes their profiles row and their Supabase auth user. This cannot
 * be undone — the frontend is expected to confirm before calling this.
 *
 * Auth: Bearer <the user's own access token> (not an admin token — this
 * only ever deletes the account that owns the token, never anyone else's).
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

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

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: 'Not signed in' });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ success: false, message: 'Invalid or expired session' });

  try {
    const { error: profileError } = await supabase
      .from('profiles')
      .delete()
      .eq('id', user.id);

    if (profileError) {
      return res.status(500).json({ success: false, message: 'Could not delete profile: ' + profileError.message });
    }

    const { error: authDeleteError } = await supabase.auth.admin.deleteUser(user.id);
    if (authDeleteError) {
      return res.status(500).json({ success: false, message: 'Could not delete account credentials: ' + authDeleteError.message });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('delete-account error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
}
