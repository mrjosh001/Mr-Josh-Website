-- Keep MJ Mails refunds atomic and reject any refund after a message/code has arrived.
-- Supplier confirmation is performed by the trusted server handler before it calls this RPC.
create or replace function public.mj_mail_refund_purchase(
  p_order_id uuid,
  p_user_id uuid,
  p_reason text default 'supplier_cancelled'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.mj_mail_orders%rowtype;
  v_debit public.wallet_debits%rowtype;
  v_balance numeric;
begin
  -- Serialize all refund attempts for this order. The first committed refund wins.
  select * into v_order
  from public.mj_mail_orders
  where id = p_order_id and user_id = p_user_id
  for update;

  if not found then
    raise exception 'MAIL_ORDER_NOT_FOUND';
  end if;

  if v_order.refunded then
    select balance into v_balance from public.profiles where id = p_user_id;
    return jsonb_build_object('refunded', false, 'already_refunded', true, 'balance', v_balance);
  end if;

  -- A message/code is a hard stop, regardless of a stale supplier status.
  if nullif(btrim(coalesce(v_order.message, '')), '') is not null
     or nullif(btrim(coalesce(v_order.value, '')), '') is not null
     or v_order.status in ('message_received', 'completed') then
    raise exception 'MAIL_ALREADY_DELIVERED';
  end if;

  -- Provider rejection can refund while still creating. Other paths must first
  -- be moved to a supplier-confirmed/undelivered refund state by the API.
  if v_order.status not in (
    'creating', 'failed', 'reconciliation_required',
    'cancel_pending_refund', 'cancelled', 'refunded'
  ) then
    raise exception 'MAIL_REFUND_NOT_CONFIRMED';
  end if;

  if v_order.wallet_debit_id is null then
    raise exception 'MAIL_WALLET_DEBIT_NOT_FOUND';
  end if;

  select * into v_debit
  from public.wallet_debits
  where id = v_order.wallet_debit_id and user_id = p_user_id
  for update;

  if not found or v_debit.refunded then
    raise exception 'MAIL_DEBIT_ALREADY_REVERSED';
  end if;

  -- These writes commit or roll back together: debit reversal, exact original
  -- NGN/USD wallet credit, order state and refund transaction ledger entry.
  update public.wallet_debits
  set refunded = true
  where id = v_debit.id and not refunded;

  if not found then
    raise exception 'MAIL_DEBIT_ALREADY_REVERSED';
  end if;

  update public.profiles
  set balance = coalesce(balance, 0) + coalesce(v_debit.ngn_amt, 0),
      balance_usd = coalesce(balance_usd, 0) + coalesce(v_debit.usd_amt, 0),
      updated_at = now()
  where id = p_user_id
  returning balance into v_balance;

  if not found then
    raise exception 'PROFILE_NOT_FOUND';
  end if;

  update public.mj_mail_orders
  set refunded = true, status = 'refunded', updated_at = now()
  where id = p_order_id and user_id = p_user_id;

  insert into public.transactions(
    user_id, type, category, title, subtitle, amount, status,
    amount_ngn, amount_usd, currency, external_reference, meta
  ) values (
    p_user_id, 'deposit', 'deposit', 'MJ Mails Refund',
    left(coalesce(p_reason, 'Supplier cancellation'), 180),
    '₦' || to_char(v_order.retail_price_ngn, 'FM999,999,999,990.00'),
    'completed', v_order.retail_price_ngn, v_debit.usd_amt, 'NGN',
    'MJMAIL-REFUND-' || p_order_id::text,
    jsonb_build_object('source', 'mj_mails', 'mail_order_id', p_order_id)
  );

  return jsonb_build_object(
    'refunded', true, 'already_refunded', false, 'balance', v_balance,
    'ngn_refunded', coalesce(v_debit.ngn_amt, 0),
    'usd_refunded', coalesce(v_debit.usd_amt, 0)
  );
end;
$$;

revoke all on function public.mj_mail_refund_purchase(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.mj_mail_refund_purchase(uuid, uuid, text) to service_role;
