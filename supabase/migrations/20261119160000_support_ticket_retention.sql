-- Support retention policy:
-- Attachments expire 60 days after a ticket is closed.
-- Message text expires 90 days after a ticket is closed.
-- Reopening clears closed_at; closing again starts a fresh retention window.

alter table public.support_tickets
  add column if not exists closed_at timestamptz;

-- Existing closed tickets have no reliable historical closure timestamp.
-- Start their retention clock from deployment, never retroactively delete history.
update public.support_tickets
set closed_at = now()
where lower(coalesce(status, '')) = 'closed'
  and closed_at is null;

create index if not exists support_tickets_closed_at_retention_idx
  on public.support_tickets (closed_at)
  where closed_at is not null;

create or replace function public.mj_support_set_ticket_closed_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if lower(coalesce(new.status, '')) = 'closed' then
    if tg_op = 'INSERT' then
      new.closed_at := coalesce(new.closed_at, now());
    elsif lower(coalesce(old.status, '')) <> 'closed' or new.closed_at is null then
      new.closed_at := now();
    end if;
  else
    -- Any transition away from closed cancels the current retention clock.
    new.closed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists mj_support_ticket_closed_at on public.support_tickets;
create trigger mj_support_ticket_closed_at
before insert or update of status on public.support_tickets
for each row execute function public.mj_support_set_ticket_closed_at();

comment on column public.support_tickets.closed_at is
  'Internal retention anchor. Attachments expire 60 days and messages 90 days after this timestamp; null while ticket is open.';
