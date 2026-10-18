/* Restore Server 3 pricing to the same Edit SMS Number Pricing popup used by Server 1/2. */
(function(){
  'use strict';
  if(window.__mjServer3PriceRestore) return;
  window.__mjServer3PriceRestore=true;
  function install(){
    if(typeof window.editNumberServiceServer3==='function' && typeof window.openServer3EditPrice==='function'){
      window.openServer3EditPrice=function(id){
        return window.editNumberServiceServer3(id);
      };
      return;
    }
    setTimeout(install,200);
  }
  install();
})();
