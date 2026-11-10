/* MJ Mails — dashboard navigation (Explore tile + sidebar dropdown).
   Additive and idempotent: only touches the dashboard when its Explore grid / sidebar exist,
   reuses the dashboard's own classes so it matches the other entries, and does nothing otherwise. */
(function () {
  'use strict';
  var tries = 0;

  function addStyles() {
    if (document.getElementById('mjMailsNavCss')) return;
    var s = document.createElement('style');
    s.id = 'mjMailsNavCss';
    s.textContent =
      '#home.home-v2 .hv-tile.mails .tico{background:linear-gradient(145deg,#4f46e5,#818cf8)}' +
      '#home.home-v2 .hv-tile.mails{grid-column:1/-1;flex-direction:row;align-items:center;gap:12px;min-height:0;padding:12px 14px}' +
      '#home.home-v2 .hv-tile.mails .mchev{margin-left:auto;color:var(--muted);font-size:12px}' +
      '#mailsSubmenu a{padding-left:34px;display:flex;align-items:center;gap:10px}';
    document.head.appendChild(s);
  }

  function addExploreTile() {
    if (document.getElementById('mailsPromoCard')) return true;
    var grid = document.querySelector('#home .hv-grid');
    if (!grid) return false;
    var a = document.createElement('a');
    a.className = 'hv-tile mails';
    a.href = 'mj-mails.html';
    a.id = 'mailsPromoCard';
    a.innerHTML =
      '<div class="tico"><i class="fa-solid fa-envelope"></i></div>' +
      '<div><b>MJ Mails</b><em>Temporary emails for verification codes</em></div>' +
      '<span class="mchev"><i class="fa-solid fa-chevron-right"></i></span>';
    grid.appendChild(a);
    return true;
  }

  function addSidebarDropdown() {
    if (document.getElementById('mailsSubmenu')) return true;
    var link = document.querySelector('.sidebar-links a[href="mj-mails.html"]');
    var li = link && link.closest('li');
    if (!li) return false;
    li.innerHTML =
      '<a href="#" class="sidebar-link" onclick="toggleMailsMenu(event)" aria-expanded="false" aria-controls="mailsSubmenu" style="display:flex;align-items:center;justify-content:space-between;">' +
        '<span style="display:flex;align-items:center;gap:12px;"><i class="fa-solid fa-envelope"></i> <span>MJ Mails</span></span>' +
        '<i class="fa-solid fa-chevron-down" id="mailsMenuChevron" style="font-size:11px;transition:transform .2s;"></i>' +
      '</a>' +
      '<ul id="mailsSubmenu" style="list-style:none;max-height:0;overflow:hidden;transition:max-height .25s ease;padding:0;">' +
        '<li><a href="mj-mails.html" style="padding-left:34px;display:flex;align-items:center;gap:10px;"><i class="fa-solid fa-plus"></i> <span>Rent Email</span></a></li>' +
        '<li><a href="mj-mails-orders.html" style="padding-left:34px;display:flex;align-items:center;gap:10px;"><i class="fa-solid fa-inbox"></i> <span>Mail Orders</span></a></li>' +
      '</ul>';
    return true;
  }

  window.toggleMailsMenu = function (e) {
    if (e) e.preventDefault();
    var menu = document.getElementById('mailsSubmenu');
    var chev = document.getElementById('mailsMenuChevron');
    var trigger = e && e.currentTarget;
    if (!menu) return;
    var open = menu.style.maxHeight && menu.style.maxHeight !== '0px';
    menu.style.maxHeight = open ? '0' : '120px';
    if (chev) chev.style.transform = open ? '' : 'rotate(180deg)';
    if (trigger && trigger.setAttribute) trigger.setAttribute('aria-expanded', open ? 'false' : 'true');
  };

  function run() {
    try {
      addStyles();
      var a = addExploreTile();
      var b = addSidebarDropdown();
      // Elements may render a moment later; retry briefly, then give up quietly.
      if ((!a || !b) && tries++ < 20) setTimeout(run, 250);
    } catch (err) {
      if (window.console) console.warn('[MJ Mails nav]', err);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
