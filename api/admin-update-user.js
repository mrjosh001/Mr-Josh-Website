import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/admin-update-user
 * Admin-only. Updates a customer's profile (and, if their NGN balance was
 * increased, writes the matching "Manual Deposit" transaction row) using
 * the service role key — bypassing RLS entirely.
 *
 * Why this exists: doing this update straight from the browser (admin's own
 * session) works for the balance field but the transactions insert was
 * being silently rejected by RLS (a customer's transactions can only be
 * inserted by that customer, not the admin), so deposits never showed up
 * in "My Orders > Deposits" even though the balance itself changed.
 * Running both writes server-side with the service role key fixes that,
 * and any real failure is now returned to the admin instead of only being
 * logged to the browser console.
 *
 * Body: { user_id, full_name, username, email, phone_number, balance, balance_usd, is_admin }
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
    const { user_id, full_name, username, email, phone_number, balance, balance_usd, is_admin } = body;

    if (!user_id) return res.status(400).json({ success: false, message: 'user_id is required' });
    if (balance == null || isNaN(Number(balance))) {
      return res.status(400).json({ success: false, message: 'A valid balance is required' });
    }

    // Source of truth for "how much was actually added" comes from the DB
    // right now, not whatever the admin's browser had cached — avoids a
    // wrong deposit amount if allProfiles was stale.
    const { data: existing, error: fetchErr } = await supabase
      .from('profiles')
      .select('balance, customer_id')
      .eq('id', user_id)
      .single();

    if (fetchErr || !existing) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

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
    if (updateErr) {
      return res.status(500).json({ success: false, message: 'Profile update failed: ' + updateErr.message });
    }

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
        // The balance change already went through — don't roll that back
        // (the admin can see and confirm it), but tell them clearly that
        // the deposit record failed so it isn't a silent, invisible gap
        // like before.
        return res.status(200).json({
          success: true,
          warning: `Balance updated, but the deposit record failed to save: ${txErr.message}`,
          data: { amount_added: amountAdded, deposit_recorded: false }
        });
      }
      depositRecorded = true;
    }

    return res.status(200).json({
      success: true,
      data: { amount_added: amountAdded, deposit_recorded: depositRecorded }
    });
  } catch (err) {
    console.error('admin-update-user error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
}
