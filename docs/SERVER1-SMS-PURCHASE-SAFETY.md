# Server 1 SMS Purchase Safety: Incident Record and Required Controls

**Scope:** MJ SMS Server 1 only. Server 1 currently has two independent supplier pools:
- **GrizzlySMS**: `source = grizzlysms`, handled by `api/grizzly-sync.js`.
- **HeroSMS**: `source = herosms`, handled by `lib/hero.js` through the Server 1 order route.

Server 3 / VirtualSMS, GotSMS rentals, SMS-BUS rentals, and other wallet flows are out of scope.

## Incident record

Affected account: `parisbrutal82@gmail.com`  
Account UUID: `bde5de27-62cf-429f-a65a-fc5f2c929262`  
Customer reference: `MJ-87AE5D`

Two purchase attempts were identified on 15 November 2026:
- Wallet debit row **481**, approximately 11:52:58 UTC, **₦1,000**.
- Wallet debit row **483**, approximately 12:15:20 UTC, **₦1,000**.

Both debit rows were marked `refunded = true`. The profile balance was **₦2,000** at audit time. No matching `number_orders` rows were found for the account in the audit window, and no matching refund transaction entries were found. This indicates the wallet value had been restored according to the profile balance and debit flags, but the customer-facing financial audit trail was incomplete.

**Do not interpret this as proof of which supplier caused either attempt.** The available evidence establishes two debit/refund cycles, but does not conclusively attribute each attempt to GrizzlySMS or HeroSMS. Supplier attribution requires matching the request IDs, provider IDs, timestamps, and supplier-side activation/history records.

## Code-path findings

### GrizzlySMS

Order path: `api/grizzly-sync.js` → `handleOrder()`.

- Wallet debit is made through `debitWallet()`, which calls the atomic NGN-first/USD-remainder RPC.
- The selected Grizzly provider pool is passed as `providerIds`; the supplier price is passed as `maxPrice`.
- A `NO_NUMBERS` response can trigger one bounded retry without the selected provider ID, still capped by `maxPrice`.
- A clear supplier failure calls `refundWalletDebit()` with the exact debit ID.
- A failed-purchase transaction is inserted on the normal supplier-failure branch.
- **Gap:** if an exception occurs after the debit, the catch block attempts an exact wallet refund but does not write a corresponding failed/refund audit transaction.
- **Gap:** after a supplier activation is returned, failure to persist the `number_orders` row is only logged. The code can continue and respond success even though the durable order record is missing.
- **Gap:** the supplier purchase fetch has no explicit timeout/abort signal. A network timeout can leave the supplier outcome ambiguous: the supplier may have created an activation even though the application did not receive the response.

### HeroSMS

Order path: `api/grizzly-sync.js` → `createHero()` → `lib/hero.js`.

- Hero is an independent second Server 1 supplier pool. It does not automatically fall back to GrizzlySMS.
- Wallet debit is atomic and exact-debit refund uses `refundWalletDebit()`.
- A clear supplier failure attempts an exact refund and writes a failed-purchase transaction.
- **Gap:** an exception after debit attempts the exact refund but does not reliably create a corresponding failed/refund audit transaction.
- **Gap:** after Hero returns an activation ID, failure to persist the `number_orders` row is logged, but the handler can continue as if the order was saved.
- **Gap:** the Hero supplier call has a 30-second timeout. If the supplier accepted the purchase but the response was lost/timed out, blindly refunding can leave a live supplier activation without a customer-visible order.

## Mandatory purchase state machine

Every Server 1 purchase must follow this sequence:

1. **Validate request:** authenticated user, allowed source, service/country, selected provider, current availability, and server-calculated price.
2. **Create durable attempt:** persist a unique request/idempotency key and state `initiated` before calling the supplier. A repeated browser submission with the same key must return the same attempt, never create a second activation or debit.
3. **Atomic debit:** debit once and attach the exact `wallet_debit_id` and NGN/USD split to the attempt.
4. **Supplier call:** call only the selected supplier/pool. Do not silently switch suppliers. Record a sanitized request/response outcome, elapsed time, HTTP status, supplier activation reference, and provider ID. Never log API keys or OTP codes.
5. **Supplier success:** persist the activation and customer order before returning success. If persistence fails, do not discard the activation reference. Mark the attempt `reconciliation_required`, retain the debit, and recover/cancel the supplier activation through a controlled reconciliation job. Do not claim the customer was refunded.
6. **Definitive supplier rejection:** mark `supplier_rejected`, refund the exact debit once, and write/update a linked transaction audit record.
7. **Ambiguous outcome (timeout, connection reset, malformed/truncated response):** mark `outcome_unknown`. Do not immediately refund and do not automatically retry the supplier purchase. Reconcile against supplier activation/history using the idempotency/reference data. If no activation exists, refund the exact debit once. If an activation exists, persist it or cancel it and refund only after cancellation is confirmed.
8. **Response to browser:** return success only after the activation and order are durably recorded. For unresolved outcomes, show a clear “checking purchase status” response and the attempt reference, not a generic error that encourages another purchase.
9. **Refund:** use `refundWalletDebit(user_id, wallet_debit_id)`; never restore profile balance snapshots or match a debit by amount/time. The refund operation must remain idempotent. Write a transaction record linked by `external_reference = wallet_debit_id` and record the final attempt state.
10. **Recovery:** a scheduled/admin reconciliation process must scan old `initiated`, `outcome_unknown`, and `reconciliation_required` attempts, reconcile supplier state, and alert admins when unresolved.

## Required database invariants

- One unique idempotency key per user and Server 1 supplier attempt.
- One wallet debit maximum per attempt.
- One supplier activation maximum per attempt.
- Every debit must resolve to exactly one of: active/completed order, definitively failed + refunded, or explicitly flagged reconciliation-required.
- A refund must reference the original `wallet_debit_id`; duplicate refund attempts must not credit twice.
- No second supplier purchase while the first attempt is `initiated`, `outcome_unknown`, or `reconciliation_required`.
- Transaction history must reflect the actual wallet outcome. A profile balance increase alone is not an adequate refund audit record.
- Preserve the NGN/USD debit split and restore that exact split.
- Supplier keys, raw authorization headers, passwords, and OTP codes must never be written to logs or customer responses.

## Acceptance tests before release

Run against mocked suppliers and a non-production wallet/database fixture. Do not use real customer funds or live supplier stock for fault injection.

1. Supplier returns a definitive no-stock rejection: one debit, one exact refund, one failed transaction record, no order.
2. Supplier returns an activation: one debit, one durable order, one pending transaction, success response.
3. Supplier returns activation but database order insert fails: attempt becomes reconciliation-required; no generic failure response; activation is not lost.
4. Supplier accepts request but response times out: attempt becomes outcome-unknown; no second purchase and no blind refund; reconciliation determines whether to persist or refund.
5. Browser retries same idempotency key: same attempt/result; no second debit or supplier activation.
6. Two concurrent requests with same key: one supplier call and one debit.
7. Refund endpoint called twice/concurrently: one wallet credit and one final refund state.
8. Transaction insert/update fails after wallet refund: attempt remains auditable and an alert/retry repairs the transaction history.
9. Grizzly pool selection: requested provider ID and max price are preserved; fallback is bounded and cannot exceed the quoted supplier cap.
10. Hero purchase failure: does not call Grizzly; Grizzly failure does not call Hero.
11. Network failure before supplier request is sent: safe retry only when the transport layer can prove no request was accepted.
12. All Server 3, GotSMS, SMS-BUS, and unrelated wallet regression tests remain unchanged and pass.

## Release status

This file records the incident and defines the required controls. It is **not evidence that the gaps above have already been implemented**. The current code still needs the durable purchase-attempt/reconciliation mechanism and corresponding automated tests before Server 1 can be described as protected against ambiguous supplier outcomes. Do not mark the incident fully resolved based only on the two wallet debit flags or the current profile balance.
