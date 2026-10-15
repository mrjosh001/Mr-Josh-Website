/* MJ HUB dashboard eSIM integration.
 * Keeps eSIM orders under their own navigation group and activity filter.
 * eSIM payment RPC already writes one authoritative completed transaction;
 * this layer prevents the dashboard from synthesizing a second activity row.
 */
(function (w, d) {
  'use strict';

  function isDashboard() {
    var p = String(w.location && w.location.pathname || '').toLowerCase();
    return p === '/dashboard.html' || p === '/' || /\/dashboard$/.test(p);
  }
  if (!isDashboard()) return;

  function isEsim(item) {
    if (!item) return false;
    var blob = [item.type, item.category, item.title, item.channel, item._source]
      .map(function (v) { return String(v || '').toLowerCase(); }).join(' ');
    return /\besim\b|e-sim|sim-card|esim_checkout|esim_orders/.test(blob);
  }

  function addEsimSidebarGroup() {
    var links = d.querySelector('.sidebar-links');
    if (!links) return;

    var planLink = links.querySelector('a[href="esim.html"]');
    if (!planLink) return;
    var planLi = planLink.closest('li');
    if (!planLi) return;

    var existingSub = planLi.querySelector('#esimSubmenu');
    if (!existingSub) {
      planLink.classList.add('sidebar-link');
      planLink.setAttribute('href', '#');
      planLink.setAttribute('onclick', 'toggleEsimMenu(event)');
      planLink.style.display = 'flex';
      planLink.style.alignItems = 'center';
      planLink.style.justifyContent = 'space-between';
      planLink.innerHTML = '<span style="display:flex;align-items:center;gap:12px;"><i class="fa-solid fa-sim-card"></i> <span>eSIM</span></span>' +
        '<i class="fa-solid fa-chevron-down" id="esimMenuChevron" style="font-size:11px;transition:transform .2s;"></i>';

      existingSub = d.createElement('ul');
      existingSub.id = 'esimSubmenu';
      existingSub.style.cssText = 'list-style:none;max-height:0;overflow:hidden;transition:max-height .25s ease;padding:0;';
      existingSub.innerHTML =
        '<li><a href="esim.html" style="padding-left:34px;display:flex;align-items:center;gap:10px;"><i class="fa-solid fa-sim-card"></i> <span>eSIM Plans</span></a></li>' +
        '<li><a href="esim-orders.html" style="padding-left:34px;display:flex;align-items:center;gap:10px;"><i class="fa-solid fa-receipt"></i> <span>eSIM Orders</span></a></li>';
      planLi.appendChild(existingSub);
    } else {
      var standalone = links.querySelector('a[href="esim-orders.html"]');
      if (standalone && standalone.closest('li') !== planLi) standalone.closest('li').remove();
    }

    var standaloneOrder = Array.prototype.slice.call(links.querySelectorAll('a[href="esim-orders.html"]')).filter(function (a) {
      return a.closest('li') && a.closest('li').parentElement === links;
    });
    standaloneOrder.forEach(function (a) { a.closest('li').remove(); });
  }

  w.toggleEsimMenu = function (event) {
    if (event) event.preventDefault();
    var sub = d.getElementById('esimSubmenu');
    var chev = d.getElementById('esimMenuChevron');
    if (!sub) return;
    var open = sub.style.maxHeight && sub.style.maxHeight !== '0px';
    sub.style.maxHeight = open ? '0px' : (sub.scrollHeight + 'px');
    if (chev) chev.style.transform = open ? '' : 'rotate(180deg)';
  };

  function addActivityFilter() {
    var bar = d.querySelector('.drawer-filter-scroll.drawer-filter-hero');
    if (!bar || bar.querySelector('[data-mj-filter="esim"]')) return;
    var btn = d.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-tab';
    btn.setAttribute('data-mj-filter', 'esim');
    btn.innerHTML = '<i class="fa-solid fa-sim-card"></i> eSIM';
    btn.addEventListener('click', function () {
      if (typeof w.filterTransactions === 'function') w.filterTransactions('esim', btn);
    });
    bar.appendChild(btn);
  }

  function patchOrderActivityMerge() {
    if (typeof w.fetchActivityFromOrders !== 'function' || w.__mjEsimMergePatched) return;
    var original = w.fetchActivityFromOrders;
    w.fetchActivityFromOrders = async function (userId) {
      var rows = await original(userId);
      return (rows || []).filter(function (row) {
        // eSIM payments have an authoritative transactions row created by the
        // checkout RPC. Do not add the separate esim_orders row to activity.
        return !isEsim(row);
      });
    };
    w.__mjEsimMergePatched = true;
  }

  function patchHistoryFilter() {
    if (typeof w.renderHistoryList !== 'function' || w.__mjEsimHistoryPatched) return;
    var original = w.renderHistoryList;
    w.renderHistoryList = function (filterType) {
      if (filterType !== 'esim') return original.apply(this, arguments);
      var all = w.transactions || [];
      var esim = all.filter(isEsim);
      // Reuse the existing renderer's complete card/status markup without
      // duplicating the dashboard history rendering implementation.
      w.transactions = esim;
      try { return original.call(this, 'all'); }
      finally { w.transactions = all; }
    };
    w.__mjEsimHistoryPatched = true;
  }

  function install() {
    addEsimSidebarGroup();
    addActivityFilter();
    patchOrderActivityMerge();
    patchHistoryFilter();
  }

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', install);
  else install();
  setTimeout(install, 250);
  setTimeout(install, 1000);
})(window, document);
