
create or replace function public.mj_begin_herosms_reactivation(
  p_user_id uuid,
  p_parent_order_id uuid,
  p_idempotency_key text,
  p_duration_hours integer,
  p_supplier_price_usd numeric,
  p_customer_price_ngn numeric
)
returns table(success boolean, attempt_id uuid, wallet_debit_id bigint, status text,
              new_balance numeric, new_balance_usd numeric, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.number_orders%rowtype;
  v_attempt public.herosms_reactivations%rowtype;
  v_ngn numeric;
  v_usd numeric;
  v_use_ngn numeric;
  v_use_usd numeric;
  v_debit_id bigint;
  v_expected numeric;
begin
  if p_user_id is null or p_parent_order_id is null or
     length(coalesce(p_idempotency_key,'')) < 16 or
     p_duration_hours is null or p_duration_hours <= 0 or
     p_supplier_price_usd is null or p_supplier_price_usd <= 0 then
    return query select false, null::uuid, null::bigint, 'failed', null::numeric, null::numeric, 'Invalid request';
    return;
  end if;

  select * into v_order
  from public.number_orders
  where id = p_parent_order_id and user_id = p_user_id and source = 'herosms'
  for update;

  if not found or lower(v_order.status) <> 'completed' or
     coalesce(trim(v_order.code),'') = '' or v_order.refunded then
    return query select false, null::uuid, null::bigint, 'failed', null::numeric, null::numeric, 'The SIM card is offline.';
    return;
  end if;

  select * into v_attempt from public.herosms_reactivations
  where user_id = p_user_id and idempotency_key = p_idempotency_key
  for update;
  if found then
    return query select (v_attempt.status in ('pending','succeeded','unknown')),
      v_attempt.id, v_attempt.wallet_debit_id, v_attempt.status,
      coalesce((select balance from public.profiles where id=p_user_id),0),
      coalesce((select balance_usd from public.profiles where id=p_user_id),0),
      'Request already exists';
    return;
  end if;

  v_expected := ceil(coalesce(v_order.price,0) + 500);
  if p_customer_price_ngn <> v_expected or p_supplier_price_usd * 1450 > p_customer_price_ngn then
    return query select false, null::uuid, null::bigint, 'failed', null::numeric, null::numeric, 'Price is no longer safe. Refresh options.';
    return;
  end if;

  select coalesce(balance,0), coalesce(balance_usd,0)
  into v_ngn, v_usd from public.profiles where id=p_user_id for update;
  if not found then
    return query select false, null::uuid, null::bigint, 'failed', 0::numeric, 0::numeric, 'Wallet not found';
    return;
  end if;

  v_use_ngn := least(v_ngn, p_customer_price_ngn);
  v_use_usd := ceil(greatest(p_customer_price_ngn-v_use_ngn,0)/1450*100)/100;
  if v_use_usd > v_usd then
    return query select false, null::uuid, null::bigint, 'failed', v_ngn, v_usd, 'Insufficient balance';
    return;
  end if;

  update public.profiles set balance=v_ngn-v_use_ngn,
    balance_usd=v_usd-v_use_usd, updated_at=now()
  where id=p_user_id;

  insert into public.wallet_debits(user_id,total_ngn,ngn_amt,usd_amt,ngn_before,usd_before)
  values(p_user_id,p_customer_price_ngn,v_use_ngn,v_use_usd,v_ngn,v_usd)
  returning id into v_debit_id;

  insert into public.herosms_reactivations(
    user_id,parent_order_id,original_activation_id,idempotency_key,
    duration_hours,supplier_price_usd,customer_price_ngn,wallet_debit_id,status
  ) values (
    p_user_id,p_parent_order_id,v_order.order_id,p_idempotency_key,
    p_duration_hours,p_supplier_price_usd,p_customer_price_ngn,v_debit_id,'pending'
  ) returning * into v_attempt;

  return query select true,v_attempt.id,v_debit_id,'pending',
    v_ngn-v_use_ngn,v_usd-v_use_usd,'Wallet debited';
end;
$$;
revoke all on function public.mj_begin_herosms_reactivation(uuid,uuid,text,integer,numeric,numeric) from public,anon,authenticated;
grant execute on function public.mj_begin_herosms_reactivation(uuid,uuid,text,integer,numeric,numeric) to service_role;
