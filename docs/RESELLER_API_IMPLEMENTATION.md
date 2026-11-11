# MJ HUB Reseller API — implementation notes

## Current implementation stage

This branch introduces the first server-side reseller API foundation. It is deliberately not wired into production and does not execute supplier purchases yet.

## Existing MJ HUB fulfilment models audited

- **SMS Server 1 / normal OTP:** `mj-sms.html`, supplier routes in `api/sms-bus.js` and related Grizzly/VirtualSMS integration.
- **SMS Server 2:** `mj-sms3.html`, separate supplier integration and order lifecycle.
- **SMS Server 3:** `mj-sms-s3.html`, Grizzly/VirtualSMS-backed OTP lifecycle.
- **USA physical SIM rental:** `mj-sms-usa-rent.html` + `mj-sms-usa-number.html`; GotSMS carrier/plan selection, renewal, inbox, cancellation/refund and expiry states.
- **Global / long-term country rental:** `mj-sms-rent.html` and SMS-BUS rental actions; country/area, duration in months, renew/cancel, inbox and rental expiry.
- **Telegram:** `mj-telegram.html`; Premium and Stars are separate product types fulfilled through SMMKings, not SMS activation.
- **eSIM:** `esim.html` + `api/esim.js`; carrier and plan selection, IMEI/customer details, manual fulfilment and email/invoice lifecycle.
- **Boosting:** `mj-boosters.html` + `api/owlet.js`; separate provider-backed panel services and order status.
- **Logs:** `mj-logs.html` + `api/order-logsdomain.js`, `api/classy.js`, `api/sujan.js`, `api/order-manual.js`; multiple supplier sources and credential fulfilment.
- **MJ Mails:** `mj-mails.html` + `mj-mails-orders.html` + `lib/mj-mails.js`; website search, available email offers, one-mail activation, message inbox/reuse, cancellation and refund states.

## Important design rule

The public reseller API must expose one authentication key and one reseller account while preserving each product's independent request schema, supplier adapter, order status model, and fulfilment data. In particular:
- SMS activation, USA physical rental, global monthly rental and long-term rental are distinct operations.
- Telegram Stars/Premium must not be mixed into SMS services.
- eSIM is not an OTP/rental number.
- MJ Mails is a separate email-activation product with inbox/reuse behaviour.
- Logs and Boosting retain their own supplier-specific fulfilment requirements.

## Implemented in this branch

- `GET /api/reseller?action=catalog` and `?action=services`: initial normalized read-only catalogue.
- `GET /api/reseller?action=balance`: separate reseller wallet read.
- `GET /api/reseller?action=keys` with user JWT: list key metadata.
- `POST /api/reseller?action=keys` with user JWT: create a key once, hash at rest.
- Reseller account defaults to pending; API keys cannot be created until an administrator activates the reseller account.
- SQL schema draft in `sql/reseller-api-foundation.sql`.

## Not yet implemented

Purchase adapters, atomic wallet debit/refund RPCs, webhook signing/delivery, reseller dashboard, admin approval UI, key rotation/revocation UI, rate limiting, supplier reconciliation and full automated tests. These must be completed before external reseller use.

## Catalogue limitation

The first catalogue adapter is intentionally read-only and best-effort. It does not yet expose MJ Mails offers or every dynamic SMS plan/stock shape. The exact catalogue schema for each supplier must be mapped before order creation is enabled. No generic order endpoint should be enabled until each adapter has a tested compensating/refund strategy.

## Security / operational requirements before launch

- Store only API key hashes; reveal plaintext only at creation.
- Add per-reseller request limits and scoped keys.
- Use transactional SQL functions for reserve/debit/settlement/refund with unique idempotency keys.
- Never call suppliers before the debit reservation commits.
- On supplier timeouts, retain an `unknown` state and reconcile; do not blindly retry purchases.
- Verify supplier terms and allowed resale rights for each category.
