-- Keep one purchase transaction for each SMS rental lifecycle.
-- Rental codes are repeatable events: the rental remains active until its stored expiry.
create or replace function public.mj_complete_expired_sms_rentals()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_order public.number_orders%rowtype;
  v_reference text;
  v_completed integer := 0;
begin
  for v_order in
    select *
      from public.number_orders
     where source in ('gotsms', 'smsbus_rent', 'virtualsms_rent')
       and coalesce(refunded, false) = false
       and lower(coalesce(status, '')) in ('active', 'pending', 'waiting', 'processing')
       and code ~ '^\\d{4}-\\d{2}-\\d{2}T'
       and code::timestamptz <= now()
     order by created_at
     limit 500
     for update skip locked
  loop
    update public.number_orders
       set status = 'completed',
           updated_at = now()
     where id = v_order.id
       and coalesce(refunded, false) = false
       and lower(coalesce(status, '')) in ('active', 'pending', 'waiting', 'processing');

    if not found then
      continue;
    end if;

    v_reference := case
      when v_order.source = 'gotsms'
        then regexp_replace(coalesce(v_order.idempotency_key, ''), '^gotsms-', '')
      when v_order.source = 'smsbus_rent'
        then coalesce(v_order.wallet_debit_id::text, '')
      else coalesce(v_order.order_id, '')
    end;

    if v_reference <> '' then
      update public.transactions
         set status = 'completed',
             subtitle = case
               when coalesce(subtitle, '') = '' then 'Rental period completed'
               else subtitle || ' · Rental period completed'
             end,
             notes = concat_ws(' | ', nullif(notes, ''), 'rental_expired_at:' || v_order.code)
       where user_id = v_order.user_id
         and type = 'purchase'
         and category = 'MJ SMS'
         and external_reference = v_reference
         and lower(coalesce(status, '')) in ('pending', 'active', 'waiting', 'processing');
    end if;

    v_completed := v_completed + 1;
  end loop;

  return v_completed;
end;
$function$;

revoke all on function public.mj_complete_expired_sms_rentals() from public, anon, authenticated;
grant execute on function public.mj_complete_expired_sms_rentals() to service_role;
