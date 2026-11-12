import crypto from 'crypto';
import { profitFloorNgn } from './pricing.js';

const BASE='https://virtualsms.io/api/v1', SOURCE='virtualsms_rent', COUNTRY='US', COUNTRY_ID=187, DURATIONS=[24,72,168];
const apiKey=()=>String(process.env.VIRTUALSMS_API_KEY||process.env.VIRTUAL_SMS_API_KEY||'').trim();
const usdRate=()=>Number(process.env.USD_TO_NGN_RATE)||Number(process.env.USD_TO_NGN)||1500;
let vsRentRequestTail=Promise.resolve();
let vsRentLastRequestAt=0;
async function paceVirtualSmsRequest(){
 const prior=vsRentRequestTail;
 let release;
 vsRentRequestTail=new Promise(resolve=>{release=resolve;});
 await prior;
 try{
  const gap=Math.max(0,Number(process.env.VSMS_MIN_GAP_MS)||1100);
  const wait=Math.max(0,gap-(Date.now()-vsRentLastRequestAt));
  if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
  vsRentLastRequestAt=Date.now();
 }finally{release();}
}
const n=v=>{const x=Number(v);return Number.isFinite(x)&&x>=0?x:0;};
const arr=j=>Array.isArray(j)?j:(Array.isArray(j?.data)?j.data:(Array.isArray(j?.services)?j.services:(Array.isArray(j?.countries)?j.countries:[])));
const sid=s=>String(s?.service_id??s?.serviceId??s?.id??s?.code??'').trim();
const sname=(s,id)=>String(s?.name||s?.title||s?.service_name||s?.serviceName||id||'Service').trim();
const price=s=>n(s?.our_price??s?.ourPrice)||n(s?.price)||n(s?.retail_price)||n(s?.base_price??s?.basePrice);
// Supplier payloads can expose stock under different field names. A zero
// physical_count must not mask a positive available_count or stock value.
function stock(s){
 const keys=new Set(['physicalcount','availablecount','availablenumbers','stockcount','stockquantity','stock','quantity','availablequantity','availablestock','numbercount','totalstock','count','totalavailable','available','isavailable','instock']);
 const found=[];
 const walk=(value,depth)=>{
  if(!value||typeof value!=='object'||depth>4)return;
  if(Array.isArray(value)){value.forEach(v=>walk(v,depth+1));return;}
  for(const [key,v] of Object.entries(value)){
   const k=String(key).toLowerCase().replace(/[^a-z0-9]/g,'');
   if(keys.has(k)){
    if(typeof v==='boolean')found.push(v?1:0);
    else if(typeof v==='number'&&Number.isFinite(v))found.push(Math.max(0,v));
    else if(typeof v==='string'&&v.trim()!==''&&Number.isFinite(Number(v)))found.push(Math.max(0,Number(v)));
    else if(v&&typeof v==='object')walk(v,depth+1);
   }else if(v&&typeof v==='object')walk(v,depth+1);
  }
 };
 walk(s,0);
 return Math.floor(found.length?Math.max(...found):0);
}
const label=h=>h===24?'1 day':h===72?'3 days':'7 days';
function stockMeta(s){
 const keys=new Set(['physicalcount','availablecount','availablenumbers','stockcount','stockquantity','stock','quantity','availablequantity','availablestock','numbercount','totalstock','count','totalavailable','available','isavailable','instock']);
 const out={};
 const walk=(value,depth)=>{
  if(!value||typeof value!=='object'||depth>4)return;
  if(Array.isArray(value)){value.forEach(v=>walk(v,depth+1));return;}
  for(const [key,v] of Object.entries(value)){
   const k=String(key).toLowerCase().replace(/[^a-z0-9]/g,'');
   if(keys.has(k)){
    if(v==null||typeof v==='string'||typeof v==='number'||typeof v==='boolean')out[key]=v;
    else walk(v,depth+1);
   }else if(v&&typeof v==='object')walk(v,depth+1);
  }
 };
 walk(s,0);
 return out;
}
const sell=usd=>{const p=Number(profitFloorNgn(Number(usd),usdRate()));return Number.isFinite(p)&&p>0?Math.ceil(p/50)*50:0;};

async function call(path,opt={}){
 const key=apiKey();if(!key)return{ok:false,status:503,error:'VIRTUALSMS_API_KEY is not configured'};
 const method=opt.method||'GET',headers={Accept:'application/json','X-API-Key':key};
 await paceVirtualSmsRequest();
 if(opt.body)headers['Content-Type']='application/json';
 if(method!=='GET')headers['X-Idempotency-Key']=opt.idempotencyKey||crypto.randomUUID();
 try{
  const r=await fetch(BASE+path,{method,headers,body:opt.body?JSON.stringify(opt.body):undefined,signal:AbortSignal.timeout(opt.timeoutMs||Number(process.env.VSMS_API_TIMEOUT_MS)||12000)});
  const raw=await r.text();let data=null;try{data=raw?JSON.parse(raw):{};}catch(_){}
  const ok=r.ok&&!(data&&typeof data==='object'&&data.success===false);
  return{ok,status:r.status,data,raw:String(raw||'').slice(0,1500),error:ok?null:String(data?.message||data?.error||('VirtualSMS HTTP '+r.status)).slice(0,300)};
 }catch(e){return{ok:false,status:0,error:String(e?.message||e).slice(0,300),uncertain:method!=='GET'};}
}
function out(deps,status,body){return deps.json(deps.res,status,body);}
async function admin(deps){
 const a=await deps.requireAuth(deps.req);if(!a.ok)return a;
 const {data:p,error}=await deps.supabase.from('profiles').select('is_admin').eq('id',a.userId).maybeSingle();
 return !error&&p?.is_admin?{ok:true,userId:a.userId}:{ok:false,status:403,message:'Admin only'};
}
async function rows(supabase,isAdmin=false){
 const {data,error}=await supabase.from('virtualsms_rent_plans').select('*').eq('country_code','US').order('service_name').order('duration_hours').limit(3000);
 if(error)throw error;
 const list=data||[];
 if(isAdmin)return list;
 // Keep the customer catalogue useful even when a popular service is
 // temporarily out of stock: show its durations as Sold out, never buyable.
 // Non-popular zero-stock entries stay out of the customer grid.
 return list.filter(r=>r.admin_hidden!==true&&r.is_available===true);
}
function publicPlan(r){
 return{id:r.id,source:SOURCE,country_code:'US',country_name:'United States',service_id:r.service_id,service_name:r.service_name,
 duration_hours:Number(r.duration_hours),duration_label:label(Number(r.duration_hours)),supplier:'VirtualSMS',
 price_ngn:Number(r.price_ngn||0),price_source:r.price_source,
 is_available:r.admin_hidden!==true};
}
async function sync(deps){
 const a=await admin(deps);if(!a.ok)return out(deps,a.status||403,{success:false,message:a.message});
 const started=Date.now(),all=[],done=[],errors=[];
 // Platform Rental catalogue is service-scoped. Do not gate it on the
 // country-level rentals/available endpoint: that endpoint can report a
 // different tier/pool and must never zero the Platform service catalogue.
 for(const h of DURATIONS){
  const r=await call('/rentals/services?country_code=US&duration='+h);
  if(!r.ok){errors.push(label(h)+': '+r.error);continue;}
  const list=arr(r.data);done.push(h);
  for(const s of list){
   const id=sid(s),name=sname(s,id),usd=price(s);
   if(!id||!name||!(usd>0))continue;
   all.push({country_code:'US',country_id:187,service_id:id,service_name:name,duration_hours:h,supplier_price_usd:usd,
    price_ngn:sell(usd),stock_count:0,is_available:true,supplier_data:{physical_count:s?.physical_count??null,stock_fields:stockMeta(s),our_price:s.our_price??s.ourPrice??null,base_price:s.base_price??s.basePrice??null,popular:s.popular===true,icon_url:s.icon_url||null}});
  }
 }
 if(!done.length||!all.length)return out(deps,502,{success:false,message:'VirtualSMS returned no usable Platform Rental service plans.',errors});
 const {data:old,error:oldErr}=await deps.supabase.from('virtualsms_rent_plans').select('*').eq('country_code','US');
 if(oldErr)return out(deps,500,{success:false,message:oldErr.message});
 const by=new Map((old||[]).map(x=>[x.service_id+'|'+x.duration_hours,x])),seen=new Set(),now=new Date().toISOString(),writes=[];
 let inserted=0,updated=0,manual=0;
 for(const e of all){
  const k=e.service_id+'|'+e.duration_hours,p=by.get(k);seen.add(k);
  const isManual=p?.price_source==='admin';if(isManual)manual++;
  writes.push({...e,price_ngn:isManual?Number(p.price_ngn):e.price_ngn,price_source:isManual?'admin':'system',
   admin_hidden:p?.admin_hidden===true,synced_at:now,updated_at:now});
  if(p)updated++;else inserted++;
 }
 for(const p of old||[]){
  if(!done.includes(Number(p.duration_hours))||seen.has(p.service_id+'|'+p.duration_hours))continue;
  writes.push({country_code:'US',country_id:187,service_id:p.service_id,service_name:p.service_name,duration_hours:Number(p.duration_hours),
   supplier_price_usd:0,price_ngn:Number(p.price_ngn||0),price_source:p.price_source||'system',stock_count:0,is_available:false,
   admin_hidden:p.admin_hidden===true,supplier_data:{},synced_at:now,updated_at:now});
 }
 for(let i=0;i<writes.length;i+=100){
  const {error}=await deps.supabase.from('virtualsms_rent_plans').upsert(writes.slice(i,i+100),{onConflict:'country_code,service_id,duration_hours'});
  if(error)return out(deps,500,{success:false,message:'Could not save VirtualSMS plans: '+error.message,saved_before_error:i});
 }
 await deps.supabase.from('sync_jobs').upsert({source:SOURCE,status:errors.length?'partial':'completed',cursor_index:0,total_countries:1,
  new_count:inserted,updated_count:updated,services_seen:all.length,errors,started_at:now,updated_at:now});
 const inStock=all.filter(x=>Number(x.stock_count)>0).length;
 return out(deps,200,{success:true,country:'US',
  durations_synced:done.map(label),plans_seen:all.length,inserted,updated,admin_prices_preserved:manual,errors,
  duration_ms:Date.now()-started,done:!errors.length,
  message:errors.length?'VirtualSMS Platform Rental catalogue partially synced. Retry to complete remaining durations.':'VirtualSMS USA Platform Rental catalogue synced. Stock is checked by the supplier at purchase.'});
}
async function adminList(deps){
 const a=await admin(deps);if(!a.ok)return out(deps,a.status||403,{success:false,message:a.message});
 try{const data=await rows(deps.supabase,true);return out(deps,200,{success:true,data:data.map(r=>({...publicPlan(r),supplier_price_usd:Number(r.supplier_price_usd||0),admin_hidden:r.admin_hidden===true}))});}
 catch(e){return out(deps,500,{success:false,message:e.message});}
}
async function setPrice(deps){
 const a=await admin(deps);if(!a.ok)return out(deps,a.status||403,{success:false,message:a.message});
 const b=typeof deps.req.body==='string'?JSON.parse(deps.req.body||'{}'):(deps.req.body||{}),id=String(b.id||''),p=Number(b.price_ngn);
 if(!id)return out(deps,400,{success:false,message:'Plan id is required.'});
 let update={updated_at:new Date().toISOString()};
 if(b.reset===true){
  const {data:plan}=await deps.supabase.from('virtualsms_rent_plans').select('supplier_price_usd').eq('id',id).maybeSingle();
  if(!plan)return out(deps,404,{success:false,message:'Plan not found.'});
  update.price_ngn=sell(Number(plan.supplier_price_usd||0));update.price_source='system';
 }else{
  if(!Number.isFinite(p)||p<=0)return out(deps,400,{success:false,message:'Enter a positive selling price.'});
  update.price_ngn=Math.round(p);update.price_source='admin';
 }
 const {data,error}=await deps.supabase.from('virtualsms_rent_plans').update(update).eq('id',id).select('id,price_ngn,price_source').maybeSingle();
 if(error||!data)return out(deps,500,{success:false,message:error?.message||'Plan not found'});
 return out(deps,200,{success:true,data,message:'Price saved. Future syncs will preserve this admin price.'});
}
async function hidePlan(deps){
 const a=await admin(deps);if(!a.ok)return out(deps,a.status||403,{success:false,message:a.message});
 const b=typeof deps.req.body==='string'?JSON.parse(deps.req.body||'{}'):(deps.req.body||{});
 if(!b.id||typeof b.hidden!=='boolean')return out(deps,400,{success:false,message:'Plan id and hidden state are required.'});
 const {error}=await deps.supabase.from('virtualsms_rent_plans').update({admin_hidden:b.hidden,updated_at:new Date().toISOString()}).eq('id',b.id);
 if(error)return out(deps,500,{success:false,message:error.message});return out(deps,200,{success:true});
}
async function catalog(deps){
 const auth=await deps.requireAuth(deps.req);if(!auth.ok)return out(deps,auth.status,{success:false,message:auth.message});
 try{const data=await rows(deps.supabase);return out(deps,200,{success:true,data:data.map(publicPlan)});}
 catch(_){return out(deps,500,{success:false,message:'Could not load VirtualSMS rental catalogue.'});}
}
async function restore(supabase,userId,amount){
 const before=await supabase.from('profiles').select('balance').eq('id',userId).maybeSingle();
 const cr=await supabase.rpc('credit_balance',{p_user_id:userId,p_amount:amount});
 const after=await supabase.from('profiles').select('balance').eq('id',userId).maybeSingle();
 return{ok:!cr.error&&before.data&&after.data&&Number(after.data.balance)>=Number(before.data.balance)+Number(amount)-0.5,error:cr.error?.message||null};
}
async function order(deps){
 const auth=await deps.requireAuth(deps.req);if(!auth.ok)return out(deps,auth.status,{success:false,message:auth.message});
 const b=typeof deps.req.body==='string'?JSON.parse(deps.req.body||'{}'):(deps.req.body||{});
 const service=String(b.service_id||''),hours=Number(b.duration_hours),requestId=String(b.request_id||''),quoted=Number(b.quoted_price_ngn);
 if(!service||!DURATIONS.includes(hours)||!requestId||!(quoted>0))return out(deps,400,{success:false,message:'Select a service and duration, then refresh the price.'});
 const {data:prior}=await deps.supabase.from('number_orders').select('order_id,phone_number,service_name,price,status,code,created_at')
  .eq('source',SOURCE).eq('user_id',auth.userId).eq('idempotency_key','virtualsms_rent_req:'+requestId).maybeSingle();
 if(prior){
  if(prior.order_id&&!String(prior.order_id).startsWith('PENDING-')&&!['refunded','cancelled','canceled','expired'].includes(String(prior.status||'').toLowerCase()))
   return out(deps,200,{success:true,replayed:true,data:{order_id:prior.order_id,number:prior.phone_number,phone:prior.phone_number,service_name:prior.service_name,price_ngn:Number(prior.price),status:prior.status,active_till:prior.code,created_at:prior.created_at}});
  return out(deps,409,{success:false,message:'This purchase request was already processed or is being reconciled. Do not retry with the same request reference.'});
 }
 const {data:plan}=await deps.supabase.from('virtualsms_rent_plans').select('*').eq('country_code','US').eq('service_id',service).eq('duration_hours',hours).maybeSingle();
 if(!plan||plan.admin_hidden||!plan.is_available)return out(deps,409,{success:false,message:'This plan is not currently listed by the supplier. Your wallet has not been charged.'});
 // Do not infer sellability from a stock-count field. VirtualSMS exposes
 // Platform plans separately from a reliable, universal stock quantity.
 // The supplier's price endpoint and final create-rental endpoint are the
 // authority; rejected purchases are refunded through the guarded flow below.
 const qr=await call('/rentals/price?service='+encodeURIComponent(service)+'&country_code=US&duration='+hours);
 if(!qr.ok)return out(deps,502,{success:false,message:'Could not verify the current supplier price. Your wallet has not been charged.'});
 const usd=n(qr.data?.price??qr.data?.our_price??qr.data?.ourPrice??plan.supplier_price_usd),fresh=plan.price_source==='admin'&&Number(plan.price_ngn)>0?Number(plan.price_ngn):sell(usd);
 if(!(usd>0)||!(fresh>0)||fresh+0.01<usd*usdRate())return out(deps,409,{success:false,message:'This plan price needs admin review because it does not cover the current supplier cost.'});
 await deps.supabase.from('virtualsms_rent_plans').update({supplier_price_usd:usd,is_available:true,price_ngn:plan.price_source==='admin'?plan.price_ngn:fresh,synced_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',plan.id);
 if(Math.abs(quoted-fresh)>1){
  return out(deps,409,{success:false,code:'PRICE_UPDATED',message:'Price updated. Refresh and try again.',data:{price_ngn:fresh}});
 }
 const debit=await deps.debitWalletStrict(auth.userId,fresh,'virtualsms_platform_rent');
 if(!debit.ok)return out(deps,400,{success:false,message:debit.message||'Insufficient wallet balance.'});
 const {data:pending,error:pendingErr}=await deps.supabase.from('number_orders').insert({
  source:SOURCE,user_id:auth.userId,customer_id:debit.customer_id||null,order_id:'PENDING-'+requestId,idempotency_key:'virtualsms_rent_req:'+requestId,
  country_id:187,country_name:'United States',service_id:service,service_name:plan.service_name+' · '+label(hours),
  price:fresh,supplier_price:usd,currency:'NGN',status:'processing',refunded:false,
  notes:JSON.stringify({request_id:requestId,duration_hours:hours,tier:'platform',provider:'network'})
 }).select('id').single();
 if(pendingErr||!pending){
  const rf=await restore(deps.supabase,auth.userId,fresh);
  return out(deps,rf.ok?500:503,{success:false,message:rf.ok?'Could not save order. Wallet restored.':'Wallet restoration requires support review. Do not retry.',refunded:!!rf.ok});
 }
 const made=await call('/rentals/provider',{method:'POST',idempotencyKey:requestId,timeoutMs:30000,body:{service,country:187,duration_hours:hours,provider:'network'}});
 if(!made.ok){
  if(made.uncertain||made.status===0||made.status>=500){
   await deps.supabase.from('number_orders').update({status:'reconciliation_required',updated_at:new Date().toISOString()}).eq('id',pending.id);
   return out(deps,503,{success:false,reconciliation_required:true,message:'VirtualSMS did not confirm the result. Your order is being reconciled. Do not purchase again. Reference '+requestId});
  }
  const rf=await restore(deps.supabase,auth.userId,fresh);
  await deps.supabase.from('number_orders').update({status:rf.ok?'refunded':'reconciliation_required',refunded:!!rf.ok,updated_at:new Date().toISOString()}).eq('id',pending.id);
  return out(deps,rf.ok?400:503,{success:false,refunded:!!rf.ok,message:rf.ok?'VirtualSMS rejected the rental. Wallet restored.':'Supplier rejected the rental but wallet restoration needs support review.'});
 }
 const d=made.data||{},rid=String(d.rental_id||d.id||''),phone=String(d.phone_number||d.phone||''),expiry=d.expires_at;
 if(!rid||!phone||!expiry){
  await deps.supabase.from('number_orders').update({status:'reconciliation_required',updated_at:new Date().toISOString()}).eq('id',pending.id);
  return out(deps,503,{success:false,reconciliation_required:true,message:'Supplier accepted the request but returned incomplete details. Do not retry. Reference '+requestId});
 }
 const actual=n(d.retail_cost??d.retailCost)||usd;
 const {error:saveErr}=await deps.supabase.from('number_orders').update({order_id:rid,idempotency_key:'virtualsms_rent_req:'+requestId,phone_number:phone,
  supplier_price:actual,status:'active',code:expiry,updated_at:new Date().toISOString()}).eq('id',pending.id);
 if(saveErr)return out(deps,503,{success:false,reconciliation_required:true,message:'Number created but local save failed. Do not retry. Rental reference '+rid});
 await deps.supabase.from('transactions').insert({user_id:auth.userId,customer_id:debit.customer_id||null,type:'purchase',category:'MJ SMS',
  title:'USA rental · '+plan.service_name,subtitle:phone+' · '+label(hours),amount:'₦'+fresh.toLocaleString(),amount_ngn:fresh,amount_usd:actual,
  status:'pending',external_reference:rid,notes:'virtualsms_rent_request:'+requestId,supplier_order:{provider:SOURCE,rental_id:rid,request_id:requestId}});
 return out(deps,201,{success:true,message:'Your USA VirtualSMS rental is ready.',data:{order_id:rid,rent_id:rid,number:phone,phone,
  service_name:plan.service_name,duration_hours:hours,duration_translation:label(hours),active_till:expiry,price_ngn:fresh,supplier:'VirtualSMS',status:'active',created_at:new Date().toISOString()}});
}
async function messages(deps){
 const auth=await deps.requireAuth(deps.req);if(!auth.ok)return out(deps,auth.status,{success:false,message:auth.message});
 const id=String(deps.url.searchParams.get('rent_id')||deps.url.searchParams.get('rental_id')||'');
 if(!id)return out(deps,400,{success:false,message:'rent_id required'});
 const {data:o}=await deps.supabase.from('number_orders').select('id,order_id,phone_number,service_name,status,price,code,created_at')
  .eq('source',SOURCE).eq('user_id',auth.userId).eq('order_id',id).maybeSingle();
 if(!o)return out(deps,404,{success:false,message:'Rental not found'});
 const {data:list,error}=await deps.supabase.from('virtualsms_rent_messages').select('id,sender,code,content,received_at')
  .eq('rental_id',id).order('received_at',{ascending:true}).limit(200);
 if(error)return out(deps,500,{success:false,message:'Could not load inbox.'});
 return out(deps,200,{success:true,data:(list||[]).map(m=>({id:m.id,code:m.code||'',body:m.content||'',content:m.content||'',from:m.sender||'SMS',sender:m.sender||'SMS',received_at:m.received_at})),
  rental:{id:o.order_id,phone:o.phone_number,service_name:o.service_name,status:o.status,price_ngn:Number(o.price||0),active_till:o.code,created_at:o.created_at,sms_received:(list||[]).length>0}});
}
async function cancel(deps){
 const auth=await deps.requireAuth(deps.req);if(!auth.ok)return out(deps,auth.status,{success:false,message:auth.message});
 const b=typeof deps.req.body==='string'?JSON.parse(deps.req.body||'{}'):(deps.req.body||{}),id=String(b.rent_id||b.rental_id||'');
 if(!id)return out(deps,400,{success:false,message:'rent_id required'});
 const {data:o}=await deps.supabase.from('number_orders').select('*').eq('source',SOURCE).eq('user_id',auth.userId).eq('order_id',id).maybeSingle();
 if(!o)return out(deps,404,{success:false,message:'Rental not found'});
 if(o.refunded||['cancelled','canceled','refunded','expired'].includes(String(o.status).toLowerCase()))return out(deps,409,{success:false,message:'Rental already closed.'});
 if(Date.now()-new Date(o.created_at).getTime()>20*60*1000)return out(deps,409,{success:false,message:'The 20-minute refund window has passed.'});
 const {count,error}=await deps.supabase.from('virtualsms_rent_messages').select('id',{count:'exact',head:true}).eq('rental_id',id);
 if(error)return out(deps,503,{success:false,message:'Could not verify SMS status. Try again.'});
 if(Number(count||0)>0||String(o.status).toLowerCase()==='completed')return out(deps,409,{success:false,message:'Cannot cancel after an SMS has arrived.'});
 const r=await call('/rentals/'+encodeURIComponent(id)+'/cancel',{method:'POST',body:{}});
 if(!r.ok)return out(deps,r.status===425?425:400,{success:false,message:r.status===425?'VirtualSMS requires a 2-minute hold before cancellation. Try again shortly.':(r.error||'Supplier did not confirm cancellation.')});
 const claim=await deps.supabase.from('number_orders').update({refunded:true,status:'refunded',updated_at:new Date().toISOString()})
  .eq('id',o.id).eq('refunded',false).neq('status','refunded').select('id,price').maybeSingle();
 if(claim.error)return out(deps,409,{success:false,message:'Supplier cancelled the rental but refund is already being reconciled. Contact support.'});
 if(!claim.data){
  const {data:latest}=await deps.supabase.from('number_orders').select('refunded,status').eq('id',o.id).maybeSingle();
  if(latest?.refunded||latest?.status==='refunded')return out(deps,200,{success:true,already_refunded:true,data:{order_id:id,status:'refunded',refunded:true}});
  return out(deps,409,{success:false,message:'Supplier cancelled the rental but refund is already being reconciled. Contact support.'});
 }
 const rf=await restore(deps.supabase,auth.userId,Number(claim.data.price||0));
 if(!rf.ok)return out(deps,503,{success:false,message:'Supplier cancelled the rental but wallet restoration needs support review. Rental '+id});
 await deps.supabase.from('transactions').update({status:'refunded',subtitle:'Cancelled — balance restored'}).eq('user_id',auth.userId)
  .eq('category','MJ SMS').eq('type','purchase').eq('external_reference',id);
 return out(deps,200,{success:true,data:{order_id:id,status:'refunded',refunded:true,refunded_amount:Number(claim.data.price||0)}});
}
async function setupWebhook(deps){
 const a=await admin(deps);if(!a.ok)return out(deps,a.status||403,{success:false,message:a.message});
 const b=typeof deps.req.body==='string'?JSON.parse(deps.req.body||'{}'):(deps.req.body||{});
 const threshold=Math.max(0.01,Math.min(100000,Number(b.threshold)||5));
 const events=['sms.received','order.cancelled','order.expired','order.swapped','balance.low'];
 const {data:old}=await deps.supabase.from('virtualsms_rent_webhook_config').select('webhook_id,active').eq('id',1).maybeSingle();
 const url='https://app.mjhub.store/api/virtualsms-rent-webhook';
 if(old?.webhook_id){
  const moved=await call('/customer/webhooks/'+encodeURIComponent(old.webhook_id),{method:'PATCH',body:{url,events,threshold,active:true,paused:false}});
  if(!moved.ok)return out(deps,502,{success:false,message:'Could not update the existing webhook subscriptions: '+moved.error});
  await deps.supabase.from('virtualsms_rent_webhook_config').update({active:true,updated_at:new Date().toISOString()}).eq('id',1);
  return out(deps,200,{success:true,updated:true,events,threshold,message:'All five VirtualSMS webhook events are activated on the MJ HUB endpoint.'});
 }
 const r=await call('/customer/webhooks',{method:'POST',body:{url,description:'MJ HUB USA Platform Rental inbox and account alerts',events,threshold}});
 if(!r.ok||!r.data?.webhook?.id||!r.data?.webhook?.secret)return out(deps,502,{success:false,message:'Webhook registration failed: '+(r.error||'missing secret')});
 const {error}=await deps.supabase.from('virtualsms_rent_webhook_config').upsert({id:1,webhook_id:String(r.data.webhook.id),secret:String(r.data.webhook.secret),active:true,updated_at:new Date().toISOString()});
 if(error)return out(deps,500,{success:false,message:'Webhook registered but secret storage failed. Contact support before retrying.'});
 return out(deps,200,{success:true,message:'VirtualSMS rental inbox webhook configured. Secret stored server-side.'});
}
async function testWebhook(deps){
 const a=await admin(deps);if(!a.ok)return out(deps,a.status||403,{success:false,message:a.message});
 const {data:c}=await deps.supabase.from('virtualsms_rent_webhook_config').select('webhook_id,active').eq('id',1).maybeSingle();
 if(!c?.active||!c.webhook_id)return out(deps,409,{success:false,message:'Set up the VirtualSMS inbox webhook first.'});
 const r=await call('/customer/webhooks/'+encodeURIComponent(c.webhook_id)+'/test',{method:'POST',body:{}});
 if(!r.ok)return out(deps,502,{success:false,message:'VirtualSMS webhook test failed: '+r.error});
 return out(deps,200,{success:true,message:'VirtualSMS accepted the test event. Check webhook delivery logs and inbox connectivity.',data:r.data});
}
async function webhook(deps){
 const raw=await deps.readRawBody(deps.req),h=deps.req.headers||{},sig=String(h['x-virtualsms-signature']||''),ts=Number(h['x-virtualsms-timestamp']||0);
 const {data:c}=await deps.supabase.from('virtualsms_rent_webhook_config').select('secret,active').eq('id',1).maybeSingle();
 if(!c?.active||!c.secret||!sig||!ts||Math.abs(Date.now()-ts)>300000)return out(deps,401,{success:false,message:'Invalid signature or timestamp.'});
 const expected='sha256='+crypto.createHmac('sha256',c.secret).update(raw).digest('hex'),a=Buffer.from(sig),b=Buffer.from(expected);
 if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return out(deps,401,{success:false,message:'Invalid signature.'});
 let p={};try{p=raw?JSON.parse(Buffer.isBuffer(raw)?raw.toString('utf8'):String(raw)):(deps.req.body||{});}catch(_){return out(deps,400,{success:false,message:'Invalid JSON.'});}
 if(p.data?.test===true)return out(deps,200,{success:true,test:true});
 const eventId=String(p.id||h['x-virtualsms-delivery']||''),type=String(p.type||h['x-virtualsms-event']||''),d=p.data||{};
 const rid=String(d.rental_id||d.order_id||d.old_order_id||'');
 if(!eventId||!type)return out(deps,200,{success:true,ignored:true});
 // balance.low is an account-level notification and intentionally has no
 // order_id. Acknowledge it so the supplier does not retry forever.
 if(type==='balance.low')return out(deps,200,{success:true,event:type,threshold:d.threshold??null});
 if(!rid)return out(deps,200,{success:true,ignored:true});
 const {data:o}=await deps.supabase.from('number_orders').select('id,user_id,phone_number,service_name,status,order_id')
  .eq('source',SOURCE).eq('order_id',rid).maybeSingle();
 if(type==='sms.received'){
  const body=String(d.full_text||d.content||''),code=String(d.code||'');
  const {error}=await deps.supabase.from('virtualsms_rent_messages').insert({rental_id:rid,event_id:eventId,phone_number:d.phone_number||o?.phone_number||null,
   service_name:d.service||o?.service_name||null,sender:d.sender||d.from||'SMS',code,content:body||(code?'SMS code: '+code:'New SMS received'),
   received_at:d.received_at||p.created_at||new Date().toISOString()});
  if(error&&/duplicate key/i.test(error.message||''))return out(deps,200,{success:true,duplicate:true});
  if(error)return out(deps,500,{success:false,message:'Could not save SMS event.'});
  if(o){
   await deps.supabase.from('number_orders').update({status:'completed',updated_at:new Date().toISOString()}).eq('id',o.id);
   await deps.supabase.from('transactions').update({status:'completed'}).eq('user_id',o.user_id).eq('category','MJ SMS').eq('type','purchase').eq('external_reference',rid);
  }
 }else if(type==='order.cancelled'&&o){
  // The app's cancel handler performs the wallet refund after supplier confirmation.
  // The webhook only updates state, avoiding a second independent credit path.
  await deps.supabase.from('number_orders').update({status:'cancelled',updated_at:new Date().toISOString()}).eq('id',o.id).eq('refunded',false);
 }else if(type==='order.expired'&&o){
  await deps.supabase.from('number_orders').update({status:'expired',updated_at:new Date().toISOString()}).eq('id',o.id).eq('refunded',false);
 }else if(type==='order.swapped'&&o){
  const nextId=String(d.new_order_id||'').trim(),nextPhone=String(d.new_phone_number||'').trim();
  const patch={updated_at:new Date().toISOString()};
  if(nextId)patch.order_id=nextId;
  if(nextPhone)patch.phone_number=nextPhone;
  await deps.supabase.from('number_orders').update(patch).eq('id',o.id);
 }
 return out(deps,200,{success:true,event:type});
}
export async function handleVirtualSmsRental(deps){
 const a=String(deps.action||'').toLowerCase(),m=String(deps.method||'GET').toUpperCase();
 if(a==='vsrent_webhook'&&m==='POST')return webhook(deps);
 if(a==='vsrent_sync'&&(m==='GET'||m==='POST'))return sync(deps);
 if(a==='vsrent_admin_list'&&m==='GET')return adminList(deps);
 if(a==='vsrent_admin_price'&&m==='POST')return setPrice(deps);
 if(a==='vsrent_admin_hide'&&m==='POST')return hidePlan(deps);
 if(a==='vsrent_setup_webhook'&&m==='POST')return setupWebhook(deps);
 if(a==='vsrent_test_webhook'&&m==='POST')return testWebhook(deps);
 if(a==='vsrent_catalog'&&m==='GET')return catalog(deps);
 if(a==='vsrent_order'&&m==='POST')return order(deps);
 if(a==='vsrent_messages'&&m==='GET')return messages(deps);
 if(a==='vsrent_cancel'&&m==='POST')return cancel(deps);
 return out(deps,400,{success:false,message:'Unknown VirtualSMS rental action.'});
}
