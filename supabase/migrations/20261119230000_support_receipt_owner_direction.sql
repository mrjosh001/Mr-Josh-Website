create or replace function public.mj_support_mark_delivered(p_ticket_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_is_owner boolean := false;
  v_is_admin boolean := false;
  v_count integer := 0;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  select exists (select 1 from public.support_tickets t where t.id = p_ticket_id and t.user_id = v_uid) into v_is_owner;
  select coalesce(p.is_admin, false) into v_is_admin from public.profiles p where p.id = v_uid;
  if not v_is_owner and not coalesce(v_is_admin, false) then raise exception 'Not authorized for this conversation'; end if;
  update public.support_messages m
  set delivered_at = coalesce(m.delivered_at, now())
  where m.ticket_id = p_ticket_id and m.delivered_at is null
    and ((v_is_owner and lower(coalesce(m.sender_type, '')) in ('admin','agent','staff','support'))
      or (not v_is_owner and coalesce(v_is_admin, false) and lower(coalesce(m.sender_type, '')) in ('user','customer','system')));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.mj_support_mark_read(p_ticket_id uuid, p_message_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_is_owner boolean := false;
  v_is_admin boolean := false;
  v_count integer := 0;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  select exists (select 1 from public.support_tickets t where t.id = p_ticket_id and t.user_id = v_uid) into v_is_owner;
  select coalesce(p.is_admin, false) into v_is_admin from public.profiles p where p.id = v_uid;
  if not v_is_owner and not coalesce(v_is_admin, false) then raise exception 'Not authorized for this conversation'; end if;
  update public.support_messages m
  set delivered_at = coalesce(m.delivered_at, now()), read_at = coalesce(m.read_at, now()), read_by = coalesce(m.read_by, v_uid)
  where m.ticket_id = p_ticket_id and (p_message_ids is null or m.id = any(p_message_ids))
    and ((v_is_owner and lower(coalesce(m.sender_type, '')) in ('admin','agent','staff','support'))
      or (not v_is_owner and coalesce(v_is_admin, false) and lower(coalesce(m.sender_type, '')) in ('user','customer','system')))
    and m.read_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.mj_support_mark_delivered(uuid) from public, anon;
revoke all on function public.mj_support_mark_read(uuid, uuid[]) from public, anon;
grant execute on function public.mj_support_mark_delivered(uuid) to authenticated;
grant execute on function public.mj_support_mark_read(uuid, uuid[]) to authenticated;