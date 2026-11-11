# MJ HUB Reseller API: implementation status

## Purpose

This document records what exists in the reseller API branch, what has only been drafted, and what remains blocked. It is an engineering status document, not a promise that the API is live.

**Current status: development foundation only.** The branch is not merged to `main`; the reseller schema has not been applied to Supabase; the endpoint has not been deployed or exercised against a configured preview environment. Supplier purchases are not implemented.

## Existing MJ HUB fulfilment models audited

| Product family | Existing MJ HUB implementation | Supplier / fulfilment notes |
|---|---|---|
| SMS Server 1 | `mj-sms.html` | GrizzlySMS and HeroSMS pools, presented as one server |
| SMS Server 2 | `mj-sms3.html` | SMS-BUS; separate activation lifecycle |
| SMS Server 3 | `mj-sms-s3.html` | VirtualSMS; separate activation lifecycle |
| USA real-number rental | `mj-sms-usa-rent.html`, `mj-sms-usa-number.html` | GotSMS; carrier/plan selection, renewal, inbox, cancellation, refund and expiry |
| Global / country rental | `mj-sms-rent.html` | SMS-BUS rental actions; country/area and duration-specific lifecycle |
| Telegram | `mj-telegram.html` | Telegram Premium and Stars via SMMKings; not SMS |
| eSIM | `esim.html`, `api/esim.js` | Separate eSIM Supabase project; customer/IMEI details and manual fulfilment may be required |
| Boosting | `mj-boosters.html`, `api/owlet.js` | Provider-backed social-panel services |
| Logs | `mj-logs.html`, `api/order-logsdomain.js`, `api/classy.js`, `api/sujan.js`, `api/order-manual.js` | Multiple suppliers and credential fulfilment |
| MJ Mails | `mj-mails.html`, `mj-mails-orders.html`, `lib/mj-mails.js` | HeroSMS email offers, activation, inbox/message reuse, cancellation and refund states |

The reseller API must preserve these product-specific request fields, provider identifiers, order states, fulfilment details and compensation rules. A single API key does not mean a single generic supplier order operation.

## Implemented in source on this branch

### Reseller account and API-key management

The handler is `api/reseller.js`.

- `GET /api/reseller?action=keys` uses the signed-in customer's Supabase user JWT. It creates a pending reseller account if one does not exist, then returns account and key metadata.
- `POST /api/reseller?action=keys` uses the signed-in customer's Supabase user JWT. It creates a key only when the reseller account is already active.
- `DELETE /api/reseller?action=keys&id={key_id}` uses the signed-in customer's Supabase user JWT and revokes an active key belonging to that user's reseller account.
- New keys use the `mj_live_` prefix, are generated with cryptographic randomness, and are stored as SHA-256 hashes. The plaintext is returned only in the successful creation response.
- A reseller account is initially `pending`. No self-service approval endpoint exists.

### Reseller-key endpoints

These require `Authorization: Bearer <reseller_api_key>` and an active reseller account:

- `GET /api/reseller?action=catalog` or `?action=services`: read-only catalogue.
- `GET /api/reseller?action=balance`: reads the separate reseller wallet.
- `GET /api/reseller?action=mail_offers&site={domain}`: fetches MJ Mails offers from HeroSMS and applies the existing MJ HUB pricing calculation.

Catalogue data is currently assembled from `number_services`, `products`, `booster_services`, and, when configured, the separate eSIM Supabase project's `esim_plans` table. SMS sources are mapped to Server 1/2/3, USA rental, and global rental. Telegram Premium/Stars are kept separate from ordinary boosting rows. MJ Mails offers are fetched through a separate site-specific request, not from the general catalogue.

### Database migration draft

`sql/reseller-api-foundation.sql` defines draft tables for reseller accounts, API keys, separate reseller wallets, wallet ledger entries, and reseller orders. It also drafts:

- `reseller_order_reserve`: locks the reseller wallet and creates the order plus debit ledger entry in one transaction.
- `reseller_wallet_post`: serializes wallet postings and uses an idempotency key to prevent duplicate postings.
- `reseller_refund_order`: allows one refund for an order only when the caller asserts supplier confirmation and the order is in a refundable state.

**These SQL objects are not applied to Supabase.** The boolean supplier-confirmation argument is not independent proof of supplier state. Only a trusted server-side adapter may call the refund function after verifying the supplier outcome. The RPCs have not been exercised against the target database.

## Not implemented

- Purchase/order endpoints for any category.
- Supplier-specific purchase adapters or provider status polling.
- Order retrieval, cancellation, renewal, inbox/message retrieval, or fulfilment endpoints for reseller orders.
- Signed reseller webhooks, signature validation, replay protection, durable outbox, and delivery retries (not implemented).
- Reseller funding/top-up and admin wallet adjustment workflows.
- Admin approval UI, reseller dashboard, key rotation UI, usage analytics, or scoped-key enforcement.
- Per-key rate limiting, quotas, abuse controls, and durable request audit logs (not implemented).
- Supplier reconciliation and safe handling of ambiguous timeouts.
- End-to-end tests and production/preview validation.

The SQL draft includes wallet reservation/posting/refund functions, so it is inaccurate to describe those functions as absent. They are **drafted but unapplied and untested**.

## Important code-review limitations

1. The current API-key middleware reads the stored scopes but does not enforce individual scopes yet. The current key is therefore not meaningfully restricted by its scope list.
2. The catalogue's `page` and `per_page` values are applied independently to each backing table. `count` is the number of mapped items on that page, not a global total. Clients must follow each `next_page` entry independently and merge results.
3. The catalogue currently filters unavailable rows out rather than returning them with `available: false`.
4. eSIM catalogue loading depends on `ESIM_SUPABASE_URL`, `ESIM_SUPABASE_SERVICE_ROLE_KEY`, and a compatible `esim_plans` table with the selected fields. This has not been verified in a preview environment.
5. The current `mail_offers` handler validates `site`; the optional `domain` is forwarded to the supplier but is not independently validated by this handler.
6. No rate limit is implemented. The `last_used_at` timestamp is updated on every authenticated API-key request.
7. The SQL refund RPC trusts a privileged caller's `p_supplier_confirmed` boolean. It must never be exposed directly to a client or called before a verified supplier result.
8. Existing customer endpoints are not reseller adapters. Routes such as `/api/grizzly-sync` and `/api/sms-bus` use customer JWT identity and customer-wallet debit/refund paths. A reseller key must never be passed as a customer JWT, and reseller orders must never debit or refund the customer's wallet.

## Required architecture before purchases are enabled

1. Authenticate one reseller API key and resolve its active reseller account.
2. Validate the requested category, service ID, request schema, scope, quantity and pricing server-side.
3. Generate or validate an idempotency key.
4. Reserve funds and persist the reseller order atomically.
5. Only after reservation commits, invoke the correct supplier adapter.
6. Persist supplier identifiers and normalized state transitions.
7. On confirmed supplier failure/cancellation, perform one idempotent refund against the original reseller order.
8. On timeout or ambiguous provider response, mark the order `unknown` and reconcile before any retry or refund.
9. Record every transition and supplier response for support and financial reconciliation.

## Documentation and validation status

- `docs/RESELLER_API.md` is the developer-facing reference for endpoints that currently exist.
- `docs/openapi.yaml` describes only those existing endpoints. Planned purchase routes are intentionally excluded.
- Documentation and OpenAPI syntax can be statically checked, but that does not prove runtime correctness.
- Runtime validation requires a preview deployment with the migration applied to a non-production database and test supplier credentials.
- No production deployment, production schema change, or production purchase test is authorized by this work.


## Latest hardening pass (feature branch only)

- Added `/api/v1/reseller` as a versioned entry point while retaining the existing handler implementation centrally.
- Catalogue service IDs are now opaque hashes. Supplier source names and raw provider service IDs are no longer returned in catalogue fields/metadata.
- Error responses now use `{ success: false, code, message, request_id }` and include an `X-Request-Id` header.
- Added `mj_test_` sandbox key creation, environment binding, expiry checks, and optional IP allowlist checks in the handler. Sandbox balance is hard-coded to zero and sandbox MJ Mails lookup returns an empty result without contacting HeroSMS.
- Added draft SQL for key environment/allowlist/expiry metadata and a separate sandbox wallet. The SQL remains unapplied.

### Still open after this pass

- Durable per-key rate limiting and `429 Retry-After`.
- `Idempotency-Key` HTTP header and 24-hour replay contract for future order-create endpoints. The draft order table currently has a permanent per-reseller idempotency uniqueness constraint, but there is no order-create route yet.
- Signed reseller webhook delivery, outbox, retry, replay and event history.
- Full sandbox order simulator and supplier-mock adapters. Current sandbox is read-only and blocks live MJ Mails supplier access; no purchase routes exist yet.
- Enforce scopes per route, implement key rotation, and test IP extraction behind the actual Vercel proxy.
- Verify all supplier adapters, catalogue mappings, eSIM schema, wallet RPCs, and refund/reconciliation paths in a non-production preview environment.


## Additional hardening added in the latest pass

- Atomic per-key fixed-window rate limiter (60 requests per 60 seconds) and HTTP 429 / `Retry-After`.
- Scope enforcement for catalogue and wallet reads.
- Atomic key rotation RPC and API key-management operation.
- 24-hour idempotency claim and order-binding RPCs. Financial order and wallet-ledger records remain permanent.
- Webhook endpoint/outbox tables, event enqueue RPC, concurrent-safe outbox claim RPC, AES-256-GCM secret encryption, HMAC-SHA256 signing/verification helpers, and an internal retrying dispatcher.
- Sandbox key environment is preserved when rotating keys.

### Remaining blockers before reseller orders or external webhooks can go live

1. There is still no purchase/order-create route, so the 24-hour idempotency claim must be wired into each future order adapter before supplier calls.
2. There is no reseller-facing webhook subscription management route. Endpoints must currently be provisioned through trusted administrative/database operations.
3. Order-state transitions do not yet enqueue webhook events because the service-specific order adapters are not implemented.
4. The webhook dispatcher needs its cron/scheduler configured and secrets provisioned in the deployment environment.
5. Sandbox has no simulated order lifecycle; it is read-only and blocks live supplier offer calls.
6. The SQL foundation and RPCs remain unapplied and untested against a non-production Supabase project. The runtime changes depending on them fail closed until that migration exists.
7. Rate-limit cleanup/retention, load tests, IP allowlist proxy validation, and end-to-end signature/retry tests remain outstanding.
8. The key-rotation route, rate-limit RPC, and webhook dispatcher are syntax-level development work only, not verified in a deployed preview.
