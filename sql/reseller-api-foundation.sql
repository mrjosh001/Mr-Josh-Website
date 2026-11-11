-- MJ HUB Reseller API foundation.
-- Apply only after reviewing this migration against the live schema.
create table if not exists public.reseller_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','active','suspended','closed')),
  currency text not null default 'NGN' check (currency = 'NGN'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reseller_api_keys (
  id uuid primary key default gen_random_uuid(),
  reseller_id uuid not null references public.reseller_accounts(id) on delete cascade,
  label text not null default 'Default API key',
  key_hash text not null unique,
  key_hint text not null,
  status text not null default 'active' check (status in ('active','revoked')),
  scopes text[] not null default '{}',
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table if not exists public.reseller_wallets (
  reseller_id uuid primary key references public.reseller_accounts(id) on delete cascade,
  balance_minor bigint not null default 0 check (balance_minor >= 0),
  currency text not null default 'NGN' check (currency = 'NGN'),
  updated_at timestamptz not null default now()
);

-- Provision an isolated reseller wallet at account creation.
create or replace function public.provision_reseller_wallet()
returns trigger
language plpgsql
as $function$
begin
  insert into public.reseller_wallets (reseller_id, balance_minor, currency)
  values (new.id, 0, coalesce(new.currency, 'NGN'))
  on conflict (reseller_id) do nothing;
  return new;
end;
$function$;

drop trigger if exists reseller_account_wallet_provision on public.reseller_accounts;
create trigger reseller_account_wallet_provision
after insert on public.reseller_accounts
for each row execute function public.provision_reseller_wallet();

create table if not exists public.reseller_wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  reseller_id uuid not null references public.reseller_accounts(id) on delete cascade,
  idempotency_key text not null,
  entry_type text not null check (entry_type in ('credit','debit','refund','adjustment')),
  amount_minor bigint not null check (amount_minor > 0),
  balance_after_minor bigint not null check (balance_after_minor >= 0),
  reference_type text,
  reference_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (reseller_id, idempotency_key)
);

create table if not exists public.reseller_orders (
  id uuid primary key default gen_random_uuid(),
  reseller_id uuid not null references public.reseller_accounts(id) on delete cascade,
  idempotency_key text not null,
  category text not null check (category in ('telegram','sms.activation','sms.usa_rental','sms.global_rental','sms.long_term_rental','esim','logs','boosting','mj_mails')),
  service_id text not null,
  supplier text,
  supplier_order_id text,
  status text not null default 'created' check (status in ('created','processing','waiting','completed','failed','cancelled','expired','refund_pending','refunded','unknown')),
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null default 'NGN',
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (reseller_id, idempotency_key)
);


-- Atomic reseller wallet posting. The wallet row lock serializes concurrent
-- debits/credits for one reseller. Replaying the same idempotency key returns
-- the original ledger row without changing the balance a second time.
create or replace function public.reseller_wallet_post(
  p_reseller_id uuid,
  p_idempotency_key text,
  p_entry_type text,
  p_amount_minor bigint,
  p_reference_type text default null,
  p_reference_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_wallet public.reseller_wallets%rowtype;
  v_existing public.reseller_wallet_ledger%rowtype;
  v_balance bigint;
  v_entry public.reseller_wallet_ledger%rowtype;
begin
  if p_reseller_id is null
     or coalesce(length(trim(p_idempotency_key)), 0) < 8
     or p_amount_minor is null or p_amount_minor <= 0
     or p_entry_type not in ('credit','debit','refund','adjustment') then
    raise exception 'INVALID_WALLET_POST';
  end if;

  select * into v_wallet
    from public.reseller_wallets
    where reseller_id = p_reseller_id
    for update;

  if not found then
    raise exception 'RESELLER_WALLET_NOT_FOUND';
  end if;

  select * into v_existing
    from public.reseller_wallet_ledger
    where reseller_id = p_reseller_id
      and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.entry_type <> p_entry_type
       or v_existing.amount_minor <> p_amount_minor then
      raise exception 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD';
    end if;
    return jsonb_build_object(
      'created', false,
      'balance_minor', v_existing.balance_after_minor,
      'ledger', to_jsonb(v_existing)
    );
  end if;

  if p_entry_type = 'debit' then
    if v_wallet.balance_minor < p_amount_minor then
      raise exception 'INSUFFICIENT_RESELLER_BALANCE';
    end if;
    v_balance := v_wallet.balance_minor - p_amount_minor;
  else
    v_balance := v_wallet.balance_minor + p_amount_minor;
  end if;

  update public.reseller_wallets
    set balance_minor = v_balance, updated_at = now()
    where reseller_id = p_reseller_id;

  insert into public.reseller_wallet_ledger (
    reseller_id, idempotency_key, entry_type, amount_minor,
    balance_after_minor, reference_type, reference_id, metadata
  ) values (
    p_reseller_id, p_idempotency_key, p_entry_type, p_amount_minor,
    v_balance, p_reference_type, p_reference_id, coalesce(p_metadata, '{}'::jsonb)
  )
  returning * into v_entry;

  return jsonb_build_object(
    'created', true,
    'balance_minor', v_balance,
    'ledger', to_jsonb(v_entry)
  );
end;
$function$;

revoke all on function public.reseller_wallet_post(uuid,text,text,bigint,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.reseller_wallet_post(uuid,text,text,bigint,text,text,jsonb)
  to service_role;

-- Refund an order only after its supplier outcome is confirmed. The order row
-- lock prevents a second refund under a different request/idempotency key.
create or replace function public.reseller_refund_order(
  p_order_id uuid,
  p_idempotency_key text,
  p_reason text,
  p_supplier_confirmed boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_order public.reseller_orders%rowtype;
  v_result jsonb;
begin
  if p_order_id is null
     or coalesce(length(trim(p_idempotency_key)), 0) < 8
     or p_supplier_confirmed is distinct from true then
    raise exception 'REFUND_NOT_CONFIRMED';
  end if;

  select * into v_order
    from public.reseller_orders
    where id = p_order_id
    for update;

  if not found then
    raise exception 'RESELLER_ORDER_NOT_FOUND';
  end if;

  if v_order.status = 'refunded' then
    return jsonb_build_object('created', false, 'status', 'refunded', 'order_id', v_order.id);
  end if;

  if v_order.status not in ('refund_pending','failed','cancelled') then
    raise exception 'ORDER_NOT_REFUNDABLE';
  end if;

  v_result := public.reseller_wallet_post(
    v_order.reseller_id,
    p_idempotency_key,
    'refund',
    v_order.amount_minor,
    'reseller_order',
    v_order.id::text,
    jsonb_build_object('reason', left(coalesce(p_reason, 'Supplier-confirmed refund'), 500))
  );

  update public.reseller_orders
    set status = 'refunded', updated_at = now(),
        response_payload = coalesce(response_payload, '{}'::jsonb)
          || jsonb_build_object('refund', jsonb_build_object('reason', left(coalesce(p_reason, ''), 500)))
    where id = v_order.id;

  return v_result || jsonb_build_object('status', 'refunded', 'order_id', v_order.id);
end;
$function$;

revoke all on function public.reseller_refund_order(uuid,text,text,boolean)
  from public, anon, authenticated;
grant execute on function public.reseller_refund_order(uuid,text,text,boolean)
  to service_role;

create index if not exists reseller_orders_reseller_created_idx
  on public.reseller_orders (reseller_id, created_at desc);
create index if not exists reseller_api_keys_reseller_status_idx
  on public.reseller_api_keys (reseller_id, status);

alter table public.reseller_accounts enable row level security;
alter table public.reseller_api_keys enable row level security;
alter table public.reseller_wallets enable row level security;
alter table public.reseller_wallet_ledger enable row level security;
alter table public.reseller_orders enable row level security;

revoke all on public.reseller_accounts, public.reseller_api_keys, public.reseller_wallets,
  public.reseller_wallet_ledger, public.reseller_orders from anon, authenticated;
