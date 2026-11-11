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
  category text not null check (category in ('telegram','telegram.premium','telegram.stars','sms.activation','sms.server1','sms.server2','sms.server3','sms.usa_rental','sms.global_rental','sms.long_term_rental','esim','logs','boosting','mj_mails')),
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


-- Reserve funds and create an order in one database transaction.
-- No supplier call may happen until this function commits successfully.
create or replace function public.reseller_order_reserve(
  p_reseller_id uuid,
  p_idempotency_key text,
  p_category text,
  p_service_id text,
  p_supplier text,
  p_amount_minor bigint,
  p_request_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_wallet public.reseller_wallets%rowtype;
  v_existing public.reseller_orders%rowtype;
  v_order public.reseller_orders%rowtype;
  v_balance bigint;
  v_ledger public.reseller_wallet_ledger%rowtype;
  v_ledger_key text;
begin
  if p_reseller_id is null
     or coalesce(length(trim(p_idempotency_key)), 0) < 8
     or coalesce(length(trim(p_service_id)), 0) = 0
     or p_amount_minor is null or p_amount_minor <= 0
     or p_category not in ('telegram','telegram.premium','telegram.stars','sms.activation','sms.server1',
       'sms.server2','sms.server3','sms.usa_rental','sms.global_rental','sms.long_term_rental',
       'esim','logs','boosting','mj_mails') then
    raise exception 'INVALID_RESELLER_ORDER';
  end if;

  select * into v_wallet
    from public.reseller_wallets
    where reseller_id = p_reseller_id
    for update;

  if not found then
    raise exception 'RESELLER_WALLET_NOT_FOUND';
  end if;

  select * into v_existing
    from public.reseller_orders
    where reseller_id = p_reseller_id
      and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.category <> p_category
       or v_existing.service_id <> p_service_id
       or v_existing.supplier is distinct from p_supplier
       or v_existing.amount_minor <> p_amount_minor
       or v_existing.request_payload is distinct from coalesce(p_request_payload, '{}'::jsonb) then
      raise exception 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_ORDER';
    end if;
    return jsonb_build_object('created', false, 'order', to_jsonb(v_existing),
      'balance_minor', v_wallet.balance_minor);
  end if;

  if v_wallet.balance_minor < p_amount_minor then
    raise exception 'INSUFFICIENT_RESELLER_BALANCE';
  end if;

  v_balance := v_wallet.balance_minor - p_amount_minor;
  update public.reseller_wallets
    set balance_minor = v_balance, updated_at = now()
    where reseller_id = p_reseller_id;

  v_ledger_key := 'order:' || p_idempotency_key;
  insert into public.reseller_wallet_ledger (
    reseller_id, idempotency_key, entry_type, amount_minor,
    balance_after_minor, reference_type, metadata
  ) values (
    p_reseller_id, v_ledger_key, 'debit', p_amount_minor, v_balance,
    'reseller_order', jsonb_build_object('idempotency_key', p_idempotency_key)
  ) returning * into v_ledger;

  insert into public.reseller_orders (
    reseller_id, idempotency_key, category, service_id, supplier,
    status, amount_minor, request_payload
  ) values (
    p_reseller_id, p_idempotency_key, p_category, p_service_id, p_supplier,
    'created', p_amount_minor, coalesce(p_request_payload, '{}'::jsonb)
  ) returning * into v_order;

  return jsonb_build_object('created', true, 'order', to_jsonb(v_order),
    'balance_minor', v_balance, 'ledger', to_jsonb(v_ledger));
end;
$function$;

revoke all on function public.reseller_order_reserve(uuid,text,text,text,text,bigint,jsonb)
  from public, anon, authenticated;
grant execute on function public.reseller_order_reserve(uuid,text,text,text,text,bigint,jsonb)
  to service_role;

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
       or v_existing.amount_minor <> p_amount_minor
       or v_existing.reference_type is distinct from p_reference_type
       or v_existing.reference_id is distinct from p_reference_id
       or v_existing.metadata is distinct from coalesce(p_metadata, '{}'::jsonb) then
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
grant all on public.reseller_accounts, public.reseller_api_keys, public.reseller_wallets,
  public.reseller_wallet_ledger, public.reseller_orders to service_role;


-- Sandbox/live separation and key-level access controls.
alter table public.reseller_api_keys
  add column if not exists environment text not null default 'live'
    check (environment in ('live','sandbox')),
  add column if not exists ip_allowlist text[] not null default '{}',
  add column if not exists expires_at timestamptz,
  add column if not exists revoked_at timestamptz;

create index if not exists reseller_api_keys_active_lookup
  on public.reseller_api_keys (key_hash, status, environment);

-- Sandbox balances are separate from live reseller funds.
create table if not exists public.reseller_sandbox_wallets (
  reseller_id uuid primary key references public.reseller_accounts(id) on delete cascade,
  balance_minor bigint not null default 0 check (balance_minor >= 0),
  currency text not null default 'NGN' check (currency = 'NGN'),
  updated_at timestamptz not null default now()
);
alter table public.reseller_sandbox_wallets enable row level security;
revoke all on public.reseller_sandbox_wallets from anon, authenticated;
grant all on public.reseller_sandbox_wallets to service_role;

create or replace function public.provision_reseller_wallet()
returns trigger
language plpgsql
as $function$
begin
  insert into public.reseller_wallets (reseller_id, balance_minor, currency)
  values (new.id, 0, coalesce(new.currency, 'NGN'))
  on conflict (reseller_id) do nothing;
  insert into public.reseller_sandbox_wallets (reseller_id, balance_minor, currency)
  values (new.id, 0, coalesce(new.currency, 'NGN'))
  on conflict (reseller_id) do nothing;
  return new;
end;
$function$;


-- Atomic fixed-window per-key rate limiting (default API policy: 60 requests / 60 seconds).
create table if not exists public.reseller_rate_limits (
  api_key_id uuid not null references public.reseller_api_keys(id) on delete cascade,
  window_start timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (api_key_id, window_start)
);
alter table public.reseller_rate_limits enable row level security;
revoke all on public.reseller_rate_limits from anon, authenticated;
grant all on public.reseller_rate_limits to service_role;

create or replace function public.reseller_consume_rate_limit(
  p_key_id uuid, p_limit integer default 60, p_window_seconds integer default 60
) returns jsonb
language plpgsql security invoker
set search_path = public, pg_temp
as $function$
declare
  v_start timestamptz;
  v_count integer;
  v_retry integer;
begin
  if p_key_id is null or p_limit < 1 or p_window_seconds < 1 then
    raise exception 'INVALID_RATE_LIMIT_ARGUMENTS';
  end if;
  v_start := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);
  insert into public.reseller_rate_limits(api_key_id, window_start, request_count)
  values (p_key_id, v_start, 1)
  on conflict (api_key_id, window_start) do update
    set request_count = public.reseller_rate_limits.request_count + 1,
        updated_at = now()
  returning request_count into v_count;
  v_retry := greatest(1, ceil(extract(epoch from (v_start + make_interval(secs => p_window_seconds) - clock_timestamp())))::integer);
  return jsonb_build_object('allowed', v_count <= p_limit, 'remaining', greatest(0, p_limit - v_count),
    'retry_after', v_retry, 'limit', p_limit);
end;
$function$;
revoke all on function public.reseller_consume_rate_limit(uuid,integer,integer) from public, anon, authenticated;
grant execute on function public.reseller_consume_rate_limit(uuid,integer,integer) to service_role;

-- Reseller webhook endpoints and durable outbox. Secret is stored encrypted by the
-- application before insertion; plaintext must never be returned by management APIs.
create table if not exists public.reseller_webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  reseller_id uuid not null references public.reseller_accounts(id) on delete cascade,
  url text not null,
  secret_ciphertext text not null,
  events text[] not null default array['order.completed','order.failed','order.partial'],
  status text not null default 'active' check (status in ('active','disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.reseller_webhook_outbox (
  id uuid primary key default gen_random_uuid(),
  reseller_id uuid not null references public.reseller_accounts(id) on delete cascade,
  endpoint_id uuid not null references public.reseller_webhook_endpoints(id) on delete cascade,
  event_type text not null check (event_type in ('order.completed','order.failed','order.partial')),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','delivering','delivered','dead')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_http_status integer,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists reseller_webhook_outbox_due_idx
  on public.reseller_webhook_outbox(status, next_attempt_at) where status in ('pending','delivering');
alter table public.reseller_webhook_endpoints enable row level security;
alter table public.reseller_webhook_outbox enable row level security;
revoke all on public.reseller_webhook_endpoints, public.reseller_webhook_outbox from anon, authenticated;
grant all on public.reseller_webhook_endpoints, public.reseller_webhook_outbox to service_role;

-- Persist request idempotency separately from the permanent financial order ledger.
-- The 24-hour replay window does not expire or delete reseller_orders/ledger entries.
create table if not exists public.reseller_idempotency_requests (
  reseller_id uuid not null references public.reseller_accounts(id) on delete cascade,
  idempotency_key text not null,
  request_hash text not null,
  order_id uuid references public.reseller_orders(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  primary key (reseller_id, idempotency_key)
);
create index if not exists reseller_idempotency_expiry_idx
  on public.reseller_idempotency_requests(expires_at);
alter table public.reseller_idempotency_requests enable row level security;
revoke all on public.reseller_idempotency_requests from anon, authenticated;
grant all on public.reseller_idempotency_requests to service_role;


-- Claim a 24-hour HTTP idempotency key. Same key + same payload is a replay;
-- same key + different payload is a conflict. Expired claims may be replaced.
create or replace function public.reseller_idempotency_claim(
  p_reseller_id uuid, p_idempotency_key text, p_request_hash text
) returns jsonb
language plpgsql security invoker
set search_path = public, pg_temp
as $function$
declare
  v_row public.reseller_idempotency_requests%rowtype;
  v_inserted boolean := false;
begin
  if p_reseller_id is null or length(trim(coalesce(p_idempotency_key,''))) < 8
     or length(trim(coalesce(p_request_hash,''))) <> 64 then
    raise exception 'INVALID_IDEMPOTENCY_REQUEST';
  end if;

  insert into public.reseller_idempotency_requests(
    reseller_id, idempotency_key, request_hash, expires_at
  ) values (
    p_reseller_id, p_idempotency_key, p_request_hash, now() + interval '24 hours'
  )
  on conflict (reseller_id, idempotency_key) do update
    set request_hash = excluded.request_hash,
        order_id = null,
        created_at = now(),
        expires_at = now() + interval '24 hours'
    where public.reseller_idempotency_requests.expires_at <= now()
  returning * into v_row;

  if found then
    return jsonb_build_object('claimed', true, 'replay', false, 'order_id', v_row.order_id);
  end if;

  select * into v_row from public.reseller_idempotency_requests
   where reseller_id = p_reseller_id and idempotency_key = p_idempotency_key;

  if v_row.request_hash <> p_request_hash then
    return jsonb_build_object('claimed', false, 'conflict', true);
  end if;
  return jsonb_build_object('claimed', false, 'replay', true, 'order_id', v_row.order_id);
end;
$function$;
revoke all on function public.reseller_idempotency_claim(uuid,text,text) from public, anon, authenticated;
grant execute on function public.reseller_idempotency_claim(uuid,text,text) to service_role;

create or replace function public.reseller_idempotency_bind_order(
  p_reseller_id uuid, p_idempotency_key text, p_order_id uuid
) returns boolean
language plpgsql security invoker
set search_path = public, pg_temp
as $function$
begin
  update public.reseller_idempotency_requests
     set order_id = p_order_id
   where reseller_id = p_reseller_id
     and idempotency_key = p_idempotency_key
     and expires_at > now();
  return found;
end;
$function$;
revoke all on function public.reseller_idempotency_bind_order(uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.reseller_idempotency_bind_order(uuid,text,uuid) to service_role;


-- Rotate a key atomically: revoke the old key and create the replacement in one transaction.
create or replace function public.reseller_rotate_api_key(
  p_reseller_id uuid, p_old_key_id uuid, p_new_key_hash text, p_new_key_hint text, p_label text
) returns jsonb
language plpgsql security invoker
set search_path = public, pg_temp
as $function$
declare
  v_old public.reseller_api_keys%rowtype;
  v_new public.reseller_api_keys%rowtype;
begin
  select * into v_old from public.reseller_api_keys
   where id = p_old_key_id and reseller_id = p_reseller_id and status = 'active'
   for update;
  if not found then raise exception 'ACTIVE_API_KEY_NOT_FOUND'; end if;
  if length(coalesce(p_new_key_hash,'')) <> 64 then raise exception 'INVALID_API_KEY_HASH'; end if;
  update public.reseller_api_keys set status = 'revoked', revoked_at = now()
   where id = v_old.id;
  insert into public.reseller_api_keys(
    reseller_id, label, key_hash, key_hint, status, scopes, environment, ip_allowlist
  ) values (
    p_reseller_id, left(coalesce(nullif(trim(p_label),''), v_old.label),60),
    p_new_key_hash, p_new_key_hint, 'active', v_old.scopes, v_old.environment, v_old.ip_allowlist
  ) returning * into v_new;
  return jsonb_build_object('id',v_new.id,'label',v_new.label,'key_hint',v_new.key_hint,
    'status',v_new.status,'scopes',v_new.scopes,'environment',v_new.environment,'created_at',v_new.created_at);
end;
$function$;
revoke all on function public.reseller_rotate_api_key(uuid,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.reseller_rotate_api_key(uuid,uuid,text,text,text) to service_role;


-- Enqueue a webhook event for every active matching subscription.
create or replace function public.reseller_enqueue_webhook(
  p_reseller_id uuid, p_event_type text, p_payload jsonb
) returns integer
language plpgsql security invoker
set search_path = public, pg_temp
as $function$
declare v_count integer;
begin
  if p_event_type not in ('order.completed','order.failed','order.partial') then
    raise exception 'INVALID_RESELLER_WEBHOOK_EVENT';
  end if;
  insert into public.reseller_webhook_outbox(reseller_id, endpoint_id, event_type, payload)
  select p_reseller_id, e.id, p_event_type, coalesce(p_payload,'{}'::jsonb)
    from public.reseller_webhook_endpoints e
   where e.reseller_id = p_reseller_id and e.status = 'active'
     and p_event_type = any(e.events);
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;
revoke all on function public.reseller_enqueue_webhook(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.reseller_enqueue_webhook(uuid,text,jsonb) to service_role;

-- Claim due outbox rows with SKIP LOCKED so concurrent dispatchers cannot double-send.
create or replace function public.reseller_claim_webhook_outbox(p_batch_size integer default 25)
returns setof public.reseller_webhook_outbox
language plpgsql security invoker
set search_path = public, pg_temp
as $function$
begin
  return query
  with picked as (
    select id from public.reseller_webhook_outbox
     where status in ('pending','delivering') and next_attempt_at <= now()
     order by created_at
     for update skip locked
     limit greatest(1, least(p_batch_size, 100))
  )
  update public.reseller_webhook_outbox o
     set status = 'delivering', attempts = attempts + 1
    from picked where o.id = picked.id
  returning o.*;
end;
$function$;
revoke all on function public.reseller_claim_webhook_outbox(integer) from public, anon, authenticated;
grant execute on function public.reseller_claim_webhook_outbox(integer) to service_role;


-- Sandbox-only order ledger and wallet. Sandbox credits are fictitious and never
-- transferable to the live wallet or redeemable for cash/services.
create table if not exists public.reseller_sandbox_orders (
  id uuid primary key default gen_random_uuid(),
  reseller_id uuid not null references public.reseller_accounts(id) on delete cascade,
  idempotency_key text not null,
  request_hash text not null,
  category text not null,
  service_id text not null,
  status text not null default 'completed' check (status in ('processing','completed','failed')),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null default 'NGN',
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (reseller_id, idempotency_key)
);
alter table public.reseller_sandbox_orders enable row level security;
revoke all on public.reseller_sandbox_orders from anon, authenticated;
grant all on public.reseller_sandbox_orders to service_role;

-- Provide a clearly fictitious test balance only when a reseller account is created.
-- Existing accounts are not auto-credited by this migration.
update public.reseller_sandbox_wallets
   set balance_minor = 100000000, updated_at = now()
 where balance_minor = 0;

create or replace function public.reseller_sandbox_order_create(
  p_reseller_id uuid, p_idempotency_key text, p_request_hash text,
  p_category text, p_service_id text, p_amount_minor bigint, p_request_payload jsonb
) returns jsonb
language plpgsql security invoker
set search_path = public, pg_temp
as $function$
declare
  v_wallet public.reseller_sandbox_wallets%rowtype;
  v_order public.reseller_sandbox_orders%rowtype;
  v_balance bigint;
begin
  if p_reseller_id is null or length(trim(coalesce(p_idempotency_key,''))) < 8
     or length(coalesce(p_request_hash,'')) <> 64 or p_amount_minor <= 0
     or p_category not in ('telegram.premium','telegram.stars','sms.server1','sms.server2','sms.server3',
       'sms.usa_rental','sms.global_rental','esim','logs','boosting','mj_mails') then
    raise exception 'INVALID_SANDBOX_ORDER';
  end if;
  select * into v_wallet from public.reseller_sandbox_wallets
   where reseller_id = p_reseller_id for update;
  if not found then raise exception 'SANDBOX_WALLET_NOT_FOUND'; end if;
  select * into v_order from public.reseller_sandbox_orders
   where reseller_id = p_reseller_id and idempotency_key = p_idempotency_key;
  if found then
    if v_order.request_hash <> p_request_hash then raise exception 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_ORDER'; end if;
    return jsonb_build_object('created',false,'order',to_jsonb(v_order),'balance_minor',v_wallet.balance_minor);
  end if;
  if v_wallet.balance_minor < p_amount_minor then raise exception 'INSUFFICIENT_SANDBOX_BALANCE'; end if;
  v_balance := v_wallet.balance_minor - p_amount_minor;
  update public.reseller_sandbox_wallets set balance_minor=v_balance,updated_at=now()
   where reseller_id=p_reseller_id;
  insert into public.reseller_sandbox_orders(
    reseller_id,idempotency_key,request_hash,category,service_id,status,amount_minor,request_payload,response_payload
  ) values (
    p_reseller_id,p_idempotency_key,p_request_hash,p_category,p_service_id,'completed',
    p_amount_minor,coalesce(p_request_payload,'{}'::jsonb),
    jsonb_build_object('sandbox',true,'message','Simulated order completed. No supplier was contacted.')
  ) returning * into v_order;
  return jsonb_build_object('created',true,'order',to_jsonb(v_order),'balance_minor',v_balance);
end;
$function$;
revoke all on function public.reseller_sandbox_order_create(uuid,text,text,text,text,bigint,jsonb)
 from public,anon,authenticated;
grant execute on function public.reseller_sandbox_order_create(uuid,text,text,text,text,bigint,jsonb) to service_role;
