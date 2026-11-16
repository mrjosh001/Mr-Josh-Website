-- Atomic eSIM admin refund before QR delivery/refill completion.
create or replace function public.refund_esim_order_admin(p_order_id uuid,p_reason text default 'admin_refund_before_delivery')
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_order public.esim_orders%rowtype; v_debit public.wallet_debits%rowtype;
 v_balance numeric; v_balance_usd numeric; v_tx_count integer:=0;
begin
 select * into v_order from public.esim_orders where id=p_order_id for update;
 if not found then raise exception 'ESIM_ORDER_NOT_FOUND'; end if;
 if lower(coalesce(v_order.status,''))='completed' or v_order.refill_completed_at is not null then raise exception 'ESIM_ALREADY_DELIVERED'; end if;
 if v_order.wallet_debit_id is null then raise exception 'ESIM_DEBIT_MISSING'; end if;
 select * into v_debit from public.wallet_debits where id=v_order.wallet_debit_id and user_id=v_order.user_id
  and round(total_ngn,2)=round(v_order.amount_ngn,2) for update;
 if not found then raise exception 'ESIM_DEBIT_MISMATCH'; end if;
 if not v_debit.refunded then
  update public.wallet_debits set refunded=true where id=v_debit.id and user_id=v_order.user_id and refunded=false;
  if not found then raise exception 'ESIM_REFUND_RACE'; end if;
  update public.profiles set balance=coalesce(balance,0)+coalesce(v_debit.ngn_amt,0),
   balance_usd=coalesce(balance_usd,0)+coalesce(v_debit.usd_amt,0),updated_at=now()
   where id=v_order.user_id returning balance,balance_usd into v_balance,v_balance_usd;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
 else
  select balance,balance_usd into v_balance,v_balance_usd from public.profiles where id=v_order.user_id;
 end if;
 update public.esim_orders set status='refunded' where id=v_order.id and user_id=v_order.user_id;
 update public.transactions set status='refunded',subtitle='eSIM order refunded before delivery',
  notes=concat_ws(' | ',nullif(notes,''),'wallet_debit_id:'||v_debit.id::text,'esim_order_id:'||v_order.id::text)
  where user_id=v_order.user_id and type='esim'
   and (external_reference=v_order.order_ref or meta->>'wallet_debit_id'=v_debit.id::text);
 get diagnostics v_tx_count=row_count;
 if v_tx_count=0 and not exists(select 1 from public.transactions where user_id=v_order.user_id and external_reference='esim-refund:'||v_order.id::text) then
  insert into public.transactions(user_id,type,category,title,subtitle,amount,status,amount_ngn,amount_usd,external_reference,meta)
  values(v_order.user_id,'refund','eSIM','eSIM order refund',left(coalesce(p_reason,'Admin refund before delivery'),180),
   '₦'||to_char(coalesce(v_debit.ngn_amt,0),'FM999,999,999,990.00'),'completed',
   coalesce(v_debit.ngn_amt,0),coalesce(v_debit.usd_amt,0),'esim-refund:'||v_order.id::text,
   jsonb_build_object('source','esim','esim_order_id',v_order.id,'order_ref',v_order.order_ref,'wallet_debit_id',v_debit.id));
 end if;
 return jsonb_build_object('success',true,'already_refunded',v_debit.refunded,'amount_ngn',coalesce(v_debit.ngn_amt,0),
  'amount_usd',coalesce(v_debit.usd_amt,0),'balance',coalesce(v_balance,0),'balance_usd',coalesce(v_balance_usd,0),'wallet_debit_id',v_debit.id);
end; $$;
revoke all on function public.refund_esim_order_admin(uuid,text) from public,anon,authenticated;
grant execute on function public.refund_esim_order_admin(uuid,text) to service_role;
