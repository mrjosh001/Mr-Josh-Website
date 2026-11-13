alter table public.esim_orders
  add column if not exists refill_completed_at timestamptz,
  add column if not exists refill_completed_by uuid references auth.users(id) on delete set null;

create index if not exists esim_orders_renewal_pending_idx
  on public.esim_orders (created_at desc)
  where renewed_from_order_id is not null and status <> 'completed';
