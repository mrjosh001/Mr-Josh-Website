create table if not exists public.log_purchase_cooldowns (
  user_id uuid not null references auth.users(id) on delete cascade,
  product_key text not null,
  locked_until timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, product_key)
);

alter table public.log_purchase_cooldowns enable row level security;

create or replace function public.claim_log_purchase_cooldown(
  p_user_id uuid,
  p_product_key text,
  p_cooldown_seconds integer default 10
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean := false;
  v_seconds integer := greatest(1, least(coalesce(p_cooldown_seconds, 10), 60));
begin
  if p_user_id is null or nullif(trim(p_product_key), '') is null then
    return false;
  end if;

  insert into public.log_purchase_cooldowns (user_id, product_key, locked_until, updated_at)
  values (p_user_id, trim(p_product_key), now() + make_interval(secs => v_seconds), now())
  on conflict (user_id, product_key) do update
    set locked_until = excluded.locked_until,
        updated_at = now()
    where public.log_purchase_cooldowns.locked_until <= now()
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

revoke all on function public.claim_log_purchase_cooldown(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.claim_log_purchase_cooldown(uuid, text, integer) to service_role;
