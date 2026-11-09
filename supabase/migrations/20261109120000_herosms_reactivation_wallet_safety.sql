
create table if not exists public.herosms_reactivations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  parent_order_id uuid not null references public.number_orders(id) on delete restrict,
  original_activation_id text not null,
  new_activation_id text unique,
  idempotency_key text not null,
  duration_hours integer not null check (duration_hours > 0),
  supplier_price_usd numeric(14,6) not null check (supplier_price_usd > 0),
  customer_price_ngn numeric(14,2) not null check (customer_price_ngn > 0),
  wallet_debit_id bigint references public.wallet_debits(id),
  status text not null default 'pending' check (status in ('pending','succeeded','failed','unknown')),
  failure_reason text,
  supplier_response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create index if not exists herosms_reactivations_parent_idx
  on public.herosms_reactivations(parent_order_id, created_at desc);
create index if not exists herosms_reactivations_user_idx
  on public.herosms_reactivations(user_id, created_at desc);

alter table public.herosms_reactivations enable row level security;
revoke all on public.herosms_reactivations from anon, authenticated;
grant all on public.herosms_reactivations to service_role;

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

  v_expected := ceil((coalesce(v_order.price,0) + 500) * 100) / 100;
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

create or replace function public.mj_finish_herosms_reactivation(
  p_attempt_id uuid,
  p_user_id uuid,
  p_new_activation_id text,
  p_phone_number text,
  p_status text,
  p_code text,
  p_supplier_response jsonb
)
returns table(success boolean, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.herosms_reactivations%rowtype;
  v_parent public.number_orders%rowtype;
  v_new_status text;
begin
  select * into v_attempt from public.herosms_reactivations
  where id=p_attempt_id and user_id=p_user_id for update;
  if not found then return query select false,'Reactivation attempt not found'; return; end if;
  if v_attempt.status='succeeded' then return query select true,'Already completed'; return; end if;
  if v_attempt.status <> 'pending' then return query select false,'Attempt is not pending'; return; end if;
  if coalesce(trim(p_new_activation_id),'')='' then
    update public.herosms_reactivations set status='unknown',
      failure_reason='Supplier success response did not include an activation ID',
      supplier_response=p_supplier_response, updated_at=now() where id=p_attempt_id;
    return query select false,'Supplier result needs reconciliation'; return;
  end if;

  select * into v_parent from public.number_orders where id=v_attempt.parent_order_id;
  v_new_status := case when coalesce(trim(p_code),'')<>'' then 'completed' else 'waiting_for_code' end;

  insert into public.number_orders(
    source,user_id,customer_id,order_id,idempotency_key,country_id,country_name,
    service_id,service_name,phone_number,price,currency,status,code,refunded,
    supplier_price,wallet_debit_id,notes,created_at,updated_at
  ) values (
    'herosms',p_user_id,v_parent.customer_id,p_new_activation_id,
    'herosms-reactivation-'||p_attempt_id::text,v_parent.country_id,v_parent.country_name,
    v_parent.service_id,v_parent.service_name,coalesce(nullif(p_phone_number,''),v_parent.phone_number),
    v_attempt.customer_price_ngn,'NGN',v_new_status,nullif(trim(p_code),''),
    false,v_attempt.supplier_price_usd,v_attempt.wallet_debit_id,
    'Reactivation of order '||v_parent.order_id,now(),now()
  )
  on conflict (source,idempotency_key) do nothing;

  update public.herosms_reactivations set status='succeeded',
    new_activation_id=p_new_activation_id,supplier_response=p_supplier_response,
    updated_at=now() where id=p_attempt_id;
  return query select true,'Reactivation completed';
exception when unique_violation then
  update public.herosms_reactivations set status='unknown',
    failure_reason='Activation ID or idempotency conflict requires reconciliation',
    supplier_response=p_supplier_response,updated_at=now() where id=p_attempt_id;
  return query select false,'Supplier result needs reconciliation';
end;
$$;

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
      update public.profiles set balance=coalesce(balance,0)+v_debit.ngn_amt,
        balance_usd=coalesce(balance_usd,0)+v_debit.usd_amt,updated_at=now()
      where id=p_user_id;
    end if;
  end if;
  update public.herosms_reactivations set status='failed',
    failure_reason=left(coalesce(p_reason,'Supplier rejected reactivation'),500),updated_at=now()
  where id=p_attempt_id;
  return query select true,found,
    (select balance from public.profiles where id=p_user_id),
    (select balance_usd from public.profiles where id=p_user_id),'failed';
end;
$$;

revoke all on function public.mj_begin_herosms_reactivation(uuid,uuid,text,integer,numeric,numeric) from public,anon,authenticated;
revoke all on function public.mj_finish_herosms_reactivation(uuid,uuid,text,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.mj_fail_herosms_reactivation(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.mj_begin_herosms_reactivation(uuid,uuid,text,integer,numeric,numeric) to service_role;
grant execute on function public.mj_finish_herosms_reactivation(uuid,uuid,text,text,text,text,jsonb) to service_role;
grant execute on function public.mj_fail_herosms_reactivation(uuid,uuid,text,boolean) to service_role;
