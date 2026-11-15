-- Targeted index for Server 3 / VirtualSMS catalogue sync.
-- The sync filters source='virtualsms' and country_id >= 1000,
-- then keyset-paginates and orders by UUID id. This partial index lets
-- PostgreSQL satisfy the filter/order directly instead of sorting the
-- source/country/service index on every page.
create index if not exists number_services_virtualsms_sync_id_idx
  on public.number_services (id)
  where source = 'virtualsms' and country_id >= 1000;

analyze public.number_services;
