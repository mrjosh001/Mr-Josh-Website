/**
 * Shared SMS markup (Grizzly, Hero, VirtualSMS, SMS-Bus catalog).
 *
 * 70–100% over supplier USD→NGN
 * + MIN_PROFIT_NGN (₦500)
 * + MIN_SALE_PRICE_NGN (₦1000)
 * + when supplier USD > $0.50 → at least ₦1500
 */

const MIN_MARKUP_PERCENT = 70;
const MAX_MARKUP_PERCENT = 100;
const MIN_PROFIT_NGN = Number(process.env.MIN_PROFIT_NGN) || 500;
const MIN_SALE_PRICE_NGN = Number(process.env.MIN_NUMBER_PRICE_NGN) || 1000;
const MID_COST_USD = Number(process.env.SMS_MID_COST_USD) || 0.5;
const MID_COST_FLOOR_NGN = Number(process.env.SMS_MID_COST_FLOOR_NGN) || 1500;

function resolveRate(usdToNgn) {
  return (
    Number(usdToNgn) ||
    Number(process.env.USD_TO_NGN_RATE) ||
    Number(process.env.USD_TO_NGN) ||
    1500
  );
}

export function applyMarkup(supplierPriceUsd, usdToNgn) {
  const rate = resolveRate(usdToNgn);
  const percent = MIN_MARKUP_PERCENT + Math.random() * (MAX_MARKUP_PERCENT - MIN_MARKUP_PERCENT);
  const supplierNgn = Number(supplierPriceUsd) * rate;
  if (!Number.isFinite(supplierNgn) || supplierNgn <= 0) {
    return Math.ceil(MIN_SALE_PRICE_NGN / 50) * 50;
  }
  const percentPrice = Math.ceil(supplierNgn * (1 + percent / 100));
  const floorPrice = Math.ceil(supplierNgn + MIN_PROFIT_NGN);
  let absolute = MIN_SALE_PRICE_NGN;
  if (Number(supplierPriceUsd) > MID_COST_USD) {
    absolute = Math.max(absolute, MID_COST_FLOOR_NGN);
  }
  const finalPrice = Math.max(percentPrice, floorPrice, absolute);
  return Math.ceil(finalPrice / 50) * 50;
}

export function profitFloorNgn(supplierPriceUsd, usdToNgn) {
  const rate = resolveRate(usdToNgn);
  const supplierNgn = Number(supplierPriceUsd) * rate;
  if (!Number.isFinite(supplierNgn) || supplierNgn <= 0) return 0;
  const midPercent = (MIN_MARKUP_PERCENT + MAX_MARKUP_PERCENT) / 2;
  const percentPrice = Math.ceil(supplierNgn * (1 + midPercent / 100));
  const floorPrice = Math.ceil(supplierNgn + MIN_PROFIT_NGN);
  let absolute = MIN_SALE_PRICE_NGN;
  if (Number(supplierPriceUsd) > MID_COST_USD) {
    absolute = Math.max(absolute, MID_COST_FLOOR_NGN);
  }
  return Math.ceil(Math.max(percentPrice, floorPrice, absolute) / 50) * 50;
}

export function saleCoversCost(priceNgn, supplierPriceUsd, usdToNgn) {
  const rate = resolveRate(usdToNgn);
  const costNgn = Number(supplierPriceUsd) * rate;
  const sale = Number(priceNgn);
  if (!(sale > 0)) return false;
  if (!(costNgn > 0) || !Number.isFinite(costNgn)) return true;
  return sale + 0.01 >= costNgn;
}

export function minSaleFromUsd(supplierPriceUsd, usdToNgn) {
  return profitFloorNgn(supplierPriceUsd, usdToNgn);
}
