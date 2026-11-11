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
