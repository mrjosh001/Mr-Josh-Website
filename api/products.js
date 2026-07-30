import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const EXCLUDED_KEYS = ['prod_119', 'prod_189', 'prod_187', 'prod_214'];

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
      headers: { 'X-Api-Key': process.env.FADDED_API_KEY, 'Accept': 'application/json' }
    });

    if (!apiRes.ok) {
      const errorText = await apiRes.text();
      return res.status(apiRes.status).json({ success: false, message: `Supplier API error: ${apiRes.status}`, details: errorText });
    }

    const supplierData = await apiRes.json();
    if (!supplierData.success) {
      return res.status(400).json({ success: false, message: 'Supplier reported failure', error: supplierData });
    }

    const products = supplierData.data.filter(item => !EXCLUDED_KEYS.includes(item.product_key));

    for (const item of products) {
      const { error } = await supabase.from('products').upsert({
        product_key: item.product_key,
        name: item.name,
        description: stripHtml(item.description),
        price: item.unit_price,
        stock_quantity: item.in_stock,
        is_available: item.in_stock > 0,
        category: categorize(item.name),
        updated_at: new Date().toISOString()
      }, { onConflict: 'product_key' });
      if (error) console.error(`Error updating ${item.product_key}:`, error);
    }

    return res.status(200).json({ success: true, synced: products.length });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}
