-- Exact-debit refunds now finalize log order and transaction records in the same DB transaction.
create or replace function public.refund_wallet_debit(p_user_id uuid,p_wallet_debit_id bigint)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_debit public.wallet_debits%rowtype; v_balance numeric; v_balance_usd numeric; v_tx_count integer:=0; v_order_count integer:=0;
begin
 select * into v_debit from public.wallet_debits where id=p_wallet_debit_id and user_id=p_user_id for update;
 if not found then return jsonb_build_object('success',false,'message','Wallet debit record not found.'); end if;
 if exists(select 1 from public.orders where wallet_debit_id=p_wallet_debit_id and user_id=p_user_id
  and lower(coalesce(status,'')) in ('completed','delivered','success')) then
  raise exception 'Refund blocked: completed log order cannot be refunded through the automatic failure path';
 end if;
 if not v_debit.refunded then
  update public.profiles set balance=coalesce(balance,0)+coalesce(v_debit.ngn_amt,0),
   balance_usd=coalesce(balance_usd,0)+coalesce(v_debit.usd_amt,0),updated_at=now()
   where id=p_user_id returning balance,balance_usd into v_balance,v_balance_usd;
  if not found then raise exception 'Wallet profile not found for refund.'; end if;
  update public.wallet_debits set refunded=true where id=p_wallet_debit_id and user_id=p_user_id and refunded=false;
  if not found then raise exception 'Wallet debit refund state changed unexpectedly.'; end if;
 else
  select balance,balance_usd into v_balance,v_balance_usd from public.profiles where id=p_user_id;
 end if;
 update public.orders set status='refunded' where wallet_debit_id=p_wallet_debit_id and user_id=p_user_id
  and lower(coalesce(status,'')) not in ('completed','delivered','success','refunded');
 get diagnostics v_order_count=row_count;
 update public.transactions set status='refunded',subtitle='Cancelled — exact wallet debit restored',
  notes=concat_ws(' | ',nullif(notes,''),'wallet_debit_id:'||p_wallet_debit_id::text)
  where user_id=p_user_id and type in ('purchase','log','purchase_failed')
   and (external_reference=p_wallet_debit_id::text or meta->>'wallet_debit_id'=p_wallet_debit_id::text);
 get diagnostics v_tx_count=row_count;
 if v_tx_count=0 and not exists(select 1 from public.transactions where user_id=p_user_id and external_reference='wallet-debit-refund:'||p_wallet_debit_id::text) then
  insert into public.transactions(user_id,type,category,title,subtitle,amount,amount_ngn,amount_usd,status,external_reference,meta)
  values(p_user_id,'refund','Wallet','Wallet refund','Exact wallet debit restored',
   '₦'||to_char(coalesce(v_debit.ngn_amt,0),'FM999,999,999,990.00'),coalesce(v_debit.ngn_amt,0),coalesce(v_debit.usd_amt,0),
   'completed','wallet-debit-refund:'||p_wallet_debit_id::text,
   jsonb_build_object('wallet_debit_id',p_wallet_debit_id,'source','exact_debit_refund'));
 end if;
 return jsonb_build_object('success',true,'already_refunded',v_debit.refunded,'balance',coalesce(v_balance,0),
  'balance_usd',coalesce(v_balance_usd,0),'amount_ngn',coalesce(v_debit.ngn_amt,0),'amount_usd',coalesce(v_debit.usd_amt,0),
  'wallet_debit_id',v_debit.id,'orders_finalized',v_order_count);
end; $$;