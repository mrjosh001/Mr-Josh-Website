/**
 * Supplier-cost selling price bands for SMS numbers.
 * <$0.10 => ₦400–₦500; $0.10–<$0.50 => ₦600–₦1,000;
 * $0.50–$1.00 => ₦1,100–₦1,500. Above $1 uses cost-plus markup.
 */
const MIN_PROFIT_NGN = Number(process.env.MIN_PROFIT_NGN) || 500;
function resolveRate(usdToNgn) {
  return Number(usdToNgn) || Number(process.env.USD_TO_NGN_RATE) || Number(process.env.USD_TO_NGN) || 1500;
}
function roundBandPrice(value) { return Math.ceil(value / 50) * 50; }
function bandPrice(supplierPriceUsd) {
  const usd = Number(supplierPriceUsd);
  if (!Number.isFinite(usd) || usd <= 0) return 400;
  if (usd < 0.1) return roundBandPrice(400 + (usd / 0.1) * 100);
  if (usd < 0.5) return roundBandPrice(600 + ((usd - 0.1) / 0.4) * 400);
  if (usd <= 1) return roundBandPrice(1100 + ((usd - 0.5) / 0.5) * 400);
  return null;
}
export function applyMarkup(supplierPriceUsd, usdToNgn) {
  const band = bandPrice(supplierPriceUsd);
  if (band != null) return band;
  const supplierNgn = Number(supplierPriceUsd) * resolveRate(usdToNgn);
  return roundBandPrice(Math.max(Math.ceil(supplierNgn * 1.85), Math.ceil(supplierNgn + MIN_PROFIT_NGN)));
}
export function profitFloorNgn(supplierPriceUsd, usdToNgn) { return applyMarkup(supplierPriceUsd, usdToNgn); }
export function saleCoversCost(priceNgn, supplierPriceUsd, usdToNgn) {
  const costNgn = Number(supplierPriceUsd) * resolveRate(usdToNgn);
  const sale = Number(priceNgn);
  if (!(sale > 0)) return false;
  if (!(costNgn > 0) || !Number.isFinite(costNgn)) return true;
  return sale + 0.01 >= costNgn;
}
export function minSaleFromUsd(supplierPriceUsd, usdToNgn) { return profitFloorNgn(supplierPriceUsd, usdToNgn); }
