-- VirtualSMS Platform Rental (USA only)
-- Isolated from Server 3 OTP source='virtualsms' and GotSMS rental source='gotsms'.

create table if not exists public.virtualsms_rent_plans (
  id uuid primary key default gen_random_uuid(),
  country_code text not null default 'US' check (country_code = 'US'),
  country_id integer not null default 187 check (country_id = 187),
  service_id text not null,
  service_name text not null,
  duration_hours integer not null check (duration_hours in (24,72,168)),
  supplier_price_usd numeric(12,4) not null default 0 check (supplier_price_usd >= 0),
  price_ngn numeric(14,2) not null default 0 check (price_ngn >= 0),
  price_source text not null default 'system' check (price_source in ('system','admin')),
  stock_count integer not null default 0 check (stock_count >= 0),
  is_available boolean not null default false,
  admin_hidden boolean not null default false,
  supplier_data jsonb not null default '{}'::jsonb,
  synced_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (country_code, service_id, duration_hours)
);

create index if not exists virtualsms_rent_plans_available_idx
  on public.virtualsms_rent_plans (is_available, service_name);

alter table public.virtualsms_rent_plans enable row level security;
revoke all on public.virtualsms_rent_plans from anon, authenticated;

create table if not exists public.virtualsms_rent_messages (
  id uuid primary key default gen_random_uuid(),
  rental_id text not null,
  event_id text not null unique,
  phone_number text,
  service_name text,
  sender text,
  code text,
  content text not null default '',
  received_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists virtualsms_rent_messages_rental_idx
  on public.virtualsms_rent_messages (rental_id, received_at desc);

alter table public.virtualsms_rent_messages enable row level security;
revoke all on public.virtualsms_rent_messages from anon, authenticated;

create table if not exists public.virtualsms_rent_webhook_config (
  id integer primary key default 1 check (id = 1),
  webhook_id text,
  secret text,
  active boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.virtualsms_rent_webhook_config enable row level security;
revoke all on public.virtualsms_rent_webhook_config from anon, authenticated;
