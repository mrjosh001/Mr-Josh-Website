# MJ Hub security (implemented + required)

## Implemented in this deploy (API code)

1. **Reject client-supplied secrets** on money / admin / order routes (`rejectClientSuppliedSecrets`).
2. **CORS** restricted to mjhub origins via `applyApiCors` (not open `*`).
3. **Rate limits** (per-isolate): orders 30/min, deposits 15/min, delete-account 5/15min, admin 60/min.
4. **IDOR**: order routes bind to JWT user id only; body `user_id` cannot impersonate.
5. **Quantity / amount validation** on server for orders and PocketFi checkout.
6. **Admin balance edits** clamped to sane ranges.
7. **Public errors** strip secrets via `lib/errors.js`.

## You must run in Supabase (money safety)

Open **SQL Editor** and run:

`sql/rls_profiles_money_guard.sql`

This:

- Enables RLS on `profiles` / `orders` / `number_orders`
- **Blocks browser clients from changing `balance`, `balance_usd`, or `is_admin`**
- Lets **service_role** (Vercel APIs) still credit/debit balances

Without this SQL, a skilled user could try to patch `profiles.balance` from the browser if policies were too open.

## Env (Vercel)

- Never put `SUPABASE_SERVICE_ROLE_KEY` in frontend HTML
- Set `CORS_ALLOWED_ORIGINS=https://www.mjhub.store,https://app.mjhub.store,https://mjhub.store`
- Keep supplier keys, PocketFi, CRON_SECRET only in Vercel env

## Auth (Supabase dashboard)

- Email confirmation ON
- Leaked password protection ON if available
- MFA for admin accounts recommended
