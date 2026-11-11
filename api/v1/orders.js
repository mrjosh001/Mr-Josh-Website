import crypto from 'crypto';
import { getServiceSupabase, applyApiCors, handleOptions } from '../../lib/secure.js';
import { requireApiKey } from '../reseller.js';

const supabase = getServiceSupabase();
const CATEGORIES = new Set([
  'telegram.premium','telegram.stars','sms.activation','sms.server1','sms.server2','sms.server3',
  'sms.usa_rental','sms.global_rental','sms.long_term_rental','esim','logs','boosting','mj_mails'
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out,key) => { out[key] = stable(value[key]); return out; }, {});
  }
  return value;
}
function fail(res,status,code,message) {
  const requestId=crypto.randomUUID();
  res.setHeader('X-Request-Id',requestId);
  return res.status(status).json({success:false,code,message,request_id:requestId});
}
function shapeOrder(order) {
  return {
    id: order.id, category: order.category, service_id: order.service_id,
    status: order.status,
    amount: { amount: Number(order.amount_minor)/100, currency: order.currency || 'NGN' },
    created_at: order.created_at, updated_at: order.updated_at,
    ...(order.response_payload?.sandbox ? { sandbox: true, message: order.response_payload.message } : {})
  };
}

export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  applyApiCors(req,res,{methods:'GET, POST, OPTIONS'});
  if (handleOptions(req,res)) return;
  if (!['GET','POST'].includes(req.method)) return fail(res,405,'METHOD_NOT_ALLOWED','Use GET or POST.');
  const scope=req.method==='POST'?'orders:write':'orders:read';
  const auth=await requireApiKey(req,scope);
  if (auth.error) {
    if(auth.error.status===429) res.setHeader('Retry-After',String(auth.error.retry_after || 60));
    return fail(res,auth.error.status,auth.error.code || 'UNAUTHORIZED',auth.error.message);
  }
  const { reseller, key }=auth;

  if(req.method==='GET') {
    const id=String(req.query?.id || '').trim();
    if(!id) return fail(res,400,'ORDER_ID_REQUIRED','Provide an order id.');
    const table=key.environment==='sandbox'?'reseller_sandbox_orders':'reseller_orders';
    const {data,error}=await supabase.from(table).select('*').eq('id',id).eq('reseller_id',reseller.id).maybeSingle();
    if(error) return fail(res,503,'ORDER_LOOKUP_UNAVAILABLE','Order lookup is temporarily unavailable.');
    if(!data) return fail(res,404,'ORDER_NOT_FOUND','Order not found.');
    return res.status(200).json({success:true,data:shapeOrder(data)});
  }

  const body=req.body && typeof req.body==='object'?req.body:{};
  const category=String(body.category || '').trim().toLowerCase();
  const serviceId=String(body.service_id || '').trim();
  const amountMinor=Number(body.amount_minor);
  const idem=String(req.headers['idempotency-key'] || '').trim();
  if(!idem || idem.length<8 || idem.length>128) return fail(res,400,'IDEMPOTENCY_KEY_REQUIRED','Provide an Idempotency-Key header between 8 and 128 characters.');
  if(!CATEGORIES.has(category)) return fail(res,400,'INVALID_CATEGORY','Unsupported service category.');
  if(!serviceId || serviceId.length>200) return fail(res,400,'INVALID_SERVICE_ID','A valid service_id is required.');
  if(!Number.isSafeInteger(amountMinor) || amountMinor<1 || amountMinor>100000000) return fail(res,400,'INVALID_AMOUNT','amount_minor must be a positive integer not exceeding 1,000,000 NGN.');

  // Live supplier adapters are deliberately fail-closed until each service has a
  // verified adapter, pricing lookup, fulfilment lifecycle and reconciliation path.
  if(key.environment!=='sandbox') return fail(res,501,'LIVE_ADAPTER_NOT_READY','Live ordering is not enabled for this API yet. Use a sandbox key to test the request contract.');

  const safePayload={category,service_id:serviceId,amount_minor:amountMinor,parameters:body.parameters && typeof body.parameters==='object'?body.parameters:{}};
  const requestHash=crypto.createHash('sha256').update(JSON.stringify(stable(safePayload))).digest('hex');
  const {data,error}=await supabase.rpc('reseller_sandbox_order_create',{
    p_reseller_id:reseller.id,p_idempotency_key:idem,p_request_hash:requestHash,
    p_category:category,p_service_id:serviceId,p_amount_minor:amountMinor,p_request_payload:safePayload
  });
  if(error) {
    const msg=String(error.message || '');
    if(msg.includes('IDEMPOTENCY_KEY_REUSED')) return fail(res,409,'IDEMPOTENCY_CONFLICT','This Idempotency-Key was already used with a different order.');
    if(msg.includes('INSUFFICIENT_SANDBOX_BALANCE')) return fail(res,402,'INSUFFICIENT_SANDBOX_BALANCE','The sandbox wallet does not have enough test credits.');
    return fail(res,503,'SANDBOX_ORDER_UNAVAILABLE','Sandbox order processing is temporarily unavailable.');
  }
  const order=data?.order;
  if(!order) return fail(res,503,'SANDBOX_ORDER_UNAVAILABLE','Sandbox order could not be created.');
  return res.status(data.created?201:200).json({
    success:true,replayed:!data.created,sandbox:true,
    balance:{amount:Number(data.balance_minor || 0)/100,currency:'NGN'},
    data:shapeOrder(order)
  });
}
