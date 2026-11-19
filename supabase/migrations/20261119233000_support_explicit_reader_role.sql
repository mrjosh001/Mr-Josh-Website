create or replace function public.mj_support_mark_delivered_for(p_ticket_id uuid, p_reader_role text)
returns integer language plpgsql security definer set search_path=public,auth as $$
declare v_uid uuid:=auth.uid(); v_is_admin boolean:=false; v_count integer:=0; v_role text:=lower(coalesce(p_reader_role,''));
begin
 if v_uid is null then raise exception 'Authentication required'; end if;
 select coalesce(p.is_admin,false) into v_is_admin from public.profiles p where p.id=v_uid;
 if v_role='customer' then
   if not exists(select 1 from public.support_tickets t where t.id=p_ticket_id and t.user_id=v_uid) then raise exception 'Not authorized for this customer conversation'; end if;
 elsif v_role='admin' then
   if not coalesce(v_is_admin,false) then raise exception 'Admin access required'; end if;
 else raise exception 'Invalid reader role'; end if;
 update public.support_messages m set delivered_at=coalesce(m.delivered_at,now())
 where m.ticket_id=p_ticket_id and m.delivered_at is null
 and ((v_role='customer' and lower(coalesce(m.sender_type,'')) in ('admin','agent','staff','support'))
 or (v_role='admin' and lower(coalesce(m.sender_type,'')) in ('user','customer','system')));
 get diagnostics v_count=row_count; return v_count;
end; $$;

create or replace function public.mj_support_mark_read_for(p_ticket_id uuid, p_message_ids uuid[], p_reader_role text)
returns integer language plpgsql security definer set search_path=public,auth as $$
declare v_uid uuid:=auth.uid(); v_is_admin boolean:=false; v_count integer:=0; v_role text:=lower(coalesce(p_reader_role,''));
begin
 if v_uid is null then raise exception 'Authentication required'; end if;
 select coalesce(p.is_admin,false) into v_is_admin from public.profiles p where p.id=v_uid;
 if v_role='customer' then
   if not exists(select 1 from public.support_tickets t where t.id=p_ticket_id and t.user_id=v_uid) then raise exception 'Not authorized for this customer conversation'; end if;
 elsif v_role='admin' then
   if not coalesce(v_is_admin,false) then raise exception 'Admin access required'; end if;
 else raise exception 'Invalid reader role'; end if;
 update public.support_messages m
 set delivered_at=coalesce(m.delivered_at,now()),read_at=coalesce(m.read_at,now()),read_by=coalesce(m.read_by,v_uid)
 where m.ticket_id=p_ticket_id and (p_message_ids is null or m.id=any(p_message_ids)) and m.read_at is null
 and ((v_role='customer' and lower(coalesce(m.sender_type,'')) in ('admin','agent','staff','support'))
 or (v_role='admin' and lower(coalesce(m.sender_type,'')) in ('user','customer','system')));
 get diagnostics v_count=row_count; return v_count;
end; $$;
revoke all on function public.mj_support_mark_delivered_for(uuid,text) from public,anon;
revoke all on function public.mj_support_mark_read_for(uuid,uuid[],text) from public,anon;
grant execute on function public.mj_support_mark_delivered_for(uuid,text) to authenticated;
grant execute on function public.mj_support_mark_read_for(uuid,uuid[],text) to authenticated;