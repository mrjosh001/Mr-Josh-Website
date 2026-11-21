create or replace function public.enforce_bulkmail_product_visibility()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if lower(coalesce(new.source, '')) = 'bulkmail' then
    if new.product_key like 'bm\_%' escape '\'
       and coalesce(new.category, '') = 'ALL COUNTRIES TIKTOK'
       and coalesce(new.name, '') ilike '%tiktok%' then
      -- TikTok catalogue products follow supplier stock. A zero-stock
      -- product stays hidden; positive stock makes it customer-visible.
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
      -- Preserve the existing explicitly approved BulkMail catalogue rules.
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
      -- All other BulkMail products remain hidden and unavailable.
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

-- Re-evaluate the TikTok catalogue against its currently stored supplier stock.
update public.products
set is_available = coalesce(stock_quantity, 0) > 0,
    admin_hidden = coalesce(stock_quantity, 0) <= 0
where source = 'bulkmail'
  and category = 'ALL COUNTRIES TIKTOK'
  and name ilike '%tiktok%'
  and product_key like 'bm\_%' escape '\';
