-- SMS dual-wallet safety for Servers 1/2/3.
-- Existing debit_balance_if_sufficient already allocates NGN first, then USD
-- at the existing 1450 NGN/USD rate, atomically, and records the exact split
-- in wallet_debits. This migration makes number-order refunds restore that
-- exact split and prevents double-crediting.

begin;

alter table public.number_orders
  add column if not exists wallet_debit_id bigint;

create index if not exists number_orders_wallet_debit_id_idx
  on public.number_orders(wallet_debit_id)
  where wallet_debit_id is not null;

create or replace function public.mj_link_number_order_wallet_debit()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_debit_id bigint;
begin
  if new.wallet_debit_id is not null or new.price is null or new.price <= 0 then
    return new;
  end if;

  select id into v_debit_id
  from public.wallet_debits
  where user_id = new.user_id
    and total_ngn = new.price
    and not refunded
    and created_at between coalesce(new.created_at, now()) - interval '5 minutes'
                      and coalesce(new.created_at, now()) + interval '2 minutes'
  order by abs(extract(epoch from (created_at - coalesce(new.created_at, now())))), id desc
  limit 1
  for update skip locked;

  if v_debit_id is not null then
    new.wallet_debit_id := v_debit_id;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_mj_link_number_order_wallet_debit on public.number_orders;
create trigger trg_mj_link_number_order_wallet_debit
before insert on public.number_orders
for each row execute function public.mj_link_number_order_wallet_debit();

create or replace function public.mj_refund_number_order_wallet_once()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_debit wallet_debits%rowtype;
begin
  if coalesce(old.refunded,false) = true or coalesce(new.refunded,false) <> true then
    return new;
  end if;

  if new.wallet_debit_id is not null then
    select * into v_debit
    from public.wallet_debits
    where id = new.wallet_debit_id
      and user_id = new.user_id
      and not refunded
    for update skip locked;
  end if;

  if not found then
    select * into v_debit
    from public.wallet_debits
    where user_id = new.user_id
      and total_ngn = new.price
      and not refunded
      and created_at between coalesce(new.created_at, now()) - interval '5 minutes'
                        and coalesce(new.created_at, now()) + interval '10 minutes'
    order by abs(extract(epoch from (created_at - coalesce(new.created_at, now())))), id desc
    limit 1
    for update skip locked;
  end if;

  if v_debit.id is null then
    -- Never mint money. The order remains refunded, but no wallet credit is created.
    return new;
  end if;

  update public.wallet_debits
  set refunded = true
  where id = v_debit.id and not refunded;

  if found then
    update public.profiles
    set balance = coalesce(balance,0) + coalesce(v_debit.ngn_amt,0),
        balance_usd = coalesce(balance_usd,0) + coalesce(v_debit.usd_amt,0),
        updated_at = now()
    where id = new.user_id;
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_mj_refund_number_order_wallet on public.number_orders;
create trigger trg_mj_refund_number_order_wallet
after update of refunded on public.number_orders
for each row
when (new.refunded = true and coalesce(old.refunded,false) = false)
execute function public.mj_refund_number_order_wallet_once();

-- Preserve the existing public API, but keep it strictly non-minting.
-- Number-order refunds are handled by the order-specific trigger above.
create or replace function public.credit_balance(p_user_id uuid, p_amount numeric)
returns numeric
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_id bigint;
  v_ngn numeric;
  v_usd numeric;
  v_new numeric;
begin
  if p_amount is null or p_amount <= 0 then
    select coalesce(balance,0) into v_new from profiles where id = p_user_id;
    return v_new;
  end if;

  select id, ngn_amt, usd_amt into v_id, v_ngn, v_usd
  from wallet_debits
  where user_id = p_user_id
    and total_ngn = p_amount
    and not refunded
    and created_at > now() - interval '30 minutes'
  order by created_at desc, id desc
  limit 1
  for update skip locked;

  if v_id is null then
    select coalesce(balance,0) into v_new from profiles where id = p_user_id;
    return v_new;
  end if;

  update wallet_debits set refunded = true where id = v_id and not refunded;
  if not found then
    select coalesce(balance,0) into v_new from profiles where id = p_user_id;
    return v_new;
  end if;

  update profiles
  set balance = coalesce(balance,0) + coalesce(v_ngn,0),
      balance_usd = coalesce(balance_usd,0) + coalesce(v_usd,0),
      updated_at = now()
  where id = p_user_id
  returning balance into v_new;

  return v_new;
end;
$function$;

revoke execute on function public.mj_link_number_order_wallet_debit() from public, anon, authenticated;
revoke execute on function public.mj_refund_number_order_wallet_once() from public, anon, authenticated;
grant execute on function public.mj_link_number_order_wallet_debit() to service_role;
grant execute on function public.mj_refund_number_order_wallet_once() to service_role;

commit;
