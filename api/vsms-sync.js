import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const VS_BASE = 'https://virtualsms.io/api/v1';
const VS_KEY = String(process.env.VIRTUALSMS_API_KEY || process.env.VIRTUAL_SMS_API_KEY || '').trim();
const GAP_MS = Math.max(1000, Number(process.env.VSMS_SYNC_GAP_MS) || 1100);
const BATCH_SIZE = Math.min(50, Math.max(10, Number(process.env.VSMS_SYNC_BATCH_SIZE) || 45));

function json(res, status, body) { return res.status(status).json(body); }
async function admin(req) {
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Bearer ')) return false;
  const { data: { user }, error } = await supabase.auth.getUser(h.slice(7).trim());
  if (error || !user) return false;
  const { data: profile } = await supabase.from('profiles').select('is_admin,role').eq('id', user.id).maybeSingle();
  return !!(profile && (profile.is_admin === true || String(profile.role || '').toLowerCase() === 'admin'));
}
async function get(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);
  try {
    const r = await fetch(`${VS_BASE}${path}`, { headers: { 'X-API-Key': VS_KEY, Accept: 'application/json' }, signal: controller.signal });
    const text = await r.text();
    let jsonBody = null;
    try { jsonBody = text ? JSON.parse(text) : null; } catch (_) {}
    return { ok: r.ok, status: r.status, json: jsonBody, text };
  } finally { clearTimeout(timer); }
}
function listOf(j, keys) {
  if (Array.isArray(j)) return j;
  if (!j || typeof j !== 'object') return [];
  for (const k of keys) if (Array.isArray(j[k])) return j[k];
  return Object.entries(j).filter(([,v]) => v && typeof v === 'object' && !Array.isArray(v)).map(([k,v]) => ({ _key:k, ...v }));
}
function svcCode(s) { for (const v of [s.code,s.service_id,s.service,s.id,s.key,s._key]) { const x=String(v??'').trim(); if(x) return x; } return null; }
function svcName(s,c) { for (const v of [s.name,s.service_name,s.title,s.label,s.display_name,s.eng]) { const x=String(v??'').trim(); if(x) return x; } return c; }
function iso(c) { for (const v of [c.country_id,c.iso,c.iso2,c.country_code,c.code,c.country,c._key]) { const x=String(v??'').trim().toUpperCase(); if(/^[A-Z]{2}$/.test(x)) return x; } return null; }
function cname(c,i) { for (const v of [c.country_name,c.name,c.eng,c.english,c.title,c.label,c.country]) { const x=String(v??'').trim(); if(x.length>2 && x.toUpperCase()!==i && !/^\d+$/.test(x)) return x; } return i; }
function usd(c) { for (const v of [c.price,c.cost,c.rate,c.price_usd,c.usd_price]) { const n=Number(v); if(Number.isFinite(n)&&n>0)return n; } return 0; }
function qty(c) { for (const v of [c.stock,c.available_quantity,c.quantity,c.count,c.available,c.numbers]) { const n=Number(v); if(Number.isFinite(n))return Math.max(0,Math.floor(n)); } return null; }
function idFromIso(i) { return 1000+(i.charCodeAt(0)-65)*26+(i.charCodeAt(1)-65); }
function sale(usdPrice) { const rate=Number(process.env.USD_TO_NGN_RATE)||Number(process.env.USD_TO_NGN)||1500; const minProfit=Number(process.env.MIN_PROFIT_NGN)||500; const minSale=Number(process.env.MIN_NUMBER_PRICE_NGN)||1000; const n=Number(usdPrice)*rate; return Math.ceil(Math.max(n*1.8,n+minProfit,minSale)/50)*50; }

export default async function handler(req,res){
  if(req.method!=='GET'&&req.method!=='POST') return json(res,405,{success:false,message:'Method not allowed'});
  if(!VS_KEY) return json(res,500,{success:false,message:'VirtualSMS is not configured.'});
  if(!(await admin(req))) return json(res,403,{success:false,message:'Admin access required.'});

  try {
    const force=String(req.query?.force||'')==='1';
    let { data: job } = await supabase.from('sync_jobs').select('*').eq('source','virtualsms').maybeSingle();
    const fresh = !job || force || job.status === 'complete' || job.status === 'error';
    if(fresh){
      const sr=await get('/customer/services');
      if(!sr.ok) return json(res,502,{success:false,message:`VirtualSMS services call failed (HTTP ${sr.status}).`});
      const services=listOf(sr.json,['services','data','items','results']).map(s=>{const code=svcCode(s);return code?{code,name:svcName(s,code)}:null;}).filter(Boolean);
      await supabase.from('sync_jobs').upsert({source:'virtualsms',status:'running',cursor_index:0,total_countries:services.length,new_count:0,updated_count:0,services_seen:0,errors:[],started_at:new Date().toISOString(),updated_at:new Date().toISOString()},{onConflict:'source'});
      job={source:'virtualsms',status:'running',cursor_index:0,total_countries:services.length,new_count:0,updated_count:0,services_seen:0,errors:[],started_at:new Date().toISOString()};
    }

    const sr=await get('/customer/services');
    if(!sr.ok) return json(res,502,{success:false,message:`VirtualSMS services call failed (HTTP ${sr.status}).`});
    const services=listOf(sr.json,['services','data','items','results']).map(s=>{const code=svcCode(s);return code?{code,name:svcName(s,code)}:null;}).filter(Boolean);
    const start=Math.max(0,Number(job.cursor_index)||0);
    const end=Math.min(services.length,start+BATCH_SIZE);
    let inserted=Number(job.new_count)||0, updated=Number(job.updated_count)||0, processed=Number(job.services_seen)||0;
    const errors=Array.isArray(job.errors)?job.errors.slice(0,20):[];
    let requests=0;

    for(let i=start;i<end;i++){
      const s=services[i];
      if(i>start) await new Promise(r=>setTimeout(r,GAP_MS));
      const r=await get(`/customer/countries?service=${encodeURIComponent(s.code)}`); requests++;
      if(r.status===429){
        await supabase.from('sync_jobs').update({status:'running',cursor_index:i,updated_at:new Date().toISOString(),errors:[...errors,'429 rate limited; retrying from service '+i].slice(0,20)}).eq('source','virtualsms');
        return json(res,200,{success:true,partial:true,rate_limited:true,done:false,cursor:i,total:services.length,services_done:processed,services_total:services.length,message:`Rate limit reached. Resume at ${i}/${services.length}.`});
      }
      if(!r.ok){ errors.push(`${s.code}: HTTP ${r.status}`); continue; }
      const countries=listOf(r.json,['countries','data','items','results']);
      const seen=new Set();
      const rows=[];
      for(const c of countries){
        const countryIso=iso(c), p=usd(c);
        if(!countryIso || !(p>0)) continue;
        seen.add(countryIso);
        const q=qty(c);
        rows.push({source:'virtualsms',country_id:idFromIso(countryIso),country_name:cname(c,countryIso),service_id:s.code,service_name:s.name,supplier_price:p,price:sale(p),price_source:'system',available_quantity:q==null?1:q,is_available:q==null?true:q>0,currency:'NGN',updated_at:new Date().toISOString()});
      }
      if(rows.length){
        for(let j=0;j<rows.length;j+=100){
          const batch=rows.slice(j,j+100);
          const {error}=await supabase.from('number_services').upsert(batch,{onConflict:'source,country_id,service_id',ignoreDuplicates:false});
          if(error){errors.push(`${s.code}: ${error.message}`);continue;}
        }
        inserted += rows.length;
      }
      // Only this service was answered completely, so stale rows for this service can safely be delisted.
      const {data: existing}=await supabase.from('number_services').select('id,country_id,price_source').eq('source','virtualsms').eq('service_id',s.code).limit(5000);
      const stale=(existing||[]).filter(r=>!seen.has((()=>{const n=Number(r.country_id)-1000;if(n<0)return '';return String.fromCharCode(65+Math.floor(n/26))+String.fromCharCode(65+(n%26));})()));
      for(let j=0;j<stale.length;j+=100){
        const ids=stale.slice(j,j+100).map(r=>r.id);
        await supabase.from('number_services').update({is_available:false,available_quantity:0,updated_at:new Date().toISOString()}).in('id',ids);
      }
      processed++;
    }

    const done=end>=services.length;
    await supabase.from('sync_jobs').update({status:done?'complete':'running',cursor_index:end,total_countries:services.length,new_count:inserted,updated_count:updated,services_seen:processed,errors:errors.slice(0,20),updated_at:new Date().toISOString()}).eq('source','virtualsms');
    return json(res,200,{success:true,partial:!done,done,cursor:end,total:services.length,services_done:processed,services_total:services.length,rows_upserted:inserted,supplier_requests:requests,errors,message:done?`Server 3 fully synced: ${services.length} services checked.`:`Server 3 sync batch complete: ${end}/${services.length} services checked. Resume sync to continue.`});
  } catch(err){
    console.error('[vsms-sync]',err);
    await supabase.from('sync_jobs').update({status:'error',updated_at:new Date().toISOString(),errors:[String(err.message||err)]}).eq('source','virtualsms');
    return json(res,500,{success:false,message:'Server 3 sync failed: '+String(err.message||err)});
  }
}
