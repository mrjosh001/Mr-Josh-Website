alter table public.mj_mail_orders
  add column if not exists supplier_date timestamptz;
comment on column public.mj_mail_orders.supplier_date is
  'Purchase timestamp returned by HeroSMS; used as the source of truth for the two-minute cancellation deadline.';
