begin;

-- A refund must identify the exact wallet_debits.id. The legacy function only
-- accepts user + amount and guesses a debit from a 30-minute time window.
-- Keep its signature for compatibility, but fail closed and prevent all roles
-- (including service_role) from invoking it.
create or replace function public.credit_balance(p_user_id uuid, p_amount numeric)
returns numeric
language plpgsql
security definer
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '0A000',
    message = 'Unsafe legacy refund disabled: provide the exact wallet_debit_id and use refund_wallet_debit or the order-specific refund path.';
end;
$function$;

revoke all on function public.credit_balance(uuid, numeric)
  from public, anon, authenticated, service_role;

commit;
