-- Fixes "Hero sync failed: load existing: canceling statement due to statement timeout".
-- lib/hero.js reads every number_services row WHERE source = 'herosms' ordered by id.
-- Without this index Postgres walks the whole table's primary key and filters afterwards.
-- Safe to run more than once. Run it in the Supabase SQL editor.
create index if not exists number_services_source_id_idx
  on public.number_services (source, id);

analyze public.number_services;
