import crypto from 'crypto';
import { profitFloorNgn } from './pricing.js';
import { refundWalletDebit } from './wallet.js';

const BASE='https://virtualsms.io/api/v1', SOURCE='virtualsms_rent', DURATIONS=[24,72,168], MIN_RENTAL_PRICE_NGN=2500;
const apiKey=()=>String(process.env.VIRTUALSMS_API_KEY||process.env.VIRTUAL_SMS_API_KEY||'').trim();
const usdRate=()=>1450;
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
 const keys=new Set(['physicalcount','physicalstock','availablecount','availablenumbers','availablephones','availablephonecount','availablenumbercount','numbersavailable','stockcount','stockquantity','stockavailable','stock','quantity','availablequantity','availablestock','numbercount','totalstock','totalphones','count','totalavailable','available','isavailable','instock']);
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
function countryDisplayName(code,fallback=''){
 const value=String(code||'').trim().toUpperCase();
 if(!/^[A-Z]{2}$/.test(value))return String(fallback||value||'Unknown');
 try{return new Intl.DisplayNames(['en'],{type:'region'}).of(value)||String(fallback||value);}catch(_){return String(fallback||value);}
}
function normalizeCountryName(value){return String(value||'').normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase().replace(/&/g,'and').replace(/[^a-z0-9]+/g,' ').trim();}
// Legacy country lists use display-name variants (for example "USA") while
// the rental catalogue uses ISO-derived names ("United States"). Numeric IDs
// are always discovered from the supplier response, never hardcoded.
const COUNTRY_NAME_ALIASES={
 usa:'united states','united states of america':'united states',
 uk:'united kingdom','great britain':'united kingdom','britain':'united kingdom',
 uae:'united arab emirates','russian federation':'russia',
 'south korea':'korea republic of','republic of korea':'korea republic of',
 'north korea':"korea democratic people s republic of",
 'czech republic':'czechia','ivory coast':'cote d ivoire',
 'viet nam':'vietnam','turkiye':'turkey'
};
const canonicalCountryName=value=>{const name=normalizeCountryName(value);return COUNTRY_NAME_ALIASES[name]||name;};
let supplierCountryIdsCache=null,supplierCountryIdsAt=0;
async function getSupplierCountryIds(){
 const now=Date.now();if(supplierCountryIdsCache&&now-supplierCountryIdsAt<15*60*1000)return supplierCountryIdsCache;
 const key=apiKey();if(!key)return new Map();
 try{
  const url='https://virtualsms.io/stubs/handler_api.php?action=getCountries&api_key='+encodeURIComponent(key);
  const response=await fetch(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(12000)});
  const raw=await response.text();let payload=null;try{payload=JSON.parse(raw);}catch(_){}
  if(!response.ok||!payload||typeof payload!=='object'){
   const legacyResponsePrefix=String(raw||'').replace(/vms_[A-Za-z0-9_-]+/g,'[redacted]').slice(0,120);
   console.warn('[VirtualSMS country ID catalogue unavailable]',{http_status:response.status,response_format:payload===null?'non_json':typeof payload,legacy_response_prefix:legacyResponsePrefix});
   // Some supplier accounts expose the country catalogue only through the
   // authenticated customer API. Prefer that official endpoint as a fallback;
   // accept only supplier-returned positive numeric IDs, never inferred IDs.
   const modern=await call('/customer/countries');
   if(modern.ok&&modern.data&&typeof modern.data==='object')payload=modern.data;
   else return supplierCountryIdsCache||new Map();
  }
  const map=new Map();
  const add=(row,keyId=null)=>{
   // The legacy getCountries endpoint commonly returns an ID-to-name map,
   // e.g. {"187":"USA"}. It can also return name-to-ID maps or row objects.
   // Earlier parsing ignored primitive values, which silently discarded the
   // entire supplier catalogue and left every global rental country unresolved.
   if(typeof row==='string'){
    const id=Number(keyId);
    if(!Number.isSafeInteger(id)||id<=0)return;
    const canonical=canonicalCountryName(row);
    if(canonical)map.set('name:'+canonical,id);
    return;
   }
   if(typeof row==='number'){
    const id=Number(row),name=String(keyId||'').trim();
    if(!Number.isSafeInteger(id)||id<=0||!name)return;
    const canonical=canonicalCountryName(name);
    if(canonical)map.set('name:'+canonical,id);
    if(/^[A-Z]{2}$/i.test(name))map.set('iso:'+name.toUpperCase(),id);
    return;
   }
   if(!row||typeof row!=='object'||Array.isArray(row))return;
   const id=Number(row.id??row.country_id??row.provider_country_id??row.countryId??keyId);
   if(!Number.isSafeInteger(id)||id<=0)return;
   const names=[row.eng,row.name,row.country_name,row.countryName,row.english,row.rus,row.chn,row.title,row.label]
    .map(value=>String(value||'').trim()).filter(Boolean);
   const iso=String(row.iso2||row.country_code||row.countryCode||row.iso||'').trim().toUpperCase();
   for(const name of names){const canonical=canonicalCountryName(name);if(canonical)map.set('name:'+canonical,id);}
   if(/^[A-Z]{2}$/.test(iso))map.set('iso:'+iso,id);
  };
  const walk=(value,depth=0)=>{
   if(!value||depth>6)return;
   if(Array.isArray(value)){for(const row of value){add(row);walk(row,depth+1);}return;}
   if(typeof value!=='object')return;
   add(value);
   for(const [key,row] of Object.entries(value)){
    add(row,key);
    if(row&&typeof row==='object')walk(row,depth+1);
   }
  };
  walk(payload);
  // Resolve the provider's numeric Platform-tier IDs from the supplier's own
  // maintained SDK registry at runtime. The live rentals/available response
  // still controls which countries and plans are displayed; this registry is
  // only the translation layer required by POST /rentals/provider.
  if(!map.size){
   try{
    const sdkResponse=await fetch('https://raw.githubusercontent.com/virtualsms-io/node-sdk/main/src/proxy-endpoint.ts',{
     headers:{Accept:'text/plain'},signal:AbortSignal.timeout(10000)
    });
    if(sdkResponse.ok){
     const sdkSource=await sdkResponse.text();
     const match=sdkSource.match(/PLATFORM_TIER_COUNTRY_IDS\s*:[^=]+?=\s*\\{([\s\\S]*?)\\}/);
     if(match){
      for(const entry of match[1].matchAll(/\b([A-Z]{2})\s*:\s*(\\d+)\b/g)){
       const id=Number(entry[2]);
       if(Number.isSafeInteger(id)&&id>=0)map.set('iso:'+entry[1],id);
      }
     }
    }
   }catch(error){
    console.warn('[VirtualSMS official country registry unavailable]',String(error?.message||error).slice(0,100));
   }
  }
  if(map.size){supplierCountryIdsCache=map;supplierCountryIdsAt=now;}
  else console.warn('[VirtualSMS country ID catalogue empty]',{http_status:response.status,top_level_keys:Object.keys(payload).slice(0,12),response_prefix:String(raw).slice(0,80)});
  return map.size?map:(supplierCountryIdsCache||new Map());
 }catch(error){console.warn('[VirtualSMS country ID catalogue unavailable]',String(error?.message||error).slice(0,120));return supplierCountryIdsCache||new Map();}
}
function countryFlag(code){
 const value=String(code||'').trim().toUpperCase();
 if(!/^[A-Z]{2}$/.test(value))return'';
 return String.fromCodePoint(...[...value].map(ch=>127397+ch.charCodeAt(0)));
}
const SOLD_OUT_RE=/(sold[\s_-]*out|out[\s_-]*of[\s_-]*stock|no[\s_-]*stock|stock[\s_-]*unavailable|no[\s_-]*numbers|no[\s_-]*inventory|service[\s_-]*unavailable|plan[\s_-]*unavailable)/i;
function availabilityState(s){
 const status=String(s?.stock_status??s?.availability_status??s?.status??s?.availability??'').trim();
 if(SOLD_OUT_RE.test(status))return{known:true,available:false,stock:0};
 if(/^(available|in[\s_-]*stock|active|ready)$/i.test(status))return{known:true,available:true,stock:null};
 for(const key of ['is_available','isAvailable','available','in_stock','inStock']){
  if(typeof s?.[key]==='boolean')return{known:true,available:s[key],stock:s[key]?null:0};
  if(typeof s?.[key]==='string'&&/^(true|false|yes|no|available|unavailable)$/i.test(s[key].trim())){
   const yes=/^(true|yes|available)$/i.test(s[key].trim());return{known:true,available:yes,stock:yes?null:0};
  }
 }
 const qtyKeys=['available_count','availableCount','available_numbers','availableNumbers','available_phones','availablePhones','available_phone_count','availablePhoneCount','available_number_count','availableNumberCount','numbers_available','numbersAvailable','stock_count','stockCount','stock_quantity','stockQuantity','stock_available','stockAvailable','total_available','totalAvailable','total_phones','totalPhones','quantity','stock','available','physical_count','physicalCount','physical_stock','physicalStock'];
 const qtyKey=qtyKeys.find(k=>s?.[k]!==undefined&&s?.[k]!==null&&s?.[k]!=='');
 if(qtyKey){const qty=Number(s[qtyKey]);if(Number.isFinite(qty))return{known:true,available:qty>0,stock:Math.floor(Math.max(0,qty))};}
 return{known:false,available:false,stock:null};
}
function stockMeta(s){
 const keys=new Set(['physicalcount','physicalstock','availablecount','availablenumbers','stockcount','stockquantity','stock','quantity','availablequantity','availablestock','numbercount','totalstock','count','totalavailable','available','isavailable','instock']);
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
const durationMinimumNgn=hours=>Number(hours)===24?2500:Number(hours)===72?3500:Number(hours)===168?5000:MIN_RENTAL_PRICE_NGN;
const sell=(usd,hours)=>{const floor=durationMinimumNgn(hours),p=Number(profitFloorNgn(Number(usd),usdRate()));return Number.isFinite(p)&&p>0?Math.max(floor,Math.ceil(p/50)*50):floor;};

let serviceNameDirectoryCache=null,serviceNameDirectoryAt=0;
async function getServiceNameDirectory(){
 const now=Date.now();
 if(serviceNameDirectoryCache&&now-serviceNameDirectoryAt<15*60*1000)return serviceNameDirectoryCache;
 const response=await call('/customer/services');
 if(!response.ok)return new Map();
 let list=arr(response.data);
 const raw=response.data?.data??response.data?.services??response.data;
 if(!list.length&&raw&&typeof raw==='object'&&!Array.isArray(raw)){
  list=Object.entries(raw).map(([code,value])=>({...value,service_id:value?.service_id??value?.serviceId??value?.id??value?.code??code}));
 }
 const map=new Map();
 for(const item of list){
  const codes=[item?.service_id,item?.serviceId,item?.code,item?.service_code,item?.serviceCode,item?.id]
   .map(v=>String(v??'').trim()).filter(Boolean);
  const name=String(item?.name||item?.title||item?.service_name||item?.serviceName||item?.display_name||item?.displayName||item?.label||'').trim();
  if(name)for(const code of codes)if(name.toLowerCase()!==code.toLowerCase())map.set(code,name);
 }
 serviceNameDirectoryCache=map;serviceNameDirectoryAt=now;
 return map;
}

async function call(path,opt={}){
 const key=apiKey();if(!key)return{ok:false,status:503,error:'VIRTUALSMS_API_KEY is not configured'};
 const method=opt.method||'GET',headers={Accept:'application/json','X-API-Key':key};
 await paceVirtualSmsRequest();
 if(opt.body)headers['Content-Type']='application/json';
 if(method!=='GET')headers['X-Idempotency-Key']=opt.idempotencyKey||crypto.randomUUID();
 try{
  const r=await fetch(BASE+path,{method,headers,body:opt.body?JSON.stringify(opt.body):undefined,signal:AbortSignal.timeout(opt.timeoutMs||Number(process.env.VSMS_API_TIMEOUT_MS)||12000)});
  const raw=await r.text();let data=null;try{data=raw?JSON.parse(raw):{};}catch(_){}
  const payload=data?.data?.rental??data?.data?.data?.rental??data?.data?.data??data?.data??data?.rental??data?.result??data;
  const ok=r.ok&&!(data&&typeof data==='object'&&data.success===false)&&!(payload&&typeof payload==='object'&&payload.success===false);
  return{ok,status:r.status,data:payload,raw:String(raw||'').slice(0,1500),error:ok?null:String(data?.message||data?.error||payload?.message||payload?.error||('VirtualSMS HTTP '+r.status)).slice(0,300)};
 }catch(e){return{ok:false,status:0,error:String(e?.message||e).slice(0,300),uncertain:method!=='GET'};}
}

/**
 * Verify platform rental pricing from live supplier data. If the dedicated
 * price endpoint is temporarily unavailable, use the live service catalogue
 * price for the exact service and duration. Never fall back to a stale DB quote.
 */
async function verifyRentalUsdPrice(service,hours,countryCode='US'){
 const direct=await call('/rentals/price?service='+encodeURIComponent(service)+'&country_code='+encodeURIComponent(countryCode)+'&duration='+hours);
 const directMessage=String(direct.error||direct.data?.message||direct.data?.error||'');
 if(SOLD_OUT_RE.test(directMessage))return{ok:false,sold_out:true,usd:0,source:null,price_status:direct.status,catalog_status:null,error:directMessage};
 const directPrice=direct.ok?n(direct.data?.price??direct.data?.our_price??direct.data?.ourPrice):0;
 // Price is not proof of inventory. Always check the live, duration-specific
 // Platform catalogue before allowing a wallet debit.
 const catalog=await call('/rentals/services?country_code='+encodeURIComponent(countryCode)+'&duration='+hours);
 if(catalog.ok){
  const list=arr(catalog.data);
  const validList=Array.isArray(catalog.data)||Array.isArray(catalog.data?.data)||Array.isArray(catalog.data?.services);
  if(!validList)return{ok:false,sold_out:false,usd:0,source:null,price_status:direct.status,catalog_status:catalog.status,error:'Invalid live availability response'};
  const match=list.find(item=>sid(item)===String(service));
  if(!match)return{ok:false,sold_out:true,usd:0,source:null,price_status:direct.status,catalog_status:catalog.status,error:'Plan absent from live rental catalogue'};
  const physical=match?.physical_count;
  const availability=physical!==undefined&&physical!==null&&physical!==''&&Number.isFinite(Number(physical))
   ?{known:true,available:Number(physical)>0,stock:Math.max(0,Math.floor(Number(physical)))}
   :availabilityState(match);
  if(availability.known&&!availability.available)return{ok:false,sold_out:true,usd:0,source:null,price_status:direct.status,catalog_status:catalog.status,error:'Plan sold out'};
  // Existing USA rentals retain their established purchase flow: the supplier's
  // create endpoint remains the final stock authority when no quantity is exposed.
  // Do not permit global-country purchases unless stock is explicitly confirmed.
  if(!availability.known&&countryCode!=='US')return{ok:false,sold_out:false,usd:0,source:null,price_status:direct.status,catalog_status:catalog.status,error:'Supplier did not confirm stock for this country'};
  const catalogPrice=price(match)||directPrice;
  if(catalogPrice>0)return{ok:true,usd:catalogPrice,source:price(match)>0?'live_catalog':'price_endpoint',price_status:direct.status,catalog_status:catalog.status,availability};
 }
 return{ok:false,sold_out:false,usd:0,source:null,price_status:direct.status,catalog_status:catalog.status,
  error:direct.error||'Live price or availability unavailable',catalog_error:catalog.error||null};
}

function out(deps,status,body){return deps.json(deps.res,status,body);}
async function admin(deps){
 const a=await deps.requireAuth(deps.req);if(!a.ok)return a;
 const {data:p,error}=await deps.supabase.from('profiles').select('is_admin').eq('id',a.userId).maybeSingle();
 return !error&&p?.is_admin?{ok:true,userId:a.userId}:{ok:false,status:403,message:'Admin only'};
}
async function readAllRentalPlans(supabase,countryCode=null){
 const result=[];
 for(let offset=0;offset<100000;offset+=1000){
  let query=supabase.from('virtualsms_rent_plans').select('*').order('id').range(offset,offset+999);
  if(Array.isArray(countryCode)&&countryCode.length)query=query.in('country_code',countryCode);
  else if(typeof countryCode==='string'&&countryCode)query=query.eq('country_code',countryCode);
  const {data,error}=await query;
  if(error)throw error;
  const page=data||[];result.push(...page);
  if(page.length<1000)break;
 }
 return result;
}
async function rows(supabase,isAdmin=false,scope='usa'){
 let list;
 if(isAdmin)list=await readAllRentalPlans(supabase);
 else if(scope==='global')list=await readAllRentalPlans(supabase);
 else list=await readAllRentalPlans(supabase,'US');
 if(isAdmin)return list;
 return list.filter(r=>r.admin_hidden!==true&&(scope!=='global'||(String(r.country_code||'').toUpperCase()!=='US'&&Number.isSafeInteger(Number(r.country_id))&&Number(r.country_id)>0)));
}
function publicPlan(r){
 const code=String(r.country_code||'US').toUpperCase();
 const countryName=countryDisplayName(code,r.country_name||r.supplier_data?.country_name);
 return{id:r.id,source:SOURCE,country_code:code,country_id:Number.isSafeInteger(Number(r.country_id))&&Number(r.country_id)>0?Number(r.country_id):null,country_name:countryName,country_flag:r.country_flag||r.supplier_data?.country_flag||countryFlag(code)||null,
 availability_known:r.supplier_data?.availability_known===true,
 service_id:r.service_id,service_name:r.service_name,duration_hours:Number(r.duration_hours),duration_label:label(Number(r.duration_hours)),
 price_ngn:Math.max(durationMinimumNgn(r.duration_hours),Number(r.price_ngn||0)),supplier_price_usd:Number(r.supplier_price_usd||0),price_source:r.price_source,
 icon_url:r.supplier_data?.icon_url||null,is_available:r.admin_hidden!==true&&r.is_available===true,stock_count:Number(r.stock_count||0)};
}
function customerPlan(r){
 const p=publicPlan(r);
 return{country_code:p.country_code,country_name:p.country_name,country_flag:p.country_flag,
  service_id:p.service_id,service_name:p.service_name,duration_hours:p.duration_hours,duration_label:p.duration_label,
  price_ngn:p.price_ngn,is_available:p.is_available,availability_known:p.availability_known};
}
let liveCatalogRefreshAt=0,liveCatalogRefreshPromise=null;
async function refreshLivePlans(deps,allCountries=false,countryOffset=0,countryLimit=1){
 const started=Date.now(),all=[],done=[],errors=[],countryResults=[];
 const serviceNameMap=await getServiceNameDirectory();
 const availability=await call('/rentals/available?provider=network');
 if(!availability.ok)return{ok:false,status:502,message:'Could not retrieve rental countries.',errors:[availability.error]};
 const supplierIds=await getSupplierCountryIds();
 const countries=arr(availability.data).map(c=>{
  const code=String(c?.country_code||c?.countryCode||c?.iso2||c?.code||'').trim().toUpperCase();
  if(!/^[A-Z]{2}$/.test(code))return null;
  const name=countryDisplayName(code,c?.country_name||c?.countryName||c?.name||'');
  const directId=c?.country_id??c?.provider_country_id??c?.countryId??c?.id;
  const incomingName=c?.country_name||c?.countryName||c?.name||name;
  const nameId=supplierIds.get('iso:'+code)||supplierIds.get('name:'+canonicalCountryName(incomingName))||supplierIds.get('name:'+canonicalCountryName(name));
  return{code,name,flag:String(c?.flag||c?.emoji||c?.country_flag||countryFlag(code)).trim(),
   countryId:directId!=null&&directId!==''&&Number.isSafeInteger(Number(directId))?Number(directId):(nameId||null)};
 }).filter(Boolean);
 for(const country of countries){if(!(Number.isSafeInteger(Number(country.countryId))&&Number(country.countryId)>0))errors.push(country.code+': provider country ID was not returned by the supplier country catalogue');}
 if(!countries.length)return{ok:false,status:502,message:'VirtualSMS returned no valid Platform rental countries. Existing catalogue was left unchanged.',errors:['Invalid or empty rentals/available response']};
 const selected=allCountries?countries.slice(Math.max(0,countryOffset),Math.max(0,countryOffset)+Math.max(1,Math.min(2,countryLimit))):countries.filter(c=>c.code==='US');
 if(!selected.length)return{ok:false,status:502,message:'USA is not currently present in the supplier Platform availability response.',errors:['US not listed by supplier']};
 let oldRows=[];try{oldRows=await readAllRentalPlans(deps.supabase,selected.map(country=>country.code));}catch(oldErr){return{ok:false,status:500,message:oldErr.message};}
 const oldBy=new Map(oldRows.map(x=>[String(x.country_code)+'|'+String(x.service_id)+'|'+Number(x.duration_hours),x]));
 const completed=new Set();
 for(const country of selected){
  let countryOk=false;
  for(const h of DURATIONS){
   const r=await call('/rentals/services?country_code='+encodeURIComponent(country.code)+'&duration='+h);
   if(!r.ok){errors.push(country.code+' '+label(h)+': '+r.error);continue;}
   const list=arr(r.data);
   const valid=Array.isArray(r.data)||Array.isArray(r.data?.data)||Array.isArray(r.data?.services);
   if(!valid){errors.push(country.code+' '+label(h)+': invalid live services response');continue;}
   countryOk=true;completed.add(country.code+'|'+h);
   for(const item of list){
    const id=sid(item);if(!id)continue;
    const key=country.code+'|'+id+'|'+h,prior=oldBy.get(key);
    const name=sname(item,serviceNameMap.get(id)||id);
    const usd=price(item);
    if(!name||!(usd>0)){errors.push(country.code+' '+id+' '+label(h)+': supplier did not return a valid live price');continue;}
    const physical=item?.physical_count;
    const availabilityStateValue=physical!==undefined&&physical!==null&&physical!==''&&Number.isFinite(Number(physical))
     ?{known:true,available:Number(physical)>0,stock:Math.max(0,Math.floor(Number(physical)))}
     :availabilityState(item);
    all.push({country_code:country.code,country_id:country.countryId||Number(prior?.country_id)||null,country_name:country.name,country_flag:country.flag,
     service_id:id,service_name:name,duration_hours:h,supplier_price_usd:usd,price_ngn:sell(usd,h),
     stock_count:availabilityStateValue.stock??0,
     // Unknown stock is not sellable for new global-country plans. Preserve
     // the existing USA availability flag until its supplier create call decides.
     is_available:availabilityStateValue.known?availabilityStateValue.available:(country.code==='US'&&prior?.is_available===true),
     supplier_data:{...(prior?.supplier_data||{}),country_name:country.name,country_flag:country.flag,
      physical_count:physical??null,stock_fields:stockMeta(item),availability_known:availabilityStateValue.known,
      our_price:item.our_price??item.ourPrice??null,base_price:item.base_price??item.basePrice??null,
      popular:item.popular===true,icon_url:item.icon_url||prior?.supplier_data?.icon_url||null}});
   }
  }
  if(countryOk)countryResults.push(country.code);
 }
 if(!completed.size)return{ok:false,status:502,message:'No country service catalogue could be refreshed. Existing plans were left unchanged.',errors};
 const by=new Map(oldRows.map(x=>[String(x.country_code)+'|'+String(x.service_id)+'|'+Number(x.duration_hours),x]));
 const seen=new Set(),now=new Date().toISOString(),writes=[];
 let inserted=0,updated=0,manual=0;
 for(const e of all){
  const k=e.country_code+'|'+e.service_id+'|'+e.duration_hours,p=by.get(k);seen.add(k);
  const isManual=p?.price_source==='admin';if(isManual)manual++;
  writes.push({...e,id:p?.id||crypto.randomUUID(),
   price_ngn:isManual?Math.max(durationMinimumNgn(e.duration_hours),Number(p.price_ngn)||0):e.price_ngn,
   price_source:isManual?'admin':'system',admin_hidden:p?.admin_hidden===true,synced_at:now,updated_at:now});
  if(p)updated++;else inserted++;
 }
 // Only mark plans unavailable for country/duration combinations successfully fetched.
 for(const p of oldRows){
  const pair=String(p.country_code)+'|'+Number(p.duration_hours);
  const k=String(p.country_code)+'|'+String(p.service_id)+'|'+Number(p.duration_hours);
  if(!completed.has(pair)||seen.has(k))continue;
  writes.push({...p,supplier_price_usd:Number(p.supplier_price_usd||0),stock_count:0,is_available:false,
   admin_hidden:p.admin_hidden===true,supplier_data:{...(p.supplier_data||{}),availability_known:true,physical_count:0},
   synced_at:now,updated_at:now});
 }
 for(let i=0;i<writes.length;i+=100){
  const {error}=await deps.supabase.from('virtualsms_rent_plans').upsert(writes.slice(i,i+100),{onConflict:'country_code,service_id,duration_hours'});
  if(error)return{ok:false,status:500,message:'Could not save live VirtualSMS availability: '+error.message};
 }
 await deps.supabase.from('sync_jobs').upsert({source:SOURCE,status:errors.length?'partial':'completed',cursor_index:0,total_countries:selected.length,
  new_count:inserted,updated_count:updated,services_seen:all.length,errors,started_at:new Date(started).toISOString(),updated_at:now});
 return{ok:true,all,done:[...completed],countries:selected.map(c=>({code:c.code,name:c.name,flag:c.flag,country_id:c.countryId||null})),
  countries_synced:countryResults.length,total_countries:countries.length,next_offset:allCountries?Math.min(countries.length,Math.max(0,countryOffset)+selected.length):countries.length,
  inserted,updated,manual,duration_ms:Date.now()-started,errors};
}
async function refreshLivePlansCached(deps){
 const now=Date.now();
 if(liveCatalogRefreshPromise)return liveCatalogRefreshPromise;
 if(now-liveCatalogRefreshAt<20000)return{ok:true,cached:true};
 liveCatalogRefreshPromise=refreshLivePlans(deps).then(result=>{
  if(result.ok)liveCatalogRefreshAt=Date.now();
  return result;
 }).finally(()=>{liveCatalogRefreshPromise=null;});
 return liveCatalogRefreshPromise;
}
async function sync(deps){
 const a=await admin(deps);if(!a.ok)return out(deps,a.status||403,{success:false,message:a.message});
 const body=typeof deps.req.body==='string'?JSON.parse(deps.req.body||'{}'):(deps.req.body||{});
 const offset=Math.max(0,Math.floor(Number(body.country_offset)||0));
 const limit=Math.max(1,Math.min(2,Math.floor(Number(body.country_limit)||1)));
 const result=await refreshLivePlans(deps,true,offset,limit);
 if(!result.ok)return out(deps,result.status||502,{success:false,message:result.message,errors:result.errors||[]});
 const inStock=result.all.filter(x=>x.is_available).length;
 const countryIdsResolved=result.countries.filter(x=>Number.isSafeInteger(Number(x.country_id))&&Number(x.country_id)>0).length;
 const countryIdsMissing=result.countries.filter(x=>!Number.isSafeInteger(Number(x.country_id))||Number(x.country_id)<=0).map(x=>x.code);
 return out(deps,200,{success:true,countries:result.countries,countries_synced:result.countries_synced,country_ids_resolved:countryIdsResolved,country_ids_missing:countryIdsMissing,
  durations_synced:result.done.length,plans_seen:result.all.length,inserted:result.inserted,updated:result.updated,
  admin_prices_preserved:result.manual,available_plans:inStock,errors:result.errors,duration_ms:result.duration_ms,
  country_offset:offset,next_country_offset:result.next_offset,total_countries:result.total_countries,done:result.next_offset>=result.total_countries,
  message:result.errors.length?'VirtualSMS global catalogue partially refreshed. Retry to complete remaining countries or plans.':'VirtualSMS global rental catalogue refreshed.'});
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
  const {data:plan}=await deps.supabase.from('virtualsms_rent_plans').select('supplier_price_usd,duration_hours').eq('id',id).maybeSingle();
  if(!plan)return out(deps,404,{success:false,message:'Plan not found.'});
  update.price_ngn=sell(Number(plan.supplier_price_usd||0),Number(plan.duration_hours));update.price_source='system';
 }else{
  const {data:plan}=await deps.supabase.from('virtualsms_rent_plans').select('duration_hours').eq('id',id).maybeSingle();
   if(!plan)return out(deps,404,{success:false,message:'Plan not found.'});
   const minimum=durationMinimumNgn(plan.duration_hours);
   if(!Number.isFinite(p)||p<minimum)return out(deps,400,{success:false,message:'This duration cannot be priced below ₦'+minimum.toLocaleString('en-NG')+'.'});
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
 try{
  const scope=String(deps.url.searchParams.get('scope')||'usa').toLowerCase()==='global'?'global':'usa';
  // Refresh the USA catalogue on customer visits. Global catalogue sync is admin-batched
  // because it spans every supplier country and must not create a long customer request.
  const live=scope==='usa'?await refreshLivePlansCached(deps):{ok:false,cached:false};
  if(scope==='usa'&&!live.ok)console.warn('[VirtualSMS live availability refresh]',live.message);
  const data=await rows(deps.supabase,false,scope);
  const names=await getServiceNameDirectory();
  const mapped=data.map(r=>customerPlan({...r,service_name:names.get(String(r.service_id))||r.service_name}));
  return out(deps,200,{success:true,data:mapped});
 }
 catch(e){console.error('[VirtualSMS rental catalogue]',e?.message||e);return out(deps,500,{success:false,message:'Could not load rental options right now.'});}
}
async function restore(supabase,userId,amount,debitId=null,orderId=null){
 let refund;
 if(orderId){
  const {data,error}=await supabase.rpc('refund_virtualsms_rental_order',{
   p_order_id:orderId,p_user_id:userId,p_reason:'VirtualSMS rental cancellation or failed purchase'
  });
  const row=Array.isArray(data)?data[0]:data;
  refund={ok:!error&&row?.success===true,already_refunded:row?.already_refunded===true,
   error:error?.message||(!row?.success?row?.message:null),
   ngn_restored:Number(row?.amount_ngn||0),usd_restored:Number(row?.amount_usd||0)};
 }else{
  refund=await refundWalletDebit(supabase,userId,debitId);
 }
 return{ok:refund.ok,already_refunded:refund.already_refunded,error:refund.error||refund.message||null,
  amount_ngn:refund.ngn_restored||Number(amount||0),amount_usd:refund.usd_restored||0};
}
async function order(deps){
 const auth=await deps.requireAuth(deps.req);if(!auth.ok)return out(deps,auth.status,{success:false,message:auth.message});
 const b=typeof deps.req.body==='string'?JSON.parse(deps.req.body||'{}'):(deps.req.body||{});
 const service=String(b.service_id||''),hours=Number(b.duration_hours),requestId=String(b.request_id||''),quoted=Number(b.quoted_price_ngn),countryCode=String(b.country_code||'US').trim().toUpperCase();
 const serviceDisplayName=String(b.service_name||'').trim().slice(0,100);
 if(!service||!DURATIONS.includes(hours)||!requestId||!(quoted>0)||! /^[A-Z]{2}$/.test(countryCode))return out(deps,400,{success:false,message:'Select a valid country, service and duration, then refresh the price.'});
 const {data:prior}=await deps.supabase.from('number_orders').select('order_id,phone_number,service_name,price,status,code,created_at,notes')
  .eq('source',SOURCE).eq('user_id',auth.userId).eq('idempotency_key','virtualsms_rent_req:'+requestId).maybeSingle();
 if(prior){
  let priorMeta={};try{priorMeta=JSON.parse(prior.notes||'{}')}catch(_){}
  if(String(priorMeta.country_code||'US').toUpperCase()!==countryCode)return out(deps,409,{success:false,message:'This purchase reference was already used for a different country. Start a new request.'});
  if(prior.order_id&&!String(prior.order_id).startsWith('PENDING-')&&!['refunded','cancelled','canceled','expired'].includes(String(prior.status||'').toLowerCase()))
   return out(deps,200,{success:true,replayed:true,data:{order_id:prior.order_id,number:prior.phone_number,phone:prior.phone_number,service_name:prior.service_name,price_ngn:Number(prior.price),status:prior.status,active_till:prior.code,created_at:prior.created_at}});
  return out(deps,409,{success:false,message:'We are still checking your previous purchase. Please do not submit another order. Reference '+requestId});
 }
 const {data:plan}=await deps.supabase.from('virtualsms_rent_plans').select('*').eq('country_code',countryCode).eq('service_id',service).eq('duration_hours',hours).maybeSingle();
 if(!plan||plan.admin_hidden||!plan.is_available)return out(deps,409,{success:false,message:'This plan is currently unavailable. Your wallet has not been charged.'});
 const providerCountryId=Number(plan.country_id);
 if(!Number.isSafeInteger(providerCountryId)||providerCountryId<=0)return out(deps,409,{success:false,code:'COUNTRY_ID_UNVERIFIED',message:'This country is temporarily unavailable. Your wallet has not been charged.'});
 // Do not infer sellability from a stock-count field. VirtualSMS exposes
 // Platform plans separately from a reliable, universal stock quantity.
 // The supplier's price endpoint and final create-rental endpoint are the
 // authority; rejected purchases are refunded through the guarded flow below.
 const markSoldOut=async()=>{
  const {error}=await deps.supabase.from('virtualsms_rent_plans').update({is_available:false,stock_count:0,synced_at:new Date().toISOString(),updated_at:new Date().toISOString()})
   .eq('country_code',countryCode).eq('service_id',service).eq('duration_hours',hours);
  if(error)console.error('[VirtualSMS availability update failed]',{service,duration_hours:hours,error_code:error.code||'db_error'});
 };
 const verified=await verifyRentalUsdPrice(service,hours,countryCode);
 if(verified.sold_out){
  await markSoldOut();
  return out(deps,409,{success:false,code:'PLAN_SOLD_OUT',message:'This rental plan is sold out. Please choose another duration or service.',data:{out_of_stock:true}});
 }
 if(!verified.ok){
  console.error('[VirtualSMS rental price lookup failed]',{service,duration_hours:hours,
   price_http_status:Number(verified.price_status||0),catalog_http_status:Number(verified.catalog_status||0),
   error_code:verified.price_status===0?'network_error':'price_unavailable',
   supplier_error:String(verified.error||'').replace(/[\\r\\n\\t]+/g,' ').slice(0,180)});
  return out(deps,502,{success:false,message:'The current rental price is temporarily unavailable. Your wallet has not been charged.'});
 }
 const usd=verified.usd,fresh=plan.price_source==='admin'&&Number(plan.price_ngn)>0?Math.max(durationMinimumNgn(hours),Number(plan.price_ngn)):sell(usd,hours);
 if(!(usd>0)||!(fresh>0)||fresh+0.01<usd*usdRate())return out(deps,409,{success:false,message:'This plan price is temporarily unavailable. Please try again later.'});
 await deps.supabase.from('virtualsms_rent_plans').update({supplier_price_usd:usd,is_available:verified.availability?.known===false?(plan.is_available===true):verified.availability?.available!==false,stock_count:verified.availability?.stock??plan.stock_count??0,price_ngn:plan.price_source==='admin'?plan.price_ngn:fresh,synced_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',plan.id);
 if(Math.abs(quoted-fresh)>1){
  return out(deps,409,{success:false,code:'PRICE_UPDATED',message:'Price updated. Refresh and try again.',data:{price_ngn:fresh}});
 }
 const debit=await deps.debitWalletStrict(auth.userId,fresh,'virtualsms_platform_rent');
 if(!debit.ok)return out(deps,400,{success:false,message:debit.message||'Insufficient wallet balance.'});
 const {data:pending,error:pendingErr}=await deps.supabase.from('number_orders').insert({
  source:SOURCE,user_id:auth.userId,customer_id:debit.customer_id||null,wallet_debit_id:debit.wallet_debit_id,order_id:'PENDING-'+requestId,idempotency_key:'virtualsms_rent_req:'+requestId,
  country_id:providerCountryId,country_name:plan.country_name||countryDisplayName(countryCode),service_id:service,service_name:(serviceDisplayName||plan.service_name)+' · '+label(hours),
  price:fresh,supplier_price:usd,currency:'NGN',status:'processing',refunded:false,
  notes:JSON.stringify({request_id:requestId,duration_hours:hours,country_code:countryCode,country_id:providerCountryId,tier:'platform',provider:'network'})
 }).select('id,wallet_debit_id').single();
 if(pendingErr||!pending){
  const rf=await restore(deps.supabase,auth.userId,fresh,debit.wallet_debit_id);
  return out(deps,rf.ok?500:503,{success:false,message:rf.ok?'Could not save order. Wallet restored.':'Wallet restoration requires support review. Do not retry.',refunded:!!rf.ok});
 }
 // Record the wallet debit before supplier I/O so ambiguous outcomes remain visible.
 const pendingRef='PENDING-'+requestId;
 const pendingTx={user_id:auth.userId,customer_id:debit.customer_id||null,type:'purchase',category:'MJ SMS',
  title:(plan.country_name||countryDisplayName(countryCode))+' rental · '+(serviceDisplayName||plan.service_name),subtitle:'Purchase status checking — do not retry',
  amount:'₦'+fresh.toLocaleString(),amount_ngn:Number(debit.ngn_debited||0),amount_usd:Number(debit.usd_debited||0),
  status:'pending',external_reference:pendingRef,notes:'virtualsms_rent_request:'+requestId};
 let pendingTxSaved=false,pendingTxError=null;
 for(let attempt=0;attempt<2&&!pendingTxSaved;attempt++){
  const {data:existingPendingTx,error:lookupError}=await deps.supabase.from('transactions').select('id')
   .eq('user_id',auth.userId).eq('category','MJ SMS').eq('type','purchase').eq('external_reference',pendingRef).maybeSingle();
  if(lookupError){pendingTxError=lookupError;}
  else if(existingPendingTx){
   const {data:saved,error}=await deps.supabase.from('transactions').update({status:'pending',subtitle:pendingTx.subtitle})
    .eq('id',existingPendingTx.id).select('id').maybeSingle();
   pendingTxSaved=!!saved&&!error;pendingTxError=error||(!saved?new Error('Pending transaction update returned no row'):null);
  }else{
   const {data:saved,error}=await deps.supabase.from('transactions').insert(pendingTx).select('id').maybeSingle();
   pendingTxSaved=!!saved&&!error;pendingTxError=error||(!saved?new Error('Pending transaction insert returned no row'):null);
  }
  if(!pendingTxSaved&&attempt===0)await new Promise(resolve=>setTimeout(resolve,300));
 }
 if(!pendingTxSaved){
  console.error('[VirtualSMS rental pending transaction save failed]',{request_id:requestId,error_code:pendingTxError?.code||'db_error'});
  const rf=await restore(deps.supabase,auth.userId,fresh,pending.wallet_debit_id,pending.id);
  const finalStatus=rf.ok?'refunded':'refund_pending';
  const {error:orderRefundError}=await deps.supabase.from('number_orders').update({
   status:finalStatus,refunded:!!rf.ok,updated_at:new Date().toISOString(),
   notes:'Supplier request was not sent because the pending transaction could not be recorded. Exact wallet refund '+(rf.ok?'completed.':'requires reconciliation.')
  }).eq('id',pending.id);
  if(orderRefundError)console.error('[VirtualSMS rental pre-supplier refund order update failed]',{request_id:requestId,error_code:orderRefundError.code||'db_error'});
  const failedTx={...pendingTx,status:rf.ok?'refunded':'pending',subtitle:rf.ok?'Purchase not sent — wallet refunded':'Purchase not sent — wallet refund pending'};
  const {data:failedTxExisting,error:failedTxLookupError}=await deps.supabase.from('transactions').select('id')
   .eq('user_id',auth.userId).eq('category','MJ SMS').eq('type','purchase').eq('external_reference',pendingRef).maybeSingle();
  let failedTxError=failedTxLookupError;
  if(!failedTxError&&failedTxExisting){
   const {error}=await deps.supabase.from('transactions').update({status:failedTx.status,subtitle:failedTx.subtitle,notes:failedTx.notes})
    .eq('id',failedTxExisting.id);failedTxError=error;
  }else if(!failedTxError){
   const {error}=await deps.supabase.from('transactions').insert(failedTx);failedTxError=error;
  }
  if(failedTxError)console.error('[VirtualSMS rental pre-supplier refund transaction failed]',{request_id:requestId,error_code:failedTxError.code||'db_error'});
  return out(deps,rf.ok?503:503,{success:false,refunded:!!rf.ok,reconciliation_required:!rf.ok,
   message:rf.ok?'Your rental request was not sent. Your wallet has been refunded. Please try again.':'Your rental request was not sent, but the wallet refund needs reconciliation. Do not retry yet. Reference '+requestId});
 }
 const made=await call('/rentals/provider',{method:'POST',idempotencyKey:requestId,timeoutMs:30000,body:{service,country:providerCountryId,duration_hours:hours,provider:'network'}});
 const providerAttempt={
  attempted_at:new Date().toISOString(),
  http_status:Number(made.status||0),
  outcome:!made.ok?(made.uncertain||made.status===0?'network_uncertain':made.status>=500?'provider_server_error':'provider_rejected'):'provider_accepted',
  response_fields:made.data&&typeof made.data==='object'?Object.keys(made.data).slice(0,30):[],
  has_rental_id:!!(made.data?.rental_id||made.data?.id),
  has_phone_number:!!(made.data?.phone_number||made.data?.phone),
  has_expiry:!!made.data?.expires_at
 };
 const saveAttempt=async(status,refunded)=>{
  const safeNotes={request_id:requestId,duration_hours:hours,country_code:countryCode,country_id:providerCountryId,tier:'platform',provider:'network',provider_attempt:providerAttempt};
  let saved=false,lastError=null;
  for(let attempt=0;attempt<2&&!saved;attempt++){
   const {data,error}=await deps.supabase.from('number_orders').update({
    status,refunded:!!refunded,notes:JSON.stringify(safeNotes),updated_at:new Date().toISOString()
   }).eq('id',pending.id).select('id').maybeSingle();
   saved=!!data&&!error;lastError=error||(!data?new Error('Purchase attempt update returned no row'):null);
   if(!saved&&attempt===0)await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(!saved)console.error('[VirtualSMS rental audit save failed]',{request_id:requestId,error_code:lastError?.code||'db_error'});
  return saved;
 };
 if(!made.ok){
  const supplierSaysSoldOut=SOLD_OUT_RE.test(String(made.error||made.data?.message||made.data?.error||''));
  const supplierHttpStatus=Number(made.status||0);
  const ambiguous=!!made.uncertain||supplierHttpStatus===0||[408,425,429].includes(supplierHttpStatus)||(supplierHttpStatus>=500&&!supplierSaysSoldOut);
  if(supplierSaysSoldOut)await markSoldOut();
  console.error('[VirtualSMS rental create failed]',{request_id:requestId,...providerAttempt});
  if(ambiguous){
   providerAttempt.refund_status='withheld_pending_reconciliation';
   providerAttempt.supplier_followup_required=true;
   await saveAttempt('reconciliation_required',false);
   return out(deps,503,{success:false,code:'SUPPLIER_RESULT_UNCONFIRMED',refunded:false,reconciliation_required:true,
    message:'Your purchase is being verified. Your wallet has not been refunded yet. Do not submit another purchase. Reference '+requestId});
  }
  const rf=await restore(deps.supabase,auth.userId,fresh,pending.wallet_debit_id,pending.id);
  providerAttempt.refund_attempted_at=new Date().toISOString();
  providerAttempt.refund_status=rf.ok?'refunded':'refund_pending';
  providerAttempt.supplier_followup_required=false;
  await saveAttempt(rf.ok?'refunded':'reconciliation_required',!!rf.ok);
  if(rf.ok){
   const refundTx={...pendingTx,subtitle:'Purchase unsuccessful — wallet refunded',status:'refunded'};
   const {data:existingRefundTx}=await deps.supabase.from('transactions').select('id')
    .eq('user_id',auth.userId).eq('category','MJ SMS').eq('type','purchase').eq('external_reference',pendingRef).maybeSingle();
   if(existingRefundTx)await deps.supabase.from('transactions').update({status:'refunded',subtitle:refundTx.subtitle,notes:refundTx.notes}).eq('id',existingRefundTx.id);
   else {
    const {error:refundTxError}=await deps.supabase.from('transactions').insert(refundTx);
    if(refundTxError)console.error('[VirtualSMS refund transaction save failed]',{request_id:requestId,error_code:refundTxError.code||'db_error'});
   }
  }
  return out(deps,rf.ok?400:503,{success:false,code:supplierSaysSoldOut?'PLAN_SOLD_OUT':undefined,refunded:!!rf.ok,reconciliation_required:false,
   data:supplierSaysSoldOut?{out_of_stock:true}:undefined,
   message:supplierSaysSoldOut?'This rental plan is sold out. Your wallet has been refunded.':(rf.ok?'Your purchase could not be completed. Your wallet has been refunded.':'Your purchase could not be completed. Your wallet refund is being processed.')});
 }
 const d=made.data||{},rid=String(d.rental_id||d.rentalId||d.id||''),phone=String(d.phone_number||d.phoneNumber||d.phone||''),expiry=d.expires_at||d.expiresAt||d.expiry;
 if(!rid||!phone||!expiry){
  providerAttempt.outcome='incomplete_provider_response';
  providerAttempt.refund_status='withheld_pending_reconciliation';
  providerAttempt.supplier_followup_required=true;
  await saveAttempt('reconciliation_required',false);
  console.error('[VirtualSMS rental response incomplete]',{request_id:requestId,...providerAttempt});
  return out(deps,503,{success:false,refunded:false,reconciliation_required:true,
   message:'We could not confirm the rental details yet. Your purchase is being verified. No refund has been issued yet. Do not submit another purchase. Reference '+requestId});
 }
 const actual=n(d.retail_cost??d.retailCost)||usd;
 // The final create response is authoritative for actual supplier cost. If
 // the supplier charged more than the customer's debit covers, cancel first
 // and only then restore the exact wallet debit.
 const actualCostNgn=actual*usdRate();
 if(actual>0&&actualCostNgn>fresh+0.01){
  console.error('[VirtualSMS rental actual cost exceeded sale price]',{
   request_id:requestId,rental_id:rid,service,duration_hours:hours,
   sale_price_ngn:fresh,supplier_cost_usd:actual,supplier_cost_ngn:actualCostNgn
  });
  const cancellation=await call('/rentals/'+encodeURIComponent(rid)+'/cancel',{
   method:'POST',idempotencyKey:'vsrent-price-guard-cancel:'+rid,body:{}
  });
  if(cancellation.ok){
   const rf=await restore(deps.supabase,auth.userId,fresh,pending.wallet_debit_id,pending.id);
   const {error:orderError}=await deps.supabase.from('number_orders').update({
    order_id:rid,idempotency_key:'virtualsms_rent_req:'+requestId,phone_number:phone,
    supplier_price:actual,status:rf.ok?'refunded':'refund_pending',refunded:!!rf.ok,
    code:expiry,updated_at:new Date().toISOString(),
    notes:rf.ok
     ?'Supplier actual cost exceeded sale price. Supplier cancellation confirmed and exact wallet debit refunded.'
     :'Supplier cancellation confirmed, but exact wallet refund requires reconciliation.'
   }).eq('id',pending.id);
   const {error:txError}=await deps.supabase.from('transactions').update({
    status:rf.ok?'refunded':'pending',
    subtitle:rf.ok?'Supplier price changed — rental cancelled and wallet refunded':'Supplier price changed — wallet refund pending'
   }).eq('user_id',auth.userId).eq('category','MJ SMS').eq('type','purchase').eq('external_reference',pendingRef);
   if(orderError||txError)console.error('[VirtualSMS rental price-guard persistence failed]',{
    request_id:requestId,order_error:orderError?.message||null,transaction_error:txError?.message||null
   });
   return out(deps,rf.ok?409:503,{
    success:false,code:rf.ok?'SUPPLIER_PRICE_CHANGED_CANCELLED':'REFUND_RECONCILIATION_REQUIRED',
    refunded:!!rf.ok,reconciliation_required:!rf.ok,
    message:rf.ok
     ?'The rental price changed after checkout. The rental was cancelled and your wallet was refunded. Refresh before trying again.'
     :'The rental was cancelled, but your wallet refund needs reconciliation. Do not purchase again. Reference '+requestId
   });
  }
  console.error('[VirtualSMS rental price-guard cancellation unconfirmed]',{
   request_id:requestId,rental_id:rid,http_status:cancellation.status||0,
   error:String(cancellation.error||'').slice(0,180)
  });
  // Do not refund while the supplier may still have an active paid rental.
 }
 const orderPatch={order_id:rid,idempotency_key:'virtualsms_rent_req:'+requestId,phone_number:phone,
  supplier_price:actual,status:'active',code:expiry,updated_at:new Date().toISOString()};
 let orderSaved=false,orderSaveError=null;
 for(let attempt=0;attempt<2&&!orderSaved;attempt++){
  const {data,error}=await deps.supabase.from('number_orders').update(orderPatch).eq('id',pending.id).select('id').maybeSingle();
  orderSaved=!!data&&!error;orderSaveError=error||(!data?new Error('Order update returned no row'):null);
  if(!orderSaved&&attempt===0)await new Promise(resolve=>setTimeout(resolve,300));
 }
 if(!orderSaved){
  console.error('[VirtualSMS rental order persistence failed]',{request_id:requestId,rental_id:rid,error_code:orderSaveError?.code||'db_error'});
  await deps.supabase.from('number_orders').update({
   order_id:rid,phone_number:phone,supplier_price:actual,code:expiry,status:'reconciliation_required',
   notes:'Supplier confirmed rental. Order history persistence requires reconciliation. Do not purchase again.',
   updated_at:new Date().toISOString()
  }).eq('id',pending.id);
  return out(deps,200,{success:true,reconciliation_required:true,message:'Your rental was created successfully. Order history is being reconciled. Do not purchase again.',
   data:{order_id:rid,rent_id:rid,number:phone,phone,service_name:serviceDisplayName||plan.service_name,
    duration_hours:hours,duration_translation:label(hours),active_till:expiry,price_ngn:fresh,status:'active',created_at:new Date().toISOString()}});
 }
 const tx={user_id:auth.userId,customer_id:debit.customer_id||null,type:'purchase',category:'MJ SMS',
  title:(plan.country_name||countryDisplayName(countryCode))+' rental · '+(serviceDisplayName||plan.service_name),subtitle:phone+' · '+label(hours),amount:'₦'+fresh.toLocaleString(),
  amount_ngn:Number(debit.ngn_debited||0),amount_usd:Number(debit.usd_debited||0),
  status:'pending',external_reference:rid,notes:'virtualsms_rent_request:'+requestId,supplier_order:{provider:SOURCE,rental_id:rid,request_id:requestId,supplier_cost_usd:actual}};
 let txSaved=false,txSaveError=null;
 for(let attempt=0;attempt<2&&!txSaved;attempt++){
  const {data:existingPending}=await deps.supabase.from('transactions').select('id')
   .eq('user_id',auth.userId).eq('category','MJ SMS').eq('type','purchase').eq('external_reference',pendingRef).maybeSingle();
  if(existingPending){
   const {data,error}=await deps.supabase.from('transactions').update({...tx}).eq('id',existingPending.id).select('id').maybeSingle();
   txSaved=!!data&&!error;txSaveError=error||(!data?new Error('Pending transaction update returned no row'):null);
  }else{
   const {data:existingTx,error:lookupError}=await deps.supabase.from('transactions').select('id')
    .eq('user_id',auth.userId).eq('category','MJ SMS').eq('type','purchase').eq('external_reference',rid).maybeSingle();
   if(lookupError){txSaveError=lookupError;}
   else if(existingTx){
    const {data,error}=await deps.supabase.from('transactions').update({...tx}).eq('id',existingTx.id).select('id').maybeSingle();
    txSaved=!!data&&!error;txSaveError=error||(!data?new Error('Existing transaction update returned no row'):null);
   }else{
    const {data,error}=await deps.supabase.from('transactions').insert(tx).select('id').maybeSingle();
    txSaved=!!data&&!error;txSaveError=error||(!data?new Error('Transaction insert returned no row'):null);
   }
  }
  if(!txSaved&&attempt===0)await new Promise(resolve=>setTimeout(resolve,300));
 }
 if(!txSaved){
  console.error('[VirtualSMS rental transaction persistence failed]',{request_id:requestId,rental_id:rid,error_code:txSaveError?.code||'db_error'});
  await deps.supabase.from('number_orders').update({
   status:'reconciliation_required',
   notes:'Supplier confirmed rental and order was saved. Transaction history persistence requires reconciliation. Do not purchase again.',
   updated_at:new Date().toISOString()
  }).eq('id',pending.id);
  return out(deps,200,{success:true,reconciliation_required:true,message:'Your rental is active. Transaction history is being reconciled. Do not purchase again.',
   data:{order_id:rid,rent_id:rid,number:phone,phone,service_name:serviceDisplayName||plan.service_name,
    duration_hours:hours,duration_translation:label(hours),active_till:expiry,price_ngn:fresh,status:'active',created_at:new Date().toISOString()}});
 }
 return out(deps,201,{success:true,message:'Your '+(plan.country_name||countryDisplayName(countryCode))+' rental is ready.',data:{order_id:rid,rent_id:rid,number:phone,phone,
  service_name:serviceDisplayName||plan.service_name,duration_hours:hours,duration_translation:label(hours),active_till:expiry,price_ngn:fresh,status:'active',created_at:new Date().toISOString()}});
}
async function adminFailRefund(deps){
 const a=await admin(deps);if(!a.ok)return out(deps,a.status||403,{success:false,message:a.message});
 const b=typeof deps.req.body==='string'?JSON.parse(deps.req.body||'{}'):(deps.req.body||{});
 const ref=String(b.reference||'').trim();
 if(!ref||b.confirm_no_supplier_charge!==true)return out(deps,400,{success:false,message:'Explicit admin confirmation is required.'});
 const {data:o,error}=await deps.supabase.from('number_orders').select('*')
  .eq('source',SOURCE).eq('idempotency_key','virtualsms_rent_req:'+ref).maybeSingle();
 if(error||!o)return out(deps,404,{success:false,message:'Purchase record not found.'});
 if(o.refunded||String(o.status||'').toLowerCase()==='refunded'){
  const prior=await restore(deps.supabase,o.user_id,Number(o.price||0),o.wallet_debit_id,o.id);
  if(!prior.ok)return out(deps,503,{success:false,message:'Wallet restoration is still pending.'});
  return out(deps,200,{success:true,status:'refunded',amount_ngn:prior.amount_ngn,already_refunded:true});
 }
 const pendingId='PENDING-'+ref;
 if(o.order_id&&String(o.order_id)!==pendingId||o.phone_number)
  return out(deps,409,{success:false,message:'A rental is already attached. Use the normal cancellation process instead.'});
 const {count:smsCount,error:smsError}=await deps.supabase.from('virtualsms_rent_messages')
  .select('id',{count:'exact',head:true}).eq('rental_id',pendingId);
 if(smsError)return out(deps,503,{success:false,message:'Could not verify the order inbox. No refund was issued.'});
 if(Number(smsCount||0)>0)return out(deps,409,{success:false,message:'An SMS record exists. Manual review is required.'});
 if(!['reconciliation_required','pending','failed','cancelled','canceled'].includes(String(o.status||'').toLowerCase()))
  return out(deps,409,{success:false,message:'This order is not eligible for failed-purchase refund.'});
 const rf=await restore(deps.supabase,o.user_id,Number(o.price||0),o.wallet_debit_id,o.id);
 if(!rf.ok)return out(deps,503,{success:false,message:'Wallet restoration failed. No completion was recorded.'});
 const now=new Date().toISOString();
 const {error:finalizeError}=await deps.supabase.from('number_orders').update({
  status:'refunded',refunded:true,updated_at:now,
  notes:(String(o.notes||'').slice(0,1200)+' | Admin confirmed no supplier rental or charge; failed purchase refunded '+now).slice(0,1600)
 }).eq('id',o.id).eq('refunded',false);
 if(finalizeError)return out(deps,503,{success:false,message:'Wallet restored; order status finalization needs retry.'});
 const {data:existing}=await deps.supabase.from('transactions').select('id')
  .eq('user_id',o.user_id).eq('category','MJ SMS').eq('type','purchase').eq('external_reference',pendingId).maybeSingle();
 const patch={user_id:o.user_id,customer_id:o.customer_id||null,type:'purchase',category:'MJ SMS',
  title:(o.country_name||'Rental')+' rental · '+String(o.service_name||'Rental'),subtitle:'Purchase unsuccessful — wallet refunded',
  amount:'₦'+Number(o.price||0).toLocaleString(),amount_ngn:Number(o.price||0),
  amount_usd:Number(o.supplier_price||0),status:'refunded',external_reference:pendingId,
  notes:'virtualsms_rent_request:'+ref};
 const txResult=existing
  ?await deps.supabase.from('transactions').update({status:'refunded',subtitle:patch.subtitle,notes:patch.notes}).eq('id',existing.id)
  :await deps.supabase.from('transactions').insert(patch);
 if(txResult.error)console.error('[VirtualSMS admin refund transaction]',txResult.error.message);
 return out(deps,200,{success:true,status:'refunded',amount_ngn:rf.amount_ngn,transaction_updated:!txResult.error});
}
async function reconcile(deps){
 const a=await admin(deps);if(!a.ok)return out(deps,a.status||403,{success:false,message:a.message});
 const b=typeof deps.req.body==='string'?JSON.parse(deps.req.body||'{}'):(deps.req.body||{});
 const ref=String(b.reference||b.request_id||'').trim();
 if(!ref)return out(deps,400,{success:false,message:'Reference is required.'});
 const {data:o,error:oErr}=await deps.supabase.from('number_orders').select('*')
  .eq('source',SOURCE).eq('idempotency_key','virtualsms_rent_req:'+ref).maybeSingle();
 if(oErr||!o)return out(deps,404,{success:false,message:'Reconciliation record not found.'});
 const customerAlreadyRefunded=!!o.refunded||String(o.status||'').toLowerCase()==='refunded';
 let refundAmount=Number(o.price||0);
 if(customerAlreadyRefunded){
  const rf=await restore(deps.supabase,o.user_id,refundAmount,o.wallet_debit_id,o.id);
  if(!rf.ok)return out(deps,503,{success:false,status:'refund_pending',message:'Wallet refund finalization is still pending.'});
  refundAmount=rf.amount_ngn;
 }
 const meta=(()=>{try{return JSON.parse(o.notes||'{}')}catch(_){return {}}})();
 const countryCode=String(meta.country_code||'US').toUpperCase();
 const hours=Number(meta.duration_hours||0),created=new Date(o.created_at).getTime();
 const from=new Date(created-10*60*1000).toISOString(),to=new Date(created+10*60*1000).toISOString();
 const [rentals,transactions]=await Promise.all([
  call('/rentals?status=all'),
  call('/customer/transactions?from='+encodeURIComponent(from)+'&to='+encodeURIComponent(to)+'&limit=100&offset=0')
 ]);
 if(!rentals.ok||!transactions.ok)return out(deps,503,{success:false,status:customerAlreadyRefunded?'refunded':'reconciliation_required',message:customerAlreadyRefunded?'Your wallet refund is complete. The rental outcome could not be verified yet.':'Purchase status could not be verified yet. No additional charge or refund was made.'});
 const rentalRows=Array.isArray(rentals.data)?rentals.data:Array.isArray(rentals.data?.rentals)?rentals.data.rentals:[];
 const candidates=rentalRows.filter(r=>{
  const started=new Date(r.started_at||r.created_at||0).getTime();
  const supplierCountry=String(r.country_code||r.country||r.iso2||'').trim().toUpperCase();
  const supplierCountryName=normalizeCountryName(r.country_name||r.countryName||'');
  const expectedCountryName=normalizeCountryName(o.country_name||countryDisplayName(countryCode));
  const countryMatches=supplierCountry?(/^[A-Z]{2}$/.test(supplierCountry)?supplierCountry===countryCode:(/^\d+$/.test(supplierCountry)?Number(supplierCountry)===Number(o.country_id):supplierCountryName===expectedCountryName)):(countryCode==='US');
  return countryMatches&&String(r.service_id||'')===String(o.service_id)&&Number(r.duration_hours)===hours
   &&Math.abs(started-created)<=10*60*1000&&Math.abs(Number(r.price||0)-Number(o.supplier_price||0))<0.02;
 });
 const txRows=Array.isArray(transactions.data?.transactions)?transactions.data.transactions:[];
 const chargeRows=txRows.filter(t=>{
  const at=new Date(t.created_at||0).getTime();
  return Math.abs(at-created)<=10*60*1000&&Math.abs(Number(t.amount||0)-Number(o.supplier_price||0))<0.02
   &&/charge|rental|purchase|debit/i.test(String(t.type||'')+' '+String(t.description||''));
 });
 if(candidates.length>1)return out(deps,409,{success:false,message:'More than one matching purchase was found. Manual review is required.'});
 const {data:plan}=await deps.supabase.from('virtualsms_rent_plans').select('service_name').eq('country_code',countryCode).eq('service_id',o.service_id).eq('duration_hours',hours).maybeSingle();
 const serviceName=plan?.service_name||o.service_name;
 if(candidates.length===1){
  const r=candidates[0],rid=String(r.id||r.rental_id||'');
  if(!rid)return out(deps,503,{success:false,message:'A matching rental was found but its reference is incomplete.'});
  const hasSms=Number(r.sms_received||0)>0;
  const terminal=['cancelled','canceled','expired','refunded'].includes(String(r.status||'').toLowerCase());
  if(customerAlreadyRefunded){
   let cleanup='not_required';
   if(!terminal&&!hasSms){
    const cancelled=await call('/rentals/'+encodeURIComponent(rid)+'/cancel',{method:'POST',idempotencyKey:'vsrent-timeout-cleanup:'+ref,body:{}});
    cleanup=cancelled.ok?'cancelled':'required';
   }else if(!terminal&&hasSms)cleanup='manual_review_sms_received';
   const followup={...meta,late_supplier_rental_id:rid,late_supplier_rental_status:String(r.status||'unknown'),
    supplier_cleanup:cleanup,supplier_cleanup_checked_at:new Date().toISOString()};
   const {error:followupError}=await deps.supabase.from('number_orders').update({notes:JSON.stringify(followup),updated_at:new Date().toISOString()}).eq('id',o.id);
   if(followupError)console.error('[VirtualSMS late rental follow-up save failed]',{request_id:ref,error_code:followupError.code||'db_error'});
   return out(deps,200,{success:true,status:'refunded',supplier_cleanup:cleanup,amount_ngn:refundAmount,
    message:cleanup==='cancelled'?'Customer refund confirmed. The late rental was cancelled.':
     cleanup==='required'||cleanup==='manual_review_sms_received'?'Customer refund confirmed. Additional verification is required.':'Customer refund confirmed.'});
  }
  if(terminal&&!hasSms){
   const rf=await restore(deps.supabase,o.user_id,Number(o.price||0),o.wallet_debit_id,o.id);
   if(!rf.ok)return out(deps,503,{success:false,message:'The purchase was closed, but wallet restoration is still pending.'});
   await deps.supabase.from('number_orders').update({order_id:rid,phone_number:r.phone_number||null,service_name:serviceName,status:'refunded',refunded:true,code:r.expires_at||null,updated_at:new Date().toISOString()}).eq('id',o.id);
   await deps.supabase.from('transactions').update({status:'refunded',subtitle:'Purchase cancelled — balance restored'}).eq('user_id',o.user_id).eq('category','MJ SMS').eq('type','purchase').eq('external_reference','PENDING-'+ref);
   return out(deps,200,{success:true,status:'refunded',amount_ngn:rf.amount_ngn});
  }
  await deps.supabase.from('number_orders').update({order_id:rid,phone_number:r.phone_number||null,service_name:serviceName,status:hasSms?'completed':'active',refunded:false,code:r.expires_at||null,updated_at:new Date().toISOString()}).eq('id',o.id);
  const tx={user_id:o.user_id,customer_id:o.customer_id||null,type:'purchase',category:'MJ SMS',title:(o.country_name||countryDisplayName(countryCode))+' rental · '+serviceName,
   subtitle:(r.phone_number||'')+' · '+label(hours),amount:'₦'+Number(o.price||0).toLocaleString(),amount_ngn:Number(o.price||0),
   amount_usd:Number(o.supplier_price||0),status:hasSms?'completed':'pending',external_reference:rid,notes:'virtualsms_rent_request:'+ref,
   supplier_order:{provider:SOURCE,rental_id:rid,request_id:ref}};
  const {data:existing}=await deps.supabase.from('transactions').select('id').eq('user_id',o.user_id).eq('category','MJ SMS').eq('type','purchase').eq('external_reference',rid).maybeSingle();
  if(!existing)await deps.supabase.from('transactions').insert(tx);
  return out(deps,200,{success:true,status:hasSms?'completed':'active',rental_id:rid,phone:r.phone_number||null});
 }
 if(chargeRows.length>0)return out(deps,409,{success:false,status:customerAlreadyRefunded?'refunded':'supplier_charge_review',
  message:customerAlreadyRefunded?'Customer refund is already complete. A charge was found without a matching rental and needs investigation.':'A charge was found but no matching rental is visible yet. Refund withheld pending confirmation.'});
 if(customerAlreadyRefunded)return out(deps,200,{success:true,status:'refunded',supplier_cleanup:'no_rental_or_charge_found',amount_ngn:refundAmount});
 const rf=await restore(deps.supabase,o.user_id,Number(o.price||0),o.wallet_debit_id,o.id);
 if(!rf.ok)return out(deps,503,{success:false,message:'No completed purchase was found, but wallet restoration is still pending.'});
 await deps.supabase.from('number_orders').update({status:'refunded',refunded:true,updated_at:new Date().toISOString()}).eq('id',o.id).eq('refunded',false);
 const pendingRef='PENDING-'+ref;
 const {data:existing}=await deps.supabase.from('transactions').select('id').eq('user_id',o.user_id).eq('category','MJ SMS').eq('type','purchase').eq('external_reference',pendingRef).maybeSingle();
 if(!existing)await deps.supabase.from('transactions').insert({user_id:o.user_id,customer_id:o.customer_id||null,type:'purchase',category:'MJ SMS',
  title:(o.country_name||countryDisplayName(countryCode))+' rental · '+serviceName,subtitle:'Purchase unsuccessful — wallet refunded',amount:'₦'+Number(o.price||0).toLocaleString(),
  amount_ngn:Number(o.price||0),amount_usd:Number(o.supplier_price||0),status:'refunded',external_reference:pendingRef,notes:'virtualsms_rent_request:'+ref});
 else await deps.supabase.from('transactions').update({status:'refunded',subtitle:'Purchase unsuccessful — wallet refunded'}).eq('id',existing.id);
 return out(deps,200,{success:true,status:'refunded',amount_ngn:rf.amount_ngn});
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
 const received=(list||[]).some(m=>String(m.code||'').trim()||String(m.content||'').trim());
 if(received&&!o.refunded&&String(o.status||'').toLowerCase()!=='completed'){
  await deps.supabase.from('number_orders').update({status:'completed',updated_at:new Date().toISOString()}).eq('id',o.id).eq('refunded',false);
  await deps.supabase.from('transactions').update({status:'completed'}).eq('user_id',auth.userId)
   .eq('category','MJ SMS').eq('type','purchase').eq('external_reference',id);
  o.status='completed';
 }
 return out(deps,200,{success:true,data:(list||[]).map(m=>({id:m.id,code:m.code||'',body:m.content||'',content:m.content||'',from:m.sender||'SMS',sender:m.sender||'SMS',received_at:m.received_at})),
  rental:{id:o.order_id,phone:o.phone_number,service_name:o.service_name,status:o.status,price_ngn:Number(o.price||0),active_till:o.code,created_at:o.created_at,sms_received:received}});
}
async function cancel(deps){
 const auth=await deps.requireAuth(deps.req);if(!auth.ok)return out(deps,auth.status,{success:false,message:auth.message});
 const b=typeof deps.req.body==='string'?JSON.parse(deps.req.body||'{}'):(deps.req.body||{}),id=String(b.rent_id||b.rental_id||'');
 if(!id)return out(deps,400,{success:false,message:'rent_id required'});
 const {data:o}=await deps.supabase.from('number_orders').select('*').eq('source',SOURCE).eq('user_id',auth.userId).eq('order_id',id).maybeSingle();
 if(!o)return out(deps,404,{success:false,message:'Rental not found'});
 if(o.refunded||String(o.status).toLowerCase()==='refunded'){
  const priorRefund=await restore(deps.supabase,auth.userId,Number(o.price||0),o.wallet_debit_id,o.id);
  if(!priorRefund.ok)return out(deps,503,{success:false,message:'Cancellation is recorded. Wallet refund is pending reconciliation. Please do not purchase again.'});
  await deps.supabase.from('transactions').update({status:'refunded',subtitle:'Cancelled — balance restored'})
   .eq('user_id',auth.userId).eq('category','MJ SMS').eq('type','purchase').eq('external_reference',id);
  return out(deps,200,{success:true,already_refunded:true,message:'Refunded. Your wallet has been restored.',data:{order_id:id,status:'refunded',refunded:true,refunded_amount:priorRefund.amount_ngn}});
 }
 const currentStatus=String(o.status).toLowerCase();
 const refundPending=['cancellation_refund_pending','cancelled','canceled'].includes(currentStatus);
 if(!refundPending){
  const ageMs=Date.now()-new Date(o.created_at).getTime();
  if(ageMs<2*60*1000)return out(deps,425,{success:false,message:'Cancellation becomes available 2 minutes after purchase.'});
  if(ageMs>20*60*1000)return out(deps,409,{success:false,message:'The 20-minute cancellation and refund window has passed.'});
  if(['cancelled','canceled','expired','completed','complete','success'].includes(String(o.status).toLowerCase()))
   return out(deps,409,{success:false,message:'This rental can no longer be cancelled.'});
  const {count,error}=await deps.supabase.from('virtualsms_rent_messages').select('id',{count:'exact',head:true}).eq('rental_id',id);
  if(error)return out(deps,503,{success:false,message:'Could not verify SMS status. Try again.'});
  if(Number(count||0)>0)return out(deps,409,{success:false,message:'Cannot cancel after an SMS has arrived.'});
  const r=await call('/rentals/'+encodeURIComponent(id)+'/cancel',{method:'POST',idempotencyKey:'vsrent-cancel:'+id,body:{}});
  if(!r.ok)return out(deps,r.status===425?425:400,{success:false,message:r.status===425?'Cancellation is not available yet. Try again shortly.':'Cancellation could not be completed. Your wallet has not been refunded.'});
  const {error:pendingError}=await deps.supabase.from('number_orders').update({status:'cancellation_refund_pending',updated_at:new Date().toISOString()})
   .eq('id',o.id).eq('refunded',false);
  if(pendingError)return out(deps,503,{success:false,message:'Cancellation was confirmed. Your wallet refund is being reconciled. Please do not purchase again.'});
 }
 const {count:lateSms,error:lateSmsError}=await deps.supabase.from('virtualsms_rent_messages').select('id',{count:'exact',head:true}).eq('rental_id',id);
 if(lateSmsError)return out(deps,503,{success:false,message:'Cancellation was confirmed. Refund finalization is pending SMS verification.'});
 if(Number(lateSms||0)>0){
  await deps.supabase.from('number_orders').update({status:'completed',updated_at:new Date().toISOString()}).eq('id',o.id).eq('refunded',false);
  return out(deps,409,{success:false,message:'An SMS arrived before cancellation finalized. No refund was issued.'});
 }
 const rf=await restore(deps.supabase,auth.userId,Number(o.price||0),o.wallet_debit_id,o.id);
 if(!rf.ok)return out(deps,503,{success:false,message:'The rental was cancelled. Wallet refund is pending reconciliation. Please do not purchase again.'});
 const {error:finalizeError}=await deps.supabase.from('number_orders').update({refunded:true,status:'refunded',updated_at:new Date().toISOString()})
  .eq('id',o.id).eq('refunded',false);
 if(finalizeError){
  console.error('[VirtualSMS refund finalize]',finalizeError.message);
  return out(deps,200,{success:true,refunded:true,message:'Refunded. Your wallet has been restored.',data:{order_id:id,status:'refunded',refunded:true,refunded_amount:rf.amount_ngn}});
 }
 await deps.supabase.from('transactions').update({status:'refunded',subtitle:'Cancelled — balance restored'})
  .eq('user_id',auth.userId).eq('category','MJ SMS').eq('type','purchase').eq('external_reference',id);
 return out(deps,200,{success:true,message:'Refunded. Your wallet has been restored.',data:{order_id:id,status:'refunded',refunded:true,refunded_amount:rf.amount_ngn}});
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
 const r=await call('/customer/webhooks',{method:'POST',body:{url,description:'MJ HUB VirtualSMS Platform Rental inbox and account alerts',events,threshold}});
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
 const {data:o}=await deps.supabase.from('number_orders').select('id,user_id,phone_number,service_name,status,order_id,price,wallet_debit_id,refunded')
  .eq('source',SOURCE).eq('order_id',rid).maybeSingle();
 if(type==='sms.received'){
  const body=String(d.full_text||d.content||''),code=String(d.code||'');
  const {error}=await deps.supabase.from('virtualsms_rent_messages').insert({rental_id:rid,event_id:eventId,phone_number:d.phone_number||o?.phone_number||null,
   service_name:d.service||o?.service_name||null,sender:d.sender||d.from||'SMS',code,content:body||(code?'SMS code: '+code:'New SMS received'),
   received_at:d.received_at||p.created_at||new Date().toISOString()});
  if(error&&/duplicate key/i.test(error.message||''))return out(deps,200,{success:true,duplicate:true});
  if(error)return out(deps,500,{success:false,message:'Could not save SMS event.'});
  if(o&&!o.refunded){
   await deps.supabase.from('number_orders').update({status:'completed',updated_at:new Date().toISOString()}).eq('id',o.id).eq('refunded',false);
   await deps.supabase.from('transactions').update({status:'completed'}).eq('user_id',o.user_id).eq('category','MJ SMS').eq('type','purchase').eq('external_reference',rid).eq('status','pending');
  }
 }else if(type==='order.cancelled'&&o){
  const {count:smsCount,error:smsError}=await deps.supabase.from('virtualsms_rent_messages')
   .select('id',{count:'exact',head:true}).eq('rental_id',rid);
  if(smsError){
   await deps.supabase.from('number_orders').update({status:'cancellation_refund_pending',updated_at:new Date().toISOString()}).eq('id',o.id).eq('refunded',false);
   return out(deps,503,{success:false,message:'Cancellation recorded; wallet refund is awaiting SMS verification.'});
  }
  if(Number(smsCount||0)>0){
   await deps.supabase.from('number_orders').update({status:'completed',updated_at:new Date().toISOString()}).eq('id',o.id).eq('refunded',false);
  }else{
   const rf=await restore(deps.supabase,o.user_id,Number(o.price||0),o.wallet_debit_id,o.id);
   if(rf.ok){
    await deps.supabase.from('number_orders').update({status:'refunded',refunded:true,updated_at:new Date().toISOString()}).eq('id',o.id).eq('refunded',false);
    await deps.supabase.from('transactions').update({status:'refunded',subtitle:'Cancelled — balance restored'})
     .eq('user_id',o.user_id).eq('category','MJ SMS').eq('type','purchase').eq('external_reference',rid);
   }else{
    await deps.supabase.from('number_orders').update({status:'cancellation_refund_pending',updated_at:new Date().toISOString()}).eq('id',o.id).eq('refunded',false);
   }
  }
 }else if(type==='order.expired'&&o){
  await deps.supabase.from('number_orders').update({status:'expired',updated_at:new Date().toISOString()}).eq('id',o.id).eq('refunded',false).neq('status','cancellation_refund_pending');
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
 if(a==='vsrent_admin_reconcile'&&m==='POST')return reconcile(deps);
 if(a==='vsrent_admin_fail_refund'&&m==='POST')return adminFailRefund(deps);
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
