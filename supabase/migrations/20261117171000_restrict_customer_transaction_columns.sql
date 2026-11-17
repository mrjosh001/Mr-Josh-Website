-- Restrict customer access to an explicit transaction-history projection.
-- RLS continues to enforce row ownership; column grants prevent direct reads of
-- supplier_order, product_details, meta, notes, payment internals and references.
revoke select on table public.transactions from anon, authenticated;
grant select (
  id,
  user_id,
  category,
  title,
  subtitle,
  amount,
  status,
  created_at,
  type,
  amount_ngn
) on table public.transactions to authenticated;
