/* MJ HUB admin patch: Server 3 = VirtualSMS. Catalog sync stays in /api/grizzly-sync. */
(function(){'use strict';if(window.__mjAdminSmsPatch)return;window.__mjAdminSmsPatch=true;
function rate(){try{if(typeof boosterUsdRate==='function')return Number(boosterUsdRate())||1500}catch(e){}return Number(window.USD_TO_NGN_RATE)||Number(localStorage.getItem('mj_usd_ngn'))||1500}
function ngn(n){return '₦'+Math.round(Math.abs(Number(n)||0)).toLocaleString()}
function profitOf(usd,price){usd=Number(usd);price=Number(price);return usd>0&&price>0?price-usd*rate():null}
function profitHtml(p){return p==null?'<span style="opacity:.6">—</span>':'<span style="color:'+(p>=0?'#34d399':'#f87171')+';font-weight:800">'+(p<0?'-':'')+ngn(p)+'</span>'}
function statusOf(r){return !(r.is_available===false||(r.available_quantity!=null&&Number(r.available_quantity)<=0))}
function esc(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}

window.filterNumberServicesServer3=function(){var q=String(document.getElementById('smsServer3Search')?.value||'').toLowerCase().trim(),cq=String(document.getElementById('smsServer3CountryFilter')?.value||'').toLowerCase().trim(),hz=!!document.getElementById('smsServer3HideZeroStock')?.checked,rows=window._server3Rows||[];if(q)rows=rows.filter(r=>String(r.service_name||'').toLowerCase().includes(q)||String(r.service_id||'').toLowerCase().includes(q));if(cq)rows=rows.filter(r=>String(r.country_name||'').toLowerCase().includes(cq)||String(r.country_id||'').toLowerCase()===cq);if(hz)rows=rows.filter(statusOf);var tb=document.getElementById('smsServer3TableBody'),cards=document.getElementById('smsServer3MobileCards');if(!rows.length){if(tb)tb.innerHTML='<tr><td colspan="8" class="empty-state">No Server 3 rows. Run Sync Server 3 or search the supplier.</td></tr>';if(cards)cards.innerHTML='<div class="empty-state">No Server 3 rows. Run Sync Server 3 or search the supplier.</div>';return}if(tb)tb.innerHTML=rows.slice(0,2000).map(r=>{var usd=r.supplier_price==null?null:Number(r.supplier_price),ok=statusOf(r);return '<tr><td>'+esc(r.country_name||'—')+'</td><td>'+esc(r.service_name||r.service_id||'—')+'</td><td>'+(Number.isFinite(usd)?'$'+usd.toFixed(2):'—')+'</td><td>₦'+Number(r.price||0).toLocaleString()+'</td><td>'+profitHtml(profitOf(usd,r.price))+'</td><td>'+(r.available_quantity==null?'—':Number(r.available_quantity))+'</td><td style="color:'+(ok?'#34d399':'#f87171')+';font-weight:700">'+(ok?'ACTIVE':'OUT')+'</td><td><button type="button" class="btn btn-ghost btn-sm" onclick="openServer3EditPrice(\''+esc(String(r.id))+'\','+Number(r.price||0)+')">Edit Price</button></td></tr>'}).join('');if(cards)cards.innerHTML=rows.slice(0,100).map(r=>{var usd=r.supplier_price==null?null:Number(r.supplier_price),ok=statusOf(r);return '<div class="s3c"><h4>'+esc(r.country_name||'—')+'</h4><div class="sub">'+esc(r.service_name||r.service_id||'—')+'</div><div class="r"><span>Supplier</span><span>'+(Number.isFinite(usd)?'$'+usd.toFixed(2):'—')+'</span></div><div class="r"><span>Your price</span><span>₦'+Number(r.price||0).toLocaleString()+'</span></div><div class="r"><span>Profit</span><span>'+profitHtml(profitOf(usd,r.price))+'</span></div><div class="r"><span>Stock</span><span>'+(r.available_quantity==null?'—':Number(r.available_quantity))+'</span></div><div class="r"><span>Status</span><span>'+ (ok?'ACTIVE':'OUT')+'</span></div></div>'}).join('')}

/*
 * The original admin loader fetched 1,000 rows at a time with an ORDER BY on
 * every request. With 13k+ Server 3 rows that could fail/timeout on Safari,
 * leaving the table blank even though the database was populated. Load the
 * same rows in small concurrent batches, without server-side sorting, then
 * sort once in memory. This is read-only and remains scoped to source=virtualsms.
 */
window.loadServer3Services=async function(){
  var tb=document.getElementById('smsServer3TableBody'),cards=document.getElementById('smsServer3MobileCards');
  var cols='id,source,country_id,country_name,service_id,service_name,supplier_price,price,available_quantity,is_available,currency,updated_at,price_source';
  try{
    var pageSize=750, maxRows=50000, first=await sb.from('number_services').select('id',{count:'exact',head:true}).eq('source','virtualsms').gte('country_id',1000);
    if(first.error)throw first.error;
    var total=Math.min(Number(first.count||0),maxRows), pages=Math.ceil(total/pageSize), all=[];
    for(var start=0;start<pages;start+=4){
      var jobs=[];
      for(var p=start;p<Math.min(start+4,pages);p++){
        (function(page){jobs.push((async function(){
          var lastErr=null;
          for(var attempt=1;attempt<=3;attempt++){
            try{
              var q=await sb.from('number_services').select(cols).eq('source','virtualsms').gte('country_id',1000).range(page*pageSize,page*pageSize+pageSize-1);
              if(q.error)throw q.error;
              return q.data||[];
            }catch(e){lastErr=e;await new Promise(function(r){setTimeout(r,250*attempt)})}
          }
          throw lastErr||new Error('Server 3 catalog page '+(page+1)+' failed');
        })())})(p);
      }
      var chunks=await Promise.all(jobs);
      chunks.forEach(function(c){all=all.concat(c)});
    }
    all.sort(function(a,b){var s=String(a.service_name||a.service_id||'').localeCompare(String(b.service_name||b.service_id||''));if(s)return s;return String(a.country_name||'').localeCompare(String(b.country_name||''))});
    window._server3Rows=all;
    filterNumberServicesServer3();
    var prog=document.getElementById('server3SyncProgress');
    if(prog&&!String(prog.textContent||'').toLowerCase().includes('syncing'))prog.textContent=all.length+' Server 3 rows in catalog';
  }catch(e){
    console.error('loadServer3Services',e);
    var msg=e&&e.message?e.message:String(e);
    if(tb)tb.innerHTML='<tr><td colspan="8" class="empty-state">Could not load Server 3 catalog. '+esc(msg)+'</td></tr>';
    if(cards)cards.innerHTML='<div class="empty-state">Could not load Server 3 catalog. '+esc(msg)+'</div>';
    showAdminToast('Could not load Server 3 services: '+msg,'error');
  }
}

window.openServer3EditPrice=function(id,current){var row=(window._server3Rows||[]).find(x=>String(x.id)===String(id));if(!row)return showAdminToast('Row not found — refresh Server 3','error');var v=prompt('New selling price (₦)',String(current??row.price??0));if(v===null)return;var n=parseFloat(String(v).replace(/[^0-9.]/g,''));if(!Number.isFinite(n)||n<0)return showAdminToast('Enter a valid price','error');(async()=>{try{var h=await authHeaders();h={...h,'Content-Type':'application/json'};var r=await fetch('/api/admin',{method:'POST',headers:h,body:JSON.stringify({resource:'sms',action:'update',id:row.id,price:n,is_available:row.is_available!==false})}),j=await r.json();if(!r.ok||!j.success)throw new Error(j.message||'Save failed');row.price=n;filterNumberServicesServer3();showAdminToast('Price updated successfully','success')}catch(e){showAdminToast('Update failed: '+(e.message||e),'error')}})()}
window.deleteServer3Row=async function(id){if(!confirm('Delete this Server 3 service row? It will return on the next sync if still available.'))return;try{var r=await sb.from('number_services').delete().eq('id',id).eq('source','virtualsms');if(r.error)throw r.error;window._server3Rows=(window._server3Rows||[]).filter(x=>String(x.id)!==String(id));filterNumberServicesServer3();showAdminToast('Deleted','success')}catch(e){showAdminToast('Delete failed: '+(e.message||e),'error')}};

window.syncServer3Now=async function(){var btn=document.getElementById('btnSyncServer3'),prog=document.getElementById('server3SyncProgress'),idle='<i class="fas fa-sync"></i> Sync Server 3';setBtnBusy(btn,true,'Syncing…');try{
  /*
   * force=1 is deliberate. The old backend considered a service "done" when
   * its newest DB row was fresh, even if another country for that same
   * service was missing. VirtualSMS documents /customer/countries?service=
   * as the source of the exact service-country availability/pricing map, so
   * a full admin refresh must walk every service rather than only stale ones.
   */
  for(var round=1;round<=24;round++){
    if(prog)prog.textContent='VirtualSMS full catalog sync · batch '+round+' / 24';
    var ctl=new AbortController(),tm=setTimeout(function(){try{ctl.abort()}catch(_){ }},55000),h=await authHeaders(),r;
    try{r=await fetch('/api/grizzly-sync?action=vsms_sync&force=1',{method:'GET',headers:h||{},signal:ctl.signal,cache:'no-store'})}finally{clearTimeout(tm)}
    var text=await r.text(),data={};try{data=text?JSON.parse(text):{}}catch(e){data={success:false,message:'Invalid sync response (HTTP '+r.status+')'}}
    if(!r.ok||data.success===false)throw new Error(data.message||('Server 3 sync failed (HTTP '+r.status+')'));
    if(prog)prog.textContent=data.message||('Server 3 batch '+round+' complete');
    await loadServer3Services();
    if(data.done===true){showAdminToast('Server 3 full catalog sync complete','success');if(prog)prog.textContent=(data.message||'Server 3 full catalog sync complete')+' · '+(window._server3Rows||[]).length+' DB rows';return}
    if(data.rate_limited){showAdminToast('VirtualSMS rate limit reached. Saved progress will continue on the next sync.','info');return}
    await new Promise(function(res){setTimeout(res,500)})
  }
  showAdminToast('Server 3 sync is still in progress. Saved progress is preserved; click Sync Server 3 again to continue.','info')
}catch(e){var msg=e&&e.name==='AbortError'?'Sync batch timed out. The Server 3 cursor is preserved.':'Server 3 sync error: '+(e.message||e);if(prog)prog.textContent=msg;showAdminToast(msg,'error')}finally{setBtnBusy(btn,false,idle)}};

var css=document.createElement('style');css.textContent='.s3c{background:rgba(15,21,36,.55);border:1px solid rgba(148,163,184,.16);border-radius:18px;padding:16px;margin-bottom:12px}.s3c h4{margin:0 0 3px;font-size:17px}.s3c .sub{font-size:13px;color:#94a3b8;margin-bottom:10px}.s3c .r{display:flex;justify-content:space-between;padding:5px 0;font-size:14px}.s3c .r:first-child{color:#cbd5e1}';document.head.appendChild(css);
function start(){try{if(window._server3Rows&&window._server3Rows.length)filterNumberServicesServer3()}catch(e){}}var tries=0;(function wait(){if(typeof setBtnBusy==='function'&&typeof authHeaders==='function'&&document.getElementById('tab-sms-server3'))return start();if(++tries<60)setTimeout(wait,250)})();
})();