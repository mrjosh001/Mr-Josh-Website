-- Align the product visibility trigger with the current Residential Proxy category.
-- The old trigger only recognized "BulkMail - Residential Proxy", while the
-- supplier sync now writes "Residential Proxy", which caused all proxy rows
-- to be hidden even when they had in-stock variants.

create or replace function public.enforce_bulkmail_product_visibility()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if lower(coalesce(new.source, '')) = 'bulkmail' then
    if new.product_key in ('bm_1293', 'bm_1152', 'bm_904', 'bm_1333') then
      new.is_available := coalesce(new.stock_quantity, 0) > 0;
      new.admin_hidden := coalesce(new.stock_quantity, 0) <= 0;
      if new.product_key in ('bm_904', 'bm_1333') then
        new.category := 'MAILS';
        new.price := case new.product_key when 'bm_904' then 1000 else 2000 end;
      end if;
    elsif left(coalesce(new.product_key, ''), 9) = 'bm_proxy_'
       and coalesce(new.category, '') in ('BulkMail - Residential Proxy', 'Residential Proxy') then
      new.admin_hidden := coalesce(new.stock_quantity, 0) <= 0;
      new.is_available := coalesce(new.stock_quantity, 0) > 0;
    elsif new.product_key like 'bm\_%' escape '\'
       and coalesce(new.category, '') = 'ALL COUNTRIES TIKTOK'
       and coalesce(new.name, '') ilike '%tiktok%' then
      new.is_available := coalesce(new.stock_quantity, 0) > 0;
      new.admin_hidden := coalesce(new.stock_quantity, 0) <= 0;
    elsif new.product_key in (
      'bm_477', 'bm_956', 'bm_957', 'bm_1018', 'bm_954', 'bm_149', 'bm_148',
      'bm_1028', 'bm_162', 'bm_953', 'bm_147', 'bm_159', 'bm_156', 'bm_173',
      'bm_165', 'bm_749', 'bm_142', 'bm_1023', 'bm_1022', 'bm_166', 'bm_150',
      'bm_145', 'bm_952', 'bm_172', 'bm_153', 'bm_176', 'bm_168', 'bm_955',
      'bm_144', 'bm_1020', 'bm_163', 'bm_160', 'bm_170', 'bm_146', 'bm_155',
      'bm_161', 'bm_152', 'bm_164', 'bm_167', 'bm_154', 'bm_1025', 'bm_1026',
      'bm_171', 'bm_143', 'bm_175', 'bm_1024', 'bm_1019', 'bm_1029', 'bm_1027',
      'bm_169', 'bm_1021', 'bm_157', 'bm_174', 'bm_151', 'bm_158'
    ) then
      new.admin_hidden := false;
      new.is_available := coalesce(new.stock_quantity, 0) > 0;
      if new.product_key in ('bm_477','bm_956','bm_957') then
        if coalesce(new.category, '') not ilike '%capcut%' then
          new.category := 'CapCut Pro';
        end if;
      else
        new.category := 'PREMIUM VPN FOR PHONE';
      end if;
    else
      new.is_available := false;
      new.admin_hidden := true;
      if coalesce(new.name, '') ilike '%vpn%' or coalesce(new.category, '') ilike '%vpn%' then
        new.category := 'PREMIUM VPN FOR PHONE';
      end if;
    end if;
  end if;
  return new;
end;
$function$;

-- Make already-synced Residential Proxy products visible only when at least
-- one supplier plan is currently available with positive stock.
update public.products p
set
  admin_hidden = not exists (
    select 1
    from public.bulkmail_proxy_variants v
    where v.product_key = p.product_key
      and v.is_available = true
      and v.stock_quantity > 0
  ),
  is_available = exists (
    select 1
    from public.bulkmail_proxy_variants v
    where v.product_key = p.product_key
      and v.is_available = true
      and v.stock_quantity > 0
  ),
  updated_at = now()
where p.source = 'bulkmail'
  and p.product_key like 'bm_proxy\_%' escape '\'
  and p.category = 'Residential Proxy';
