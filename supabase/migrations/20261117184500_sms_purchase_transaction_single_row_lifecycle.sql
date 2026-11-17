-- Enforce one purchase-history row per SMS order/rental.
-- Refunds update the original purchase row. A transferred rental may still
-- create a separate credit entry for the new owner, who was not the original payer.

create or replace function public.mj_refund_number_order_wallet_once()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_debit public.wallet_debits%rowtype;
  v_balance numeric;
  v_tx_count integer := 0;
  v_tx_status text;
  v_title text;
begin
  if coalesce(old.refunded,false)=true or coalesce(new.refunded,false)<>true then return new; end if;
  -- Rentals use dedicated ownership-aware refund RPCs. Never refund them here.
  if new.source in ('smsbus_rent','virtualsms_rent') then return new; end if;
  if coalesce(new.price,0)<=0 then return new; end if;
  if new.source='gotsms' and (old.status='completed'
    or coalesce(old.service_name,'') ~* 'sms[[:space:]]*received'
    or coalesce(old.notes,'') ~ '"inbox"[[:space:]]*:[[:space:]]*\\[[[:space:]]*\\{') then
    raise exception 'GotSMS order has received an SMS or is completed; refund blocked';
  end if;
  if new.wallet_debit_id is null then raise exception 'Refund blocked: order has no linked wallet debit'; end if;
  select * into v_debit from public.wallet_debits
   where id=new.wallet_debit_id and user_id=new.user_id
     and round(total_ngn,2)=round(new.price,2) for update;
  if not found then raise exception 'Refund blocked: exact linked wallet debit is missing or mismatched'; end if;

  if not v_debit.refunded then
    update public.wallet_debits set refunded=true
     where id=v_debit.id and user_id=new.user_id and refunded=false;
    if not found then raise exception 'Refund blocked: linked debit refund state changed unexpectedly'; end if;
    update public.profiles
       set balance=coalesce(balance,0)+coalesce(v_debit.ngn_amt,0),
           balance_usd=coalesce(balance_usd,0)+coalesce(v_debit.usd_amt,0),
           updated_at=now()
     where id=new.user_id returning balance into v_balance;
    if not found then raise exception 'Refund blocked: wallet profile not found'; end if;
  else
    select coalesce(balance,0) into v_balance from public.profiles where id=new.user_id;
  end if;

  v_tx_status := case when lower(coalesce(new.status,''))='expired' then 'expired' else 'refunded' end;
  v_title := case
    when new.source='gotsms' then 'USA rental'
    when new.source='hero' then 'SMS purchase'
    when new.source='grizzly' then 'SMS purchase'
    when new.source='virtualsms' then 'SMS purchase'
    else 'SMS purchase'
  end;

  update public.transactions
     set status=v_tx_status,
         subtitle='Cancelled — exact wallet debit restored',
         notes=concat_ws(' | ',nullif(notes,''),'wallet_debit_id:'||v_debit.id::text,'number_order_id:'||new.id::text)
   where user_id=new.user_id and type='purchase' and category='MJ SMS'
     and (
       external_reference=v_debit.id::text
       or meta->>'wallet_debit_id'=v_debit.id::text
       or (new.source='gotsms' and external_reference=regexp_replace(coalesce(new.idempotency_key,''),'^gotsms-',''))
     );
  get diagnostics v_tx_count=row_count;

  if v_tx_count=0 then
    insert into public.transactions(
      user_id,customer_id,type,category,title,subtitle,amount,amount_ngn,amount_usd,status,external_reference,meta
    ) values (
      new.user_id,new.customer_id,'purchase','MJ SMS',v_title,
      'Cancelled — exact wallet debit restored',
      '₦'||to_char(coalesce(v_debit.ngn_amt,0),'FM999,999,999,990.00'),
      coalesce(v_debit.ngn_amt,0),coalesce(v_debit.usd_amt,0),v_tx_status,
      v_debit.id::text,
      jsonb_build_object('source',new.source,'number_order_id',new.id,'wallet_debit_id',v_debit.id)
    );
  end if;
  return new;
end;
$$;

create or replace function public.refund_virtualsms_rental_order(
  p_order_id uuid, p_user_id uuid, p_reason text default 'supplier_cancelled'
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_order public.number_orders%rowtype;
  v_debit public.wallet_debits%rowtype;
  v_balance numeric;
  v_balance_usd numeric;
  v_pending_ref text;
begin
  select * into v_order from public.number_orders
   where id=p_order_id and user_id=p_user_id and source='virtualsms_rent' for update;
  if not found then raise exception 'VIRTUALSMS_RENTAL_NOT_FOUND'; end if;
  if v_order.wallet_debit_id is null or coalesce(v_order.price,0)<=0 then
    raise exception 'VIRTUALSMS_RENTAL_DEBIT_MISSING';
  end if;
  select * into v_debit from public.wallet_debits
   where id=v_order.wallet_debit_id and user_id=p_user_id
     and round(total_ngn,2)=round(v_order.price,2) for update;
  if not found then raise exception 'VIRTUALSMS_RENTAL_DEBIT_MISMATCH'; end if;

  if not v_debit.refunded then
    update public.wallet_debits set refunded=true
     where id=v_debit.id and user_id=p_user_id and refunded=false;
    if not found then raise exception 'VIRTUALSMS_RENTAL_REFUND_RACE'; end if;
    update public.profiles
       set balance=coalesce(balance,0)+coalesce(v_debit.ngn_amt,0),
           balance_usd=coalesce(balance_usd,0)+coalesce(v_debit.usd_amt,0),updated_at=now()
     where id=p_user_id returning balance,balance_usd into v_balance,v_balance_usd;
    if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
  else
    select balance,balance_usd into v_balance,v_balance_usd from public.profiles where id=p_user_id;
  end if;

  v_pending_ref := case
    when v_order.idempotency_key like 'virtualsms_rent_req:%'
    then 'PENDING-'||substring(v_order.idempotency_key from length('virtualsms_rent_req:')+1)
    else null
  end;

  update public.number_orders set status='refunded',refunded=true,updated_at=now()
   where id=v_order.id and user_id=p_user_id;

  update public.transactions
     set status='refunded',
         subtitle='VirtualSMS rental cancelled — balance restored',
         notes=concat_ws(' | ',nullif(notes,''),'wallet_debit_id:'||v_debit.id::text,'number_order_id:'||v_order.id::text)
   where user_id=p_user_id and type='purchase' and category='MJ SMS'
     and (external_reference=v_debit.id::text or external_reference=v_order.order_id
       or (v_pending_ref is not null and external_reference=v_pending_ref)
       or meta->>'wallet_debit_id'=v_debit.id::text);

  if not found then
    insert into public.transactions(
      user_id,customer_id,type,category,title,subtitle,amount,amount_ngn,amount_usd,status,external_reference,meta
    ) values (
      p_user_id,v_order.customer_id,'purchase','MJ SMS',
      'VirtualSMS rental','Rental cancelled — balance restored',
      '₦'||to_char(coalesce(v_debit.ngn_amt,0),'FM999,999,999,990.00'),
      coalesce(v_debit.ngn_amt,0),coalesce(v_debit.usd_amt,0),'refunded',v_debit.id::text,
      jsonb_build_object('source','virtualsms_rent','number_order_id',v_order.id,'wallet_debit_id',v_debit.id)
    );
  end if;

  return jsonb_build_object(
    'success',true,'already_refunded',v_debit.refunded,
    'amount_ngn',coalesce(v_debit.ngn_amt,0),'amount_usd',coalesce(v_debit.usd_amt,0),
    'balance',coalesce(v_balance,0),'balance_usd',coalesce(v_balance_usd,0),
    'wallet_debit_id',v_debit.id
  );
end;
$$;
revoke all on function public.refund_virtualsms_rental_order(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.refund_virtualsms_rental_order(uuid,uuid,text) to service_role;

create or replace function public.smsbus_rent_refund_current_owner(
  p_rental_order_id uuid, p_current_owner_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $function$
declare
  v_order public.number_orders%rowtype;
  v_debit public.wallet_debits%rowtype;
  v_original_payer uuid;
  v_customer_id text;
  v_credit public.smsbus_rent_refund_credits%rowtype;
begin
  if p_rental_order_id is null or p_current_owner_user_id is null then
    return jsonb_build_object('success',false,'message','Invalid refund request.');
  end if;
  select * into v_order from public.number_orders
   where id=p_rental_order_id and source='smsbus_rent' for update;
  if not found or v_order.user_id<>p_current_owner_user_id then
    return jsonb_build_object('success',false,'message','Rental not found or no longer belongs to you.');
  end if;
  if coalesce(v_order.refunded,false) then
    select * into v_credit from public.smsbus_rent_refund_credits where rental_order_id=v_order.id;
    if found and v_credit.beneficiary_user_id=p_current_owner_user_id then
      return jsonb_build_object('success',true,'already',true,'ngn_restored',v_credit.amount_ngn,'usd_restored',v_credit.amount_usd);
    end if;
    return jsonb_build_object('success',false,'message','This rental is already refunded.');
  end if;
  if v_order.wallet_debit_id is null or coalesce(v_order.price,0)<=0 then
    return jsonb_build_object('success',false,'message','Original wallet debit cannot be verified.');
  end if;
  select * into v_debit from public.wallet_debits where id=v_order.wallet_debit_id for update;
  if not found or v_debit.refunded or round(v_debit.total_ngn,2)<>round(v_order.price,2) then
    return jsonb_build_object('success',false,'message','Original wallet debit is missing, mismatched or already refunded.');
  end if;
  select original_payer_user_id into v_original_payer
    from public.smsbus_rent_transfers
   where rental_order_id=v_order.id order by transferred_at asc limit 1;
  v_original_payer:=coalesce(v_original_payer,v_order.user_id);
  if v_debit.user_id<>v_original_payer then
    return jsonb_build_object('success',false,'message','Original payer and wallet debit do not match.');
  end if;

  update public.wallet_debits set refunded=true where id=v_debit.id and refunded=false;
  if not found then
    return jsonb_build_object('success',false,'message','Refund was already claimed by another request.');
  end if;

  update public.transactions set status='refunded',
    subtitle='Rental cancelled — balance restored',
    notes=concat_ws(' | ',nullif(notes,''),'refund_beneficiary_user_id:'||p_current_owner_user_id::text)
   where user_id=v_debit.user_id and category='MJ SMS' and type='purchase'
     and external_reference=v_debit.id::text;

  insert into public.smsbus_rent_refund_credits(
    rental_order_id,order_id,original_payer_user_id,beneficiary_user_id,wallet_debit_id,amount_ngn,amount_usd
  ) values (
    v_order.id,v_order.order_id,v_debit.user_id,p_current_owner_user_id,v_debit.id,
    coalesce(v_debit.ngn_amt,0),coalesce(v_debit.usd_amt,0)
  ) returning * into v_credit;

  update public.profiles set balance=coalesce(balance,0)+coalesce(v_debit.ngn_amt,0),
    balance_usd=coalesce(balance_usd,0)+coalesce(v_debit.usd_amt,0),updated_at=now()
   where id=p_current_owner_user_id;
  if not found then raise exception 'Current owner wallet profile not found; refund transaction rolled back.'; end if;

  if p_current_owner_user_id<>v_debit.user_id then
    select customer_id into v_customer_id from public.profiles where id=p_current_owner_user_id;
    insert into public.transactions(
      user_id,customer_id,type,category,title,subtitle,amount,amount_ngn,amount_usd,status,external_reference,meta
    ) values (
      p_current_owner_user_id,v_customer_id,'refund','MJ SMS',
      'Transferred SMS-BUS rental refund','Refund credited to current rental owner',
      '₦'||to_char(coalesce(v_debit.ngn_amt,0),'FM999,999,999,990.00'),
      coalesce(v_debit.ngn_amt,0),coalesce(v_debit.usd_amt,0),'completed',
      'smsbus-rent-refund:'||v_order.id::text,
      jsonb_build_object('rental_order_id',v_order.id,'original_payer_user_id',v_debit.user_id,
        'refund_beneficiary_user_id',p_current_owner_user_id,'wallet_debit_id',v_debit.id)
    );
  end if;

  update public.number_orders set status='refunded',refunded=true,updated_at=now()
   where id=v_order.id and user_id=p_current_owner_user_id and coalesce(refunded,false)=false;
  if not found then raise exception 'Rental refund state changed unexpectedly; refund transaction rolled back.'; end if;

  return jsonb_build_object('success',true,'already',false,
    'ngn_restored',coalesce(v_debit.ngn_amt,0),'usd_restored',coalesce(v_debit.usd_amt,0),
    'beneficiary_user_id',p_current_owner_user_id,'original_payer_user_id',v_debit.user_id);
end;
$function$;
revoke all on function public.smsbus_rent_refund_current_owner(uuid,uuid) from public,anon,authenticated;
grant execute on function public.smsbus_rent_refund_current_owner(uuid,uuid) to service_role;
