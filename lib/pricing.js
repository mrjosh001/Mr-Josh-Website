/**
 * Shared markup logic for SMS number pricing (GrizzlySMS and any future
 * number supplier). Used by:
 *   - api/grizzly-sync.js  — sets a price the first time a service is synced
 *   - api/admin.js         — bulk repricing from the admin panel
 *
 * This file was referenced by both of those but never actually created,
 * which crashed every function that imported it (Node can't resolve a
 * missing ES module) — that's what broke supplier balances, SMS pricing,
 * user editing, product editing, and the daily Grizzly catalog sync all
 * at once, since they all route through api/admin.js.
 *
 * Cap: 60-100% markup over supplier cost. Raised from the original 40-85%
 * band once the ₦500 profit floor below was added, since the floor alone
 * covers the cheap end of the catalog — this wider band pushes margin up
 * across the board, especially on pricier items where the floor doesn't
 * bind.
 *
 * MIN_PROFIT_NGN: a pure percentage markup barely protects cheap items —
 * e.g. a $0.28 supplier cost at 78% markup nets ~₦330, which one refund or
 * support ticket can wipe out several sales' worth of. So the final price
 * is whichever is higher: the percentage markup, or supplier cost + this
 * flat floor. Expensive items are unaffected (percentage already clears
 * the floor); cheap items get pulled up to guarantee a real profit.
 * ₦500 — tune further via MIN_PROFIT_NGN once real PocketFi fee and
 * refund-rate numbers are known, no code change needed.
 */

const MIN_MARKUP_PERCENT = 60;
const MAX_MARKUP_PERCENT = 100;
const MIN_PROFIT_NGN = Number(process.env.MIN_PROFIT_NGN) || 500;
// Absolute floor: no SMS number should ever sell for under this, regardless
// of how cheap the supplier's cost is or what the percentage/profit-floor
// math above works out to. This is a business rule, not a margin target —
// it wins even when the percentage/profit-floor price would clear it.
const MIN_SALE_PRICE_NGN = Number(process.env.MIN_NUMBER_PRICE_NGN) || 1000;

/**
 * @param {number} supplierPriceUsd - what the supplier charges us, in USD
 * @param {number} usdToNgn - exchange rate to apply (defaults to 1500)
 * @returns {number} final NGN price to charge the customer, rounded up to
 *                    the nearest ₦50 so prices look clean in the UI
 */
export function applyMarkup(supplierPriceUsd, usdToNgn) {
  // Prefer explicit rate, then env (same keys as admin overview)
  const rate =
    Number(usdToNgn) ||
    Number(process.env.USD_TO_NGN_RATE) ||
    Number(process.env.USD_TO_NGN) ||
    1500;
  const percent = MIN_MARKUP_PERCENT + Math.random() * (MAX_MARKUP_PERCENT - MIN_MARKUP_PERCENT);
  const supplierNgn = Number(supplierPriceUsd) * rate;
  const percentPrice = Math.ceil(supplierNgn * (1 + percent / 100));
  const floorPrice = Math.ceil(supplierNgn + MIN_PROFIT_NGN);
  const finalPrice = Math.max(percentPrice, floorPrice, MIN_SALE_PRICE_NGN);
  return Math.ceil(finalPrice / 50) * 50;
}
