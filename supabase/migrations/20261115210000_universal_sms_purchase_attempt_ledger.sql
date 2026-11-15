-- Extend the durable SMS purchase-attempt ledger from Server 1 to all active SMS suppliers.
-- This migration is additive: existing attempts and uniqueness guarantees are preserved.

alter table public.sms_purchase_attempts
  drop constraint if exists sms_purchase_attempts_source_check;

alter table public.sms_purchase_attempts
  add constraint sms_purchase_attempts_source_check
  check (source in (
    'grizzlysms',
    'herosms',
    'smsbus',
    'smsbus_rent',
    'gotsms',
    'virtualsms',
    'virtualsms_rent'
  ));

alter table public.sms_purchase_attempts
  add column if not exists request_kind text,
  add column if not exists supplier_order_id text,
  add column if not exists number_order_id text,
  add column if not exists request_metadata jsonb not null default '{}'::jsonb,
  add column if not exists reconciled_at timestamptz,
  add column if not exists last_reconciled_at timestamptz;

create index if not exists sms_purchase_attempts_supplier_order_idx
  on public.sms_purchase_attempts (source, supplier_order_id)
  where supplier_order_id is not null;

create index if not exists sms_purchase_attempts_wallet_debit_idx
  on public.sms_purchase_attempts (wallet_debit_id)
  where wallet_debit_id is not null;

create index if not exists sms_purchase_attempts_user_recent_idx
  on public.sms_purchase_attempts (user_id, created_at desc);
