
create table if not exists public.sms_purchase_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('grizzlysms','herosms')),
  idempotency_key text not null,
  country_id integer not null,
  service_id text not null,
  provider_id text,
  price_ngn numeric(14,2) not null check (price_ngn > 0),
  supplier_price_usd numeric(14,6),
  wallet_debit_id bigint references public.wallet_debits(id),
  ngn_debited numeric(14,2) not null default 0,
  usd_debited numeric(14,6) not null default 0,
  supplier_activation_id text,
  supplier_phone text,
  state text not null default 'initiated' check (state in (
    'initiated','debited','supplier_pending','outcome_unknown','activated',
    'order_persisted','supplier_rejected','refunded','reconciliation_required'
  )),
  error_code text,
  error_message text,
  supplier_http_status integer,
  supplier_response jsonb,
  reconciliation_attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sms_purchase_attempts_idempotency_unique unique (user_id, source, idempotency_key),
  constraint sms_purchase_attempts_activation_unique unique (source, supplier_activation_id)
);
create index if not exists sms_purchase_attempts_recovery_idx
  on public.sms_purchase_attempts (state, updated_at)
  where state in ('initiated','debited','supplier_pending','outcome_unknown','activated','reconciliation_required');
alter table public.sms_purchase_attempts enable row level security;
revoke all on public.sms_purchase_attempts from anon, authenticated;
grant all on public.sms_purchase_attempts to service_role;
