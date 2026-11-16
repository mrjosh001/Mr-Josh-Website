-- Prevent generic exact-debit refunds from bypassing service-specific guards.
create or replace function public.refund_wallet_debit(p_user_id uuid,p_wallet_debit_id bigint)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_debit public.wallet_debits%rowtype; v_balance numeric; v_balance_usd numeric;
 v_tx_count integer:=0; v_order_count integer:=0; v_number_count integer:=0;
begin
 select * into v_debit from public.wallet_debits where id=p_wallet_debit_id and user_id=p_user_id for update;
 if not found then return jsonb_build_object('success',false,'message','Wallet debit record not found.'); end if;
 if exists(select 1 from public.booster_orders where wallet_debit_id=p_wallet_debit_id and user_id=p_user_id) then raise exception 'Use the order-specific booster refund function'; end if;
 if exists(select 1 from public.esim_orders where wallet_debit_id=p_wallet_debit_id and user_id=p_user_id) then raise exception 'Use the admin eSIM refund function'; end if;
 if exists(select 1 from public.mj_mail_orders where wallet_debit_id=p_wallet_debit_id and user_id=p_user_id) then raise exception 'Use the order-specific MJ Mails refund function'; end if;
 if exists(select 1 from public.number_orders where wallet_debit_id=p_wallet_debit_id and user_id=p_user_id and source='virtualsms_rent') then raise exception 'Use the order-specific VirtualSMS rental refund function'; end if;
 if exists(select 1 from public.number_orders n join public.smsbus_rent_transfers t on t.rental_order_id=n.id
  where n.wallet_debit_id=p_wallet_debit_id and n.user_id=p_user_id and n.source='smsbus_rent') then
  raise exception 'Transferred SMS-BUS rentals must use the current-owner refund function';
 end if;
 if exists(select 1 from public.orders where wallet_debit_id=p_wallet_debit_id and user_id=p_user_id
  and lower(coalesce(status,'')) in ('completed','delivered','success')) then
  raise exception 'Refund blocked: completed log order cannot be refunded through the automatic failure path';
 end if;
 if exists(select 1 from public.number_orders where wallet_debit_id=p_wallet_debit_id and user_id=p_user_id
  and source not in ('smsbus_rent','virtualsms_rent')
  and (lower(coalesce(status,''))='completed' or nullif(btrim(coalesce(code,'')),'') is not null)) then
  raise exception 'Refund blocked: SMS code has already been received or order is completed';
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
 update public.number_orders set status='refunded',refunded=true,updated_at=now()
  where wallet_debit_id=p_wallet_debit_id and user_id=p_user_id and coalesce(refunded,false)=false
   and source <> 'virtualsms_rent'
   and (source <> 'smsbus_rent' or not exists(select 1 from public.smsbus_rent_transfers t where t.rental_order_id=number_orders.id));
 get diagnostics v_number_count=row_count;
 update public.transactions set status='refunded',subtitle='Cancelled — exact wallet debit restored',
  notes=concat_ws(' | ',nullif(notes,''),'wallet_debit_id:'||p_wallet_debit_id::text)
  where user_id=p_user_id and type in ('purchase','log','purchase_failed')
   and (external_reference=p_wallet_debit_id::text or meta->>'wallet_debit_id'=p_wallet_debit_id::text);
 get diagnostics v_tx_count=row_count;
 if v_tx_count=0 and not exists(
  select 1 from public.transactions t where t.user_id=p_user_id and (
   t.external_reference='wallet-debit-refund:'||p_wallet_debit_id::text
   or t.external_reference in (select 'number-order-refund:'||n.id::text from public.number_orders n where n.wallet_debit_id=p_wallet_debit_id)
  )
 ) then
  insert into public.transactions(user_id,type,category,title,subtitle,amount,amount_ngn,amount_usd,status,external_reference,meta)
  values(p_user_id,'refund','Wallet','Wallet refund','Exact wallet debit restored',
   '₦'||to_char(coalesce(v_debit.ngn_amt,0),'FM999,999,999,990.00'),coalesce(v_debit.ngn_amt,0),coalesce(v_debit.usd_amt,0),
   'completed','wallet-debit-refund:'||p_wallet_debit_id::text,
   jsonb_build_object('wallet_debit_id',p_wallet_debit_id,'source','exact_debit_refund'));
 end if;
 return jsonb_build_object('success',true,'already_refunded',v_debit.refunded,'balance',coalesce(v_balance,0),
  'balance_usd',coalesce(v_balance_usd,0),'amount_ngn',coalesce(v_debit.ngn_amt,0),'amount_usd',coalesce(v_debit.usd_amt,0),
  'wallet_debit_id',v_debit.id,'orders_finalized',v_order_count,'number_orders_finalized',v_number_count);
end; $$;