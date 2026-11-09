-- MJ Mails: isolated HeroSMS email activation ledger and wallet RPCs.
create table if not exists public.mj_mail_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  supplier_id text unique,
  site text not null,
  domain text not null,
  email_address text,
  supplier_cost numeric(14,6) not null,
  supplier_currency integer not null default 840,
  retail_price_ngn numeric(14,2) not null,
  supplier_status integer,
  status text not null default 'creating',
  message text,
  value text,
  refunded boolean not null default false,
  wallet_debit_id bigint references public.wallet_debits(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, request_id),
  constraint mj_mail_orders_positive_amounts check (supplier_cost > 0 and retail_price_ngn > 0),
  constraint mj_mail_orders_status_check check (status in ('creating','waiting','message_received','completed','cancelled','refunded','failed','reconciliation_required','cancel_pending_refund'))
);
create index if not exists mj_mail_orders_user_created_idx on public.mj_mail_orders(user_id, created_at desc);
alter table public.mj_mail_orders enable row level security;
drop policy if exists "Users can read their own MJ Mail orders" on public.mj_mail_orders;
create policy "Users can read their own MJ Mail orders" on public.mj_mail_orders
  for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.mj_mail_orders from anon, authenticated;
grant select on public.mj_mail_orders to authenticated;
grant all on public.mj_mail_orders to service_role;

create or replace function public.mj_mail_reserve_purchase(
  p_user_id uuid, p_request_id uuid, p_site text, p_domain text,
  p_supplier_cost numeric, p_supplier_currency integer, p_retail_ngn numeric,
  p_wallet_usd_rate numeric default 1450
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_existing public.mj_mail_orders%rowtype;
  v_ngn numeric; v_usd numeric; v_ngn_debit numeric := 0; v_usd_debit numeric := 0;
  v_usd_needed numeric; v_debit_id bigint; v_order public.mj_mail_orders%rowtype;
begin
  if p_user_id is null or p_request_id is null or length(trim(p_site)) = 0 or length(trim(p_domain)) = 0
     or p_supplier_cost <= 0 or p_retail_ngn <= 0 or p_wallet_usd_rate <= 0 then
    raise exception 'INVALID_MAIL_PURCHASE';
  end if;
  select * into v_existing from public.mj_mail_orders
    where user_id = p_user_id and request_id = p_request_id for update;
  if found then
    return jsonb_build_object('created', false, 'order', to_jsonb(v_existing));
  end if;
  select coalesce(balance,0), coalesce(balance_usd,0) into v_ngn, v_usd
    from public.profiles where id = p_user_id for update;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
  if v_ngn >= p_retail_ngn then
    v_ngn_debit := p_retail_ngn;
  else
    v_usd_needed := ceil((p_retail_ngn / p_wallet_usd_rate) * 100) / 100;
    if v_usd >= v_usd_needed then
      v_usd_debit := v_usd_needed;
    else
      v_ngn_debit := v_ngn;
      v_usd_needed := ceil(((p_retail_ngn - v_ngn_debit) / p_wallet_usd_rate) * 100) / 100;
      if v_usd < v_usd_needed then raise exception 'INSUFFICIENT_WALLET'; end if;
      v_usd_debit := v_usd_needed;
    end if;
  end if;
  update public.profiles set balance = round(v_ngn-v_ngn_debit,2),
    balance_usd = round(v_usd-v_usd_debit,2), updated_at = now() where id = p_user_id;
  insert into public.wallet_debits(user_id,total_ngn,ngn_amt,usd_amt,ngn_before,usd_before)
    values(p_user_id,p_retail_ngn,v_ngn_debit,v_usd_debit,v_ngn,v_usd)
    returning id into v_debit_id;
  insert into public.mj_mail_orders(user_id,request_id,site,domain,supplier_cost,supplier_currency,
    retail_price_ngn,wallet_debit_id,status)
    values(p_user_id,p_request_id,lower(trim(p_site)),lower(trim(p_domain)),p_supplier_cost,
    coalesce(p_supplier_currency,840),p_retail_ngn,v_debit_id,'creating')
    returning * into v_order;
  insert into public.transactions(user_id,customer_id,type,category,title,subtitle,amount,status,
    amount_ngn,amount_usd,product_details,external_reference,currency,meta)
  select p_user_id, customer_id, 'email', 'email', 'MJ Mails',
    lower(trim(p_site)) || ' · ' || lower(trim(p_domain)),
    '₦' || to_char(p_retail_ngn,'FM999,999,999,990.00'),'completed',
    p_retail_ngn,v_usd_debit,
    jsonb_build_object('mail_order_id',v_order.id,'site',p_site,'domain',p_domain,
      'supplier_cost',p_supplier_cost,'wallet_ngn_debited',v_ngn_debit,
      'wallet_usd_debited',v_usd_debit)::text,
    'MJMAIL-' || v_order.id::text,'NGN',
    jsonb_build_object('source','mj_mails','wallet_debit_id',v_debit_id)
  from public.profiles where id=p_user_id;
  return jsonb_build_object('created',true,'order',to_jsonb(v_order));
end;
$$;

create or replace function public.mj_mail_refund_purchase(p_order_id uuid, p_user_id uuid, p_reason text default 'supplier_cancelled')
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_order public.mj_mail_orders%rowtype; v_debit public.wallet_debits%rowtype; v_balance numeric;
begin
  select * into v_order from public.mj_mail_orders
    where id=p_order_id and user_id=p_user_id for update;
  if not found then raise exception 'MAIL_ORDER_NOT_FOUND'; end if;
  if v_order.refunded then
    select balance into v_balance from public.profiles where id=p_user_id;
    return jsonb_build_object('refunded',false,'already_refunded',true,'balance',v_balance);
  end if;
  if v_order.wallet_debit_id is null then raise exception 'MAIL_WALLET_DEBIT_NOT_FOUND'; end if;
  select * into v_debit from public.wallet_debits where id=v_order.wallet_debit_id and user_id=p_user_id for update;
  if not found or v_debit.refunded then raise exception 'MAIL_DEBIT_ALREADY_REVERSED'; end if;
  update public.wallet_debits set refunded=true where id=v_debit.id and not refunded;
  update public.profiles set balance=coalesce(balance,0)+coalesce(v_debit.ngn_amt,0),
    balance_usd=coalesce(balance_usd,0)+coalesce(v_debit.usd_amt,0),updated_at=now()
    where id=p_user_id returning balance into v_balance;
  update public.mj_mail_orders set refunded=true,status='refunded',updated_at=now() where id=p_order_id;
  insert into public.transactions(user_id,type,category,title,subtitle,amount,status,amount_ngn,
    amount_usd,currency,external_reference,meta)
    values(p_user_id,'deposit','deposit','MJ Mails Refund',left(coalesce(p_reason,'Supplier cancellation'),180),
    '₦'||to_char(v_order.retail_price_ngn,'FM999,999,999,990.00'),'completed',
    v_debit.ngn_amt + (v_debit.usd_amt * 1450),v_debit.usd_amt,'NGN',
    'MJMAIL-REFUND-'||p_order_id::text,jsonb_build_object('source','mj_mails','mail_order_id',p_order_id));
  return jsonb_build_object('refunded',true,'already_refunded',false,'balance',v_balance);
end;
$$;
revoke all on function public.mj_mail_reserve_purchase(uuid,uuid,text,text,numeric,integer,numeric,numeric) from public, anon, authenticated;
revoke all on function public.mj_mail_refund_purchase(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.mj_mail_reserve_purchase(uuid,uuid,text,text,numeric,integer,numeric,numeric) to service_role;
grant execute on function public.mj_mail_refund_purchase(uuid,uuid,text) to service_role;
