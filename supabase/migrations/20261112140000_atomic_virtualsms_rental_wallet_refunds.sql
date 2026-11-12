create unique index if not exists idx_transactions_mj_sms_purchase_external_ref
on public.transactions (external_reference)
where category = 'MJ SMS'
  and type = 'purchase'
  and external_reference is not null;

create or replace function public.refund_wallet_debit(
  p_user_id uuid,
  p_wallet_debit_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_debit public.wallet_debits%rowtype;
  v_balance numeric;
begin
  select *
    into v_debit
    from public.wallet_debits
   where id = p_wallet_debit_id
     and user_id = p_user_id
   for update;

  if not found then
    return jsonb_build_object('success', false, 'message', 'Wallet debit record not found.');
  end if;

  if v_debit.refunded then
    select coalesce(balance, 0) into v_balance
      from public.profiles where id = p_user_id;
    return jsonb_build_object(
      'success', true,
      'already_refunded', true,
      'balance', coalesce(v_balance, 0),
      'amount_ngn', coalesce(v_debit.ngn_amt, 0),
      'amount_usd', coalesce(v_debit.usd_amt, 0)
    );
  end if;

  update public.profiles
     set balance = coalesce(balance, 0) + coalesce(v_debit.ngn_amt, 0),
         balance_usd = coalesce(balance_usd, 0) + coalesce(v_debit.usd_amt, 0),
         updated_at = now()
   where id = p_user_id
   returning balance into v_balance;

  if not found then
    raise exception 'Wallet profile not found for refund.';
  end if;

  update public.wallet_debits
     set refunded = true
   where id = p_wallet_debit_id
     and user_id = p_user_id
     and refunded = false;

  if not found then
    raise exception 'Wallet debit refund state changed unexpectedly.';
  end if;

  return jsonb_build_object(
    'success', true,
    'already_refunded', false,
    'balance', coalesce(v_balance, 0),
    'amount_ngn', coalesce(v_debit.ngn_amt, 0),
    'amount_usd', coalesce(v_debit.usd_amt, 0)
  );
end;
$$;

revoke all on function public.refund_wallet_debit(uuid, bigint) from public;
revoke all on function public.refund_wallet_debit(uuid, bigint) from anon;
revoke all on function public.refund_wallet_debit(uuid, bigint) from authenticated;
grant execute on function public.refund_wallet_debit(uuid, bigint) to service_role;
