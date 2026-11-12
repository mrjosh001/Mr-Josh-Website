-- Central wallet debit contract: NGN first, USD for the remainder, exact debit ID.
begin;

create or replace function public.mj_debit_wallet_atomic(p_user_id uuid, p_amount numeric)
returns table(success boolean,new_balance numeric,new_balance_usd numeric,ngn_debited numeric,usd_debited numeric,wallet_debit_id bigint,wallet_rate numeric)
language plpgsql security definer set search_path=public
as $function$
declare
  v_rate constant numeric := 1450;
  v_ngn numeric; v_usd numeric; v_use_ngn numeric; v_use_usd numeric; v_id bigint;
begin
  if p_amount is null or p_amount <= 0 then
    return query select false,coalesce(p.balance,0),coalesce(p.balance_usd,0),0::numeric,0::numeric,null::bigint,v_rate
      from public.profiles p where p.id=p_user_id;
    return;
  end if;
  select coalesce(p.balance,0),coalesce(p.balance_usd,0) into v_ngn,v_usd
    from public.profiles p where p.id=p_user_id for update;
  if not found then
    return query select false,0::numeric,0::numeric,0::numeric,0::numeric,null::bigint,v_rate;
    return;
  end if;
  v_use_ngn:=least(v_ngn,p_amount);
  v_use_usd:=ceil(greatest(p_amount-v_use_ngn,0)/v_rate*100)/100;
  if v_use_usd>v_usd then
    return query select false,v_ngn,v_usd,0::numeric,0::numeric,null::bigint,v_rate;
    return;
  end if;
  update public.profiles set balance=v_ngn-v_use_ngn,balance_usd=v_usd-v_use_usd,updated_at=now() where id=p_user_id;
  insert into public.wallet_debits(user_id,total_ngn,ngn_amt,usd_amt,ngn_before,usd_before)
    values(p_user_id,p_amount,v_use_ngn,v_use_usd,v_ngn,v_usd) returning id into v_id;
  return query select true,v_ngn-v_use_ngn,v_usd-v_use_usd,v_use_ngn,v_use_usd,v_id,v_rate;
end;
$function$;

create or replace function public.debit_balance_if_sufficient(p_user_id uuid,p_amount numeric)
returns table(success boolean,new_balance numeric,new_balance_usd numeric,ngn_debited numeric,usd_debited numeric)
language plpgsql security definer set search_path=public
as $function$
begin
  return query select d.success,d.new_balance,d.new_balance_usd,d.ngn_debited,d.usd_debited
    from public.mj_debit_wallet_atomic(p_user_id,p_amount) d;
end;
$function$;

revoke all on function public.mj_debit_wallet_atomic(uuid,numeric) from public,anon,authenticated;
grant execute on function public.mj_debit_wallet_atomic(uuid,numeric) to service_role;
commit;
