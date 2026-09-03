/** Read stock from messy supplier payloads. Boolean "in stock" counts as 1. */

export function readSupplierStock(item) {
  if (!item || typeof item !== 'object') return 0;
  const bags = [item];
  if (item.stock && typeof item.stock === 'object') bags.push(item.stock);
  if (item.inventory && typeof item.inventory === 'object') bags.push(item.inventory);
  if (item.meta && typeof item.meta === 'object') bags.push(item.meta);
  if (item.stats && typeof item.stats === 'object') bags.push(item.stats);
  const keys = [
    'available_quantity',
    'available_qty',
    'available_count',
    'available_stock',
    'quantity_available',
    'qty_available',
    'in_stock_count',
    'in_stock_qty',
    'stock_count',
    'stock_quantity',
    'stock_qty',
    'qty',
    'quantity',
    'stock',
    'available',
    'in_stock',
    'units',
    'count'
  ];
  let best = 0;
  for (const bag of bags) {
    for (const k of keys) {
      if (bag == null || !(k in bag)) continue;
      const v = bag[k];
      if (v === true || v === 'true' || v === 'yes' || v === 'in_stock') {
        if (best < 1) best = 1;
        continue;
      }
      if (v === false || v === 'false' || v === 'no' || v == null || v === '') continue;
      if (typeof v === 'object') continue;
      const n = Number(String(v).replace(/,/g, '').replace(/[^\d.-]/g, ''));
      if (Number.isFinite(n) && n > best) best = Math.floor(n);
    }
  }
  return best;
}

export function shouldShowProduct(stock, adminHidden) {
  if (adminHidden) return false;
  return Number(stock) > 0;
}
