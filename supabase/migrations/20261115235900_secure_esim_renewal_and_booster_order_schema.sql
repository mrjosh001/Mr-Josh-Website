-- Security and schema corrections from the 2026-11-15 production audit.
-- Enforce owner identity for authenticated callers while preserving trusted service-role API calls.
CREATE OR REPLACE FUNCTION public.create_esim_renewal_wallet_order(
  p_user_id uuid,
  p_order_id uuid,
  p_phone_number text,
  p_request_id text,
  p_usd_rate numeric DEFAULT 1450
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
 v_source public.esim_orders%rowtype; v_order public.esim_orders%rowtype;
 v_phone text; v_ngn numeric(14,2); v_usd numeric(14,2);
 v_ngn_debit numeric(14,2):=0; v_usd_debit numeric(14,2):=0;
 v_usd_needed numeric(14,2); v_rate numeric(14,4); v_debit_id bigint; v_ref text;
begin
 if auth.role() = 'authenticated' and auth.uid() is distinct from p_user_id then
   raise exception 'ESIM_RENEWAL_FORBIDDEN';
 end if;
 v_phone:=regexp_replace(coalesce(p_phone_number,''),'[^0-9+]','','g');
 v_rate:=coalesce(nullif(p_usd_rate,0),1450);
 if p_user_id is null or p_order_id is null or p_request_id is null
  or length(trim(p_request_id))<10 or v_phone !~ '^\+?[0-9]{7,20}$' or v_rate<=0
 then raise exception 'INVALID_RENEWAL'; end if;
 select * into v_source from public.esim_orders where id=p_order_id and user_id=p_user_id for update;
 if not found then raise exception 'ESIM_ORDER_NOT_FOUND'; end if;
 if lower(coalesce(v_source.status,'')) not in ('completed','complete','delivered','success','successful')
 then raise exception 'ESIM_ORDER_NOT_RENEWABLE'; end if;
 select * into v_order from public.esim_orders where request_id=p_request_id for update;
 if found then
  if v_order.user_id<>p_user_id then raise exception 'REQUEST_ID_CONFLICT'; end if;
  return jsonb_build_object('success',true,'created',false,'order_id',v_order.id,'order_ref',v_order.order_ref,
   'amount_ngn',v_order.amount_ngn,'phone_number',v_order.phone_number,'status',v_order.status);
 end if;
 select coalesce(balance,0),coalesce(balance_usd,0) into v_ngn,v_usd from public.profiles where id=p_user_id for update;
 if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
 v_ngn_debit:=least(v_ngn,v_source.amount_ngn);
 v_usd_needed:=ceil(greatest(v_source.amount_ngn-v_ngn_debit,0)/v_rate*100)/100;
 if v_usd<v_usd_needed then raise exception 'INSUFFICIENT_WALLET'; end if;
 v_usd_debit:=v_usd_needed;
 update public.profiles set balance=round(v_ngn-v_ngn_debit,2),balance_usd=round(v_usd-v_usd_debit,2),updated_at=now() where id=p_user_id;
 v_ref:='ESIM-R-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,12));
 insert into public.wallet_debits(user_id,total_ngn,ngn_amt,usd_amt,ngn_before,usd_before)
 values(p_user_id,v_source.amount_ngn,v_ngn_debit,v_usd_debit,v_ngn,v_usd) returning id into v_debit_id;
 insert into public.esim_orders(user_id,order_ref,request_id,plan_id,plan_name,amount_ngn,imei,customer_email,
  wallet_ngn_debited,wallet_usd_debited,wallet_debit_id,status,phone_number,renewed_from_order_id)
 values(p_user_id,v_ref,p_request_id,v_source.plan_id,v_source.plan_name,v_source.amount_ngn,v_source.imei,
  v_source.customer_email,v_ngn_debit,v_usd_debit,v_debit_id,'paid',v_phone,v_source.id) returning * into v_order;
 insert into public.transactions(user_id,customer_id,type,category,title,subtitle,amount,status,amount_ngn,amount_usd,
  product_details,external_reference,currency,meta)
 select p_user_id,pr.customer_id,'esim','esim','eSIM Plan Refill — '||v_source.plan_name,'Renewal of '||v_source.order_ref,
  '₦'||to_char(v_source.amount_ngn,'FM999,999,999,990.00'),'completed',v_ngn_debit,v_usd_debit,
  jsonb_build_object('order_ref',v_ref,'renewed_from_order_ref',v_source.order_ref,'plan_id',v_source.plan_id,
   'plan_name',v_source.plan_name,'phone_number',v_phone,'wallet_ngn_debited',v_ngn_debit,
   'wallet_usd_debited',v_usd_debit)::text,v_ref,'NGN',
  jsonb_build_object('source','esim_renewal','wallet_debit_id',v_debit_id,'usd_ngn_rate',v_rate,'renewed_from_order_id',v_source.id)
 from public.profiles pr where pr.id=p_user_id;
 return jsonb_build_object('success',true,'created',true,'order_id',v_order.id,'order_ref',v_order.order_ref,
  'amount_ngn',v_order.amount_ngn,'phone_number',v_phone,'plan_name',v_order.plan_name,
  'renewed_from_order_ref',v_source.order_ref,'wallet_ngn_debited',v_ngn_debit,'wallet_usd_debited',v_usd_debit);
end;
$function$;

REVOKE ALL ON FUNCTION public.create_esim_renewal_wallet_order(uuid,uuid,text,text,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_esim_renewal_wallet_order(uuid,uuid,text,text,numeric) TO service_role;

-- Remove unauthenticated and authenticated access to the account-existence oracle.
REVOKE ALL ON FUNCTION public.email_registered(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_registered(text) TO service_role;

-- api/owlet.js writes this field; the live table previously lacked it.
ALTER TABLE public.booster_orders ADD COLUMN IF NOT EXISTS rate_per_1k numeric;
