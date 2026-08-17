# MJ Hub — Secret management & API security

## Golden rules

1. **Backend only** for supplier keys, PocketFi secret, Supabase **service role**, cron secret.
2. **Browser may only** use Supabase **anon / publishable** key (with RLS enabled).
3. **Never** commit `.env`, service role JWTs, or supplier keys to Git.
4. **Never** accept API keys from request body/query — server reads `process.env` only.
5. **Rotate** keys if they ever appeared in a screenshot, chat, or public repo.

## What is already server-side

These routes call suppliers with `process.env.*` (not from the browser):

| Area | Route examples | Env vars |
|------|----------------|----------|
| Admin | `/api/admin` | `SUPABASE_*`, supplier keys as needed |
| SMS sync | `/api/grizzly-sync`, `/api/logsdomain-numbers` | `GRIZZLYSMS_API_KEY`, `LOGSDOMAIN_API_KEY` |
| Orders | `/api/order`, `/api/order-logsdomain`, `/api/order-manual` | `FADDED_API_KEY`, `LOGSDOMAIN_API_KEY` |
| Boosters | `/api/owlet` | `OWLET_API_KEY` |
| Payments | `/api/pocketfi` | `POCKETFI_SECRET_KEY`, `POCKETFI_PUBLIC_KEY`, … |
| Catalog | `/api/products`, `/api/products-logsdomain`, `/api/sujan` | supplier keys |

New helpers:

- `lib/secrets.js` — read env, rotation candidates (`KEY` + `KEY_PREVIOUS`)
- `lib/secure.js` — CORS, reject client-supplied secrets, require user/admin/cron
- `GET /api/secrets-status` — admin-only, shows which secrets are **configured** (true/false only)

## Vercel setup

1. Project → **Settings → Environment Variables**
2. Paste values from `.env.example` (real secrets, not the placeholders)
3. Apply to **Production** (and Preview if you need staging)
4. **Redeploy** after changing secrets

## API key rotation (zero-downtime)

Example for Grizzly:

1. Generate **new** key at Grizzly.
2. Vercel: `GRIZZLYSMS_API_KEY_PREVIOUS` = **old** key.
3. Vercel: `GRIZZLYSMS_API_KEY` = **new** key.
4. Deploy / wait ~1 minute.
5. Test SMS order + sync.
6. Revoke **old** key at Grizzly.
7. Delete `GRIZZLYSMS_API_KEY_PREVIOUS` in Vercel.

Use the same pattern for:

`LOGSDOMAIN_API_KEY`, `FADDED_API_KEY`, `OWLET_API_KEY`, `SUJAN_API_KEY`,
`POCKETFI_SECRET_KEY`, `CRON_SECRET`.

Code that should accept rotation:

```js
import { getSecretCandidates } from '../lib/secrets.js';

for (const apiKey of getSecretCandidates('GRIZZLYSMS_API_KEY')) {
  // try request with apiKey; break on success
}
```

Until every route is migrated, setting only the primary `KEY` (no `_PREVIOUS`) still works with existing `process.env.KEY` reads.

## Cron jobs

In `vercel.json`, cron hits paths like `/api/grizzly-sync`.  
Protect those handlers with:

```http
Authorization: Bearer <CRON_SECRET>
```

Vercel can send this via cron config headers where supported, or check `CRON_SECRET` inside the handler (already partially used in grizzly-sync).

## Browser / “vibe code” checklist

| Allowed in HTML/JS | Forbidden in HTML/JS |
|--------------------|----------------------|
| Supabase URL | `SUPABASE_SERVICE_ROLE_KEY` |
| Supabase anon / publishable key | Any `*_API_KEY` for suppliers |
| User `access_token` after login | `POCKETFI_SECRET_KEY` |
| Calls to **your** `/api/*` | Direct calls to Grizzly/Owlet/Fadded with secrets |

If a supplier key was ever pasted into a frontend file:

1. Rotate it immediately (playbook above).
2. Remove it from git history if the repo is public (`git filter-repo` / support).
3. Confirm RLS policies on `profiles`, `orders`, `transactions`.

## Supabase RLS

Service role bypasses RLS — that is why it stays on the server.  
Anon key **must** be constrained by RLS so users only read/write their own rows.

Minimum checks:

- `profiles`: users select/update own `id = auth.uid()`
- `orders` / `transactions`: `user_id = auth.uid()`
- Admin flags: only service role or carefully locked policies

## Verify after deploy

```bash
# Should 401 without admin token
curl -s https://YOUR_DOMAIN/api/secrets-status

# With admin user access_token — booleans only
curl -s -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  https://YOUR_DOMAIN/api/secrets-status
```

## Incident response

1. Rotate every supplier + PocketFi secret + `CRON_SECRET`.
2. Rotate Supabase service role (Dashboard → Settings → API → reset) and update Vercel.
3. Review Supabase auth logs for unknown admin logins.
4. Redeploy.
