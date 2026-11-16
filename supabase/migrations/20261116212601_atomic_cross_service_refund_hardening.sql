-- Atomic refund hardening for number orders, VirtualSMS rentals and boosters.
create or replace function public.mj_refund_number_order_wallet_once()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_debit public.wallet_debits%rowtype; v_balance numeric; v_tx_count integer:=0; v_tx_status text; v_title text;
begin
 if coalesce(old.refunded,false)=true or coalesce(new.refunded,false)<>true then return new; end if;
 if coalesce(new.price,0)<=0 then return new; end if;
 if new.source='gotsms' and (old.status='completed' or coalesce(old.service_name,'') ~* 'sms[[:space:]]*received'
   or coalesce(old.notes,'') ~ '"inbox"[[:space:]]*:[[:space:]]*\[[[:space:]]*\{') then
  raise exception 'GotSMS order has received an SMS or is completed; refund blocked';
 end if;
 if new.wallet_debit_id is null then raise exception 'Refund blocked: order has no linked wallet debit'; end if;
 select * into v_debit from public.wallet_debits where id=new.wallet_debit_id and user_id=new.user_id
  and round(total_ngn,2)=round(new.price,2) for update;
 if not found then raise exception 'Refund blocked: exact linked wallet debit is missing or mismatched'; end if;
 if not v_debit.refunded then
  update public.wallet_debits set refunded=true where id=v_debit.id and user_id=new.user_id and refunded=false;
  if not found then raise exception 'Refund blocked: linked debit refund state changed unexpectedly'; end if;
  update public.profiles set balance=coalesce(balance,0)+coalesce(v_debit.ngn_amt,0),
   balance_usd=coalesce(balance_usd,0)+coalesce(v_debit.usd_amt,0),updated_at=now()
   where id=new.user_id returning balance into v_balance;
  if not found then raise exception 'Refund blocked: wallet profile not found'; end if;
 else
  select coalesce(balance,0) into v_balance from public.profiles where id=new.user_id;
 end if;
 v_tx_status:=case when lower(coalesce(new.status,''))='expired' then 'expired' else 'refunded' end;
 v_title:=case when new.source='gotsms' then 'GotSMS order refund'
  when new.source='hero' then 'SMS Server 1 refund' when new.source='grizzly' then 'SMS Server 2 refund'
  when new.source='virtualsms' then 'SMS Server 3 refund' else 'MJ SMS order refund' end;
 update public.transactions set status=v_tx_status,subtitle='Cancelled — exact wallet debit restored',
  notes=concat_ws(' | ',nullif(notes,''),'wallet_debit_id:'||v_debit.id::text,'number_order_id:'||new.id::text)
  where user_id=new.user_id and type='purchase'
   and (external_reference=v_debit.id::text or meta->>'wallet_debit_id'=v_debit.id::text);
 get diagnostics v_tx_count=row_count;
 if v_tx_count=0 then
  insert into public.transactions(user_id,customer_id,type,category,title,subtitle,amount,amount_ngn,amount_usd,status,external_reference,meta)
  values(new.user_id,new.customer_id,'refund','MJ SMS',v_title,'Cancelled — exact wallet debit restored',
   '₦'||to_char(coalesce(v_debit.ngn_amt,0),'FM999,999,999,990.00'),coalesce(v_debit.ngn_amt,0),
   coalesce(v_debit.usd_amt,0),'completed','number-order-refund:'||new.id::text,
   jsonb_build_object('source',new.source,'number_order_id',new.id,'wallet_debit_id',v_debit.id));
 end if;
 return new;
end; $$;

create or replace function public.refund_virtualsms_rental_order(p_order_id uuid,p_user_id uuid,p_reason text default 'supplier_cancelled')
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_order public.number_orders%rowtype; v_debit public.wallet_debits%rowtype;
 v_balance numeric; v_balance_usd numeric; v_tx_count integer:=0; v_pending_ref text;
begin
 select * into v_order from public.number_orders where id=p_order_id and user_id=p_user_id and source='virtualsms_rent' for update;
 if not found then raise exception 'VIRTUALSMS_RENTAL_NOT_FOUND'; end if;
 if v_order.wallet_debit_id is null or coalesce(v_order.price,0)<=0 then raise exception 'VIRTUALSMS_RENTAL_DEBIT_MISSING'; end if;
 select * into v_debit from public.wallet_debits where id=v_order.wallet_debit_id and user_id=p_user_id
  and round(total_ngn,2)=round(v_order.price,2) for update;
 if not found then raise exception 'VIRTUALSMS_RENTAL_DEBIT_MISMATCH'; end if;
 if not v_debit.refunded then
  update public.wallet_debits set refunded=true where id=v_debit.id and user_id=p_user_id and refunded=false;
  if not found then raise exception 'VIRTUALSMS_RENTAL_REFUND_RACE'; end if;
  update public.profiles set balance=coalesce(balance,0)+coalesce(v_debit.ngn_amt,0),
   balance_usd=coalesce(balance_usd,0)+coalesce(v_debit.usd_amt,0),updated_at=now()
   where id=p_user_id returning balance,balance_usd into v_balance,v_balance_usd;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
 else
  select balance,balance_usd into v_balance,v_balance_usd from public.profiles where id=p_user_id;
 end if;
 v_pending_ref:=case when v_order.idempotency_key like 'virtualsms_rent_req:%'
  then 'PENDING-'||substring(v_order.idempotency_key from length('virtualsms_rent_req:')+1) else null end;
 update public.number_orders set status='refunded',refunded=true,updated_at=now() where id=v_order.id and user_id=p_user_id;
 update public.transactions set status='refunded',subtitle='VirtualSMS rental cancelled — balance restored',
  notes=concat_ws(' | ',nullif(notes,''),'wallet_debit_id:'||v_debit.id::text,'number_order_id:'||v_order.id::text)
  where user_id=p_user_id and type='purchase' and (external_reference=v_debit.id::text or external_reference=v_order.order_id
   or (v_pending_ref is not null and external_reference=v_pending_ref) or meta->>'wallet_debit_id'=v_debit.id::text);
 get diagnostics v_tx_count=row_count;
 if v_tx_count=0 and not exists(select 1 from public.transactions where user_id=p_user_id and external_reference='virtualsms-rent-refund:'||v_order.id::text) then
  insert into public.transactions(user_id,customer_id,type,category,title,subtitle,amount,amount_ngn,amount_usd,status,external_reference,meta)
  values(p_user_id,v_order.customer_id,'refund','MJ SMS','VirtualSMS rental refund',left(coalesce(p_reason,'Supplier cancellation'),180),
   '₦'||to_char(coalesce(v_debit.ngn_amt,0),'FM999,999,999,990.00'),coalesce(v_debit.ngn_amt,0),coalesce(v_debit.usd_amt,0),
   'completed','virtualsms-rent-refund:'||v_order.id::text,
   jsonb_build_object('source','virtualsms_rent','number_order_id',v_order.id,'wallet_debit_id',v_debit.id));
 end if;
 return jsonb_build_object('success',true,'already_refunded',v_debit.refunded,'amount_ngn',coalesce(v_debit.ngn_amt,0),
  'amount_usd',coalesce(v_debit.usd_amt,0),'balance',coalesce(v_balance,0),'balance_usd',coalesce(v_balance_usd,0),'wallet_debit_id',v_debit.id);
end; $$;
revoke all on function public.refund_virtualsms_rental_order(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.refund_virtualsms_rental_order(uuid,uuid,text) to service_role;

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
  status=case when p_amount>=v_order.price_ngn then 'refunded' else 'partially_refunded' end,updated_at=now()
  where id=p_order_id;
 insert into public.transactions(user_id,customer_id,type,category,title,subtitle,amount,amount_ngn,amount_usd,status,external_reference,meta)
 values(v_order.user_id,v_order.customer_id,'deposit','deposit',
  case when p_amount>=v_order.price_ngn then 'Booster order refund' else 'Booster partial refund' end,
  left(coalesce(p_reason,'Supplier refund'),180),'₦'||to_char(v_refund_ngn,'FM999,999,999,990.00'),
  v_refund_ngn,v_refund_usd,'completed','booster-refund:'||p_order_id::text,
  jsonb_build_object('source','boosters','booster_order_id',p_order_id,'wallet_debit_id',v_debit.id,'partial',p_amount<v_order.price_ngn));
 return jsonb_build_object('credited',true,'already_credited',false,'amount',p_amount,'amount_ngn',v_refund_ngn,
  'amount_usd',v_refund_usd,'wallet_debit_id',v_debit.id,'balance',v_balance,'balance_usd',v_balance_usd);
end; $$;
revoke all on function public.credit_booster_order_refund(uuid,numeric,text) from public,anon,authenticated;
grant execute on function public.credit_booster_order_refund(uuid,numeric,text) to service_role;
