import { createClient } from '@supabase/supabase-js';
import { profitFloorNgn } from '../lib/pricing.js';
import { applyApiCors, handleOptions, setNoStore } from '../lib/secure.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const HERO_BASE = 'https://hero-sms.com/api/v1';
const apiKey = () => String(process.env.HEROSMS_API_KEY || '').trim();
const usdRate = () => Number(process.env.USD_TO_NGN_RATE) || Number(process.env.USD_TO_NGN) || 1500;
const walletRate = () => Number(process.env.WALLET_USD_RATE) || 1450;

async function authUser(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token || token.includes('service_role')) return null;
  const { data, error } = await supabase.auth.getUser(token);
  return error || !data?.user ? null : data.user;
}
async function hero(path, options = {}) {
  if (!apiKey()) throw new Error('Email service is not configured');
  const response = await fetch(HERO_BASE + path, {
    ...options,
    headers: { Authorization: 'ApiKey ' + apiKey(), Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    signal: AbortSignal.timeout(20000)
  });
  const raw = await response.text();
  let data = null; try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
  if (!response.ok) {
    const e = new Error(data?.message || 'Email provider request failed');
    e.status = response.status; throw e;
  }
  return data;
}
function send(res, status, payload) { return res.status(status).json(payload); }
function bodyOf(req) { try { return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (_) { return {}; } }
function cleanEmailOrder(row) {
  return { id:row.id, site:row.site, domain:row.domain, email:row.email_address,
    status:row.status, supplier_status:row.supplier_status, message:row.message,
    value:row.value, price:row.retail_price_ngn, created_at:row.created_at,
    updated_at:row.updated_at, refunded:row.refunded };
}
function mapStatus(n) {
  return ({3:'waiting',4:'cancelled',5:'message_received',6:'completed',7:'refunded'})[Number(n)] || 'waiting';
}
async function updateSupplierState(row, data) {
  const item = data?.data || data;
  const patch = { updated_at:new Date().toISOString() };
  if (item?.status != null) {
    const raw = String(item.status).toUpperCase();
    const statusMap = { WAIT:3, WAITING:3, ACTIVE:5, MESSAGE:5, RECEIVED:5, COMPLETED:6, DONE:6, SUCCESS:6, CANCEL:4, CANCELLED:4, REFUNDED:7 };
    patch.supplier_status = Number.isFinite(Number(item.status)) ? Number(item.status) : (statusMap[raw] || row.supplier_status);
    patch.status = mapStatus(patch.supplier_status);
  }
  if (item?.email) patch.email_address = String(item.email);
  if (item?.message != null) patch.message = String(item.message).slice(0,12000);
  if (item?.value != null) patch.value = String(item.value).slice(0,1000);
  const { data: saved, error } = await supabase.from('mj_mail_orders').update(patch)
    .eq('id',row.id).eq('user_id',row.user_id).select('*').single();
  if (error) throw error;
  return saved;
}

export default async function handler(req,res) {
  applyApiCors(req,res); setNoStore(res);
  if (handleOptions(req,res)) return;
  const user = await authUser(req);
  if (!user) return send(res,401,{success:false,message:'Sign in to use MJ Mails'});
  if (!apiKey()) return send(res,503,{success:false,message:'MJ Mails is temporarily unavailable'});
  const action = String(req.query?.action || '').toLowerCase();
  try {
    if (req.method === 'GET' && action === 'offers') {
      const site = String(req.query.site || '').trim().toLowerCase();
      const domain = String(req.query.domain || '').trim().toLowerCase();
      if (!site) return send(res,400,{success:false,message:'Enter a service or site first'});
      const qs = new URLSearchParams({site}); if (domain) qs.set('domain',domain);
      const data = await hero('/emails/offers?' + qs.toString());
      const rows = Array.isArray(data?.data) ? data.data : [];
      const offers = rows.flatMap(row => (Array.isArray(row.offers) ? row.offers : [])
        .filter(o => Number(o.cost)>0 && Number(o.count)>0)
        .map(o => ({domain:String(row.domain || '').toLowerCase(),cost:Number(o.cost),
          count:Math.floor(Number(o.count)),price_ngn:profitFloorNgn(Number(o.cost),usdRate())})));
      return send(res,200,{success:true,site,offers});
    }
    if (req.method === 'GET' && action === 'orders') {
      const {data,error} = await supabase.from('mj_mail_orders').select('*').eq('user_id',user.id)
        .order('created_at',{ascending:false}).limit(100);
      if(error) throw error;
      return send(res,200,{success:true,orders:(data||[]).map(cleanEmailOrder)});
    }
    if (req.method === 'POST' && action === 'purchase') {
      const body = bodyOf(req);
      const site = String(body.site || '').trim().toLowerCase();
      const domain = String(body.domain || '').trim().toLowerCase();
      const requestId = String(body.request_id || '');
      if (!site || !domain || !/^[0-9a-f-]{36}$/i.test(requestId))
        return send(res,400,{success:false,message:'Invalid email purchase request'});
      const offerData = await hero('/emails/offers?' + new URLSearchParams({site,domain}));
      const domainOffer = (offerData?.data || []).find(x => String(x.domain).toLowerCase() === domain);
      const cheapest = (domainOffer?.offers || []).filter(x=>Number(x.cost)>0 && Number(x.count)>0)
        .sort((a,b)=>Number(a.cost)-Number(b.cost))[0];
      if(!cheapest) return send(res,409,{success:false,message:'This email domain is currently out of stock'});
      const supplierCost = Number(cheapest.cost);
      const price = profitFloorNgn(supplierCost,usdRate());
      if(body.expected_price != null && Number(body.expected_price) !== price)
        return send(res,409,{success:false,message:'The price has changed. Refresh the offers and try again.',price_ngn:price});
      const reserved = await supabase.rpc('mj_mail_reserve_purchase',{
        p_user_id:user.id,p_request_id:requestId,p_site:site,p_domain:domain,
        p_supplier_cost:supplierCost,p_supplier_currency:840,p_retail_ngn:price,p_wallet_usd_rate:walletRate()
      });
      if(reserved.error) {
        if(String(reserved.error.message||'').includes('INSUFFICIENT_WALLET'))
          return send(res,402,{success:false,message:'Insufficient wallet balance'});
        throw reserved.error;
      }
      const order = reserved.data?.order;
      if(!order) throw new Error('Could not reserve this purchase');
      if(!reserved.data.created) return send(res,200,{success:true,order:cleanEmailOrder(order),reused:true});
      let created;
      try {
        created = await hero('/emails',{method:'POST',body:JSON.stringify({site,domain,maxPrice:supplierCost})});
      } catch (e) {
        if (e.status) {
          await supabase.rpc('mj_mail_refund_purchase',{p_order_id:order.id,p_user_id:user.id,p_reason:'Provider rejected purchase'});
          await supabase.from('mj_mail_orders').update({status:'failed',updated_at:new Date().toISOString()}).eq('id',order.id);
          return send(res,502,{success:false,message:'The email could not be created. Your wallet has been restored.'});
        }
        await supabase.from('mj_mail_orders').update({status:'reconciliation_required'}).eq('id',order.id);
        return send(res,202,{success:false,pending:true,message:'Purchase status is being verified. Do not retry yet.'});
      }
      const item = created?.data;
      if(!item?.id || !item?.email) {
        await supabase.from('mj_mail_orders').update({status:'reconciliation_required'}).eq('id',order.id);
        return send(res,202,{success:false,pending:true,message:'Provider response needs reconciliation. Do not retry yet.'});
      }
      const patch = {supplier_id:String(item.id),email_address:String(item.email),
        supplier_status:Number(item.status) || (String(item.status).toUpperCase()==='WAIT'?3:3),supplier_currency:Number(item.currency)||840,
        status:mapStatus(Number(item.status) || 3),updated_at:new Date().toISOString()};
      const {data:saved,error} = await supabase.from('mj_mail_orders').update(patch).eq('id',order.id)
        .eq('user_id',user.id).select('*').single();
      if(error) return send(res,202,{success:false,pending:true,message:'Email created, but order sync is pending. Refresh MJ Mails Orders.'});
      return send(res,200,{success:true,order:cleanEmailOrder(saved)});
    }
    if (req.method === 'POST' && action === 'refresh') {
      const body=bodyOf(req); const id=String(body.id||'');
      const {data:row,error}=await supabase.from('mj_mail_orders').select('*').eq('id',id).eq('user_id',user.id).maybeSingle();
      if(error) throw error; if(!row) return send(res,404,{success:false,message:'Order not found'});
      if(!row.supplier_id) return send(res,202,{success:false,pending:true,message:'This purchase is awaiting provider reconciliation'});
      const result=await hero('/emails/'+encodeURIComponent(row.supplier_id));
      const saved=await updateSupplierState(row,result);
      return send(res,200,{success:true,order:cleanEmailOrder(saved)});
    }
    if (req.method === 'POST' && action === 'cancel') {
      const body=bodyOf(req); const id=String(body.id||'');
      const {data:row,error}=await supabase.from('mj_mail_orders').select('*').eq('id',id).eq('user_id',user.id).maybeSingle();
      if(error) throw error; if(!row) return send(res,404,{success:false,message:'Order not found'});
      if(row.refunded || ['completed','refunded','cancelled','message_received'].includes(row.status))
        return send(res,409,{success:false,message:'This email activation can no longer be cancelled'});
      if(!row.supplier_id) return send(res,409,{success:false,message:'This purchase is still being reconciled'});
      if(row.status !== 'cancel_pending_refund') {
        if(row.status !== 'waiting') return send(res,409,{success:false,message:'Only waiting email activations can be cancelled'});
        await hero('/emails/'+encodeURIComponent(row.supplier_id),{method:'DELETE'});
        const {error:markError}=await supabase.from('mj_mail_orders').update({status:'cancel_pending_refund',supplier_status:4,updated_at:new Date().toISOString()}).eq('id',row.id).eq('user_id',user.id);
        if(markError) throw markError;
      }
      const refund=await supabase.rpc('mj_mail_refund_purchase',{p_order_id:row.id,p_user_id:user.id,p_reason:'Email activation cancelled'});
      if(refund.error) throw refund.error;
      return send(res,200,{success:true,message:'Email cancelled and wallet refunded'});
    }
    return send(res,405,{success:false,message:'Unsupported MJ Mails action'});
  } catch(e) {
    console.error('[mj-mails]',e?.message||e);
    return send(res,Number(e.status)||500,{success:false,message:e.status===401?'Email provider authorization failed':'MJ Mails request failed. Please try again.'});
  }
}
