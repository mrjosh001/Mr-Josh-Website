-- Server 3 wallet safety: never create balance from a refund without a matching recent purchase debit.
create or replace function public.credit_balance(p_user_id uuid, p_amount numeric)
returns table(new_balance numeric)
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_id bigint;
  v_ngn numeric;
  v_usd numeric;
  v_new numeric;
begin
  if p_amount is null or p_amount <= 0 then
    return query select balance from profiles where id = p_user_id;
    return;
  end if;

  select id, ngn_amt, usd_amt into v_id, v_ngn, v_usd
  from wallet_debits
  where user_id = p_user_id
    and total_ngn = p_amount
    and not refunded
    and created_at > now() - interval '30 minutes'
  order by created_at desc
  limit 1
  for update skip locked;

  if v_id is null then
    select balance into v_new from profiles where id = p_user_id;
    return query select v_new;
    return;
  end if;

  update wallet_debits set refunded = true where id = v_id;
  update profiles
  set balance = coalesce(balance,0) + coalesce(v_ngn,0),
      balance_usd = coalesce(balance_usd,0) + coalesce(v_usd,0)
  where id = p_user_id
  returning balance into v_new;

  return query select v_new;
end $function$;

create schema if not exists private;

create or replace function private.refund_number_order_once(
  p_order_id uuid,
  p_user_id uuid,
  p_status text default 'refunded',
  p_subtitle text default 'Cancelled — balance restored'
)
returns table(ok boolean, reason text, refunded_amount numeric, new_balance numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.number_orders%rowtype;
  v_debit public.wallet_debits%rowtype;
  v_new_balance numeric;
  v_status text := case when lower(coalesce(p_status,'')) = 'expired' then 'expired' else 'refunded' end;
begin
  select * into v_order from public.number_orders
  where id = p_order_id and user_id = p_user_id and source = 'virtualsms' for update;
  if not found then return query select false,'not_found',0::numeric,null::numeric; return; end if;
  if coalesce(v_order.refunded,false) or lower(coalesce(v_order.status,'')) in ('refunded','expired','cancelled','canceled','completed') then
    select coalesce(balance,0) into v_new_balance from public.profiles where id=p_user_id;
    return query select false,'already_final',coalesce(v_order.price,0),v_new_balance; return;
  end if;
  select * into v_debit from public.wallet_debits
  where user_id=p_user_id and not refunded and total_ngn=v_order.price
    and created_at between v_order.created_at - interval '2 minutes' and v_order.created_at + interval '10 minutes'
  order by abs(extract(epoch from (created_at-v_order.created_at))) asc,id desc limit 1 for update skip locked;
  if not found then return query select false,'no_matching_debit',0::numeric,null::numeric; return; end if;
  update public.wallet_debits set refunded=true where id=v_debit.id;
  update public.profiles set balance=coalesce(balance,0)+coalesce(v_debit.ngn_amt,0), balance_usd=coalesce(balance_usd,0)+coalesce(v_debit.usd_amt,0) where id=p_user_id returning balance into v_new_balance;
  update public.number_orders set status=v_status,refunded=true,updated_at=now(),notes=case when coalesce(notes,'')='' then p_subtitle else notes end where id=v_order.id;
  insert into public.transactions(user_id,customer_id,category,title,subtitle,amount,amount_ngn,amount_usd,status,type,created_at,currency,external_reference,notes)
  select p_user_id,p.customer_id,'MJ SMS',coalesce(v_order.service_name,'SMS'),p_subtitle,'₦'||to_char(v_order.price,'FM999G999G999G990'),v_order.price,coalesce(v_debit.usd_amt,0),case when v_status='expired' then 'expired' else 'cancelled' end,'purchase',now(),'NGN',v_order.order_id,'Server 3 refund guard'
  from public.profiles p where p.id=p_user_id;
  return query select true,'refunded',v_debit.total_ngn,v_new_balance;
end;
$$;
revoke execute on function private.refund_number_order_once(uuid,uuid,text,text) from public,anon,authenticated;
grant usage on schema private to service_role;
grant execute on function private.refund_number_order_once(uuid,uuid,text,text) to service_role;
