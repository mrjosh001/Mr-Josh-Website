/**
 * Central wallet contract.
 * Database is authoritative: NGN is consumed first, then USD at the fixed
 * platform wallet conversion rate. Never perform client-side balance checks
 * or restore profile snapshots.
 */
import { WALLET_USD_RATE } from './wallet-rate.js';
export { WALLET_USD_RATE } from './wallet-rate.js';

export async function debitWallet(supabase, userId, amount) {
  const charge = Math.round(Number(amount) * 100) / 100;
  if (!userId || !(charge > 0) || !Number.isFinite(charge)) {
    return { ok: false, message: 'Invalid wallet charge.' };
  }
  const { data, error } = await supabase.rpc('mj_debit_wallet_atomic', {
    p_user_id: userId,
    p_amount: charge
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (error) {
    console.error('[wallet] atomic debit failed', error.message);
    return { ok: false, error: error.message, message: 'Could not verify your wallet debit. Please try again.' };
  }
  if (!row || row.success !== true || !Number(row.wallet_debit_id)) {
    return {
      ok: false,
      insufficient: true,
      balance_ngn: Number(row?.new_balance || 0),
      balance_usd: Number(row?.new_balance_usd || 0),
      message: 'Insufficient combined wallet balance.'
    };
  }
  return {
    ok: true,
    wallet_debit_id: Number(row.wallet_debit_id),
    amount_ngn: charge,
    ngn_debited: Number(row.ngn_debited || 0),
    usd_debited: Number(row.usd_debited || 0),
    balance_ngn: Number(row.new_balance || 0),
    balance_usd: Number(row.new_balance_usd || 0),
    wallet_rate: Number(row.wallet_rate || WALLET_USD_RATE)
  };
}

export async function refundWalletDebit(supabase, userId, debitId) {
  const id = Number(debitId);
  if (!userId || !Number.isInteger(id) || id <= 0) {
    return { ok: false, message: 'Exact wallet debit reference is required.' };
  }
  const { data, error } = await supabase.rpc('refund_wallet_debit', {
    p_user_id: userId,
    p_wallet_debit_id: id
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || row?.success !== true) {
    console.error('[wallet] exact refund failed', error?.message || row?.message);
    return { ok: false, error: error?.message || row?.message || 'Refund failed.' };
  }
  return {
    ok: true,
    already_refunded: row.already_refunded === true,
    ngn_restored: Number(row.amount_ngn || 0),
    usd_restored: Number(row.amount_usd || 0),
    balance_ngn: Number(row.balance || 0)
  };
}
