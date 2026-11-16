-- Repair idempotent booster/Telegram refund retries without issuing a second wallet credit.
create or replace function public.credit_booster_order_refund(p_order_id uuid,p_amount numeric,p_reason text default 'supplier_refund')
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_order public.booster_orders%rowtype; v_debit public.wallet_debits%rowtype;
 v_existing public.booster_refund_credits%rowtype; v_refund_ngn numeric(14,2); v_refund_usd numeric(14,2);
 v_ratio numeric; v_balance numeric; v_balance_usd numeric;
begin
 if p_amount is null or p_amount<=0 then raise exception 'Refund amount must be positive'; end if;
 select * into v_order from public.booster_orders where id=p_order_id for update;
 if not found or v_order.user_id is null then raise exception 'Booster order not found'; end if;
 if p_amount>coalesce(v_order.price_ngn,0) then raise exception 'Refund exceeds original order charge'; end if;
 select * into v_existing from public.booster_refund_credits where order_id=p_order_id for update;
 if found then
  if v_existing.wallet_debit_id is null or v_existing.wallet_debit_id<>v_order.wallet_debit_id then
   raise exception 'Existing booster refund ledger has no matching exact debit; manual review required';
  end if;
  select * into v_debit from public.wallet_debits where id=v_existing.wallet_debit_id and user_id=v_order.user_id for update;
  if not found or round(v_debit.total_ngn,2)<>round(v_order.price_ngn,2) then
   raise exception 'Existing booster refund ledger does not match the original debit; manual review required';
  end if;
  if coalesce(v_existing.amount_ngn,0)>=coalesce(v_order.price_ngn,0) and not v_debit.refunded then
   update public.wallet_debits set refunded=true where id=v_debit.id and user_id=v_order.user_id and refunded=false;
  end if;
  update public.booster_orders set refund_ngn=v_existing.amount_ngn,
   status=case when coalesce(v_existing.amount_ngn,0)>=coalesce(v_order.price_ngn,0) then 'refunded' else 'partially_refunded' end,
   updated_at=now() where id=p_order_id;
  update public.transactions set status='completed',
   subtitle=coalesce(nullif(subtitle,''),'Booster refund reconciled'),
   meta=coalesce(meta,'{}'::jsonb)||jsonb_build_object('wallet_debit_id',v_debit.id,'booster_order_id',p_order_id)
   where user_id=v_order.user_id and external_reference='booster-refund:'||p_order_id::text;
  if not found then
   insert into public.transactions(user_id,customer_id,type,category,title,subtitle,amount,amount_ngn,amount_usd,status,external_reference,meta)
   values(v_order.user_id,v_order.customer_id,'deposit','deposit',
    case when coalesce(v_existing.amount_ngn,0)>=coalesce(v_order.price_ngn,0) then 'Booster order refund' else 'Booster partial refund' end,
    'Existing refund ledger reconciled','₦'||to_char(coalesce(v_existing.amount_ngn,0),'FM999,999,999,990.00'),
    coalesce(v_existing.amount_ngn,0),coalesce(v_existing.amount_usd,0),'completed','booster-refund:'||p_order_id::text,
    jsonb_build_object('source','boosters','booster_order_id',p_order_id,'wallet_debit_id',v_debit.id,'reconciled',true));
  end if;
  select balance,balance_usd into v_balance,v_balance_usd from public.profiles where id=v_order.user_id;
  return jsonb_build_object('credited',false,'already_credited',true,'amount',v_existing.amount_ngn,
   'amount_ngn',v_existing.amount_ngn,'amount_usd',coalesce(v_existing.amount_usd,0),
   'wallet_debit_id',v_existing.wallet_debit_id,'balance',v_balance,'balance_usd',v_balance_usd);
 end if;
 if v_order.wallet_debit_id is null then raise exception 'Original wallet debit ID is missing; manual review required'; end if;
 select * into v_debit from public.wallet_debits where id=v_order.wallet_debit_id and user_id=v_order.user_id for update;
 if not found then raise exception 'Original wallet debit not found'; end if;
 if round(v_debit.total_ngn,2)<>round(v_order.price_ngn,2) then raise exception 'Original wallet debit amount does not match booster order'; end if;
 if v_debit.refunded then raise exception 'Original wallet debit has already been fully refunded'; end if;
 v_ratio:=least(1,p_amount/greatest(coalesce(v_order.price_ngn,0),0.01));
 if p_amount>=v_order.price_ngn then v_refund_ngn:=coalesce(v_debit.ngn_amt,0); v_refund_usd:=coalesce(v_debit.usd_amt,0);
 else v_refund_ngn:=round(coalesce(v_debit.ngn_amt,0)*v_ratio,2); v_refund_usd:=round(coalesce(v_debit.usd_amt,0)*v_ratio,2); end if;
 update public.profiles set balance=coalesce(balance,0)+v_refund_ngn,balance_usd=coalesce(balance_usd,0)+v_refund_usd,updated_at=now()
  where id=v_order.user_id returning balance,balance_usd into v_balance,v_balance_usd;
 if not found then raise exception 'User profile not found'; end if;
 insert into public.booster_refund_credits(order_id,user_id,amount_ngn,amount_usd,wallet_debit_id,reason)
  values(p_order_id,v_order.user_id,v_refund_ngn,v_refund_usd,v_debit.id,p_reason);
 if p_amount>=v_order.price_ngn then
  update public.wallet_debits set refunded=true where id=v_debit.id and user_id=v_order.user_id and refunded=false;
  if not found then raise exception 'Booster debit refund state changed unexpectedly'; end if;
 end if;
 update public.booster_orders set refund_ngn=v_refund_ngn,
  status=case when p_amount>=v_order.price_ngn then 'refunded' else 'partially_refunded' end,updated_at=now() where id=p_order_id;
 insert into public.transactions(user_id,customer_id,type,category,title,subtitle,amount,amount_ngn,amount_usd,status,external_reference,meta)
 values(v_order.user_id,v_order.customer_id,'deposit','deposit',
  case when p_amount>=v_order.price_ngn then 'Booster order refund' else 'Booster partial refund' end,
  left(coalesce(p_reason,'Supplier refund'),180),'₦'||to_char(v_refund_ngn,'FM999,999,999,990.00'),
  v_refund_ngn,v_refund_usd,'completed','booster-refund:'||p_order_id::text,
  jsonb_build_object('source','boosters','booster_order_id',p_order_id,'wallet_debit_id',v_debit.id,'partial',p_amount<v_order.price_ngn));
 return jsonb_build_object('credited',true,'already_credited',false,'amount',p_amount,'amount_ngn',v_refund_ngn,
  'amount_usd',v_refund_usd,'wallet_debit_id',v_debit.id,'balance',v_balance,'balance_usd',v_balance_usd);
end; $$;