import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  try {
    const apiRes = await fetch('https://fadded.net/api/v1/reseller/products', {
      method: 'GET',
      headers: {
        'X-Api-Key': process.env.FADDED_API_KEY,
        'Accept': 'application/json'
      }
    });

    if (!apiRes.ok) {
      const errorText = await apiRes.text();
      return res.status(apiRes.status).json({ success: false, message: `Supplier API error: ${apiRes.status}`, details: errorText });
    }

    const supplierData = await apiRes.json();
    if (!supplierData.success) {
      return res.status(400).json({ success: false, message: 'Supplier reported failure', error: supplierData });
    }

    for (const item of supplierData.data) {
      const { error } = await supabase.from('products').upsert({
        product_key: item.product_key,
        name: item.name,
        description: item.description,
        price: item.unit_price,
        stock_quantity: item.in_stock,
        is_available: item.in_stock > 0,
        updated_at: new Date().toISOString()
      }, { onConflict: 'product_key' });

      if (error) console.error(`Error updating ${item.product_key}:`, error);
    }

    return res.status(200).json({ success: true, synced: supplierData.data.length });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
} 
