-- Keep VirtualSMS rentals on their dedicated order-aware atomic refund RPC.
create or replace function public.mj_refund_number_order_wallet_once()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_debit public.wallet_debits%rowtype; v_balance numeric; v_tx_count integer:=0; v_tx_status text; v_title text;
begin
 if coalesce(old.refunded,false)=true or coalesce(new.refunded,false)<>true then return new; end if;
 if new.source in ('smsbus_rent','virtualsms_rent') then return new; end if;
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
   '₦'||to_char(coalesce(v_debit.ngn_amt,0),'FM999,999,999,990.00'),coalesce(v_debit.ngn_amt,0),coalesce(v_debit.usd_amt,0),
   'completed','number-order-refund:'||new.id::text,
   jsonb_build_object('source',new.source,'number_order_id',new.id,'wallet_debit_id',v_debit.id));
 end if;
 return new;
end; $$;