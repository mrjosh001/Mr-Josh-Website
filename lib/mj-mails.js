import { profitFloorNgn } from './pricing.js';

const HERO_BASE = 'https://hero-sms.com/api/v1';
const apiKey = () => String(process.env.HEROSMS_API_KEY || '').trim();
const usdRate = () => Number(process.env.USD_TO_NGN_RATE) || Number(process.env.USD_TO_NGN) || 1500;
const walletRate = () => Number(process.env.WALLET_USD_RATE) || 1450;
function emailRetailPriceNgn(supplierCostUsd) {
  const usd=Number(supplierCostUsd);
  if(!Number.isFinite(usd)||usd<=0)return 0;
  const round50=value=>Math.ceil(value/50)*50;
  if(usd<0.1)return round50(400+(usd/0.1)*100);
  if(usd<0.5)return round50(600+((usd-0.1)/0.4)*400);
  if(usd<=1)return round50(1100+((usd-0.5)/0.5)*400);
  return profitFloorNgn(usd,usdRate());
}
const bodyOf = (req) => {
  try { return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); }
  catch (_) { return {}; }
};
const mapStatus = (n) => ({3:'waiting',4:'cancelled',5:'message_received',6:'completed',7:'refunded'})[Number(n)] || 'waiting';
const REFUND_DELAY_MS = 2 * 60 * 1000;
const MAIL_LIFETIME_MS = 20 * 60 * 1000;
function supplierDate(value) {
  if (value == null || value === '') return null;
  const raw=String(value).trim();
  const numeric=/^\\d{10,13}$/.test(raw)?Number(raw):null;
  let ms = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value)
    : numeric!=null ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(raw);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}
const cleanOrder = (r) => {
  const supplier_date = supplierDate(r.supplier_date || r.provider_date || r.date);
  const refund_available_at = supplier_date ? new Date(Date.parse(supplier_date) + REFUND_DELAY_MS).toISOString() : null;
  const expires_at = supplier_date ? new Date(Date.parse(supplier_date) + MAIL_LIFETIME_MS).toISOString() : null;
  return {id:r.id,site:r.site,domain:r.domain,email:r.email_address,status:r.status,
    supplier_status:r.supplier_status,message:r.message,value:r.value,price:r.retail_price_ngn,
    created_at:r.created_at,updated_at:r.updated_at,refunded:r.refunded,supplier_date,refund_available_at,expires_at};
};

async function hero(path, options = {}) {
  const key = apiKey();
  if (!key) throw new Error('HeroSMS email API is not configured');
  const response = await fetch(HERO_BASE + path, {
    ...options,
    headers: { Authorization:'ApiKey '+key, Accept:'application/json',
      ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) },
    signal: AbortSignal.timeout(20000)
  });
  const raw = await response.text();
  let data = null; try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
  if (!response.ok) { const e = new Error(data?.message || 'Email provider request failed'); e.status=response.status; throw e; }
  return data;
}
async function saveProviderState(supabase,row,data) {
  const item=data?.data||data; const patch={updated_at:new Date().toISOString()};
  const providerDate=supplierDate(item?.date);
  if(providerDate) patch.supplier_date=providerDate;
  if(item?.status!=null) {
    const raw=String(item.status).toUpperCase();
    const names={WAIT:3,WAITING:3,ACTIVE:5,MESSAGE:5,RECEIVED:5,COMPLETED:6,DONE:6,SUCCESS:6,CANCEL:4,CANCELLED:4,REFUNDED:7};
    patch.supplier_status=Number.isFinite(Number(item.status))?Number(item.status):(names[raw]||row.supplier_status);
    patch.status=mapStatus(patch.supplier_status);
  }
  if(item?.email) patch.email_address=String(item.email);
  if(item?.message!=null) patch.message=String(item.message).slice(0,12000);
  if(item?.value!=null) patch.value=String(item.value).slice(0,1000);
  const {data:saved,error}=await supabase.from('mj_mail_orders').update(patch)
    .eq('id',row.id).eq('user_id',row.user_id).select('*').single();
  if(error) throw error; return saved;
}

export async function handleMjMails({req,res,url,supabase,requireAuth,json}) {
  const action=String(url.searchParams.get('action')||'').toLowerCase();
  const method=String(req.method||'GET').toUpperCase();
  if(!apiKey()) return json(res,503,{success:false,message:'MJ Mails is temporarily unavailable'});
  // Domain offers are public catalogue data. Authentication is required only for account actions.
  try {
    if(method==='GET' && action==='mails_offers') {
      const site=String(url.searchParams.get('site')||'').trim().toLowerCase();
      const domain=String(url.searchParams.get('domain')||'').trim().toLowerCase();
      if(!site) return json(res,400,{success:false,message:'Enter a service or site first'});
      const qs=new URLSearchParams({site}); if(domain) qs.set('domain',domain);
      const response=await hero('/emails/offers?'+qs.toString());
      const rows=Array.isArray(response?.data)?response.data:[];
      const offers=rows.flatMap(r=>(Array.isArray(r.offers)?r.offers:[])
        .filter(o=>Number(o.cost)>0&&Number(o.count)>0)
        .map(o=>({domain:String(r.domain||'').toLowerCase(),cost:Number(o.cost),
          count:Math.floor(Number(o.count)),price_ngn:emailRetailPriceNgn(Number(o.cost))})));
      return json(res,200,{success:true,site,offers});
    }
    const auth=await requireAuth(req);
    if(!auth.ok) return json(res,auth.status,{success:false,message:auth.message});
    const userId=auth.userId;
    if(method==='GET' && action==='mails_orders') {
      const {data,error}=await supabase.from('mj_mail_orders').select('*').eq('user_id',userId)
        .order('created_at',{ascending:false}).limit(100);
      if(error) throw error;
      return json(res,200,{success:true,orders:(data||[]).map(cleanOrder)});
    }
    if(method==='POST' && action==='mails_purchase') {
      const body=bodyOf(req); const site=String(body.site||'').trim().toLowerCase();
      const domain=String(body.domain||'').trim().toLowerCase(); const requestId=String(body.request_id||'');
      if(!site||!domain||!/^[0-9a-f-]{36}$/i.test(requestId))
        return json(res,400,{success:false,message:'Invalid email purchase request'});
      const offerResponse=await hero('/emails/offers?'+new URLSearchParams({site,domain}));
      const domainRow=(offerResponse?.data||[]).find(r=>String(r.domain).toLowerCase()===domain);
      const offer=(domainRow?.offers||[]).filter(o=>Number(o.cost)>0&&Number(o.count)>0)
        .sort((a,b)=>Number(a.cost)-Number(b.cost))[0];
      if(!offer) return json(res,409,{success:false,message:'This email domain is currently out of stock'});
      const supplierCost=Number(offer.cost); const price=emailRetailPriceNgn(supplierCost);
      if(body.expected_price!=null&&Number(body.expected_price)!==price)
        return json(res,409,{success:false,message:'The price has changed. Refresh the offers and try again.',price_ngn:price});
      const reserved=await supabase.rpc('mj_mail_reserve_purchase',{p_user_id:userId,p_request_id:requestId,
        p_site:site,p_domain:domain,p_supplier_cost:supplierCost,p_supplier_currency:840,
        p_retail_ngn:price,p_wallet_usd_rate:walletRate()});
      if(reserved.error) {
        if(String(reserved.error.message||'').includes('INSUFFICIENT_WALLET'))
          return json(res,402,{success:false,message:'Insufficient wallet balance'});
        throw reserved.error;
      }
      const order=reserved.data?.order; if(!order) throw new Error('Could not reserve this purchase');
      if(!reserved.data.created) return json(res,200,{success:true,order:cleanOrder(order),reused:true});
      let created;
      try { created=await hero('/emails',{method:'POST',body:JSON.stringify({site,domain,maxPrice:supplierCost})}); }
      catch(e) {
        if(e.status) {
          await supabase.rpc('mj_mail_refund_purchase',{p_order_id:order.id,p_user_id:userId,p_reason:'Provider rejected purchase'});
          await supabase.from('mj_mail_orders').update({status:'failed',updated_at:new Date().toISOString()}).eq('id',order.id);
          return json(res,502,{success:false,message:'The email could not be created. Your wallet has been restored.'});
        }
        await supabase.from('mj_mail_orders').update({status:'reconciliation_required'}).eq('id',order.id);
        return json(res,202,{success:false,pending:true,message:'Purchase status is being verified. Do not retry yet.'});
      }
      const item=created?.data;
      if(!item?.id||!item?.email) {
        await supabase.from('mj_mail_orders').update({status:'reconciliation_required'}).eq('id',order.id);
        return json(res,202,{success:false,pending:true,message:'Provider response needs reconciliation. Do not retry yet.'});
      }
      const providerDate=supplierDate(item.date);
      const patch={supplier_id:String(item.id),email_address:String(item.email),
        supplier_status:Number(item.status)||3,status:mapStatus(Number(item.status)||3),
        supplier_currency:Number(item.currency)||840,supplier_date:providerDate,
        updated_at:new Date().toISOString()};
      const {data:saved,error}=await supabase.from('mj_mail_orders').update(patch).eq('id',order.id)
        .eq('user_id',userId).select('*').single();
      if(error) return json(res,202,{success:false,pending:true,message:'Email created, but order sync is pending. Refresh MJ Mails Orders.'});
      return json(res,200,{success:true,order:cleanOrder(saved)});
    }
    if(method==='POST' && action==='mails_refresh') {
      const id=String(bodyOf(req).id||'');
      const {data:row,error}=await supabase.from('mj_mail_orders').select('*').eq('id',id).eq('user_id',userId).maybeSingle();
      if(error) throw error; if(!row) return json(res,404,{success:false,message:'Order not found'});
      if(!row.supplier_id) return json(res,202,{success:false,pending:true,message:'This purchase is awaiting provider reconciliation'});
      const result=await hero('/emails/'+encodeURIComponent(row.supplier_id));
      return json(res,200,{success:true,order:cleanOrder(await saveProviderState(supabase,row,result))});
    }
    if(method==='POST' && action==='mails_cancel') {
      const id=String(bodyOf(req).id||'');
      const {data:row,error}=await supabase.from('mj_mail_orders').select('*').eq('id',id).eq('user_id',userId).maybeSingle();
      if(error) throw error; if(!row) return json(res,404,{success:false,message:'Order not found'});
      if(row.refunded||['completed','refunded','cancelled','message_received'].includes(row.status))
        return json(res,409,{success:false,message:'This email activation can no longer be refunded'});
      if(!row.supplier_id) return json(res,409,{success:false,message:'This purchase is still being reconciled'});
      if(row.status!=='cancel_pending_refund') {
        if(row.status!=='waiting') return json(res,409,{success:false,message:'Only waiting email activations can be refunded'});
        const purchasedAt=supplierDate(row.supplier_date);
        if(!purchasedAt) return json(res,409,{success:false,message:'The supplier did not provide a purchase timestamp. Refresh the order first.'});
        const age=Date.now()-Date.parse(purchasedAt);
        if(age<REFUND_DELAY_MS) return json(res,409,{success:false,message:'Refund becomes available after the first 2 minutes'});
        if(age>=MAIL_LIFETIME_MS) return json(res,409,{success:false,message:'The 20-minute email rental period has expired'});
        let latest=await hero('/emails/'+encodeURIComponent(row.supplier_id));
        let latestRow=await saveProviderState(supabase,row,latest);
        if(latestRow.message||latestRow.value||['message_received','completed'].includes(latestRow.status))
          return json(res,409,{success:false,message:'A verification email has arrived. This order is not eligible for a refund.'});
        if(!['waiting','cancelled','refunded'].includes(latestRow.status))
          return json(res,409,{success:false,message:'The supplier has closed this activation. Refresh the order status before requesting a refund.'});
        // DELETE requests cancellation; a fresh GET must confirm the supplier state before wallet refund.
        if(latestRow.status==='waiting') {
          await hero('/emails/'+encodeURIComponent(row.supplier_id),{method:'DELETE'});
          latest=await hero('/emails/'+encodeURIComponent(row.supplier_id));
          latestRow=await saveProviderState(supabase,latestRow,latest);
        }
        if(!['cancelled','refunded'].includes(latestRow.status)||latestRow.message||latestRow.value)
          return json(res,202,{success:false,pending:true,message:'HeroSMS has not yet confirmed cancellation. No wallet refund has been issued. Try Refund again shortly.'});
        const {error:markError}=await supabase.from('mj_mail_orders').update({
          status:'cancel_pending_refund',supplier_status:latestRow.supplier_status,updated_at:new Date().toISOString()
        }).eq('id',row.id).eq('user_id',userId);
        if(markError) throw markError;
      }
      const refund=await supabase.rpc('mj_mail_refund_purchase',{p_order_id:row.id,p_user_id:userId,p_reason:'Email activation cancelled after supplier confirmation'});
      if(refund.error) throw refund.error;
      return json(res,200,{success:true,message:'HeroSMS cancellation confirmed and wallet refund issued'});
    }
    return json(res,405,{success:false,message:'Unsupported MJ Mails action'});
  } catch(e) {
    console.error('[mj-mails]',e?.message||e);
    return json(res,Number(e.status)||500,{success:false,message:e.status===401?'Email provider authorization failed':'MJ Mails request failed. Please try again.'});
  }
}
