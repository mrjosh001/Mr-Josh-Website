-- SMS-BUS long-rental ownership transfer, operation locking and current-owner refunds.
-- Scope is intentionally limited to number_orders.source = 'smsbus_rent'.

create table if not exists public.smsbus_rent_transfers (
  id uuid primary key default gen_random_uuid(),
  rental_order_id uuid not null references public.number_orders(id) on delete restrict,
  order_id text not null,
  from_user_id uuid not null references auth.users(id),
  to_user_id uuid not null references auth.users(id),
  original_payer_user_id uuid not null references auth.users(id),
  transferred_at timestamptz not null default now(),
  constraint smsbus_rent_transfers_different_users check (from_user_id <> to_user_id)
);
create index if not exists smsbus_rent_transfers_rental_time_idx
  on public.smsbus_rent_transfers (rental_order_id, transferred_at);

create table if not exists public.smsbus_rent_operation_locks (
  rental_order_id uuid primary key references public.number_orders(id) on delete cascade,
  operation text not null check (operation in ('cancel','renew')),
  owner_user_id uuid not null references auth.users(id),
  lock_token uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.smsbus_rent_refund_credits (
  rental_order_id uuid primary key references public.number_orders(id) on delete restrict,
  order_id text not null,
  original_payer_user_id uuid not null references auth.users(id),
  beneficiary_user_id uuid not null references auth.users(id),
  wallet_debit_id bigint not null references public.wallet_debits(id),
  amount_ngn numeric(14,2) not null default 0,
  amount_usd numeric(14,2) not null default 0,
  created_at timestamptz not null default now()
);

alter table public.smsbus_rent_transfers enable row level security;
alter table public.smsbus_rent_operation_locks enable row level security;
alter table public.smsbus_rent_refund_credits enable row level security;
revoke all on public.smsbus_rent_transfers, public.smsbus_rent_operation_locks, public.smsbus_rent_refund_credits from public, anon, authenticated;
grant all on public.smsbus_rent_transfers, public.smsbus_rent_operation_locks, public.smsbus_rent_refund_credits to service_role;

create or replace function public.smsbus_rent_transfer_ownership(
  p_rental_order_id uuid,
  p_from_user_id uuid,
  p_to_user_id uuid,
  p_recipient_customer_id text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_order public.number_orders%rowtype;
  v_original_payer uuid;
  v_debit public.wallet_debits%rowtype;
  v_transfer_id uuid;
  v_expiry timestamptz;
begin
  if p_rental_order_id is null or p_from_user_id is null or p_to_user_id is null
     or p_from_user_id = p_to_user_id then
    return jsonb_build_object('success', false, 'message', 'Invalid transfer request.');
  end if;

  select * into v_order
    from public.number_orders
   where id = p_rental_order_id and source = 'smsbus_rent'
   for update;

  if not found or v_order.user_id <> p_from_user_id then
    return jsonb_build_object('success', false, 'message', 'Rental not found or no longer belongs to you.');
  end if;

  if coalesce(v_order.refunded,false)
     or lower(coalesce(v_order.status,'')) in ('refunded','cancelled','canceled','expired') then
    return jsonb_build_object('success', false, 'message', 'Only active, non-refunded rentals can be transferred.');
  end if;

  if nullif(trim(coalesce(v_order.code,'')), '') is not null
     and pg_input_is_valid(trim(v_order.code), 'timestamptz') then
    v_expiry := trim(v_order.code)::timestamptz;
    if v_expiry <= now() then
      return jsonb_build_object('success', false, 'message', 'This rental has expired and cannot be transferred.');
    end if;
  end if;

  delete from public.smsbus_rent_operation_locks
   where rental_order_id = v_order.id and expires_at <= now();

  if exists (
    select 1 from public.smsbus_rent_operation_locks
     where rental_order_id = v_order.id and expires_at > now()
  ) then
    return jsonb_build_object('success', false, 'message', 'A cancellation or renewal is currently processing. Try again shortly.');
  end if;

  select original_payer_user_id into v_original_payer
    from public.smsbus_rent_transfers
   where rental_order_id = v_order.id
   order by transferred_at asc
   limit 1;

  v_original_payer := coalesce(v_original_payer, v_order.user_id);

  if v_order.wallet_debit_id is null then
    return jsonb_build_object('success', false, 'message', 'This rental has no verifiable wallet debit and cannot be transferred. Contact support.');
  end if;

  select * into v_debit
    from public.wallet_debits
   where id = v_order.wallet_debit_id
   for update;

  if not found or v_debit.user_id <> v_original_payer
     or round(v_debit.total_ngn,2) <> round(v_order.price,2)
     or v_debit.refunded then
    return jsonb_build_object('success', false, 'message', 'The original wallet debit could not be verified. Contact support before transferring this rental.');
  end if;

  insert into public.smsbus_rent_transfers (
    rental_order_id, order_id, from_user_id, to_user_id, original_payer_user_id
  ) values (
    v_order.id, v_order.order_id, p_from_user_id, p_to_user_id, v_original_payer
  ) returning id into v_transfer_id;

  update public.number_orders
     set user_id = p_to_user_id,
         customer_id = nullif(p_recipient_customer_id,''),
         updated_at = now()
   where id = v_order.id and user_id = p_from_user_id;

  if not found then
    raise exception 'Rental ownership changed during transfer.';
  end if;

  return jsonb_build_object(
    'success', true,
    'transfer_id', v_transfer_id,
    'rental_order_id', v_order.id,
    'order_id', v_order.order_id,
    'from_user_id', p_from_user_id,
    'to_user_id', p_to_user_id,
    'original_payer_user_id', v_original_payer
  );
end;
$function$;

create or replace function public.smsbus_rent_begin_operation(
  p_rental_order_id uuid,
  p_user_id uuid,
  p_operation text,
  p_lock_token uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_order public.number_orders%rowtype;
  v_expiry timestamptz;
begin
  if p_operation not in ('cancel','renew') or p_lock_token is null then
    return jsonb_build_object('success', false, 'message', 'Invalid rental operation.');
  end if;

  select * into v_order
    from public.number_orders
   where id = p_rental_order_id and source = 'smsbus_rent'
   for update;

  if not found or v_order.user_id <> p_user_id then
    return jsonb_build_object('success', false, 'message', 'Rental not found or no longer belongs to you.');
  end if;

  if coalesce(v_order.refunded,false)
     or lower(coalesce(v_order.status,'')) in ('refunded','cancelled','canceled','expired') then
    return jsonb_build_object('success', false, 'message', 'This rental is no longer active.');
  end if;

  if nullif(trim(coalesce(v_order.code,'')), '') is not null
     and pg_input_is_valid(trim(v_order.code), 'timestamptz') then
    v_expiry := trim(v_order.code)::timestamptz;
    if v_expiry <= now() then
      return jsonb_build_object('success', false, 'message', 'This rental has expired.');
    end if;
  end if;

  delete from public.smsbus_rent_operation_locks
   where rental_order_id = v_order.id and expires_at <= now();

  insert into public.smsbus_rent_operation_locks (
    rental_order_id, operation, owner_user_id, lock_token, expires_at
  ) values (
    v_order.id, p_operation, p_user_id, p_lock_token, now() + interval '3 minutes'
  )
  on conflict (rental_order_id) do nothing;

  if not found then
    return jsonb_build_object('success', false, 'message', 'Another rental operation is already processing. Try again shortly.');
  end if;

  return jsonb_build_object('success', true, 'lock_token', p_lock_token);
end;
$function$;

create or replace function public.smsbus_rent_release_operation(
  p_rental_order_id uuid,
  p_user_id uuid,
  p_lock_token uuid
) returns boolean
language sql
security definer
set search_path = public, pg_temp
as $function$
  with deleted as (
    delete from public.smsbus_rent_operation_locks
     where rental_order_id = p_rental_order_id
       and owner_user_id = p_user_id
       and lock_token = p_lock_token
    returning 1
  )
  select exists(select 1 from deleted);
$function$;

revoke all on function public.smsbus_rent_transfer_ownership(uuid,uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.smsbus_rent_begin_operation(uuid,uuid,text,uuid) from public, anon, authenticated;
revoke all on function public.smsbus_rent_release_operation(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.smsbus_rent_transfer_ownership(uuid,uuid,uuid,text) to service_role;
grant execute on function public.smsbus_rent_begin_operation(uuid,uuid,text,uuid) to service_role;
grant execute on function public.smsbus_rent_release_operation(uuid,uuid,uuid) to service_role;

-- Extend the existing refund trigger only for SMS-BUS rentals that have changed owners.
-- All other sources retain the existing refund contract.
create or replace function public.mj_refund_number_order_wallet_once()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_debit public.wallet_debits%rowtype;
  v_customer_id text;
begin
  if coalesce(old.refunded,false) = true or coalesce(new.refunded,false) <> true then
    return new;
  end if;

  if coalesce(new.price,0) <= 0 then
    return new;
  end if;

  if new.source = 'gotsms' and (
       old.status = 'completed'
       or coalesce(old.service_name,'') ~* 'sms[[:space:]]*received'
       or coalesce(old.notes,'') ~ '\"inbox\"[[:space:]]*:[[:space:]]*\\[[[:space:]]*\\{'
  ) then
    raise exception 'GotSMS order has received an SMS or is completed; refund blocked';
  end if;

  if new.wallet_debit_id is null then
    raise exception 'Refund blocked: order has no linked wallet debit';
  end if;

  select * into v_debit
    from public.wallet_debits
   where id = new.wallet_debit_id
   for update;

  if not found then
    raise exception 'Refund blocked: linked wallet debit is missing';
  end if;

  -- Transferred SMS-BUS rentals refund the original debit split to the current owner.
  if new.source = 'smsbus_rent' and v_debit.user_id <> new.user_id then
    if not exists (
      select 1 from public.smsbus_rent_transfers t
       where t.rental_order_id = new.id
         and t.to_user_id = new.user_id
         and t.original_payer_user_id = v_debit.user_id
    ) then
      raise exception 'Refund blocked: current owner is not a verified SMS-BUS rental transferee';
    end if;

    if round(v_debit.total_ngn,2) <> round(new.price,2) then
      raise exception 'Refund blocked: original wallet debit amount does not match rental price';
    end if;

    if v_debit.refunded then
      raise exception 'Refund blocked: original wallet debit was already refunded';
    end if;

    update public.wallet_debits
       set refunded = true
     where id = v_debit.id and user_id = v_debit.user_id and refunded = false;
    if not found then
      raise exception 'Refund blocked: original debit refund state changed unexpectedly';
    end if;

    update public.profiles
       set balance = coalesce(balance,0) + coalesce(v_debit.ngn_amt,0),
           balance_usd = coalesce(balance_usd,0) + coalesce(v_debit.usd_amt,0),
           updated_at = now()
     where id = new.user_id;
    if not found then
      raise exception 'Refund blocked: current owner wallet profile not found';
    end if;

    insert into public.smsbus_rent_refund_credits (
      rental_order_id, order_id, original_payer_user_id, beneficiary_user_id,
      wallet_debit_id, amount_ngn, amount_usd
    ) values (
      new.id, new.order_id, v_debit.user_id, new.user_id,
      v_debit.id, coalesce(v_debit.ngn_amt,0), coalesce(v_debit.usd_amt,0)
    );

    select customer_id into v_customer_id
      from public.profiles where id = new.user_id;

    insert into public.transactions (
      user_id, customer_id, type, category, title, subtitle, amount,
      amount_ngn, amount_usd, status, external_reference, meta
    ) values (
      new.user_id, v_customer_id, 'refund', 'MJ SMS',
      'Transferred rental cancelled — balance restored',
      coalesce(new.phone_number,new.order_id),
      concat('₦',to_char(coalesce(v_debit.ngn_amt,0),'FM999,999,999,990.00'),
             case when coalesce(v_debit.usd_amt,0) > 0
                  then concat(' + $',to_char(v_debit.usd_amt,'FM999,999,990.00')) else '' end),
      coalesce(v_debit.ngn_amt,0), coalesce(v_debit.usd_amt,0),
      'completed', 'smsbus-rent-refund:' || new.id::text,
      jsonb_build_object(
        'rental_order_id',new.id,
        'original_payer_user_id',v_debit.user_id,
        'refund_beneficiary_user_id',new.user_id,
        'wallet_debit_id',v_debit.id
      )
    );

    return new;
  end if;

  if v_debit.user_id <> new.user_id or round(v_debit.total_ngn,2) <> round(new.price,2) then
    raise exception 'Refund blocked: exact linked wallet debit is missing or mismatched';
  end if;

  -- Existing path for all non-transferred orders remains unchanged.
  if v_debit.refunded then
    return new;
  end if;

  update public.wallet_debits
     set refunded = true
   where id = v_debit.id
     and user_id = new.user_id
     and refunded = false;

  if not found then
    raise exception 'Refund blocked: linked debit refund state changed unexpectedly';
  end if;

  update public.profiles
     set balance = coalesce(balance,0) + coalesce(v_debit.ngn_amt,0),
         balance_usd = coalesce(balance_usd,0) + coalesce(v_debit.usd_amt,0),
         updated_at = now()
   where id = new.user_id;

  if not found then
    raise exception 'Refund blocked: wallet profile not found';
  end if;

  if new.source = 'gotsms' then
    insert into public.transactions (
      user_id, customer_id, type, category, title, subtitle,
      amount, amount_ngn, status, external_reference
    )
    values (
      new.user_id, new.customer_id, 'refund', 'MJ SMS',
      'USA rental cancelled', 'Balance restored',
      '₦' || to_char(v_debit.ngn_amt, 'FM999,999,999,990.00'),
      v_debit.ngn_amt, 'refunded', coalesce(new.order_id, new.idempotency_key)
    );
  end if;

  return new;
end;
$function$;
