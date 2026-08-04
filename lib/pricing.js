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
 * Cap: 40-85% markup over supplier cost, live and earning money already —
 * kept deliberately tighter than the old 50-100% range so a bad roll can't
 * ever land at a loss, while a high roll still stays reasonable for the
 * customer.
 */

const MIN_MARKUP_PERCENT = 40;
const MAX_MARKUP_PERCENT = 85;

/**
 * @param {number} supplierPriceUsd - what the supplier charges us, in USD
 * @param {number} usdToNgn - exchange rate to apply (defaults to 1500)
 * @returns {number} final NGN price to charge the customer, rounded up to
 *                    the nearest ₦50 so prices look clean in the UI
 */
export function applyMarkup(supplierPriceUsd, usdToNgn = 1500) {
  const percent = MIN_MARKUP_PERCENT + Math.random() * (MAX_MARKUP_PERCENT - MIN_MARKUP_PERCENT);
  const ngn = Number(supplierPriceUsd) * Number(usdToNgn);
  const finalPrice = Math.ceil(ngn * (1 + percent / 100));
  return Math.ceil(finalPrice / 50) * 50;
}
