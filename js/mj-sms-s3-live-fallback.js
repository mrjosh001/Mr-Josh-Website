/* MJ HUB Server 3 live supplier fallback.
 * If a selected VirtualSMS service has no country rows in the local catalog,
 * ask the existing supplier-backed Supabase Edge function for live countries,
 * merge them into the same country index, and replay the normal renderer.
 */
(function(){
  'use strict';
  if(window.__mjS3LiveFallback) return;
  window.__mjS3LiveFallback = true;

  var EDGE='https://atczodlljmlayvldxfmv.supabase.co/functions/v1/virtualsms-live';

  function countryId(iso){
    iso=String(iso||'').toUpperCase();
    if(!/^[A-Z]{2}$/.test(iso)) return null;
    return 1000+(iso.charCodeAt(0)-65)*26+(iso.charCodeAt(1)-65);
  }
  function esc(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');}

  async function fetchLive(svc){
    var code=String((svc&& (svc.key||svc.service_id||svc.code))||'').trim();
    if(!code) return [];
    var url=EDGE+'?mode=countries&service='+encodeURIComponent(code);
    var r=await fetch(url,{method:'GET',cache:'no-store',headers:{Accept:'application/json'}});
    var text=await r.text(),j={};
    try{j=text?JSON.parse(text):{};}catch(e){throw new Error('Invalid live supplier response');}
    if(!r.ok||j.success===false) throw new Error(j.message||'VirtualSMS live country lookup failed');
    return Array.isArray(j.countries)?j.countries:[];
  }

  function install(){
    var original=window.selectService;
    if(typeof original!=='function'){
      setTimeout(install,250);
      return;
    }
    if(original.__mjS3Wrapped) return;
    async function wrappedSelectService(svc){
      await original.apply(this,arguments);
      var list=document.getElementById('countryList');
      if(!list) return;
      if(list.querySelector('.country-price-row')) return;

      var code=String((svc&&(svc.key||svc.service_id||svc.code))||'').trim();
      if(!code) return;
      list.innerHTML='<div class="loading-spinner"><div class="spinner"></div><div class="loading-text">Checking VirtualSMS live availability…</div></div>';
      try{
        var countries=await fetchLive(svc);
        var rows=countries.map(function(c){
          var iso=String(c.iso||'').toUpperCase(), id=countryId(iso), price=Number(c.price_ngn), stock=c.stock==null?null:Number(c.stock);
          if(!id||!Number.isFinite(price)||price<=0) return null;
          return {
            country_id:id,
            country_name:c.name||iso,
            service_id:c.service_id||code,
            service_name:(svc&& (svc.service_name||svc.name))||code,
            supplier_price:c.price_usd,
            price:price,
            available_quantity:stock,
            is_available:stock==null||stock>0,
            currency:'NGN',
            source:'virtualsms',
            live_supplier:true
          };
        }).filter(function(r){return r&&r.is_available!==false&&(r.available_quantity==null||Number(r.available_quantity)>0);});

        if(!rows.length){
          list.innerHTML='<div class="empty-state">VirtualSMS has no live stock for this service right now.</div>';
          return;
        }

        try{
          if(window.serviceCountryIndex){
            var k=code.toLowerCase();
            window.serviceCountryIndex[k]=rows.slice();
          }
          window.allCountriesForService=rows.slice();
        }catch(e){}

        /* Replay the existing renderer so the normal country click/pool/order
         * flow is preserved. It will now read the live rows from the index. */
        await original.call(this,svc);
      }catch(e){
        console.error('[Server3 live fallback]',e);
        list.innerHTML='<div class="empty-state">Could not check VirtualSMS live availability. '+esc(e.message||e)+'</div>';
      }
    }
    wrappedSelectService.__mjS3Wrapped=true;
    window.selectService=wrappedSelectService;
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',install,{once:true});
  else install();
})();
