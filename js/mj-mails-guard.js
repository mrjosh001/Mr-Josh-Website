/* MJ Mails guard — runs as its own script so it survives a parse error in the page script.
   If the page never signals ready (or a fatal script error happens first), replace the
   skeleton with a clear message and a Reload button instead of loading forever. */
(function(){
  var done=false,shown=false;
  window.mmReady=function(){done=true};
  function fail(msg){
    if(done||shown)return;shown=true;
    var html='<div class="empty card"><span class="ico">⚠️</span><b>This page did not finish loading</b><br><span>'+msg+'</span><br><button class="btn sm" type="button" onclick="location.reload()">Reload</button></div>';
    var orders=document.getElementById('orders');
    if(orders)orders.innerHTML=html;
    else{var m=document.querySelector('main');if(m)m.insertAdjacentHTML('afterbegin',html)}
    var live=document.getElementById('live');if(live)live.hidden=true;
  }
  window.addEventListener('error',function(e){
    if(done)return;
    var t=String((e&&e.message)||'');
    if(/SyntaxError|Can't find variable|is not defined|Unexpected|Invalid regular expression/i.test(t))
      fail('Your browser could not run this page. Tap Reload, or update iOS/your browser if it keeps happening.');
  });
  var limit=document.getElementById('orders')?25000:0;
  if(limit)setTimeout(function(){fail('Check your connection and tap Reload.')},limit);
})();
