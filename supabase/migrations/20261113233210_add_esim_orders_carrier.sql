alter table public.esim_orders add column if not exists carrier text;

update public.esim_orders
set carrier = case
  when lower(split_part(plan_name, ' · ', 1)) = 't-mobile' then 'tmobile'
  when lower(split_part(plan_name, ' · ', 1)) = 'at&t' then 'att'
  when lower(split_part(plan_name, ' · ', 1)) = 'lyca mobile' then 'lyca'
  else carrier
end
where carrier is null and position(' · ' in coalesce(plan_name, '')) > 0;
