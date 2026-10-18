/* MJ HUB Server 3 wiring + live catalog fallback. */
(function () {
  'use strict';
  if (window.__mjS3Fix) return;
  window.__mjS3Fix = true;
  var UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function fix(a){try{var h=a.getAttribute('href')||'';if(h.indexOf('mj-sms-number.html')<0)return;var u=new URL(h,location.href),id=u.searchParams.get('order_id');if(id&&UUID.test(id)){u.pathname=u.pathname.replace('mj-sms-number.html','mj-sms-s3-number.html');a.setAttribute('href',u.pathname+u.search);}}catch(e){}}
  function scan(){document.querySelectorAll('a[href*="mj-sms-number.html"]').forEach(fix);}
  new MutationObserver(scan).observe(document.documentElement,{childList:true,subtree:true});scan();

  // DB-first, supplier-second. If the local snapshot misses a service/country, query
  // VirtualSMS directly and let the API backfill the result into number_services.
  var svcTimer=null,countryTimer=null;
  function token(){try{if(window.sbClient&&window.sbClient.auth)return window.sbClient.auth.getSession().then(function(x){return x.data&&x.data.session?x.data.session.access_token:null;});}catch(e){}return Promise.resolve(null);}
  function live(path){return token().then(function(t){if(!t)throw new Error('Please sign in first.');return fetch('/api/vsms-live'+path,{headers:{Authorization:'Bearer '+t,Accept:'application/json'}});}).then(function(r){return r.json().then(function(j){return{ok:r.ok,data:j};});});}
  function mergeServices(items,q){if(!Array.isArray(items)||!items.length||typeof window.renderServiceCatalog!=='function')return;var list=Array.isArray(window.allServiceCatalog)?window.allServiceCatalog.slice():[],seen={};list.forEach(function(s){seen[String(s.service_id||s.service_name||'').toLowerCase()]=1;});items.forEach(function(s){var name=s.name||s.code||'Service',id=s.code||name,key=String(name).toLowerCase();if(!seen[String(id).toLowerCase()]&&!seen[key])list.push({service_id:id,service_name:name,key:key,live:true});});window.allServiceCatalog=list;window.renderServiceCatalog(list,q||'');}
  function liveServiceSearch(q){if(String(q||'').trim().length<2)return;live('?mode=services&q='+encodeURIComponent(q.trim())).then(function(r){if(r.ok&&r.data&&r.data.success)mergeServices(r.data.services,q.trim().toLowerCase());}).catch(function(){});}
  function isoId(iso){var s=String(iso||'').toUpperCase();return /^[A-Z]{2}$/.test(s)?1000+(s.charCodeAt(0)-65)*26+(s.charCodeAt(1)-65):null;}
  function liveCountrySearch(q){var svc=window.currentServicePick;if(!svc||String(q||'').trim().length<2)return;var code=svc.service_id||svc.code||'';if(!code)return;live('?mode=countries&service='+encodeURIComponent(code)+'&q='+encodeURIComponent(String(q).trim())).then(function(r){if(!r.ok||!r.data||!r.data.success||!Array.isArray(r.data.countries))return;var rows=r.data.countries.map(function(c){return{country_id:isoId(c.iso),country_name:c.name,price:Number(c.price_ngn)||0,available_quantity:c.stock==null?1:Number(c.stock),service_id:code,service_name:svc.service_name||code,live:true};}).filter(function(c){return c.country_id!=null&&c.price>0&&(c.available_quantity==null||c.available_quantity>0);});if(!rows.length)return;window.allCountries=rows;if(typeof window.renderCountryPrices==='function')window.renderCountryPrices(rows);}).catch(function(){});}
  function bind(){var ss=document.getElementById('serviceSearch'),cs=document.getElementById('countrySearch');if(ss&&!ss.__liveBound){ss.__liveBound=true;ss.addEventListener('input',function(){clearTimeout(svcTimer);var q=ss.value.trim();if(q.length<2)return;var local=(window.allServiceCatalog||[]).some(function(s){return String(s.service_name||'').toLowerCase().indexOf(q.toLowerCase())>-1;});if(local)return;svcTimer=setTimeout(function(){liveServiceSearch(q);},350);});}if(cs&&!cs.__liveBound){cs.__liveBound=true;cs.addEventListener('input',function(){clearTimeout(countryTimer);var q=cs.value.trim();if(q.length<2)return;var local=(window.allCountries||[]).some(function(c){return typeof window.countryMatchesQuery==='function'&&window.countryMatchesQuery(c.country_name,q);});if(local)return;countryTimer=setTimeout(function(){liveCountrySearch(q);},350);});}}
  var tries=0;(function wait(){bind();if(document.getElementById('serviceSearch')||document.getElementById('countrySearch')||++tries>40)return;setTimeout(wait,250);})();
})();
