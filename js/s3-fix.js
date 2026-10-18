/* MJ HUB Server 3 wiring: new Server 3 (VirtualSMS REST) orders open on mj-sms-s3-number.html, not Server 1's page.
 * Loaded by /js/mj-page-loader.js on the SMS pages. */
(function () {
  'use strict';
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function fix(a) {
    try {
      var h = a.getAttribute('href') || '';
      if (h.indexOf('mj-sms-number.html') < 0) return;
      var u = new URL(h, location.href), id = u.searchParams.get('order_id');
      if (id && UUID.test(id)) { u.pathname = u.pathname.replace('mj-sms-number.html', 'mj-sms-s3-number.html'); a.setAttribute('href', u.pathname + u.search); }
    } catch (e) {}
  }
  function scan() { document.querySelectorAll('a[href*="mj-sms-number.html"]').forEach(fix); }
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
