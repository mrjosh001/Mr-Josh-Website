import { createClient } from '@supabase/supabase-js';

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
const DEFAULT_PLANS = [
  { id: '1m',  name: '1 month',  amount: 26000, supplier_cost: 20000, days: 30,  sort: 1, active: true },
  { id: '3m',  name: '3 months', amount: 47000, supplier_cost: 40000, days: 90,  sort: 2, active: true },
  { id: '6m',  name: '6 months', amount: 68000, supplier_cost: 60000, days: 180, sort: 3, active: true },
  { id: '12m', name: '1 year',   amount: 90000, supplier_cost: 80000, days: 365, sort: 4, active: true }
];

const supabase = ESIM_URL && ESIM_SERVICE_KEY
  ? createClient(ESIM_URL, ESIM_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    })
  : null;

/** Plans = defaults, overridden by whatever is saved in the esim_plans table. */
async function getPlans() {
  const defaults = DEFAULT_PLANS.map((p) => ({ ...p }));
  try {
    const { data, error } = await supabase.from('esim_plans').select('*');
    if (error || !Array.isArray(data) || !data.length) return defaults;
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
    return defaults;
  } catch (e) {
    console.error('[esim plans] falling back to defaults:', e?.message || e);
    return defaults;
  }
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
async function sendEmail({ to, subject, html, attachments, replyTo }) {
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) {
    throw new Error('Resend is not configured for this deployment');
  }
  const payload = {
    from: process.env.RESEND_FROM_EMAIL,
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
  const createdAt = new Date(order.created_at || Date.now()).toLocaleString('en-NG', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Lagos'
  });
  const createdAtSafe = escapeHtml(createdAt);
  const customerHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#172033;line-height:1.6">
      <h2 style="color:#315fe8">MJ HUB eSIM order received</h2>
      <p>Your wallet payment was successful. We have received your eSIM order and it is awaiting processing.</p>
      <table style="border-collapse:collapse;width:100%">
        <tr><td style="padding:9px;border-bottom:1px solid #e5e7eb">Order reference</td><td style="padding:9px;border-bottom:1px solid #e5e7eb"><strong>${orderRef}</strong></td></tr>
        <tr><td style="padding:9px;border-bottom:1px solid #e5e7eb">Plan</td><td style="padding:9px;border-bottom:1px solid #e5e7eb">${planName}</td></tr>
        <tr><td style="padding:9px;border-bottom:1px solid #e5e7eb">Amount paid</td><td style="padding:9px;border-bottom:1px solid #e5e7eb"><strong>${amount}</strong></td></tr>
        <tr><td style="padding:9px;border-bottom:1px solid #e5e7eb">Phone IMEI</td><td style="padding:9px;border-bottom:1px solid #e5e7eb">${imei}</td></tr>
        <tr><td style="padding:9px;border-bottom:1px solid #e5e7eb">Order date</td><td style="padding:9px;border-bottom:1px solid #e5e7eb">${createdAtSafe}</td></tr>
        <tr><td style="padding:9px;border-bottom:1px solid #e5e7eb">Status</td><td style="padding:9px;border-bottom:1px solid #e5e7eb">Paid — processing</td></tr>
      </table>
      <p>Keep your order reference for support. This email confirms payment and order receipt; it does not mean the eSIM has already been activated.</p>
      <p>MJ HUB Support</p>
    </div>`;
  const adminHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#172033;line-height:1.6">
      <h2>New paid eSIM order</h2>
      <p>A customer has completed an eSIM wallet purchase.</p>
      <table style="border-collapse:collapse;width:100%">
        <tr><td style="padding:9px;border-bottom:1px solid #e5e7eb">Order reference</td><td style="padding:9px;border-bottom:1px solid #e5e7eb"><strong>${orderRef}</strong></td></tr>
        <tr><td style="padding:9px;border-bottom:1px solid #e5e7eb">Customer name</td><td style="padding:9px;border-bottom:1px solid #e5e7eb">${escapeHtml(order.full_name || 'MJ HUB customer')}</td></tr>
        <tr><td style="padding:9px;border-bottom:1px solid #e5e7eb">Customer email</td><td style="padding:9px;border-bottom:1px solid #e5e7eb">${email}</td></tr>
        <tr><td style="padding:9px;border-bottom:1px solid #e5e7eb">Plan</td><td style="padding:9px;border-bottom:1px solid #e5e7eb">${planName}</td></tr>
        <tr><td style="padding:9px;border-bottom:1px solid #e5e7eb">Amount paid</td><td style="padding:9px;border-bottom:1px solid #e5e7eb">${amount}</td></tr>
        <tr><td style="padding:9px;border-bottom:1px solid #e5e7eb">Phone IMEI</td><td style="padding:9px;border-bottom:1px solid #e5e7eb">${imei}</td></tr>
        <tr><td style="padding:9px;border-bottom:1px solid #e5e7eb">Order date</td><td style="padding:9px;border-bottom:1px solid #e5e7eb">${createdAtSafe}</td></tr>
        <tr><td style="padding:9px;border-bottom:1px solid #e5e7eb">Status</td><td style="padding:9px;border-bottom:1px solid #e5e7eb">Paid — processing</td></tr>
      </table>
      <p style="margin-top:14px">Open the admin dashboard → <strong>eSIM Orders</strong> to deliver this order once the eSIM is ready.</p>
    </div>`;

  const tasks = [];
  if (!order.customer_email_sent_at) {
    tasks.push(sendEmail({
      to: order.customer_email,
      subject: 'MJ HUB eSIM order received · ' + order.order_ref,
      html: customerHtml
    }).then(async () => {
      const { error } = await supabase.from('esim_orders')
        .update({ customer_email_sent_at: new Date().toISOString() })
        .eq('id', order.id);
      if (error) throw error;
      return 'customer';
    }));
  }
  if (!order.admin_email_sent_at) {
    tasks.push(sendEmail({
      to: ADMIN_EMAIL,
      subject: 'New paid eSIM order · ' + order.order_ref,
      html: adminHtml
    }).then(async () => {
      const { error } = await supabase.from('esim_orders')
        .update({ admin_email_sent_at: new Date().toISOString() })
        .eq('id', order.id);
      if (error) throw error;
      return 'admin';
    }));
  }

  const results = await Promise.allSettled(tasks);
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length) {
    const message = failed.map((result) => String(result.reason?.message || result.reason || 'Email failed')).join('; ').slice(0, 1000);
    console.error('[esim email] Order ' + order.order_ref + ': ' + message);
    await supabase.from('esim_orders').update({ email_error: message }).eq('id', order.id);
  } else if (tasks.length) {
    await supabase.from('esim_orders').update({ email_error: null }).eq('id', order.id);
  }

  const { data: latest } = await supabase.from('esim_orders')
    .select('customer_email_sent_at, admin_email_sent_at')
    .eq('id', order.id)
    .maybeSingle();
  return {
    customer: Boolean(latest?.customer_email_sent_at),
    admin: Boolean(latest?.admin_email_sent_at)
  };
}

/* ------------------------------------------------------------------ */
/* eSIM delivery email (sent manually from the admin dashboard)        */
/* ------------------------------------------------------------------ */

/**
 * The premade eSIM delivery template. The QR code is embedded in the middle of
 * the message through a CID reference (<img src="cid:esim-qr">), which every
 * major mail client renders. (Gmail blocks base64 data: images, so CID is the
 * reliable way.) The same image is also attached as a normal file.
 */
function buildDeliveryEmail({ fullName, orderRef, planName, phone }) {
  const name = escapeHtml(String(fullName || '').trim());
  const greeting = name ? 'Hi ' + name + ',' : 'Hi there,';
  const ref = escapeHtml(orderRef);
  const plan = escapeHtml(planName);
  const phoneBlock = phone
    ? `<p style="margin:0 0 4px;font-size:16px;text-align:center">Phone Number: <strong style="color:#1d4ed8">${escapeHtml(phone)}</strong></p>`
    : '';
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f3f5f9">
  <div style="max-width:600px;margin:0 auto;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#111827">
    <div style="background:#ffffff;border-radius:14px;padding:30px 26px;border:1px solid #e5e7eb">
      <p style="margin:0 0 18px;font-size:17px;font-weight:bold">${greeting}</p>
      <p style="margin:0 0 22px;font-size:16px;line-height:1.6">Congratulations! Your eSIM is here and ready to be activated! Please find the essential information for your eSIM below:</p>
      ${phoneBlock}
      <p style="margin:10px 0 12px;font-size:16px;font-weight:bold;text-align:center">eSIM QR Code:</p>
      <div style="text-align:center;margin:0 0 26px">
        <img src="cid:esim-qr" alt="eSIM QR code" width="240" style="width:240px;max-width:100%;height:auto;border:0;display:inline-block">
      </div>
      <div style="background:#f3f5f9;border-radius:10px;padding:16px 18px;font-size:15px;line-height:1.8">
        <strong>How to install</strong><br>
        1. Connect VPN<br>
        2. Go to Settings &rarr; Cellular &rarr; Add eSIM<br>
        3. Click &lsquo;Use QR code&rsquo; and scan this QR code
      </div>
      <p style="margin:22px 0 0;font-size:12px;color:#6b7280;line-height:1.6">Order reference: <strong>${ref}</strong> &middot; Plan: ${plan}<br>
      This QR code is for you only &mdash; please don&rsquo;t share it. A copy of the QR code is also attached to this email. Need help? Just reply to this email.</p>
      <p style="margin:16px 0 0;font-size:13px;color:#374151">MJ HUB Support</p>
    </div>
  </div>
</body>
</html>`;
}

/** Decode a data URL (png / jpeg / webp only) and verify the bytes really are that image type. */
function decodeQrDataUrl(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(String(dataUrl || '').trim());
  if (!match) return null;
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length || buffer.length > MAX_QR_BYTES) return null;
  const isPng = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const isJpeg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isWebp = buffer.length > 12 && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP';
  if (isPng) return { buffer, ext: 'png', type: 'image/png' };
  if (isJpeg) return { buffer, ext: 'jpg', type: 'image/jpeg' };
  if (isWebp) return { buffer, ext: 'webp', type: 'image/webp' };
  return null;
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
  const html = buildDeliveryEmail({
    fullName,
    orderRef: order.order_ref,
    planName: order.plan_name,
    phone
  });

  try {
    await sendEmail({
      to: customerEmail,
      subject: 'Your MJ HUB eSIM is ready · ' + order.order_ref,
      html,
      replyTo: ADMIN_EMAIL,
      attachments: [
        // embedded in the middle of the email body
        { filename: 'esim-qr-inline.' + qr.ext, content: base64, content_id: 'esim-qr' },
        // the same QR as a normal attachment the customer can save
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

  return res.status(200).json({
    success: true,
    emailed: true,
    message: 'eSIM delivered to ' + customerEmail
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
    if (String(body.action || '') === 'plans') {
      const plans = await getPlans();
      return res.status(200).json({
        success: true,
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
    const plans = await getPlans();
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
    const { data: rpcData, error: rpcError } = await supabase.rpc('create_esim_wallet_order', {
      p_user_id: user.id,
      p_plan_id: planId,
      p_plan_name: plan.name,
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

    const emailStatus = await sendOrderEmails({
      ...order,
      full_name: (await supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle()).data?.full_name || ''
    }).catch((error) => {
      console.error('[esim email] Order ' + order.order_ref + ':', error?.message || error);
      return { customer: false, admin: false };
    });

    return res.status(200).json({
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
