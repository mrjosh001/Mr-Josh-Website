-- Customer transaction history must never reveal supplier identity or routing.
-- Keep internal supplier fields untouched; sanitize only the two fields rendered
-- by the customer dashboard. This does not change wallet or refund accounting.

create or replace function public.mj_sanitize_customer_transaction_labels()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_title_original text := coalesce(new.title, '');
  v_subtitle_original text := coalesce(new.subtitle, '');
  v_title text;
  v_subtitle text;
  v_supplier_pattern constant text :=
    '(sms[[:space:]_-]*bus|smsbus|got[[:space:]_-]*sms|gotsms|virtual[[:space:]_-]*sms|grizzly[[:space:]_-]*sms|hero[[:space:]_-]*sms|herosms|sms[[:space:]_-]*server[[:space:]_-]*[123])';
begin
  -- Remove supplier URLs/domains and supplier brand aliases from display title.
  v_title := regexp_replace(v_title_original, 'https?://[^[:space:]]+', '', 'gi');
  v_title := regexp_replace(v_title, '[[:alnum:]._-]*(gotsms|got-sms|smsbus|sms-bus|grizzlysms|virtualsms|hero-sms)[[:alnum:]._-]*\.(org|com|io|net)', '', 'gi');
  v_title := regexp_replace(v_title, v_supplier_pattern, '', 'gi');
  v_title := btrim(regexp_replace(v_title, '[[:space:]|·•,:;_-]+', ' ', 'g'));

  if v_title = '' and v_title_original ~* v_supplier_pattern then
    if v_title_original ~* '(refund|cancel)' then
      v_title := 'MJ SMS refund';
    elsif v_title_original ~* 'rent' then
      v_title := 'Number rental';
    elsif coalesce(new.category, '') ilike '%sms%' or v_title_original ~* '(sms|otp|number)' then
      v_title := 'MJ SMS';
    else
      v_title := 'Transaction';
    end if;
  end if;

  -- Preserve legitimate customer details (country, service, phone, duration),
  -- while stripping supplier labels and internal routing/reference tokens.
  v_subtitle := regexp_replace(v_subtitle_original, 'https?://[^[:space:]]+', '', 'gi');
  v_subtitle := regexp_replace(v_subtitle, '[[:alnum:]._-]*(gotsms|got-sms|smsbus|sms-bus|grizzlysms|virtualsms|hero-sms)[[:alnum:]._-]*\.(org|com|io|net)', '', 'gi');
  v_subtitle := regexp_replace(v_subtitle, v_supplier_pattern, '', 'gi');
  v_subtitle := regexp_replace(
    v_subtitle,
    '(gotsms-renew-|sms_order:|smsbus_rent_order:|virtualsms_rent_req:|order_id:|rent_id:|activation_id:|supplier_order:|supplier_id:|provider_id:|service_id:|country_id:)[^[:space:],;|]+',
    '',
    'gi'
  );
  v_subtitle := btrim(regexp_replace(v_subtitle, '[[:space:]|·•,:;_-]+', ' ', 'g'));

  -- Raw integration diagnostics must not be turned into customer-facing copy.
  if v_subtitle_original ~* '(api[_ -]?key|authorization:|bearer[[:space:]]|raw (supplier|provider)?[[:space:]]*response|supplier (error|response)|provider (error|response)|json payload)' then
    if v_subtitle_original ~* 'gotsms-renew-' then
      v_subtitle := 'Rental renewal';
    else
      v_subtitle := 'Order update';
    end if;
  elsif v_subtitle = '' and v_subtitle_original ~* 'gotsms-renew-' then
    v_subtitle := 'Rental renewal';
  end if;

  new.title := nullif(v_title, '');
  new.subtitle := nullif(v_subtitle, '');
  return new;
end;
$$;

drop trigger if exists trg_mj_sanitize_customer_transaction_labels on public.transactions;
create trigger trg_mj_sanitize_customer_transaction_labels
before insert or update of title, subtitle
on public.transactions
for each row
execute function public.mj_sanitize_customer_transaction_labels();

-- Re-run the same sanitizer over historical rows. Amounts, statuses,
-- references, supplier_order, wallet debit links and refund records are untouched.
update public.transactions
set title = title,
    subtitle = subtitle
where coalesce(title, '') ~* '(gotsms|got[[:space:]_-]*sms|sms[-_ ]?bus|sms[[:space:]_-]*server[[:space:]_-]*[123]|grizzly[[:space:]_-]*sms|virtual[[:space:]_-]*sms|hero[[:space:]_-]*sms|https?://)'
   or coalesce(subtitle, '') ~* '(gotsms|got[[:space:]_-]*sms|sms[-_ ]?bus|sms[[:space:]_-]*server[[:space:]_-]*[123]|grizzly[[:space:]_-]*sms|virtual[[:space:]_-]*sms|hero[[:space:]_-]*sms|https?://|gotsms-renew-|sms_order:|smsbus_rent_order:|virtualsms_rent_req:|supplier_order:|provider_id:)';
