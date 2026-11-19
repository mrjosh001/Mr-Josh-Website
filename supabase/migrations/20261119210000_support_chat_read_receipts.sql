alter table public.support_messages
  add column if not exists delivered_at timestamptz,
  add column if not exists read_at timestamptz,
  add column if not exists read_by uuid references auth.users(id) on delete set null;

create index if not exists support_messages_ticket_created_idx
  on public.support_messages (ticket_id, created_at);

create or replace function public.mj_support_mark_delivered(p_ticket_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_admin boolean := false;
  v_count integer := 0;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  select coalesce(is_admin, false) into v_admin from public.profiles where id = v_uid;
  if not exists (
    select 1 from public.support_tickets t
    where t.id = p_ticket_id and (t.user_id = v_uid or coalesce(v_admin,false))
  ) then raise exception 'Not authorized for this conversation'; end if;

  update public.support_messages m
  set delivered_at = coalesce(m.delivered_at, now())
  where m.ticket_id = p_ticket_id
    and m.sender_type <> case when coalesce(v_admin,false) then 'admin' else 'user' end
    and m.delivered_at is null;
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
  v_admin boolean := false;
  v_count integer := 0;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  select coalesce(is_admin, false) into v_admin from public.profiles where id = v_uid;
  if not exists (
    select 1 from public.support_tickets t
    where t.id = p_ticket_id and (t.user_id = v_uid or coalesce(v_admin,false))
  ) then raise exception 'Not authorized for this conversation'; end if;

  update public.support_messages m
  set delivered_at = coalesce(m.delivered_at, now()),
      read_at = now(),
      read_by = v_uid
  where m.ticket_id = p_ticket_id
    and m.sender_type <> case when coalesce(v_admin,false) then 'admin' else 'user' end
    and m.read_at is null
    and (p_message_ids is null or m.id = any(p_message_ids));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.mj_support_mark_delivered(uuid) from public, anon;
revoke all on function public.mj_support_mark_read(uuid, uuid[]) from public, anon;
grant execute on function public.mj_support_mark_delivered(uuid) to authenticated;
grant execute on function public.mj_support_mark_read(uuid, uuid[]) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public' and tablename = 'support_messages'
     ) then
    alter publication supabase_realtime add table public.support_messages;
  end if;
end $$;
