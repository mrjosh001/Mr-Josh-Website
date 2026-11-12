begin;
alter table public.esim_orders add column if not exists wallet_debit_id bigint;
create index if not exists esim_orders_wallet_debit_id_idx on public.esim_orders(wallet_debit_id);
create or replace function public.create_esim_wallet_order(p_user_id uuid,p_plan_id text,p_plan_name text,p_amount_ngn numeric,p_imei text,p_customer_email text,p_request_id text,p_usd_rate numeric default 1450)
returns jsonb language plpgsql security definer set search_path=public as $function$
declare v_ngn numeric(14,2); v_usd numeric(14,2); v_ngn_debit numeric(14,2):=0; v_usd_debit numeric(14,2):=0; v_usd_needed numeric(14,2); v_order public.esim_orders%rowtype; v_ref text; v_rate constant numeric(14,4):=1450; v_debit_id bigint;
begin
 if p_user_id is null or p_plan_id not in ('1m','3m','6m','12m') or p_amount_ngn is null or p_amount_ngn<=0 or p_imei is null or p_imei !~ '^[0-9]{15}$' or p_customer_email is null or length(trim(p_customer_email))<5 or p_request_id is null or length(trim(p_request_id))<10 then raise exception 'INVALID_ORDER'; end if;
 select * into v_order from public.esim_orders where request_id=p_request_id for update;
 if found then if v_order.user_id<>p_user_id then raise exception 'REQUEST_ID_CONFLICT'; end if;
 return jsonb_build_object('success',true,'created',false,'order_id',v_order.id,'order_ref',v_order.order_ref,'plan_id',v_order.plan_id,'plan_name',v_order.plan_name,'amount_ngn',v_order.amount_ngn,'imei',v_order.imei,'customer_email',v_order.customer_email,'status',v_order.status,'wallet_ngn_debited',v_order.wallet_ngn_debited,'wallet_usd_debited',v_order.wallet_usd_debited,'wallet_debit_id',v_order.wallet_debit_id,'customer_email_sent_at',v_order.customer_email_sent_at,'admin_email_sent_at',v_order.admin_email_sent_at,'created_at',v_order.created_at); end if;
 select coalesce(balance,0),coalesce(balance_usd,0) into v_ngn,v_usd from public.profiles where id=p_user_id for update; if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
 v_ngn_debit:=least(v_ngn,p_amount_ngn); v_usd_needed:=ceil(greatest(p_amount_ngn-v_ngn_debit,0)/v_rate*100)/100; if v_usd<v_usd_needed then raise exception 'INSUFFICIENT_WALLET'; end if; v_usd_debit:=v_usd_needed;
 update public.profiles set balance=round(v_ngn-v_ngn_debit,2),balance_usd=round(v_usd-v_usd_debit,2),updated_at=now() where id=p_user_id;
 v_ref:='ESIM-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,12));
 insert into public.wallet_debits(user_id,total_ngn,ngn_amt,usd_amt,ngn_before,usd_before) values(p_user_id,p_amount_ngn,v_ngn_debit,v_usd_debit,v_ngn,v_usd) returning id into v_debit_id;
 insert into public.esim_orders(user_id,order_ref,request_id,plan_id,plan_name,amount_ngn,imei,customer_email,wallet_ngn_debited,wallet_usd_debited,wallet_debit_id,status)
 values(p_user_id,v_ref,p_request_id,p_plan_id,p_plan_name,p_amount_ngn,p_imei,lower(trim(p_customer_email)),v_ngn_debit,v_usd_debit,v_debit_id,'paid') returning * into v_order;
 insert into public.transactions(user_id,customer_id,type,category,title,subtitle,amount,status,amount_ngn,amount_usd,product_details,external_reference,currency,meta)
 select p_user_id,pr.customer_id,'esim','esim','T-Mobile eSIM — '||p_plan_name,'Order '||v_ref,'₦'||to_char(p_amount_ngn,'FM999,999,999,990.00'),'completed',v_ngn_debit,v_usd_debit,jsonb_build_object('order_ref',v_ref,'plan_id',p_plan_id,'plan_name',p_plan_name,'imei',p_imei,'customer_email',lower(trim(p_customer_email)),'wallet_ngn_debited',v_ngn_debit,'wallet_usd_debited',v_usd_debit)::text,v_ref,'NGN',jsonb_build_object('source','esim_checkout','wallet_debit_id',v_debit_id,'usd_ngn_rate',v_rate) from public.profiles pr where pr.id=p_user_id;
 return jsonb_build_object('success',true,'created',true,'order_id',v_order.id,'order_ref',v_order.order_ref,'plan_id',v_order.plan_id,'plan_name',v_order.plan_name,'amount_ngn',v_order.amount_ngn,'imei',v_order.imei,'customer_email',v_order.customer_email,'status',v_order.status,'wallet_ngn_debited',v_order.wallet_ngn_debited,'wallet_usd_debited',v_order.wallet_usd_debited,'wallet_debit_id',v_order.wallet_debit_id,'customer_email_sent_at',v_order.customer_email_sent_at,'admin_email_sent_at',v_order.admin_email_sent_at,'created_at',v_order.created_at);
end;$function$;
create or replace function public.mj_mail_reserve_purchase(p_user_id uuid,p_request_id uuid,p_site text,p_domain text,p_supplier_cost numeric,p_supplier_currency integer,p_retail_ngn numeric,p_wallet_usd_rate numeric default 1450)
returns jsonb language plpgsql security definer set search_path=public as $function$
declare v_existing public.mj_mail_orders%rowtype; v_ngn numeric; v_usd numeric; v_ngn_debit numeric:=0; v_usd_debit numeric:=0; v_usd_needed numeric; v_debit_id bigint; v_order public.mj_mail_orders%rowtype; v_rate constant numeric:=1450;
begin
 if p_user_id is null or p_request_id is null or length(trim(p_site))=0 or length(trim(p_domain))=0 or p_supplier_cost<=0 or p_retail_ngn<=0 then raise exception 'INVALID_MAIL_PURCHASE'; end if;
 select * into v_existing from public.mj_mail_orders where user_id=p_user_id and request_id=p_request_id for update; if found then return jsonb_build_object('created',false,'order',to_jsonb(v_existing)); end if;
 select coalesce(balance,0),coalesce(balance_usd,0) into v_ngn,v_usd from public.profiles where id=p_user_id for update; if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
 v_ngn_debit:=least(v_ngn,p_retail_ngn); v_usd_needed:=ceil(greatest(p_retail_ngn-v_ngn_debit,0)/v_rate*100)/100; if v_usd<v_usd_needed then raise exception 'INSUFFICIENT_WALLET'; end if; v_usd_debit:=v_usd_needed;
 update public.profiles set balance=round(v_ngn-v_ngn_debit,2),balance_usd=round(v_usd-v_usd_debit,2),updated_at=now() where id=p_user_id;
 insert into public.wallet_debits(user_id,total_ngn,ngn_amt,usd_amt,ngn_before,usd_before) values(p_user_id,p_retail_ngn,v_ngn_debit,v_usd_debit,v_ngn,v_usd) returning id into v_debit_id;
 insert into public.mj_mail_orders(user_id,request_id,site,domain,supplier_cost,supplier_currency,retail_price_ngn,wallet_debit_id,status) values(p_user_id,p_request_id,lower(trim(p_site)),lower(trim(p_domain)),p_supplier_cost,coalesce(p_supplier_currency,840),p_retail_ngn,v_debit_id,'creating') returning * into v_order;
 insert into public.transactions(user_id,customer_id,type,category,title,subtitle,amount,status,amount_ngn,amount_usd,product_details,external_reference,currency,meta) select p_user_id,customer_id,'email','email','MJ Mails',lower(trim(p_site))||' · '||lower(trim(p_domain)),'₦'||to_char(p_retail_ngn,'FM999,999,999,990.00'),'completed',v_ngn_debit,v_usd_debit,jsonb_build_object('mail_order_id',v_order.id,'site',p_site,'domain',p_domain,'supplier_cost',p_supplier_cost,'wallet_ngn_debited',v_ngn_debit,'wallet_usd_debited',v_usd_debit)::text,'MJMAIL-'||v_order.id::text,'NGN',jsonb_build_object('source','mj_mails','wallet_debit_id',v_debit_id,'usd_ngn_rate',v_rate) from public.profiles where id=p_user_id;
 return jsonb_build_object('created',true,'order',to_jsonb(v_order));
end;$function$;
create or replace function public.mj_mail_reserve_reuse(p_user_id uuid,p_source_order_id uuid,p_request_id uuid,p_supplier_cost numeric,p_supplier_currency integer,p_retail_ngn numeric,p_wallet_usd_rate numeric default 1450)
returns jsonb language plpgsql security definer set search_path=public as $function$
declare v_source public.mj_mail_orders%rowtype; v_existing public.mj_mail_orders%rowtype; v_ngn numeric; v_usd numeric; v_ngn_debit numeric:=0; v_usd_debit numeric:=0; v_usd_needed numeric; v_debit_id bigint; v_order public.mj_mail_orders%rowtype; v_rate constant numeric:=1450;
begin
 if p_user_id is null or p_source_order_id is null or p_request_id is null or p_supplier_cost<=0 or p_retail_ngn<=0 then raise exception 'INVALID_MAIL_REUSE'; end if;
 select * into v_existing from public.mj_mail_orders where user_id=p_user_id and request_id=p_request_id for update; if found then return jsonb_build_object('created',false,'order',to_jsonb(v_existing)); end if;
 select * into v_source from public.mj_mail_orders where id=p_source_order_id and user_id=p_user_id for update; if not found then raise exception 'MAIL_ORDER_NOT_FOUND'; end if;
 if v_source.reuse_claimed_at is not null then raise exception 'MAIL_ALREADY_REUSED'; end if;
 if v_source.refunded or v_source.supplier_id is null or v_source.status not in ('message_received','completed') or (nullif(trim(coalesce(v_source.message,'')),'') is null and nullif(trim(coalesce(v_source.value,'')),'') is null) then raise exception 'MAIL_NOT_ELIGIBLE_FOR_REUSE'; end if;
 update public.mj_mail_orders set reuse_claimed_at=now(),updated_at=now() where id=v_source.id and user_id=p_user_id and reuse_claimed_at is null; if not found then raise exception 'MAIL_ALREADY_REUSED'; end if;
 select coalesce(balance,0),coalesce(balance_usd,0) into v_ngn,v_usd from public.profiles where id=p_user_id for update; if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
 v_ngn_debit:=least(v_ngn,p_retail_ngn); v_usd_needed:=ceil(greatest(p_retail_ngn-v_ngn_debit,0)/v_rate*100)/100; if v_usd<v_usd_needed then raise exception 'INSUFFICIENT_WALLET'; end if; v_usd_debit:=v_usd_needed;
 update public.profiles set balance=round(v_ngn-v_ngn_debit,2),balance_usd=round(v_usd-v_usd_debit,2),updated_at=now() where id=p_user_id;
 insert into public.wallet_debits(user_id,total_ngn,ngn_amt,usd_amt,ngn_before,usd_before) values(p_user_id,p_retail_ngn,v_ngn_debit,v_usd_debit,v_ngn,v_usd) returning id into v_debit_id;
 insert into public.mj_mail_orders(user_id,request_id,site,domain,email_address,supplier_cost,supplier_currency,retail_price_ngn,wallet_debit_id,status,reused_from_order_id) values(p_user_id,p_request_id,v_source.site,v_source.domain,v_source.email_address,p_supplier_cost,coalesce(p_supplier_currency,840),p_retail_ngn,v_debit_id,'creating',v_source.id) returning * into v_order;
 insert into public.transactions(user_id,customer_id,type,category,title,subtitle,amount,status,amount_ngn,amount_usd,product_details,external_reference,currency,meta) select p_user_id,customer_id,'email','email','MJ Mails · Reuse',lower(v_source.site)||' · '||lower(v_source.domain),'₦'||to_char(p_retail_ngn,'FM999,999,999,990.00'),'completed',v_ngn_debit,v_usd_debit,jsonb_build_object('mail_order_id',v_order.id,'reused_from_order_id',v_source.id,'email',v_source.email_address,'supplier_cost',p_supplier_cost,'wallet_ngn_debited',v_ngn_debit,'wallet_usd_debited',v_usd_debit)::text,'MJMAIL-'||v_order.id::text,'NGN',jsonb_build_object('source','mj_mails','wallet_debit_id',v_debit_id,'usd_ngn_rate',v_rate) from public.profiles where id=p_user_id;
 return jsonb_build_object('created',true,'order',to_jsonb(v_order));
end;$function$;
alter table public.booster_refund_credits add column if not exists amount_usd numeric not null default 0;
alter table public.booster_refund_credits add column if not exists wallet_debit_id bigint;

create or replace function public.credit_booster_order_refund(
 p_order_id uuid,
 p_amount numeric,
 p_reason text default 'supplier_refund'
) returns jsonb
language plpgsql security definer set search_path=public
as $function$
declare
 v_user uuid;
 v_price numeric;
 v_debit_id bigint;
 v_debit public.wallet_debits%rowtype;
 v_existing public.booster_refund_credits%rowtype;
 v_refund_ngn numeric(14,2);
 v_refund_usd numeric(14,2);
 v_ratio numeric;
 v_balance numeric;
 v_balance_usd numeric;
begin
 if p_amount is null or p_amount<=0 then raise exception 'Refund amount must be positive'; end if;
 select user_id,price_ngn,wallet_debit_id into v_user,v_price,v_debit_id
 from public.booster_orders where id=p_order_id for update;
 if v_user is null then raise exception 'Booster order not found'; end if;
 if p_amount>coalesce(v_price,0) then raise exception 'Refund exceeds original order charge'; end if;
 select * into v_existing from public.booster_refund_credits where order_id=p_order_id for update;
 if found then
  select balance,balance_usd into v_balance,v_balance_usd from public.profiles where id=v_user;
  return jsonb_build_object('credited',false,'already_credited',true,
   'amount',v_existing.amount_ngn,'amount_ngn',v_existing.amount_ngn,
   'amount_usd',coalesce(v_existing.amount_usd,0),'wallet_debit_id',v_existing.wallet_debit_id,
   'balance',v_balance,'balance_usd',v_balance_usd);
 end if;
 if v_debit_id is not null then
  select * into v_debit from public.wallet_debits where id=v_debit_id and user_id=v_user for update;
  if not found then raise exception 'Original wallet debit not found'; end if;
  if v_debit.refunded then raise exception 'Original wallet debit has already been fully refunded'; end if;
  v_ratio:=least(1,p_amount/greatest(coalesce(v_price,0),0.01));
  if p_amount>=v_price then
   v_refund_ngn:=coalesce(v_debit.ngn_amt,0);
   v_refund_usd:=coalesce(v_debit.usd_amt,0);
  else
   v_refund_ngn:=round(coalesce(v_debit.ngn_amt,0)*v_ratio,2);
   v_refund_usd:=round(coalesce(v_debit.usd_amt,0)*v_ratio,2);
  end if;
 else
  v_refund_ngn:=p_amount;
  v_refund_usd:=0;
 end if;
 update public.profiles
 set balance=coalesce(balance,0)+v_refund_ngn,
     balance_usd=coalesce(balance_usd,0)+v_refund_usd,updated_at=now()
 where id=v_user returning balance,balance_usd into v_balance,v_balance_usd;
 if not found then raise exception 'User profile not found'; end if;
 insert into public.booster_refund_credits(order_id,user_id,amount_ngn,amount_usd,wallet_debit_id,reason)
 values(p_order_id,v_user,p_amount,v_refund_usd,v_debit_id,p_reason);
 if v_debit_id is not null and p_amount>=v_price then
  update public.wallet_debits set refunded=true where id=v_debit_id and user_id=v_user and refunded=false;
 end if;
 return jsonb_build_object('credited',true,'already_credited',false,
  'amount',p_amount,'amount_ngn',v_refund_ngn,'amount_usd',v_refund_usd,
  'wallet_debit_id',v_debit_id,'balance',v_balance,'balance_usd',v_balance_usd);
end;
$function$;
create or replace function public.mj_mail_refund_purchase(
 p_order_id uuid,p_user_id uuid,p_reason text default 'supplier_cancelled'
) returns jsonb language plpgsql security definer set search_path=public as $function$
declare
 v_order public.mj_mail_orders%rowtype; v_debit public.wallet_debits%rowtype;
 v_balance numeric; v_balance_usd numeric;
begin
 select * into v_order from public.mj_mail_orders where id=p_order_id and user_id=p_user_id for update;
 if not found then raise exception 'MAIL_ORDER_NOT_FOUND'; end if;
 if v_order.refunded then
  select balance,balance_usd into v_balance,v_balance_usd from public.profiles where id=p_user_id;
  return jsonb_build_object('refunded',false,'already_refunded',true,'balance',v_balance,'balance_usd',v_balance_usd);
 end if;
 if nullif(btrim(coalesce(v_order.message,'')),'') is not null
  or nullif(btrim(coalesce(v_order.value,'')),'') is not null
  or v_order.status in ('message_received','completed') then raise exception 'MAIL_ALREADY_DELIVERED'; end if;
 if v_order.status not in ('creating','failed','reconciliation_required','cancel_pending_refund','cancelled','refunded') then raise exception 'MAIL_REFUND_NOT_CONFIRMED'; end if;
 if v_order.wallet_debit_id is null then raise exception 'MAIL_WALLET_DEBIT_NOT_FOUND'; end if;
 select * into v_debit from public.wallet_debits where id=v_order.wallet_debit_id and user_id=p_user_id for update;
 if not found or v_debit.refunded then raise exception 'MAIL_DEBIT_ALREADY_REVERSED'; end if;
 update public.wallet_debits set refunded=true where id=v_debit.id and not refunded;
 if not found then raise exception 'MAIL_DEBIT_ALREADY_REVERSED'; end if;
 update public.profiles set balance=coalesce(balance,0)+coalesce(v_debit.ngn_amt,0),
  balance_usd=coalesce(balance_usd,0)+coalesce(v_debit.usd_amt,0),updated_at=now()
 where id=p_user_id returning balance,balance_usd into v_balance,v_balance_usd;
 if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
 update public.mj_mail_orders set refunded=true,status='refunded',updated_at=now() where id=p_order_id and user_id=p_user_id;
 insert into public.transactions(user_id,type,category,title,subtitle,amount,status,amount_ngn,amount_usd,currency,external_reference,meta)
 values(p_user_id,'deposit','deposit','MJ Mails Refund',left(coalesce(p_reason,'Supplier cancellation'),180),
  '₦'||to_char(v_order.retail_price_ngn,'FM999,999,999,990.00'),'completed',
  coalesce(v_debit.ngn_amt,0),coalesce(v_debit.usd_amt,0),'NGN','MJMAIL-REFUND-'||p_order_id::text,
  jsonb_build_object('source','mj_mails','mail_order_id',p_order_id,'wallet_debit_id',v_debit.id));
 return jsonb_build_object('refunded',true,'already_refunded',false,'balance',v_balance,'balance_usd',v_balance_usd,
  'ngn_refunded',coalesce(v_debit.ngn_amt,0),'usd_refunded',coalesce(v_debit.usd_amt,0),'wallet_debit_id',v_debit.id);
end;$function$;
commit;