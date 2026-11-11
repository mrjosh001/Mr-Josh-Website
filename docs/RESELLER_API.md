# MJ HUB Reseller API

> **Development preview only.** This API is not enabled for production use. The current implementation supports reseller account/key management, a read-only catalogue, reseller wallet balance reads, and MJ Mails offer lookup. It does not place orders or fund wallets.

## Base URL

The handler is mounted at:

```
/api/v1/reseller
```

Use the host of the deployment containing this branch. Do not assume the production host has this code.

## Authentication

There are two distinct authentication contexts.

### Reseller management: signed-in MJ HUB user

Use the user's Supabase access token:

```http
Authorization: Bearer <supabase_user_access_token>
```

This is required for the `action=keys` operations. It is not the reseller API key.

### Reseller data endpoints: reseller API key

Use the reseller key created by MJ HUB:

```http
Authorization: Bearer mj_live_<secret>
```

The key is shown only once at creation. MJ HUB stores its SHA-256 hash. The associated reseller account must be `active`; pending, suspended, or closed accounts cannot use the reseller data endpoints.

**Do not send supplier credentials to clients. Do not use a reseller key as a customer Supabase JWT.**

## Current endpoint status

| Method | Request | Auth | Status |
|---|---|---|---|
| GET | `?action=keys` | MJ HUB user JWT | Implemented in branch |
| POST | `?action=keys` | MJ HUB user JWT | Implemented in branch |
| DELETE | `?action=keys&id={key_id}` | MJ HUB user JWT | Implemented in branch |
| GET | `?action=catalog` | Reseller API key | Read-only, implemented in branch |
| GET | `?action=services` | Reseller API key | Alias for catalogue |
| GET | `?action=balance` | Reseller API key | Read-only, implemented in branch |
| GET | `?action=mail_offers&site={domain}` | Reseller API key | Read-only offer lookup |
| POST | Purchase/order | Not available | Not implemented |
| GET | Order/status/inbox | Not available | Not implemented |
| POST | Cancel/renew/refund | Not available | Not implemented |
| POST | Wallet funding | Not available | Not implemented |

## 1. List reseller account and API keys

```http
GET /api/v1/reseller?action=keys
Authorization: Bearer <supabase_user_access_token>
```

Creates a pending reseller account if the signed-in user does not already have one. It does not approve the account or create a key.

Example response:

```json
{
  "success": true,
  "reseller": {
    "id": "reseller-uuid",
    "user_id": "user-uuid",
    "status": "pending",
    "currency": "NGN"
  },
  "keys": []
}
```

Key metadata includes `id`, `label`, `key_hint`, `status`, `scopes`, `created_at`, and `last_used_at`. The secret itself is never returned by this list endpoint.

## 2. Create a reseller API key

```http
POST /api/v1/reseller?action=keys
Authorization: Bearer <supabase_user_access_token>
Content-Type: application/json

{
  "label": "Production integration"
}
```

The reseller account must already be active. The label is optional and is limited to 60 characters.

Example success response:

```json
{
  "success": true,
  "key": "mj_live_<secret>",
  "warning": "Copy this key now. It cannot be displayed again.",
  "data": {
    "id": "key-uuid",
    "label": "Production integration",
    "key_hint": "a1b2c3",
    "status": "active",
    "scopes": ["catalog:read", "wallet:read", "orders:read", "orders:write"],
    "created_at": "2026-11-11T08:00:00.000Z"
  }
}
```

The listed scopes are currently stored as metadata. The middleware does not yet enforce them. Do not interpret them as active authorization boundaries until scope enforcement is implemented.

## 3. Revoke an API key

```http
DELETE /api/v1/reseller?action=keys&id=<key_id>
Authorization: Bearer <supabase_user_access_token>
```

Only an active key belonging to the signed-in user's reseller account can be revoked.

Example response:

```json
{
  "success": true,
  "key": {
    "id": "key-uuid",
    "status": "revoked"
  }
}
```

A missing ID returns HTTP 400. A key that is not an active key owned by that reseller returns HTTP 404.

## 4. Read the service catalogue

```http
GET /api/v1/reseller?action=catalog&page=1&per_page=50
Authorization: Bearer mj_live_<secret>
```

`action=services` is an alias for `action=catalog`.

- `page`: integer, defaults to 1; minimum 1; maximum 10000.
- `per_page`: integer, defaults to 50; clamped to 10–100.
- Currency is NGN.
- Only mapped rows with a positive retail price and available stock/status are currently returned.
- The catalogue is read-only. A catalogue item is not proof that a purchase endpoint exists.

Current category mapping:

| Public category | Current source mapping |
|---|---|
| `sms.server1` | `grizzlysms`, `herosms` |
| `sms.server2` | `smsbus` |
| `sms.server3` | `virtualsms` |
| `sms.usa_rental` | `gotsms` |
| `sms.global_rental` | `smsbus_rent` |
| `telegram.premium` | Matching SMMKings Telegram Premium rows |
| `telegram.stars` | Matching SMMKings Telegram Stars rows |
| `boosting` | Other mapped booster services |
| `logs` | Rows from the current `products` table mapping |
| `esim` | Separate eSIM project's `esim_plans`, when configured |

Telegram is a separate product family, not an SMS service. USA real-number rentals and global/country rentals are distinct from one-time SMS activation. eSIM, Logs, Boosting and MJ Mails also have independent fulfilment requirements.

Example response shape:

```json
{
  "success": true,
  "currency": "NGN",
  "count": 1,
  "page": 1,
  "per_page": 50,
  "next_page": {
    "number_services": null,
    "products": null,
    "booster_services": null,
    "esim_plans": null
  },
  "data": [
    {
      "id": "sms.server1:herosms:1:23",
      "category": "sms.server1",
      "source": "herosms",
      "name": "Example service",
      "country": "Example country",
      "price": {
        "amount": 500,
        "currency": "NGN"
      },
      "available": true,
      "metadata": {
        "provider_service_id": "23",
        "country_id": 1
      }
    }
  ]
}
```

The sample item above is illustrative, not a live service or price.

### Pagination detail

The handler applies the same page number and page size independently to each backing table. The `next_page` object therefore contains a separate continuation value for `number_services`, `products`, `booster_services`, and `esim_plans`. Follow each table's continuation independently and merge/deduplicate results by public `id`. The top-level `count` is the number of mapped items returned in this response, not a total catalogue count.

## 5. Read reseller wallet balance

```http
GET /api/v1/reseller?action=balance
Authorization: Bearer mj_live_<secret>
```

Example response:

```json
{
  "success": true,
  "balance": {
    "amount": 12500,
    "currency": "NGN"
  },
  "updated_at": "2026-11-11T08:00:00.000Z"
}
```

The reseller wallet is designed to be separate from the normal MJ HUB customer wallet. The current endpoint is read-only. No public top-up, debit, transfer, or adjustment endpoint exists.

## 6. Look up MJ Mails offers

```http
GET /api/v1/reseller?action=mail_offers&site=telegram.com
Authorization: Bearer mj_live_<secret>
```

Query parameters:

- `site` (required): website/domain string, 3–253 characters, limited to lowercase letters, digits, dots and hyphens after normalization. Example: `telegram.com`.
- `domain` (optional): forwarded to the supplier as a domain filter. The current handler does not independently validate this parameter.

Example response shape:

```json
{
  "success": true,
  "category": "mj_mails",
  "site": "telegram.com",
  "count": 1,
  "data": [
    {
      "id": "mjmail:<stable-offer-hash>",
      "category": "mj_mails",
      "name": "telegram.com email",
      "site": "telegram.com",
      "domain": "example-domain",
      "available": 10,
      "price": {
        "amount": 700,
        "currency": "NGN"
      }
    }
  ]
}
```

The offer ID is a lookup identifier, not a purchase endpoint. MJ Mails purchase, message retrieval, reuse/reactivation, cancellation and refund are not yet exposed through the reseller API.

## Error responses

The current handler returns JSON errors using this shape:

```json
{
  "success": false,
  "message": "Human-readable error"
}
```

Observed status classes include:

| HTTP | Meaning |
|---|---|
| 400 | Missing/invalid required input |
| 401 | Missing or invalid/revoked reseller key |
| 403 | Reseller account is not active, or key creation is not approved |
| 404 | Unknown action or key not found for revocation |
| 405 | Method not allowed |
| 500 | Internal/database operation failure |
| 502 | Supplier offer lookup failure |
| 503 | Catalogue, wallet, or supplier configuration unavailable |

Clients should not automatically retry a request that creates/revokes a key or any future purchase operation without a defined idempotency contract. Purchase operations do not exist yet.

## Operational and security constraints

- Keep API keys server-side and out of browser code, mobile app bundles, logs and support screenshots.
- Store the plaintext key securely when it is created. MJ HUB cannot recover it later; revoke and replace it if lost.
- HTTPS is required.
- The current implementation has no rate limiter and does not enforce stored key scopes.
- No purchase, order status, cancellation, renewal, refund, webhook or funding endpoints are currently available.
- Do not retry supplier operations after ambiguous timeouts until supplier state has been reconciled.
- Supplier credentials and raw supplier API responses must not be exposed to reseller clients.

## Launch checklist

Before external developers are given production credentials, MJ HUB must implement and test each product adapter independently, including request validation, price verification, atomic reseller-wallet reservation, supplier submission, status reconciliation, cancellation/renewal rules where applicable, and exactly-once refund behaviour. The SQL migration must be reviewed and applied to a non-production database first. The API must then pass authenticated preview tests, concurrency/idempotency tests, supplier failure tests, and security/rate-limit tests.

**This reference documents the current development branch only. It does not certify production availability.**


## Sandbox behaviour

Sandbox keys are isolated from live keys. Their balance endpoint returns a fixed zero sandbox balance, and MJ Mails offer lookup returns an empty sandbox response without calling HeroSMS. Sandbox keys cannot be used as live keys. This is a read-only sandbox foundation, not a complete order simulator: purchase adapters, mock order lifecycle, rate limits, and signed webhooks are not yet implemented. IP allowlists and key expiry are supported by the database draft but require that migration to be applied before use.


## Security controls in the current development branch

- API keys can be rotated by posting `{"rotate_key_id":"<active-key-uuid>"}` to the key-management route. Rotation revokes the old key and creates its replacement in one database transaction. The replacement secret is shown once.
- API key scopes are checked by endpoint. Catalogue and MJ Mails offer reads require `catalog:read`; wallet reads require `wallet:read`.
- Authenticated API-key requests are limited to 60 per fixed 60-second window. Excess requests return HTTP 429 with `Retry-After`.
- Keys may be restricted by an IP allowlist and expiry timestamp after the foundation SQL is applied.
- Sandbox keys use a separate environment marker and do not access the live reseller wallet or live MJ Mails supplier. The sandbox currently provides read-only responses; no order simulation exists.
- Webhook delivery uses HMAC-SHA256 over `timestamp.raw_body`, sent in `X-MJ-Signature` as `v1=<hex>`, with `X-MJ-Timestamp`, `X-MJ-Event`, and `X-MJ-Delivery`. Receivers should reject timestamps older than five minutes and compare signatures in constant time.
- Webhook secrets are encrypted at rest with AES-256-GCM. Configure `RESELLER_WEBHOOK_ENCRYPTION_KEY` as a base64-encoded 32-byte key and `RESELLER_WEBHOOK_DISPATCH_SECRET` for the internal dispatcher.
- The internal dispatcher retries failed deliveries with exponential backoff and marks deliveries dead after ten attempts.
