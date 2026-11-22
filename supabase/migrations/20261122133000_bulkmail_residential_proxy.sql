-- BulkMail Residential Proxy catalogue and order isolation.
-- VPN and IPv4 products are deliberately excluded.

create table if not exists public.bulkmail_proxy_variants (
  variant_id text primary key,
  product_key text not null,
  product_id text not null,
  product_name text not null,
  variant_name text not null,
  supplier_price_usd numeric(14,6) not null default 0,
  retail_price_ngn numeric(14,2) not null default 0,
  stock_quantity integer not null default 0 check (stock_quantity >= 0),
  max_quantity integer not null default 1 check (max_quantity > 0),
  is_available boolean not null default false,
  raw jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists bulkmail_proxy_variants_product_idx
  on public.bulkmail_proxy_variants (product_key, is_available, retail_price_ngn);

create table if not exists public.bulkmail_proxy_orders (
  id uuid primary key default gen_random_uuid(),
  order_ref text not null,
  user_id uuid not null references auth.users(id) on delete restrict,
  customer_id text,
  product_key text not null,
  product_name text not null,
  variant_id text not null,
  variant_name text not null,
  quantity integer not null check (quantity > 0),
  unit_price_ngn numeric(14,2) not null check (unit_price_ngn > 0),
  total_ngn numeric(14,2) not null check (total_ngn > 0),
  supplier_price_usd numeric(14,6) not null default 0,
  wallet_debit_id bigint references public.wallet_debits(id),
  supplier_order_id text,
  status text not null default 'created',
  credentials text,
  activation_url text,
  refunded boolean not null default false,
  supplier_response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bulkmail_proxy_orders_user_ref_unique unique (user_id, order_ref)
);

create index if not exists bulkmail_proxy_orders_user_created_idx
  on public.bulkmail_proxy_orders (user_id, created_at desc);
create index if not exists bulkmail_proxy_orders_supplier_idx
  on public.bulkmail_proxy_orders (supplier_order_id);

alter table public.bulkmail_proxy_variants enable row level security;
alter table public.bulkmail_proxy_orders enable row level security;
revoke all on table public.bulkmail_proxy_variants from anon, authenticated;
revoke all on table public.bulkmail_proxy_orders from anon, authenticated;
grant all on table public.bulkmail_proxy_variants to service_role;
grant all on table public.bulkmail_proxy_orders to service_role;

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
       and coalesce(new.category, '') = 'BulkMail - Residential Proxy' then
      new.admin_hidden := false;
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
