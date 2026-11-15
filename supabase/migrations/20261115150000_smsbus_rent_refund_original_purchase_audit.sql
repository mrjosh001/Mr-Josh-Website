-- Keep the original payer's purchase ledger synchronized with a transferred-rental refund.
create or replace function public.smsbus_rent_refund_current_owner(
  p_rental_order_id uuid, p_current_owner_user_id uuid
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
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
  select original_payer_user_id into v_original_payer from public.smsbus_rent_transfers
   where rental_order_id=v_order.id order by transferred_at asc limit 1;
  v_original_payer:=coalesce(v_original_payer,v_order.user_id);
  if v_debit.user_id<>v_original_payer then
    return jsonb_build_object('success',false,'message','Original payer and wallet debit do not match.');
  end if;
  update public.wallet_debits set refunded=true where id=v_debit.id and refunded=false;
  if not found then
    return jsonb_build_object('success',false,'message','Refund was already claimed by another request.');
  end if;
  -- A's purchase record is marked refunded while B receives the wallet credit.
  update public.transactions set status='refunded',
    subtitle='Transferred rental cancelled — refund credited to current owner'
   where user_id=v_debit.user_id and category='MJ SMS' and type='purchase'
     and external_reference=v_debit.id::text;
  insert into public.smsbus_rent_refund_credits (
    rental_order_id,order_id,original_payer_user_id,beneficiary_user_id,wallet_debit_id,amount_ngn,amount_usd
  ) values (
    v_order.id,v_order.order_id,v_debit.user_id,p_current_owner_user_id,v_debit.id,
    coalesce(v_debit.ngn_amt,0),coalesce(v_debit.usd_amt,0)
  ) returning * into v_credit;
  update public.profiles set balance=coalesce(balance,0)+coalesce(v_debit.ngn_amt,0),
    balance_usd=coalesce(balance_usd,0)+coalesce(v_debit.usd_amt,0),updated_at=now()
   where id=p_current_owner_user_id;
  if not found then raise exception 'Current owner wallet profile not found; refund transaction rolled back.'; end if;
  select customer_id into v_customer_id from public.profiles where id=p_current_owner_user_id;
  insert into public.transactions (
    user_id,customer_id,type,category,title,subtitle,amount,amount_ngn,amount_usd,status,external_reference,meta
  ) values (
    p_current_owner_user_id,v_customer_id,'refund','MJ SMS',
    case when p_current_owner_user_id=v_debit.user_id
      then 'SMS-BUS rental cancelled — balance restored'
      else 'Transferred SMS-BUS rental cancelled — balance restored' end,
    coalesce(v_order.phone_number,v_order.order_id),
    concat('₦',to_char(coalesce(v_debit.ngn_amt,0),'FM999,999,999,990.00'),
      case when coalesce(v_debit.usd_amt,0)>0 then concat(' + $',to_char(v_debit.usd_amt,'FM999,999,990.00')) else '' end),
    coalesce(v_debit.ngn_amt,0),coalesce(v_debit.usd_amt,0),'completed',
    'smsbus-rent-refund:'||v_order.id::text,
    jsonb_build_object('rental_order_id',v_order.id,'original_payer_user_id',v_debit.user_id,
      'refund_beneficiary_user_id',p_current_owner_user_id,'wallet_debit_id',v_debit.id)
  );
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
