import { createClient } from '@supabase/supabase-js';
import { sendPushToUser } from '../lib/push.js';

const ESIM_URL = process.env.ESIM_SUPABASE_URL;
const ESIM_SERVICE_KEY = process.env.ESIM_SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL = 'mjhubhelp@gmail.com';
const MAX_QR_BYTES = 3 * 1024 * 1024; // 3 MB

/**
 * Default plans. These are ALSO the safety net: if the `esim_plans` table does
 * not exist yet (or is empty / unreachable) the site keeps working with these
 * exact prices. Once the table exists, prices are edited from the admin
 * dashboard (eSIM Orders → Plan prices) and this file never needs editing.
 *   amount        = what the customer pays (₦)
 *   supplier_cost = what MJ HUB pays the supplier (₦), used for profit only
 */

/** Supported carrier networks shown on the eSIM checkout. */
const ALLOWED_CARRIERS = {
  tmobile: { id: 'tmobile', label: 'T-Mobile' },
  att: { id: 'att', label: 'AT&T' },
  lyca: { id: 'lyca', label: 'Lyca Mobile' }
};

function normalizeCarrier(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (key === 'tmobile' || key === 'tmo') return ALLOWED_CARRIERS.tmobile;
  if (key === 'att' || key === 'atandt') return ALLOWED_CARRIERS.att;
  if (key === 'lyca' || key === 'lycamobile') return ALLOWED_CARRIERS.lyca;
  return null;
}

/** Base plan durations (T-Mobile default selling prices). */
const DEFAULT_PLANS = [
  { id: '1m',  name: '1 month',  amount: 26000, supplier_cost: 20000, days: 30,  sort: 1, active: true },
  { id: '3m',  name: '3 months', amount: 47000, supplier_cost: 40000, days: 90,  sort: 2, active: true },
  { id: '6m',  name: '6 months', amount: 68000, supplier_cost: 60000, days: 180, sort: 3, active: true },
  { id: '12m', name: '1 year',   amount: 90000, supplier_cost: 80000, days: 365, sort: 4, active: true }
];

/** Per-carrier customer prices (₦). */
const CARRIER_PLAN_PRICES = {
  tmobile: { '1m': 26000, '3m': 47000, '6m': 68000, '12m': 90000 },
  lyca:    { '1m': 24000, '3m': 43000, '6m': 68000, '12m': 90000 },
  att:     { '1m': 28000, '3m': 50000, '6m': 70000, '12m': 92000 }
};

/** Per-carrier supplier cost (₦). Lyca 1m/3m differ; AT&T + rest of Lyca match T-Mobile. */
const CARRIER_SUPPLIER_COST = {
  tmobile: { '1m': 20000, '3m': 40000, '6m': 60000, '12m': 80000 },
  att:     { '1m': 20000, '3m': 40000, '6m': 60000, '12m': 80000 },
  lyca:    { '1m': 17000, '3m': 36000, '6m': 60000, '12m': 80000 }
};

const PLAN_DAYS = { '1m': 30, '3m': 90, '6m': 180, '12m': 365 };

const supabase = ESIM_URL && ESIM_SERVICE_KEY
  ? createClient(ESIM_URL, ESIM_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    })
  : null;

async function notifyUserPush(userId, title, body, url, type) {
  if (!userId) return;
  try {
    await sendPushToUser(supabase, userId, {
      title: String(title || 'MJ HUB').slice(0, 80),
      body: String(body || '').slice(0, 180),
      url: url || '/dashboard.html',
      type: String(type || 'activity').slice(0, 40)
    });
  } catch (e) { console.warn('[push]', e?.message || e); }
}

/**
 * Plans = defaults, then optional esim_plans table overrides (T-Mobile base),
 * then per-carrier selling prices when carrierId is provided.
 */
async function getPlans(carrierId) {
  const defaults = DEFAULT_PLANS.map((p) => ({ ...p }));
  try {
    if (supabase) {
      const { data, error } = await supabase.from('esim_plans').select('*');
      if (!error && Array.isArray(data) && data.length) {
        const byId = new Map(defaults.map((p) => [p.id, p]));
        for (const row of data) {
          const base = byId.get(String(row.id));
          if (!base) continue;
          const amount = Number(row.amount_ngn);
          const cost = Number(row.supplier_cost_ngn);
          if (Number.isFinite(amount) && amount > 0) base.amount = amount;
          if (Number.isFinite(cost) && cost >= 0) base.supplier_cost = cost;
          base.active = row.is_active !== false;
        }
      }
    }
  } catch (e) {
    console.error('[esim plans] falling back to defaults:', e?.message || e);
  }

  const cid = String(carrierId || '').toLowerCase();
  const priceMap = CARRIER_PLAN_PRICES[cid];
  const costMap = CARRIER_SUPPLIER_COST[cid];
  if (priceMap || costMap) {
    for (const p of defaults) {
      if (priceMap && priceMap[p.id] != null) p.amount = Number(priceMap[p.id]);
      if (costMap && costMap[p.id] != null) p.supplier_cost = Number(costMap[p.id]);
    }
  }
  return defaults;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function formatNgn(value) {
  return '₦' + Number(value || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 });
}

/**
 * Send through Resend. `attachments` is optional:
 *   [{ filename, content (base64), content_id? }]
 * An attachment with content_id is embedded in the body via <img src="cid:...">.
 */
/** Display name in the inbox, e.g. "MJ HUB Wireless <orders@domain>". */
function fromAddress(displayName) {
  const base = String(process.env.RESEND_FROM_EMAIL || '').trim();
  if (!base) return base;
  const m = base.match(/<([^>]+)>/);
  const addr = (m ? m[1] : base).trim();
  if (!displayName || !addr) return base;
  return String(displayName).replace(/[<>]/g, '').trim() + ' <' + addr + '>';
}

async function sendEmail({ to, subject, html, attachments, replyTo, fromName }) {
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) {
    throw new Error('Resend is not configured for this deployment');
  }
  const payload = {
    from: fromName ? fromAddress(fromName) : process.env.RESEND_FROM_EMAIL,
    to: [to],
    subject,
    html
  };
  if (Array.isArray(attachments) && attachments.length) payload.attachments = attachments;
  if (replyTo) payload.reply_to = replyTo;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.message || 'Resend rejected the email (' + response.status + ')');
  }
  return result;
}

async function sendOrderEmails(order) {
  const orderRef = escapeHtml(order.order_ref);
  const planName = escapeHtml(order.plan_name);
  const email = escapeHtml(order.customer_email);
  const imei = escapeHtml(order.imei);
  const amount = formatNgn(order.amount_ngn);
  const carrierRaw = order.carrier_label || order.carrier || (String(order.plan_name || '').split('·')[0] || '').trim() || '—';
  const carrier = escapeHtml(carrierRaw);
  const createdAt = new Date(order.created_at || Date.now()).toLocaleString('en-NG', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Lagos'
  });
  const createdAtSafe = escapeHtml(createdAt);

  let fullName = '';
  if (order.user_id) {
    try {
      const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', order.user_id).maybeSingle();
      fullName = String(profile?.full_name || '').trim();
    } catch (_) {}
  }

  const invoiceHtml = buildInvoiceEmail({
    fullName,
    orderRef: order.order_ref,
    planName: order.plan_name,
    carrier: carrierRaw,
    email: order.customer_email,
    imei: order.imei,
    amountNgn: order.amount_ngn,
    createdAt,
    createdIso: order.created_at || new Date().toISOString()
  });

  const adminHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#172033;line-height:1.6">
      <h2 style="color:#315fe8">New eSIM order</h2>
      <p>Customer paid. Deliver when the line is ready.</p>
      <table style="border-collapse:collapse;width:100%">
        <tr><td style="padding:9px;border-bottom:1px solid #e5e7eb">Order</td><td style="padding:9px;border-bottom:1px solid #e5e7eb"><strong>${orderRef}</strong></td></tr>
        <tr><td style="padding:9px;border-bottom:1px solid #e5e7eb">Plan</td><td style="padding:9px;border-bottom:1px solid #e5e7eb">${planName}</td></tr>
        <tr><td style="padding:9px;border-bottom:1px solid #e5e7eb">Network</td><td style="padding:9px;border-bottom:1px solid #e5e7eb">${carrier}</td></tr>
        <tr><td style="padding:9px;border-bottom:1px solid #e5e7eb">Amount</td><td style="padding:9px;border-bottom:1px solid #e5e7eb">${amount}</td></tr>
        <tr><td style="padding:9px;border-bottom:1px solid #e5e7eb">Customer</td><td style="padding:9px;border-bottom:1px solid #e5e7eb">${email}</td></tr>
        <tr><td style="padding:9px;border-bottom:1px solid #e5e7eb">IMEI</td><td style="padding:9px;border-bottom:1px solid #e5e7eb">${imei}</td></tr>
        <tr><td style="padding:9px;border-bottom:1px solid #e5e7eb">Paid at</td><td style="padding:9px;border-bottom:1px solid #e5e7eb">${createdAtSafe}</td></tr>
      </table>
      <p style="margin-top:14px">Admin → eSIM Orders → upload QR → Deliver.</p>
    </div>`;

  if (!order.customer_email_sent_at) {
    try {
      await sendEmail({
        to: order.customer_email,
        subject: 'Invoice for Your Recent Purchase',
        html: invoiceHtml,
        fromName: 'MJ HUB Wireless'
      });
      await supabase.from('esim_orders')
        .update({ customer_email_sent_at: new Date().toISOString() })
        .eq('id', order.id);
    } catch (e) {
      console.error('[esim invoice]', e?.message || e);
      throw e;
    }
  }
  if (!order.admin_email_sent_at) {
    try {
      await sendEmail({
        to: ADMIN_EMAIL,
        subject: 'New eSIM order ' + order.order_ref,
        html: adminHtml
      });
      await supabase.from('esim_orders')
        .update({ admin_email_sent_at: new Date().toISOString() })
        .eq('id', order.id);
    } catch (e) {
      console.error('[esim admin alert]', e?.message || e);
    }
  }
  await supabase.from('esim_orders').update({ email_error: null }).eq('id', order.id);
  const { data: latest } = await supabase.from('esim_orders')
    .select('customer_email_sent_at, admin_email_sent_at')
    .eq('id', order.id)
    .maybeSingle();
  return {
    customer: Boolean(latest?.customer_email_sent_at),
    admin: Boolean(latest?.admin_email_sent_at)
  };
}

function brandHeader(subtitle) {
  return `
    <div style="background:#0b1220;padding:28px 24px 12px;text-align:center;border-bottom:1px solid #1e293b">
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:800;letter-spacing:0.04em;color:#60a5fa">MJ HUB Wireless</div>
      ${subtitle ? `<div style="font-family:Arial,sans-serif;font-size:12px;color:#94a3b8;margin-top:6px">${subtitle}</div>` : ''}
    </div>`;
}

function brandFooter() {
  return `
    <div style="background:#0b1220;padding:18px 24px;border-top:3px solid #2563eb;font-family:Arial,sans-serif;font-size:12px;color:#94a3b8;text-align:center">
      <div style="margin-bottom:4px">MJ HUB · www.mjhub.store</div>
      <div>Support: reply to this email</div>
    </div>`;
}

/** EMAIL 1 — Invoice */
function buildInvoiceEmail({ fullName, orderRef, planName, carrier, email, imei, amountNgn, createdAt, createdIso }) {
  const name = escapeHtml(String(fullName || '').trim());
  const greeting = name ? 'Dear ' + name + ',' : 'Hello,';
  const ref = escapeHtml(orderRef || '');
  const plan = escapeHtml(planName || 'eSIM plan');
  const car = escapeHtml(carrier || '—');
  const im = escapeHtml(imei || '—');
  const when = escapeHtml(createdAt || '');
  const amtNum = Number(amountNgn || 0);
  const amt = escapeHtml(formatNgn(amtNum));
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Order',
    orderNumber: String(orderRef || ''),
    orderStatus: 'https://schema.org/OrderProcessing',
    orderDate: String(createdIso || new Date().toISOString()),
    priceCurrency: 'NGN',
    price: String(amtNum),
    merchant: { '@type': 'Organization', name: 'MJ HUB Wireless', url: 'https://www.mjhub.store' },
    customer: { '@type': 'Person', email: String(email || ''), name: String(fullName || '') },
    acceptedOffer: {
      '@type': 'Offer',
      itemOffered: { '@type': 'Product', name: String(planName || 'eSIM') + (carrier ? ' · ' + carrier : '') },
      price: String(amtNum),
      priceCurrency: 'NGN'
    },
    url: 'https://www.mjhub.store/esim-orders.html'
  };
  const jsonLdStr = JSON.stringify(jsonLd).replace(/</g, '\\u003c');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <script type="application/ld+json">${jsonLdStr}</script>
</head>
<body style="margin:0;padding:0;background:#0f172a">
  <div style="max-width:600px;margin:0 auto;font-family:Georgia,'Times New Roman',serif;color:#e2e8f0">
    ${brandHeader('')}
    <div style="background:#1e293b;padding:28px 24px;text-align:center">
      <h1 style="margin:0;font-size:28px;font-weight:400;color:#93c5fd">Invoice Summary</h1>
    </div>
    <div style="background:#0f172a;padding:28px 24px 32px;font-size:16px;line-height:1.7">
      <p style="margin:0 0 16px">${greeting}</p>
      <p style="margin:0 0 20px">Thank you for choosing MJ HUB Wireless. We appreciate your business. Below is a summary of your recent purchase:</p>
      <ul style="margin:0 0 22px;padding-left:20px;color:#cbd5e1">
        <li style="margin-bottom:8px">Order ID: <strong style="color:#fff">#${ref}</strong></li>
        <li style="margin-bottom:8px">Payment Method: <strong style="color:#fff">MJ HUB Wallet</strong></li>
        <li style="margin-bottom:8px">Order Date: <strong style="color:#fff">${when}</strong></li>
        <li style="margin-bottom:8px">Network: <strong style="color:#fff">${car}</strong></li>
        <li style="margin-bottom:8px">Plan: <strong style="color:#fff">${plan}</strong></li>
        <li style="margin-bottom:8px">IMEI: <strong style="color:#fff">${im}</strong></li>
        <li style="margin-bottom:8px">Total Amount: <strong style="color:#60a5fa;font-size:18px">${amt}</strong></li>
      </ul>
      <p style="margin:0 0 16px">Your payment is confirmed. Your eSIM is being prepared. You will receive a welcome message and your QR code by email when the line is ready.</p>
      <p style="margin:0 0 16px">Order history: <a href="https://www.mjhub.store/esim-orders.html" style="color:#60a5fa">View eSIM orders</a></p>
      <p style="margin:0 0 20px">If you have any questions, reply to this email. We are here to help.</p>
      <p style="margin:0">Best regards,<br>The MJ HUB Wireless Team</p>
    </div>
    ${brandFooter()}
  </div>
</body>
</html>`;
}

/** EMAIL 2 — Welcome */
function buildWelcomeEmail({ fullName, orderRef, planName, carrier }) {
  const name = escapeHtml(String(fullName || '').trim());
  const greeting = name ? 'Dear ' + name + ',' : 'Hello,';
  const ref = escapeHtml(orderRef || '');
  const plan = escapeHtml(planName || '');
  const car = escapeHtml(carrier || '');
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a">
  <div style="max-width:600px;margin:0 auto;font-family:Georgia,'Times New Roman',serif;color:#e2e8f0">
    ${brandHeader('')}
    <div style="background:#1e293b;padding:28px 24px;text-align:center">
      <h1 style="margin:0;font-size:26px;font-weight:400;color:#93c5fd">Welcome to MJ HUB Wireless</h1>
    </div>
    <div style="background:#0f172a;padding:28px 24px 32px;font-size:16px;line-height:1.7">
      <p style="margin:0 0 16px">${greeting}</p>
      <p style="margin:0 0 16px">Thank you for choosing MJ HUB Wireless. Your order is confirmed and your line is being set up.</p>
      <p style="margin:0 0 16px">In a separate email you will receive your eSIM QR code, your number when it is assigned, and clear install steps for iPhone and Android.</p>
      <p style="margin:0 0 8px"><strong style="color:#fff">Your order</strong></p>
      <ul style="margin:0 0 20px;padding-left:20px;color:#cbd5e1">
        <li style="margin-bottom:6px">Order ID: <strong style="color:#fff">#${ref}</strong></li>
        <li style="margin-bottom:6px">Plan: <strong style="color:#fff">${plan}</strong></li>
        ${car ? `<li style="margin-bottom:6px">Network: <strong style="color:#fff">${car}</strong></li>` : ''}
      </ul>
      <p style="margin:0 0 8px"><strong style="color:#fff">Manage your order</strong></p>
      <ol style="margin:0 0 20px;padding-left:20px;color:#cbd5e1">
        <li style="margin-bottom:8px">Sign in at <a href="https://www.mjhub.store" style="color:#60a5fa">www.mjhub.store</a></li>
        <li style="margin-bottom:8px">Open eSIM orders on your dashboard</li>
        <li style="margin-bottom:0">Keep this email for your records</li>
      </ol>
      <p style="margin:0 0 20px">If you need help, reply to this email. Our support team will assist you.</p>
      <p style="margin:0">Best regards,<br>The MJ HUB Wireless Team</p>
    </div>
    ${brandFooter()}
  </div>
</body>
</html>`;
}

/**
 * EMAIL 3 — QR + install guide (your real activation steps)
 */
function buildDeliveryEmail({ fullName, orderRef, planName, phone, carrier, imei }) {
  const name = escapeHtml(String(fullName || '').trim());
  const greeting = name ? 'Dear ' + name + ',' : 'Hello,';
  const ref = escapeHtml(orderRef || '');
  const plan = escapeHtml(planName || '');
  const car = escapeHtml(carrier || '');
  const im = escapeHtml(imei || '');
  const phoneBlock = phone
    ? `<p style="margin:0 0 18px;text-align:center;font-size:16px">Phone Number<br><strong style="color:#93c5fd;font-size:22px;letter-spacing:0.03em">${escapeHtml(phone)}</strong></p>`
    : '';
  const imeiBlock = im
    ? `<p style="margin:0 0 18px;padding:14px 16px;background:#1c1917;border:1px solid #92400e;border-radius:8px;font-size:14px;color:#fde68a;line-height:1.55"><strong>Important:</strong> This eSIM will only activate on IMEI <strong>${im}</strong>. Do not remove or delete the eSIM after install.</p>`
    : '';

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a">
  <div style="max-width:600px;margin:0 auto;font-family:Georgia,'Times New Roman',serif;color:#e2e8f0">
    ${brandHeader('')}
    <div style="background:#1e293b;padding:28px 24px;text-align:center">
      <h1 style="margin:0;font-size:26px;font-weight:400;color:#93c5fd">eSIM QR Code</h1>
    </div>
    <div style="background:#0f172a;padding:28px 24px 32px;font-size:16px;line-height:1.7">
      <p style="margin:0 0 16px">${greeting}</p>
      <p style="margin:0 0 18px">Your eSIM QR code is ready. Follow the steps below to set up your line.</p>
      ${phoneBlock}
      <p style="margin:0 0 12px;text-align:center;font-weight:700;color:#fff;font-family:Arial,sans-serif">eSIM QR Code</p>
      <div style="text-align:center;margin:0 0 22px">
        <img src="cid:esim-qr" alt="eSIM QR code" width="240" style="width:240px;max-width:100%;height:auto;border:0;display:inline-block;background:#ffffff;padding:14px;border-radius:8px">
      </div>
      ${imeiBlock}

      <div style="margin:0 0 16px;padding:16px 18px;background:#1e293b;border-radius:10px">
        <p style="margin:0 0 12px;font-family:Arial,sans-serif;font-weight:700;color:#93c5fd">How to install</p>
        <ol style="margin:0;padding-left:18px;color:#cbd5e1;font-size:15px">
          <li style="margin-bottom:10px">Connect <strong style="color:#fff">Super VPN</strong> and set location to <strong style="color:#fff">USA Dallas</strong></li>
          <li style="margin-bottom:10px">Go to <strong style="color:#fff">Settings → Cellular → Add eSIM</strong></li>
          <li style="margin-bottom:10px">Tap <strong style="color:#fff">Use QR code</strong> and scan the code above (or use the activation notification if your phone shows one)</li>
          <li style="margin-bottom:10px">After activation, turn on <strong style="color:#fff">WiFi Calling</strong></li>
          <li style="margin-bottom:10px">Add a <strong style="color:#fff">USA address</strong> when asked, then continue</li>
          <li style="margin-bottom:0">You are ready. Your eSIM is fully functional</li>
        </ol>
      </div>

      <p style="margin:0 0 16px;padding:14px 16px;background:#0b1220;border:1px solid #334155;border-radius:8px;font-size:14px;color:#cbd5e1;line-height:1.55">
        <strong style="color:#fff">Note:</strong> If WiFi Calling will not turn on, switch the phone off, turn it back on, then try again.
      </p>

      <p style="margin:0 0 8px;font-size:14px;color:#94a3b8;font-family:Arial,sans-serif">Order #${ref}${plan ? ' · ' + plan : ''}${car ? ' · ' + car : ''}</p>
      <p style="margin:0 0 16px;font-size:14px;color:#94a3b8">A copy of the QR code is attached. Do not share it. Contact support if you face any issue.</p>
      <p style="margin:0">Best regards,<br>The MJ HUB Wireless Team</p>
    </div>
    ${brandFooter()}
  </div>
</body>
</html>`;
}

async function isAdminUser(user) {
  const { data: adminProfile } = await supabase.from('profiles')
    .select('is_admin')
    .eq('id', user.id)
    .maybeSingle();
  const flag = adminProfile && adminProfile.is_admin;
  return flag === true || flag === 'true' || flag === 1
    || String(user.email || '').toLowerCase() === ADMIN_EMAIL;
}

async function handleDeliver(body, adminUser, res) {
  const orderId = String(body.order_id || '').trim();
  if (!/^[0-9a-f-]{8,40}$/i.test(orderId)) {
    return res.status(400).json({ success: false, message: 'Missing or invalid order.' });
  }
  const resend = body.resend === true;
  const phone = String(body.phone || '').replace(/[^0-9+ ()-]/g, '').trim().slice(0, 24);

  const { data: order, error: orderError } = await supabase.from('esim_orders')
    .select('*')
    .eq('id', orderId)
    .maybeSingle();
  if (orderError || !order) {
    return res.status(404).json({ success: false, message: 'eSIM order not found.' });
  }
  if (/^(failed|cancelled|canceled|expired|refunded)$/i.test(String(order.status || ''))) {
    return res.status(400).json({ success: false, message: 'This order is ' + order.status + ' and cannot be delivered.' });
  }
  if (/^completed$/i.test(String(order.status || '')) && !resend) {
    return res.status(409).json({ success: false, message: 'This eSIM was already delivered. Use Resend if you need to send it again.' });
  }
  const customerEmail = String(order.customer_email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    return res.status(400).json({ success: false, message: 'This order has no valid customer email.' });
  }

  // The QR image comes straight from the admin dashboard upload; it is emailed and never stored.
  const qr = decodeQrDataUrl(body.qr_image);
  if (!qr) {
    return res.status(400).json({ success: false, message: 'Upload the eSIM QR code image first (PNG, JPG or WEBP under 3 MB).' });
  }

  // The customer's exact name as saved on their MJ HUB account.
  let fullName = '';
  if (order.user_id) {
    const { data: profile } = await supabase.from('profiles')
      .select('full_name')
      .eq('id', order.user_id)
      .maybeSingle();
    fullName = String(profile?.full_name || '').trim();
  }

  const base64 = qr.buffer.toString('base64');
  const carrierLabel = order.carrier_label || order.carrier || '';
  const welcomeHtml = buildWelcomeEmail({
    fullName,
    orderRef: order.order_ref,
    planName: order.plan_name,
    carrier: carrierLabel
  });
  const html = buildDeliveryEmail({
    fullName,
    orderRef: order.order_ref,
    planName: order.plan_name,
    phone,
    carrier: carrierLabel,
    imei: order.imei
  });

  try {
    await sendEmail({
      to: customerEmail,
      subject: 'Welcome to MJ HUB Wireless',
      html: welcomeHtml,
      replyTo: ADMIN_EMAIL,
      fromName: 'MJ HUB Wireless'
    });
    await sendEmail({
      to: customerEmail,
      subject: 'Set Up Your eSIM – Your QR Code is Ready',
      html,
      replyTo: ADMIN_EMAIL,
      fromName: 'MJ HUB Wireless',
      attachments: [
        { filename: 'esim-qr-inline.' + qr.ext, content: base64, content_id: 'esim-qr' },
        { filename: 'esim-qr-code.' + qr.ext, content: base64 }
      ]
    });
  } catch (error) {
    console.error('[esim deliver] email failed for ' + order.order_ref + ':', error?.message || error);
    await supabase.from('esim_orders').update({ email_error: String(error?.message || error).slice(0, 1000) }).eq('id', order.id);
    return res.status(502).json({ success: false, message: 'The email could not be sent: ' + (error?.message || 'unknown error') + '. Nothing was marked as delivered.' });
  }

  // Only the existing status column is touched, so no database migration is needed.
  const { error: updateError } = await supabase.from('esim_orders')
    .update({ status: 'completed', email_error: null })
    .eq('id', order.id);
  if (updateError) {
    return res.status(200).json({
      success: true,
      emailed: true,
      warning: 'Email sent to the customer, but the order status could not be updated: ' + updateError.message
    });
  }

  if (order.user_id) {
    await notifyUserPush(
      order.user_id,
      'Your eSIM is ready',
      'Check your email for the QR code and setup guide.',
      '/dashboard.html',
      'esim'
    );
  }
  return res.status(200).json({
    success: true,
    emailed: true,
    message: 'Welcome + eSIM emails sent to ' + customerEmail
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  if (!ESIM_URL || !ESIM_SERVICE_KEY || !supabase) {
    return res.status(503).json({
      success: false,
      message: 'eSIM checkout is not configured yet. Please contact MJ HUB support.'
    });
  }

  try {
    const authHeader = req.headers.authorization || req.headers.Authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token || token.includes('service_role')) {
      return res.status(401).json({ success: false, message: 'Please sign in again.' });
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ success: false, message: 'Your session has expired. Please sign in again.' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    // ---- Customer: live plan list for the eSIM page (selling prices only — never supplier cost) ----
    if (String(body.action || '') === 'my_orders') {
      const { data, error } = await supabase
        .from('esim_orders')
        .select('id,order_ref,plan_id,plan_name,amount_ngn,imei,wallet_ngn_debited,wallet_usd_debited,status,created_at,customer_email')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) {
        console.error('[esim my_orders]', error);
        return res.status(500).json({ success: false, message: 'Could not load your eSIM orders.' });
      }
      return res.status(200).json({ success: true, orders: data || [] });
    }

    if (String(body.action || '') === 'plans') {
      const carrierInfo = normalizeCarrier(body.carrier) || ALLOWED_CARRIERS.tmobile;
      const plans = await getPlans(carrierInfo.id);
      return res.status(200).json({
        success: true,
        carrier: carrierInfo.id,
        plans: plans
          .filter((p) => p.active)
          .map((p) => ({ id: p.id, name: p.name, amount_ngn: p.amount, days: p.days }))
      });
    }

    // ---- Admin: plan prices incl. supplier cost (drives the "Plan prices" editor + profit) ----
    if (String(body.action || '') === 'admin_plans') {
      if (!(await isAdminUser(user))) {
        return res.status(403).json({ success: false, message: 'Admin privileges required' });
      }
      const plans = await getPlans();
      const { error: tableError } = await supabase.from('esim_plans').select('id').limit(1);
      return res.status(200).json({
        success: true,
        table_ready: !tableError,
        plans: plans.map((p) => ({
          id: p.id,
          name: p.name,
          days: p.days,
          amount_ngn: p.amount,
          supplier_cost_ngn: p.supplier_cost,
          is_active: p.active
        }))
      });
    }

    // ---- Admin: save plan prices ----
    if (String(body.action || '') === 'admin_save_plans') {
      if (!(await isAdminUser(user))) {
        return res.status(403).json({ success: false, message: 'Admin privileges required' });
      }
      const incoming = Array.isArray(body.plans) ? body.plans : [];
      const rows = [];
      for (const item of incoming) {
        const base = DEFAULT_PLANS.find((p) => p.id === String(item && item.id));
        if (!base) continue;
        const amount = Math.round(Number(item.amount_ngn));
        const cost = Math.round(Number(item.supplier_cost_ngn));
        if (!Number.isFinite(amount) || amount < 1000 || amount > 5000000) {
          return res.status(400).json({ success: false, message: 'Enter a valid selling price for ' + base.name + '.' });
        }
        if (!Number.isFinite(cost) || cost < 0 || cost > 5000000) {
          return res.status(400).json({ success: false, message: 'Enter a valid supplier price for ' + base.name + '.' });
        }
        rows.push({
          id: base.id,
          name: base.name,
          days: base.days,
          sort_order: base.sort,
          amount_ngn: amount,
          supplier_cost_ngn: cost,
          is_active: item.is_active !== false,
          updated_at: new Date().toISOString()
        });
      }
      if (!rows.length) {
        return res.status(400).json({ success: false, message: 'No plans to save.' });
      }
      const { error: saveError } = await supabase.from('esim_plans').upsert(rows, { onConflict: 'id' });
      if (saveError) {
        console.error('[esim plans] save failed:', saveError.message);
        return res.status(500).json({
          success: false,
          message: 'Could not save prices: ' + saveError.message + ' (If the esim_plans table does not exist yet, run the SQL in esim-plans.sql in the eSIM Supabase project first.)'
        });
      }
      return res.status(200).json({ success: true, message: 'Plan prices saved. The eSIM page now shows them.' });
    }

    // ---- Admin: list eSIM orders (read-only) — used by the admin dashboard "eSIM Orders" page ----
    if (String(body.action || '') === 'admin_orders') {
      if (!(await isAdminUser(user))) {
        return res.status(403).json({ success: false, message: 'Admin privileges required' });
      }

      const page = Math.max(1, parseInt(body.page, 10) || 1);
      const pageSize = Math.min(100, Math.max(10, parseInt(body.page_size, 10) || 50));
      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const q = String(body.q || '').replace(/[%_,()]/g, ' ').trim();

      let query = supabase.from('esim_orders')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);
      if (q) {
        query = query.or(
          'order_ref.ilike.%' + q + '%,customer_email.ilike.%' + q + '%,imei.ilike.%' + q + '%,plan_name.ilike.%' + q + '%'
        );
      }
      const { data, error, count } = await query;
      if (error) {
        console.error('[esim admin] list failed:', error.message);
        return res.status(500).json({ success: false, message: 'Could not load eSIM orders' });
      }

      // Attach each customer's saved name so the admin sees who to deliver to.
      const rows = data || [];
      const userIds = [...new Set(rows.map((row) => row.user_id).filter(Boolean))];
      let names = {};
      if (userIds.length) {
        const { data: profiles } = await supabase.from('profiles')
          .select('id, full_name')
          .in('id', userIds);
        names = Object.fromEntries((profiles || []).map((p) => [p.id, p.full_name || '']));
      }
      const out = rows.map((row) => ({ ...row, full_name: names[row.user_id] || '' }));

      return res.status(200).json({
        success: true,
        data: out,
        total: count || 0,
        page,
        page_size: pageSize
      });
    }

    // ---- Admin: deliver (or re-send) the eSIM QR email ----
    if (String(body.action || '') === 'deliver') {
      if (!(await isAdminUser(user))) {
        return res.status(403).json({ success: false, message: 'Admin privileges required' });
      }
      return handleDeliver(body, user, res);
    }

    const planId = String(body.plan_id || '');
    const carrierInfo = normalizeCarrier(body.carrier);
    if (!carrierInfo) return res.status(400).json({ success: false, message: 'Choose a carrier network (T-Mobile, AT&T, or Lyca Mobile).' });
    const plans = await getPlans(carrierInfo.id);
    const plan = plans.find((p) => p.id === planId && p.active);
    const imei = String(body.imei || '').replace(/\D/g, '');
    const requestId = String(body.request_id || '');
    if (!plan) return res.status(400).json({ success: false, message: 'Choose a valid eSIM plan.' });
    if (!/^\d{15}$/.test(imei)) return res.status(400).json({ success: false, message: 'Enter a valid 15-digit IMEI.' });
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      return res.status(400).json({ success: false, message: 'Invalid checkout request. Refresh and try again.' });
    }
    // If the admin changed the price after the customer loaded the page, never charge a
    // different amount than the one the customer saw: stop and ask them to review it.
    const expectedAmount = Number(body.expected_amount);
    if (Number.isFinite(expectedAmount) && expectedAmount > 0 && expectedAmount !== plan.amount) {
      return res.status(409).json({
        success: false,
        code: 'PRICE_CHANGED',
        message: 'The price of this plan has just changed to ' + formatNgn(plan.amount) + '. Nothing was charged. Please refresh the page and review the new price.'
      });
    }
    const customerEmail = String(user.email || '').trim().toLowerCase();
    if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
      return res.status(400).json({ success: false, message: 'Your account has no valid email address. Contact support.' });
    }

    const usdRate = Number(process.env.WALLET_USD_RATE) || 1450;
    const planLabel = carrierInfo.label + ' · ' + plan.name;
    const { data: rpcData, error: rpcError } = await supabase.rpc('create_esim_wallet_order', {
      p_user_id: user.id,
      p_plan_id: planId,
      p_plan_name: planLabel,
      p_amount_ngn: plan.amount,
      p_imei: imei,
      p_customer_email: customerEmail,
      p_request_id: requestId,
      p_usd_rate: usdRate
    });
    if (rpcError) {
      const message = String(rpcError.message || '');
      if (/INSUFFICIENT_WALLET/i.test(message)) {
        const { data: profile } = await supabase.from('profiles')
          .select('balance,balance_usd')
          .eq('id', user.id).maybeSingle();
        return res.status(402).json({
          success: false,
          code: 'INSUFFICIENT_WALLET',
          message: 'Your combined NGN and USD wallet balance is not enough for this plan.',
          balance_ngn: Number(profile?.balance || 0),
          balance_usd: Number(profile?.balance_usd || 0),
          required_ngn: plan.amount
        });
      }
      if (/PROFILE_NOT_FOUND/i.test(message)) {
        return res.status(404).json({ success: false, message: 'Your MJ HUB wallet profile was not found.' });
      }
      if (/REQUEST_ID_CONFLICT/i.test(message)) {
        return res.status(409).json({ success: false, message: 'This checkout request has already been used. Refresh and try again.' });
      }
      if (/INVALID_ORDER/i.test(message)) {
        return res.status(400).json({ success: false, message: 'The eSIM order details are invalid. Check them and try again.' });
      }
      console.error('[esim checkout] wallet order RPC failed:', message);
      return res.status(500).json({ success: false, message: 'We could not complete the wallet payment. No order was placed.' });
    }

    const orderData = Array.isArray(rpcData) ? rpcData[0] : rpcData;
    if (!orderData?.success || !orderData?.order_id) {
      return res.status(500).json({ success: false, message: 'The wallet did not confirm this order. Please contact support before retrying.' });
    }

    const [{ data: order }, { data: profile }] = await Promise.all([
      supabase.from('esim_orders').select('*').eq('id', orderData.order_id).maybeSingle(),
      supabase.from('profiles').select('balance,balance_usd').eq('id', user.id).maybeSingle()
    ]);
    if (!order) {
      return res.status(500).json({ success: false, message: 'Your payment was recorded but the order could not be loaded. Contact support with reference ' + orderData.order_ref + '.' });
    }

    // Persist carrier when column exists (non-fatal if migration not applied yet)
    try {
      await supabase.from('esim_orders').update({
        carrier: carrierInfo.id,
        plan_name: planLabel
      }).eq('id', order.id);
      order.carrier = carrierInfo.id;
      order.plan_name = planLabel;
    } catch (e) {
      console.warn('[esim] carrier column optional:', e?.message || e);
    }

    const emailStatus = await sendOrderEmails({
      ...order,
      full_name: (await supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle()).data?.full_name || ''
    }).catch((error) => {
      console.error('[esim email] Order ' + order.order_ref + ':', error?.message || error);
      return { customer: false, admin: false };
    });

    await notifyUserPush(
      order.user_id,
      'eSIM order received',
      (order.plan_name || 'Your eSIM') + ' is being processed.',
      '/dashboard.html',
      'esim'
    );
    return res.status(200).json({
      // push below after order loaded
      success: true,
      message: orderData.created ? 'eSIM order placed successfully.' : 'Your eSIM order is confirmed.',
      order: {
        order_ref: order.order_ref,
        plan_name: order.plan_name,
        amount_ngn: Number(order.amount_ngn),
        status: order.status,
        created_at: order.created_at
      },
      wallet: {
        balance_ngn: Number(profile?.balance || 0),
        balance_usd: Number(profile?.balance_usd || 0),
        ngn_debited: Number(order.wallet_ngn_debited || 0),
        usd_debited: Number(order.wallet_usd_debited || 0)
      },
      email_status: emailStatus
    });
  } catch (error) {
    console.error('[esim checkout] Unexpected error:', error?.message || error);
    return res.status(500).json({ success: false, message: 'Something went wrong while placing your eSIM order. Please contact support before trying again.' });
  }
}
