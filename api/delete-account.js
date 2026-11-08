import { createClient } from '@supabase/supabase-js';
import { rateLimit, applyRateLimitHeaders } from '../lib/rateLimit.js';
import { rejectClientSuppliedSecrets, applyApiCors, handleOptions, setNoStore } from '../lib/secure.js';
import { sendError } from '../lib/errors.js';
import { deleteUserStorageObjects } from '../lib/delete-user-storage.js';

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
  applyApiCors(req, res, { methods: 'POST, OPTIONS' });
  setNoStore(res);
  res.setHeader('Content-Type', 'application/json');
  if (handleOptions(req, res)) return;
  if (!rejectClientSuppliedSecrets(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }
  const rl = rateLimit(req, { limit: 5, windowMs: 15 * 60_000, suffix: 'delete-account' });
  applyRateLimitHeaders(res, rl);
  if (!rl.ok) return res.status(429).json({ success: false, message: rl.message });

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: 'Not signed in' });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ success: false, message: 'Invalid or expired session' });

  try {
    // Supabase Auth refuses to delete users who still own Storage objects.
    const storageCleanup = await deleteUserStorageObjects(supabase, user.id);

    const { error: unlinkErr } = await supabase
      .from('profiles')
      .update({ referred_by: null })
      .eq('referred_by', user.id);
    if (unlinkErr) {
      return res.status(500).json({ success: false, message: 'Could not unlink referral records: ' + unlinkErr.message });
    }

    const { error: earningsErr } = await supabase
      .from('referral_earnings')
      .delete()
      .or(`referrer_id.eq.${user.id},referee_id.eq.${user.id}`);
    if (earningsErr) {
      return res.status(500).json({ success: false, message: 'Could not remove referral records: ' + earningsErr.message });
    }

    // Remove Auth credentials before deleting the app profile. This prevents
    // the old partial-success state where the profile vanished but the user
    // could still sign in.
    const { error: authDeleteError } = await supabase.auth.admin.deleteUser(user.id);
    if (authDeleteError) {
      return res.status(500).json({ success: false, message: 'Could not delete account credentials: ' + authDeleteError.message });
    }

    const { error: profileError } = await supabase
      .from('profiles')
      .delete()
      .eq('id', user.id);
    if (profileError) {
      console.error('delete-account: Auth user deleted but profile cleanup failed', profileError);
      return res.status(500).json({ success: false, auth_deleted: true, message: 'Your login account was deleted, but profile cleanup failed: ' + profileError.message });
    }

    return res.status(200).json({ success: true, storage_objects_removed: storageCleanup.removed });
  } catch (err) {
    console.error('delete-account error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
}
