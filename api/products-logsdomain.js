import { createClient } from '@supabase/supabase-js';

/**
 * Sync Logs Domain categories into Supabase products.
 * Manual trigger: GET /api/products-logsdomain (from Admin button)
 *
 * Env: LOGSDOMAIN_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const BASE = 'https://logsdomain.com/api/v1';

function stripHtml(html) {
  if (!html) return '';
  let text = String(html);
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  text = text.replace(/<br\s*\/?>/gi, ' ').replace(/<\/(div|p|li)>/gi, ' ');
  text = text.replace(/<[^>]*>/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

/** Match Fadded-style markup: 50–100%, rounded up to nearest 50 */
function applyRandomMarkup(supplierPrice) {
  const percent = 50 + Math.random() * 50;
  const finalPrice = Math.ceil(Number(supplierPrice) * (1 + percent / 100));
  return Math.ceil(finalPrice / 50) * 50;
}

function categorize(name, parentName) {
  const n = `${name || ''} ${parentName || ''}`.toUpperCase();
  if (n.includes('PROXY')) return '9PROXY (IPS)';
  if (n.includes('VPN') && n.includes('PHONE')) return 'PREMIUM VPN FOR PHONE';
  if (n.includes('VPN')) return 'PREMIUM VPN FOR PC';
  if (n.includes('CHATGPT') || n.includes('DEEPSEEK') || n.includes('AI ')) return 'AI';
  if (n.includes('INSTAGRAM') && n.includes('FOLLOWER')) return 'INSTAGRAM / HIGH FOLLOWERS';
  if (n.includes('INSTAGRAM')) return 'ALL COUNTRIES INSTAGRAM';
  if (n.includes('TIKTOK') || n.includes('TIK TOK')) {
    if (n.includes('FOLLOWER')) return 'TIKTOK/HIGH FOLLOWERS';
    return 'ALL COUNTRIES TIKTOK';
  }
  if (n.includes('DATING')) return 'DATING SITES';
  if (n.includes('FACEBOOK') || n.includes('MARKETPLACE')) {
    if (n.includes('RANDOM')) return 'RANDOM COUNTRY FACEBOOK';
    if (n.includes('0-5') || n.includes('0-30')) return 'COUNTRIES FACEBOOK (0-5 FRIENDS)';
    return 'COUNTRIES FACEBOOK (30+ FRIENDS)';
  }
  if (n.includes('TWITTER') || n.includes(' X ')) return 'X / TWITTER';
  if (n.includes('REDDIT')) return 'REDDIT';
  if (n.includes('SNAPCHAT')) return 'SNAPCHAT';
  if (n.includes('LINKEDIN')) return 'LINKEDIN';
  if (n.includes('GMAIL') || n.includes('HOTMAIL') || n.includes('MAIL')) return 'MAILS';
  if (n.includes('NETFLIX') || n.includes('DISNEY') || n.includes('PRIME')) return 'STREAMING SITE';
  if (n.includes('STEAM')) return 'GAME ACCOUNTS';
  if (parentName) return String(parentName).toUpperCase();
  return 'OTHER';
}

async function fetchAllCategories(apiKey) {
  const all = [];
  let page = 1;
  const perPage = 100;

  // API may return a flat array or paginated object — handle both
  while (page <= 50) {
    const url = `${BASE}/logs/categories?per_page=${perPage}&page=${page}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`
      }
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Logs Domain categories error ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = await res.json();
    if (!json.success) {
      throw new Error(json.message || 'Logs Domain reported failure');
    }

    const batch = Array.isArray(json.data)
      ? json.data
      : (json.data?.data || json.data?.items || []);

    if (!batch.length) break;
    all.push(...batch);

    // Stop if fewer than a full page (no more pages)
    if (batch.length < perPage) break;
    page += 1;
  }

  return all;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({
        success: false,
        message: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'
      });
    }
    if (!process.env.LOGSDOMAIN_API_KEY) {
      return res.status(500).json({
        success: false,
        message: 'Missing LOGSDOMAIN_API_KEY'
      });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const categories = await fetchAllCategories(process.env.LOGSDOMAIN_API_KEY);
    let newCount = 0;
    let updatedCount = 0;

    for (const item of categories) {
      const id = item.id;
      if (id == null) continue;

      const productKey = `ld_${id}`;
      const name = item.name || `Category ${id}`;
      const parentName = item.parent_category?.name || '';
      const cleanDescription = stripHtml(item.description || '');
      const supplierPrice = Number(item.price) || 0;
      const stock = Number(item.available_quantity) || 0;

      const { data: existing } = await supabase
        .from('products')
        .select('product_key, price')
        .eq('product_key', productKey)
        .maybeSingle();

      if (!existing) newCount += 1;
      else updatedCount += 1;

      // Keep existing selling price if already set; only markup on first insert
      const sellingPrice = existing?.price
        ? Number(existing.price)
        : applyRandomMarkup(supplierPrice);

      const row = {
        product_key: productKey,
        name,
        description: cleanDescription,
        display_description: cleanDescription,
        supplier_price: supplierPrice,
        price: sellingPrice,
        stock_quantity: stock,
        is_available: stock > 0,
        category: categorize(name, parentName),
        source: 'logsdomain',
        updated_at: new Date().toISOString()
      };

      const { error } = await supabase
        .from('products')
        .upsert(row, { onConflict: 'product_key' });

      if (error) {
        console.error(`Logs Domain upsert ${productKey}:`, error.message);
      }
    }

    return res.status(200).json({
      success: true,
      synced: categories.length,
      new_products: newCount,
      updated_products: updatedCount,
      source: 'logsdomain'
    });
  } catch (error) {
    console.error('products-logsdomain error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Internal server error'
    });
  }
}
