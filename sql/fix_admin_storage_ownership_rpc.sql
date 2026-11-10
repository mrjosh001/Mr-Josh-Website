-- Account deletion Storage ownership lookup.
-- The function is SECURITY DEFINER because it must inspect storage.objects.
-- Restrict execution to service_role at the ACL level; do not rely on a
-- request.jwt.claim.role setting, which is not consistently populated by
-- Supabase's server-side service-role client.

create or replace function public.admin_list_user_storage_objects(
  p_user_id uuid,
  p_offset integer default 0,
  p_limit integer default 1000
)
returns table(bucket_id text, name text)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  return query
  select o.bucket_id, o.name
  from storage.objects as o
  where o.owner_id = p_user_id::text
     or o.owner = p_user_id
  order by o.bucket_id, o.name
  offset greatest(coalesce(p_offset, 0), 0)
  limit least(greatest(coalesce(p_limit, 1000), 1), 1000);
end;
$function$;

revoke all on function public.admin_list_user_storage_objects(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_list_user_storage_objects(uuid, integer, integer) to service_role;
