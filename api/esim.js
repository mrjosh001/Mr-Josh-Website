import { createClient } from '@supabase/supabase-js';

const ESIM_URL = process.env.ESIM_SUPABASE_URL;
const ESIM_SERVICE_KEY = process.env.ESIM_SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL = 'mjhubhelp@gmail.com';
const PLANS = {
  '1m': { name: '1 month', amount: 26000 },
  '3m': { name: '3 months', amount: 47000 },
  '6m': { name: '6 months', amount: 68000 },
  '12m': { name: '1 year', amount: 90000 }
};

const supabase = ESIM_URL && ESIM_SERVICE_KEY
  ? createClient(ESIM_URL, ESIM_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    })
  : null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function formatNgn(value) {
  return '₦' + Number(value || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 });
}

async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) {
    throw new Error('Resend is not configured for this deployment');
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL,
      to: [to],
      subject,
      html
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || 'Resend rejected the email (' + response.status + ')');
  }
  return payload;
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

    // ---- Admin: list eSIM orders (read-only) — used by the admin dashboard "eSIM Orders" page ----
    if (String(body.action || '') === 'admin_orders') {
      const { data: adminProfile } = await supabase.from('profiles')
        .select('is_admin')
        .eq('id', user.id)
        .maybeSingle();
      const flag = adminProfile && adminProfile.is_admin;
      const isAdmin = flag === true || flag === 'true' || flag === 1
        || String(user.email || '').toLowerCase() === ADMIN_EMAIL;
      if (!isAdmin) {
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
      return res.status(200).json({
        success: true,
        data: data || [],
        total: count || 0,
        page,
        page_size: pageSize
      });
    }

    const planId = String(body.plan_id || '');
    const plan = PLANS[planId];
    const imei = String(body.imei || '').replace(/\D/g, '');
    const requestId = String(body.request_id || '');
    if (!plan) return res.status(400).json({ success: false, message: 'Choose a valid eSIM plan.' });
    if (!/^\d{15}$/.test(imei)) return res.status(400).json({ success: false, message: 'Enter a valid 15-digit IMEI.' });
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      return res.status(400).json({ success: false, message: 'Invalid checkout request. Refresh and try again.' });
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
