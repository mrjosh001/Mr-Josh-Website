
create unique index if not exists herosms_reactivations_one_unresolved_per_activation
on public.herosms_reactivations(original_activation_id)
where status in ('pending','unknown');

create or replace function public.mj_fail_herosms_reactivation(
  p_attempt_id uuid,
  p_user_id uuid,
  p_reason text,
  p_refund boolean
)
returns table(success boolean, refunded boolean, new_balance numeric, new_balance_usd numeric, status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.herosms_reactivations%rowtype;
  v_debit public.wallet_debits%rowtype;
  v_did_refund boolean := false;
begin
  select * into v_attempt from public.herosms_reactivations
  where id=p_attempt_id and user_id=p_user_id for update;
  if not found then
    return query select false,false,null::numeric,null::numeric,'not_found'; return;
  end if;
  if v_attempt.status in ('succeeded','failed') then
    return query select true,false,
      (select balance from public.profiles where id=p_user_id),
      (select balance_usd from public.profiles where id=p_user_id),v_attempt.status;
    return;
  end if;
  if not p_refund then
    update public.herosms_reactivations set status='unknown',
      failure_reason=left(coalesce(p_reason,'Supplier result uncertain'),500),updated_at=now()
    where id=p_attempt_id;
    return query select true,false,
      (select balance from public.profiles where id=p_user_id),
      (select balance_usd from public.profiles where id=p_user_id),'unknown';
    return;
  end if;

  select * into v_debit from public.wallet_debits
  where id=v_attempt.wallet_debit_id and user_id=p_user_id and not refunded for update;
  if found then
    update public.wallet_debits set refunded=true where id=v_debit.id and not refunded;
    if found then
      v_did_refund := true;
      update public.profiles set balance=coalesce(balance,0)+v_debit.ngn_amt,
        balance_usd=coalesce(balance_usd,0)+v_debit.usd_amt,updated_at=now()
      where id=p_user_id;
    end if;
  end if;
  update public.herosms_reactivations set status='failed',
    failure_reason=left(coalesce(p_reason,'Supplier rejected reactivation'),500),updated_at=now()
  where id=p_attempt_id;
  return query select true,v_did_refund,
    (select balance from public.profiles where id=p_user_id),
    (select balance_usd from public.profiles where id=p_user_id),'failed';
end;
$$;

revoke all on function public.mj_fail_herosms_reactivation(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.mj_fail_herosms_reactivation(uuid,uuid,text,boolean) to service_role;
