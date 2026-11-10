-- GotSMS refund hardening: never infer a debit by user/amount/time.
-- A refund must use the exact wallet_debit_id linked to the order.
-- Trigger failure rolls back the order status update and wallet mutation together.

create or replace function public.mj_refund_number_order_wallet_once()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_debit public.wallet_debits%rowtype;
begin
  if coalesce(old.refunded,false) = true or coalesce(new.refunded,false) <> true then
    return new;
  end if;

  if new.source = 'gotsms' and (
       old.status = 'completed'
       or coalesce(old.service_name,'') ~* 'sms[[:space:]]*received'
       or coalesce(old.notes,'') ~ '"inbox"[[:space:]]*:[[:space:]]*\[[[:space:]]*\{'
  ) then
    raise exception 'GotSMS order has received an SMS or is completed; refund blocked';
  end if;

  if new.wallet_debit_id is null then
    raise exception 'Refund blocked: order has no linked wallet debit';
  end if;

  select * into v_debit
  from public.wallet_debits
  where id = new.wallet_debit_id
    and user_id = new.user_id
    and total_ngn = new.price
    and refunded = false
  for update;

  if not found then
    raise exception 'Refund blocked: exact linked wallet debit is missing, mismatched, or already refunded';
  end if;

  update public.wallet_debits
  set refunded = true
  where id = v_debit.id and user_id = new.user_id and refunded = false;

  if not found then
    raise exception 'Refund blocked: linked debit was already refunded';
  end if;

  update public.profiles
  set balance = coalesce(balance,0) + coalesce(v_debit.ngn_amt,0),
      balance_usd = coalesce(balance_usd,0) + coalesce(v_debit.usd_amt,0),
      updated_at = now()
  where id = new.user_id;

  if not found then
    raise exception 'Refund blocked: wallet profile not found';
  end if;

  if new.source = 'gotsms' then
    insert into public.transactions (
      user_id, customer_id, type, category, title, subtitle,
      amount, amount_ngn, status, external_reference
    )
    values (
      new.user_id, new.customer_id, 'refund', 'MJ SMS',
      'USA rental cancelled', 'Balance restored',
      '₦' || to_char(v_debit.ngn_amt, 'FM999,999,999,990.00'),
      v_debit.ngn_amt, 'refunded', coalesce(new.order_id, new.idempotency_key)
    );
  end if;

  return new;
end;
$$;
