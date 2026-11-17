-- Remove supplier identity from customer-visible transaction labels without changing refund accounting.
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.mj_refund_number_order_wallet_once()'::regprocedure);
  v_def := replace(v_def, 'GotSMS order refund', 'MJ SMS refund');
  v_def := replace(v_def, 'SMS Server 1 refund', 'MJ SMS refund');
  v_def := replace(v_def, 'SMS Server 2 refund', 'MJ SMS refund');
  v_def := replace(v_def, 'SMS Server 3 refund', 'MJ SMS refund');
  v_def := replace(v_def, 'jsonb_build_object(''source'',new.source,''number_order_id'',new.id,''wallet_debit_id'',v_debit.id)',
                           'jsonb_build_object(''number_order_id'',new.id,''wallet_debit_id'',v_debit.id)');
  if position('GotSMS order refund' in v_def) > 0
     or position('SMS Server 1 refund' in v_def) > 0
     or position('SMS Server 2 refund' in v_def) > 0
     or position('SMS Server 3 refund' in v_def) > 0 then
    raise exception 'Could not sanitize SMS refund trigger labels';
  end if;
  execute v_def;

  v_def := pg_get_functiondef('public.smsbus_rent_refund_current_owner(uuid,uuid)'::regprocedure);
  v_def := replace(v_def, 'SMS-BUS rental cancelled — balance restored', 'Rental cancelled — balance restored');
  v_def := replace(v_def, 'Transferred SMS-BUS rental cancelled — balance restored', 'Transferred rental cancelled — balance restored');
  if position('SMS-BUS rental cancelled' in v_def) > 0
     or position('Transferred SMS-BUS rental cancelled' in v_def) > 0 then
    raise exception 'Could not sanitize SMS rental refund labels';
  end if;
  execute v_def;
end $$;

-- Rewrite historical customer-facing labels. Keep amounts, statuses, references,
-- wallet debit links and refund audit records unchanged.
update public.transactions
set title = case
  when title ilike '%gotsms%' and (type = 'refund' or title ilike '%refund%') then 'MJ SMS refund'
  when title ilike '%sms-bus%' and (type = 'refund' or title ilike '%cancel%') then 'Rental refund'
  when title ilike '%sms server 1%' or title ilike '%sms server 2%' or title ilike '%sms server 3%' then 'MJ SMS refund'
  else title
end,
subtitle = case
  when subtitle ilike '%grizzlysms%' then regexp_replace(subtitle, '(?i)\\s*\\(GrizzlySMS\\)', '', 'g')
  when subtitle ilike '%gotsms-renew-%' then 'Rental renewal'
  when subtitle ilike '%order failed at supplier%' then 'Purchase failed. Balance restored.'
  else subtitle
end
where coalesce(title,'') ~* '(gotsms|sms[-_ ]?bus|sms server [123])'
   or coalesce(subtitle,'') ~* '(grizzlysms|gotsms-renew-|order failed at supplier)';

-- Ensure transaction history no longer contains a supplier name in its display labels.
