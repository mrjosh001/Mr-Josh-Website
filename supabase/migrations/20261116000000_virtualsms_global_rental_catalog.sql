-- Expand VirtualSMS Platform rental catalogue from USA-only to supplier-discovered countries.
-- Existing USA rows and all pricing/visibility settings are preserved.
alter table public.virtualsms_rent_plans
  drop constraint if exists virtualsms_rent_plans_country_code_check,
  drop constraint if exists virtualsms_rent_plans_country_id_check;

alter table public.virtualsms_rent_plans
  alter column country_id drop not null,
  alter column country_id drop default,
  add column if not exists country_name text,
  add column if not exists country_flag text;

update public.virtualsms_rent_plans
set country_name = coalesce(nullif(country_name, ''), 'United States'),
    supplier_data = coalesce(supplier_data, '{}'::jsonb) ||
      jsonb_build_object('country_name', coalesce(nullif(supplier_data->>'country_name',''), 'United States'))
where country_code = 'US';

create index if not exists virtualsms_rent_plans_country_available_idx
  on public.virtualsms_rent_plans (country_code, is_available, service_name);

-- Keep the catalogue private: server-side service role only, as before.
alter table public.virtualsms_rent_plans enable row level security;
revoke all on public.virtualsms_rent_plans from anon, authenticated;
