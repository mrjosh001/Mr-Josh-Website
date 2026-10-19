-- Repair the legacy Server 1/3 supplier-failure path that restored only NGN.
-- The shared debit RPC already supports NGN-first + USD remainder at 1450 NGN/USD.
-- These before-values let the DB recognize that exact rollback and restore the
-- missing USD portion without changing normal deposits or debits.

begin;

alter table public.wallet_debits
  add column if not exists ngn_before numeric,
  add column if not exists usd_before numeric;

create or replace function public.debit_balance_if_sufficient(p_user_id uuid, p_amount numeric)
returns table(success boolean, new_balance numeric, new_balance_usd numeric, ngn_debited numeric, usd_debited numeric)
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_rate constant numeric := 1450;
  v_ngn numeric;
  v_usd numeric;
  v_use_ngn numeric;
  v_use_usd numeric;
  v_id bigint;
begin
  if p_amount is null or p_amount <= 0 then
    return query select false, coalesce(balance,0), coalesce(balance_usd,0), 0::numeric, 0::numeric
      from profiles where id = p_user_id;
    return;
  end if;

  select coalesce(balance,0), coalesce(balance_usd,0)
    into v_ngn, v_usd
  from profiles where id = p_user_id for update;

  if not found then
    return query select false, 0::numeric, 0::numeric, 0::numeric, 0::numeric;
    return;
  end if;

  v_use_ngn := least(v_ngn, p_amount);
  v_use_usd := ceil(greatest(p_amount - v_use_ngn, 0) / v_rate * 100) / 100;

  if v_use_usd > v_usd then
    return query select false, v_ngn, v_usd, 0::numeric, 0::numeric;
    return;
  end if;

  update profiles
    set balance = v_ngn - v_use_ngn,
        balance_usd = v_usd - v_use_usd,
        updated_at = now()
  where id = p_user_id;

  insert into wallet_debits (user_id, total_ngn, ngn_amt, usd_amt, ngn_before, usd_before)
  values (p_user_id, p_amount, v_use_ngn, v_use_usd, v_ngn, v_usd)
  returning id into v_id;

  return query select true,
    v_ngn - v_use_ngn,
    v_usd - v_use_usd,
    v_use_ngn,
    v_use_usd;
end;
$function$;

create or replace function public.mj_repair_sms_wallet_rollback()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  d wallet_debits%rowtype;
begin
  if new.id is null then return new; end if;

  select * into d
  from public.wallet_debits
  where user_id = new.id
    and not refunded
    and created_at > now() - interval '5 minutes'
    and ngn_before is not null
    and usd_before is not null
    and coalesce(old.balance,0) = coalesce(d.ngn_before,0) - coalesce(d.ngn_amt,0)
    and coalesce(old.balance_usd,0) = coalesce(d.usd_before,0) - coalesce(d.usd_amt,0)
    and coalesce(new.balance,0) = coalesce(d.ngn_before,0)
    and coalesce(new.balance_usd,0) = coalesce(d.usd_before,0) - coalesce(d.usd_amt,0)
  order by d.created_at desc, d.id desc
  limit 1
  for update skip locked;

  if not found then return new; end if;

  update public.wallet_debits set refunded = true where id = d.id and not refunded;
  if found then
    new.balance_usd := coalesce(new.balance_usd,0) + coalesce(d.usd_amt,0);
    new.updated_at := now();
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_mj_repair_sms_wallet_rollback on public.profiles;
create trigger trg_mj_repair_sms_wallet_rollback
before update of balance, balance_usd on public.profiles
for each row execute function public.mj_repair_sms_wallet_rollback();

revoke execute on function public.mj_repair_sms_wallet_rollback() from public, anon, authenticated;
grant execute on function public.mj_repair_sms_wallet_rollback() to service_role;

commit;
