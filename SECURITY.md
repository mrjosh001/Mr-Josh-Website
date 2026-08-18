# MJ Hub security checklist

Implemented in the website code (this deploy):

1. **Password strength** — signup + password reset require 8+ chars, upper, lower, number (with on-screen strength meter).
2. **Login rate limiting** — max 5 failed sign-ins per 15 minutes (client-side; Supabase also rate-limits Auth).
3. **Password reset rate limiting** — max 3 requests per 15 minutes.
4. **Session storage** — auth tokens use `sessionStorage` (cleared when the browser tab/window closes) instead of long-lived `localStorage`.
5. **Remember me** — stores email only, never the password.
6. **Admin gate** — client checks `profiles.is_admin`; non-admins are signed out. Sensitive APIs use server-side `requireAdmin` (service role + JWT).
7. **API hardening** — `lib/secure.js` blocks client-supplied service_role secrets.

## You must set these in Supabase (Dashboard)

### Auth
- **Email confirmation**: ON (recommended)
- **Minimum password length**: 8 (Auth → Providers → Email)
- **Leaked password protection**: ON if available (Have I Been Pwned)
- **MFA / 2FA**: enable TOTP under Auth → MFA for admin accounts (optional but recommended)

### Auth rate limits (Auth → Rate Limits)
Keep defaults or tighten sign-in / recovery if you see abuse.

### RLS (Row Level Security)
- Ensure **RLS is enabled** on `profiles`, wallets, orders, products, tickets.
- Users may only **select/update their own** profile rows.
- Only **admins** may set `is_admin` or edit other users (prefer server API with service role).
- Never expose `service_role` key in HTML or public repo.

### Vercel
- Keep all supplier keys, `SUPABASE_SERVICE_ROLE_KEY`, Paystack/PocketFi secrets in **Vercel Environment Variables** only.
- Do not commit `.env` files.

### 2FA note
Full authenticator 2FA is a Supabase Auth MFA feature. Turn it on in the Supabase dashboard, then we can add enroll/verify UI on the site for admins.
