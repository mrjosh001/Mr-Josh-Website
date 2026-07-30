import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Your channels
const MY_WHATSAPP = 'https://whatsapp.com/channel/0029VbBdXJ2KQuJSJcqcck3o';
const MY_TELEGRAM = 'https://t.me/mj_hub_tg';

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

function replaceChannelLinks(text) {
  if (!text) return text;

  text = text.replace(
    /https?:\/\/(wa\.me\/[^\s]+|api\.whatsapp\.com\/[^\s]+|whatsapp\.com\/[^\s]+|chat\.whatsapp\.com\/[^\s]+)/gi,
    MY_WHATSAPP
  );

  text = text.replace(
    /https?:\/\/(t\.me\/[^\s]+|telegram\.me\/[^\s]+|telegram\.dog\/[^\s]+)/gi,
    MY_TELEGRAM
  );

  return text;
}

/** Random markup between 35% and 50% */
function applyRandomMarkup(supplierPrice) {
  const percent = 35 + Math.random() * 15; // 35 → 50
  const finalPrice = Math.ceil(supplierPrice * (1 + percent / 100));
  // Round up to nearest 50 for cleaner prices (optional)
  return Math.ceil(finalPrice / 50) * 50;
}

function categorize(name) {
  const n = name.toUpperCase();
  if (n.includes('PROXY')) return '9PROXY (IPS)';
  if (n.includes('VPN') && n.includes('PHONE')) return 'PREMIUM VPN FOR PHONE';
  if (n.includes('VPN')) return 'PREMIUM VPN FOR PC';
  if (n.includes('INSTAGRAM') && n.includes('FOLLOWER')) return 'INSTAGRAM / HIGH FOLLOWERS';
  if (n.includes('INSTAGRAM')) return 'ALL COUNTRIES INSTAGRAM';
  if (n.includes('TIKTOK') && n.includes('FOLLOWER')) return 'TIKTOK/HIGH FOLLOWERS';
  if (n.includes('TIKTOK')) return 'ALL COUNTRIES TIKTOK';
  if (n.includes('DATING')) return 'DATING SITES';
  if (n.includes('RANDOM') && n.includes('FACEBOOK')) return 'RANDOM COUNTRY FACEBOOK';
  if (n.includes('FACEBOOK') && (n.includes('0-5') || n.includes('0-30'))) return 'COUNTRIES FACEBOOK (0-5 FRIENDS)';
  if (n.includes('FACEBOOK')) return 'COUNTRIES FACEBOOK (30+ FRIENDS)';
  if (n.includes('TWITTER') || n.includes(' X ') || n.startsWith('X ')) return 'X / TWITTER';
  if (n.includes('REDDIT')) return 'REDDIT';
  if (n.includes('SNAPCHAT')) return 'SNAPCHAT';
  if (n.includes('LINKEDIN')) return 'LINKEDIN';
  if (n.includes('GMAIL') || n.includes('HOTMAIL') || n.includes('GMX') || n.includes('MAIL.RU') || n.includes('TEXPLUS')) return 'MAILS';
  if (n.includes('NETFLIX') || n.includes('DISNEY') || n.includes('PRIME VIDEO') || n.includes('APPLE MUSIC')) return 'STREAMING SITE';
  if (n.includes('STEAM')) return 'GAME ACCOUNTS';
  if (n.includes('GOOGLE VOICE') || n.includes('TEXT FREE') || n.includes('TALKATONE')) return 'TEXTING APP';
  if (n.includes('TWITCH') || n.includes('DISCORD') || n.includes('PINTEREST') || n.includes('QUORA') || n.includes('CANVA') || n.includes('DEEP SEEK')) return 'SOCIAL NETWORKS ACCOUNTS';
  return 'OTHER';
}

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
      return res.status(apiRes.status).json({
        success: false,
        message: `Supplier API error: ${apiRes.status}`,
        details: errorText
      });
    }

    const supplierData = await apiRes.json();
    if (!supplierData.success) {
      return res.status(400).json({
        success: false,
        message: 'Supplier reported failure',
        error: supplierData
      });
    }

    const products = supplierData.data;
    let newCount = 0;
    let updatedCount = 0;

    for (const item of products) {
      const cleanDescription = stripHtml(item.description);
      const displayDescription = replaceChannelLinks(cleanDescription);
      const supplierPrice = Number(item.unit_price) || 0;

      // Check if product already exists
      const { data: existing } = await supabase
        .from('products')
        .select('product_key, price')
        .eq('product_key', item.product_key)
        .maybeSingle();

      const baseData = {
        product_key: item.product_key,
        name: item.name,
        description: cleanDescription,
        display_description: displayDescription,
        supplier_price: supplierPrice,
        stock_quantity: item.in_stock,
        is_available: item.in_stock > 0,
        category: categorize(item.name),
        updated_at: new Date().toISOString()
      };

      if (!existing) {
        // NEW product → apply random 35–50% markup
        baseData.price = applyRandomMarkup(supplierPrice);
        newCount++;
      } else {
        // EXISTING product → do NOT touch price (you can edit it anytime)
        updatedCount++;
      }

      const { error } = await supabase
        .from('products')
        .upsert(baseData, { onConflict: 'product_key' });

      if (error) {
        console.error(`Error updating ${item.product_key}:`, error);
      }
    }

    return res.status(200).json({
      success: true,
      synced: products.length,
      new_products: newCount,
      updated_products: updatedCount
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
}
