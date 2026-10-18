/* MJ HUB admin patch: Server 3 layout = Server 2 layout, Profit line on Servers 1/2/3, real-country sync button.
 * Loaded by /js/mj-page-loader.js on the admin page only. Everything is guarded; a failure here never breaks admin.
 * FIX: Server 3 "Edit Price" button now works (openServer3EditPrice was referenced but never defined). */
(function () {
  'use strict';
  if (window.__mjAdminSmsPatch) return;
  window.__mjAdminSmsPatch = true;

  function rate() {
    try {
      if (typeof boosterUsdRate === 'function') return Number(boosterUsdRate()) || 1500;
    } catch (e) {}
    return Number(window.USD_TO_NGN_RATE) || Number(localStorage.getItem('mj_usd_ngn')) || 1500;
  }
  function ngn(n) { return '\u20A6' + Math.round(Math.abs(n)).toLocaleString(); }
  function esc(s) { return typeof escapeHtml === 'function' ? escapeHtml(s) : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function profitOf(usd, price) {
    usd = Number(usd); price = Number(price);
    if (!isFinite(usd) || usd <= 0 || !isFinite(price) || price <= 0) return null;
    return price - usd * rate();
  }
  function profitHtml(p) {
    if (p == null) return '<span style="opacity:.6">\u2014</span>';
    return '<span style="color:' + (p >= 0 ? '#34d399' : '#f87171') + ';font-weight:800">' + (p < 0 ? '-' : '') + ngn(p) + '</span>';
  }

  var css = document.createElement('style');
  css.textContent =
    '.s3c{background:rgba(15,21,36,.55);border:1px solid rgba(148,163,184,.16);border-radius:18px;padding:16px;margin-bottom:12px}' +
    '.s3c h4{margin:0 0 2px;font-size:17px;font-weight:800}.s3c .sub{font-size:13px;color:#94a3b8;margin-bottom:10px}' +
    '.s3c .r{display:flex;justify-content:space-between;align-items:center;padding:5px 0;font-size:14px}' +
    '.s3c .r span:first-child{color:#cbd5e1}.s3c .sup{color:#fbbf24;font-weight:800}.s3c .you{color:#34d399;font-weight:800}' +
    '.s3c .pill{padding:3px 12px;border-radius:999px;font-size:12px;font-weight:800;border:1px solid}' +
    '.s3c .pill.ok{color:#34d399;background:rgba(52,211,153,.1);border-color:rgba(52,211,153,.4)}' +
    '.s3c .pill.out{color:#f87171;background:rgba(248,113,113,.1);border-color:rgba(248,113,113,.4)}' +
    '.s3c .acts{display:flex;gap:8px;margin-top:10px}';
  document.head.appendChild(css);

  function statusOf(r) {
    var q = r.available_quantity;
    return !(r.is_available === false || (q != null && Number(q) <= 0));
  }

  // ---- Server 3 render (same fields/look as Server 2 + Profit) ----
  window.filterNumberServicesServer3 = function () {
    var q = String((document.getElementById('smsServer3Search') || {}).value || '').toLowerCase().trim();
    var cq = String((document.getElementById('smsServer3CountryFilter') || {}).value || '').toLowerCase().trim();
    var hz = !!(document.getElementById('smsServer3HideZeroStock') || {}).checked;
    var rows = window._server3Rows || [];
    if (q) rows = rows.filter(function (r) { return String(r.service_name || '').toLowerCase().indexOf(q) > -1 || String(r.service_id || '').toLowerCase().indexOf(q) > -1; });
    if (cq) rows = rows.filter(function (r) { return String(r.country_name || '').toLowerCase().indexOf(cq) > -1; });
    if (hz) rows = rows.filter(statusOf);
    var tbody = document.getElementById('smsServer3TableBody');
    var cards = document.getElementById('smsServer3MobileCards');
    // table header: add Profit after Your Price once
    var th = tbody && tbody.closest('table') && tbody.closest('table').querySelectorAll('thead th');
    if (th && !tbody.closest('table').querySelector('th[data-profit]')) {
      for (var i = 0; i < th.length; i++) if (/your price/i.test(th[i].textContent)) {
        var h = document.createElement('th'); h.setAttribute('data-profit', '1'); h.textContent = 'Profit (\u20A6)';
        th[i].parentNode.insertBefore(h, th[i].nextSibling); break;
      }
    }
    if (!rows.length) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No Server 3 rows. Click Sync Server 3.</td></tr>';
      if (cards) cards.innerHTML = '<div class="empty-state">No Server 3 rows. Click Sync Server 3.</div>';
      return;
    }
    if (tbody) tbody.innerHTML = rows.map(function (r) {
      var ok = statusOf(r), usd = r.supplier_price != null ? Number(r.supplier_price) : null, id = esc(String(r.id));
      return '<tr><td>' + esc(r.country_name || '\u2014') + '</td><td>' + esc(r.service_name || r.service_id) + '</td>' +
        '<td>' + (usd ? '$' + usd.toFixed(2) : '\u2014') + '</td><td>\u20A6' + Number(r.price || 0).toLocaleString() + '</td>' +
        '<td>' + profitHtml(profitOf(usd, r.price)) + '</td>' +
        '<td>' + (r.available_quantity == null ? '\u2014' : Number(r.available_quantity)) + '</td>' +
        '<td style="color:' + (ok ? '#34d399' : '#f87171') + ';font-weight:700">' + (ok ? 'ACTIVE' : 'OUT') + '</td>' +
        '<td><button type="button" class="btn btn-ghost btn-sm" onclick="openServer3EditPrice(\'' + id + '\',' + Number(r.price || 0) + ')"><i class="fas fa-pen"></i> Edit Price</button> ' +
        '<button type="button" class="btn btn-ghost btn-sm" style="color:#f87171" onclick="deleteServer3Row(\'' + id + '\')"><i class="fas fa-trash"></i> Delete</button></td></tr>';
    }).join('');
    if (cards) cards.innerHTML = rows.slice(0, 80).map(function (r) {
      var ok = statusOf(r), usd = r.supplier_price != null ? Number(r.supplier_price) : null, id = esc(String(r.id));
      return '<div class="s3c"><h4>' + esc(r.country_name || '\u2014') + '</h4><div class="sub">' + esc(r.service_name || r.service_id) + '</div>' +
        '<div class="r"><span>Supplier Price</span><span class="sup">' + (usd ? '$' + usd.toFixed(2) : '\u2014') + '</span></div>' +
        '<div class="r"><span>Your Price</span><span class="you">\u20A6' + Number(r.price || 0).toLocaleString() + '</span></div>' +
        '<div class="r"><span>Profit</span><span>' + profitHtml(profitOf(usd, r.price)) + '</span></div>' +
        '<div class="r"><span>Stock</span><span>' + (r.available_quantity == null ? '\u2014' : Number(r.available_quantity)) + '</span></div>' +
        '<div class="r"><span>Status</span><span class="pill ' + (ok ? 'ok' : 'out') + '">' + (ok ? 'ACTIVE' : 'OUT') + '</span></div>' +
        '<div class="acts"><button type="button" class="btn btn-ghost btn-sm" onclick="openServer3EditPrice(\'' + id + '\',' + Number(r.price || 0) + ')"><i class="fas fa-pen"></i> Edit Price</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" style="color:#f87171" onclick="deleteServer3Row(\'' + id + '\')"><i class="fas fa-trash"></i> Delete</button></div></div>';
    }).join('') + (rows.length > 80 ? '<div class="empty-state">Showing 80 of ' + rows.length + ' \u2014 use search to narrow.</div>' : '');
  };

  // ---- Edit Price (FIX) ----
  // The buttons above call openServer3EditPrice(id, price) but that function was never defined anywhere,
  // so tapping Edit Price did nothing. It now opens the same "Edit SMS Number Pricing" popup Servers 1/2 use
  // (editNumberServiceServer3 in admin.html). If that popup function is ever missing, a simple prompt
  // fallback saves through the same /api/admin endpoint so the button can never be dead again.
  window.openServer3EditPrice = function (id, currentPrice) {
    try {
      if (typeof window.editNumberServiceServer3 === 'function') {
        window.editNumberServiceServer3(id);
        return;
      }
    } catch (e) { console.error('openServer3EditPrice popup failed, using fallback', e); }

    var row = (window._server3Rows || []).filter(function (x) { return String(x.id) === String(id); })[0];
    if (!row) { showAdminToast('Row not found \u2014 refresh Server 3', 'error'); return; }
    var label = (row.country_name || '') + ' \u00b7 ' + (row.service_name || row.service_id || '');
    var v = prompt('New selling price (\u20A6) for ' + label, String(currentPrice != null ? currentPrice : (row.price || 0)));
    if (v === null) return;
    var n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
    if (!isFinite(n) || n < 0) { showAdminToast('Enter a valid price', 'error'); return; }
    (async function () {
      try {
        var headers = (await authHeaders()) || {};
        headers['Content-Type'] = 'application/json';
        var res = await fetch('/api/admin', {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({ resource: 'sms', action: 'update', id: row.id, price: n, is_available: row.is_available !== false })
        });
        var data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || 'Save failed');
        row.price = n;
        window.filterNumberServicesServer3();
        showAdminToast('Price updated successfully', 'success');
      } catch (e) { showAdminToast('Update failed: ' + (e.message || e), 'error'); }
    })();
  };

  window.deleteServer3Row = async function (id) {
    if (!confirm('Delete this Server 3 service row? It comes back on the next sync if still in stock.')) return;
    try {
      var r = await sb.from('number_services').delete().eq('id', id).eq('source', 'virtualsms');
      if (r.error) throw r.error;
      window._server3Rows = (window._server3Rows || []).filter(function (x) { return String(x.id) !== String(id); });
      window.filterNumberServicesServer3();
      showAdminToast('Deleted', 'success');
    } catch (e) { showAdminToast('Delete failed: ' + (e.message || e), 'error'); }
  };

  // ---- Sync button: keep going until every batch is done ----
  window.syncServer3Now = async function () {
    var btn = document.getElementById('btnSyncServer3'), prog = document.getElementById('server3SyncProgress');
    var idle = '<i class="fas fa-sync"></i> Sync Server 3';
    setBtnBusy(btn, true, 'Syncing\u2026');
    var last = '';
    try {
      for (var round = 1; round <= 8; round++) {
        if (prog) prog.textContent = 'Syncing VirtualSMS\u2026 batch ' + round;
        var ctrl = new AbortController(), t = setTimeout(function () { ctrl.abort(); }, 90000);
        var headers = await authHeaders();
        var res = await fetch('/api/grizzly-sync?action=vsms_sync', { headers: headers || {}, signal: ctrl.signal });
        clearTimeout(t);
        var data = {};
        try { data = JSON.parse(await res.text()); } catch (_) { data = { success: false, message: 'Bad response (HTTP ' + res.status + ')' }; }
        if (!data.success) {
          var m = data.message || 'Server 3 sync failed';
          showAdminToast(m, 'error'); if (prog) prog.textContent = m + (data.raw_hint ? ' \u00b7 ' + data.raw_hint : '');
          return;
        }
        last = data.message || '';
        if (prog) prog.textContent = last;
        await loadServer3Services();
        if (!data.partial) { showAdminToast('Server 3 synced', 'success'); return; }
        if (data.rate_limited) { showAdminToast(last, 'info'); return; }
        await new Promise(function (r) { setTimeout(r, 15000); }); // stay under VirtualSMS 60 req/min
      }
      showAdminToast('Server 3: more services remain \u2014 click Sync again', 'info');
    } catch (e) {
      var ab = e && (e.name === 'AbortError');
      var msg = ab ? 'Sync timed out in the browser. Click Sync Server 3 again \u2014 progress is saved.' : 'Server 3 sync error: ' + (e.message || e);
      showAdminToast(msg, ab ? 'info' : 'error'); if (prog) prog.textContent = msg;
    } finally { setBtnBusy(btn, false, idle); }
  };

  // ---- Profit line for Server 1 & 2 (works on whatever they render) ----
  var busy = false;
  function leaf(root, text) {
    var out = [], all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) if (!all[i].children.length && all[i].textContent.trim().toLowerCase() === text) out.push(all[i]);
    return out;
  }
  function num(t) { var n = parseFloat(String(t).replace(/[^0-9.]/g, '')); return isFinite(n) ? n : 0; }
  function addProfit(tab) {
    if (!tab) return;
    busy = true;
    try {
      leaf(tab, 'your price').forEach(function (lbl) {
        var row = lbl.parentElement; if (!row || row.nextElementSibling && row.nextElementSibling.getAttribute('data-profit')) return;
        var card = row.parentElement, sup = card && leaf(card, 'supplier price')[0];
        if (!sup || !sup.parentElement) return;
        var usd = num(sup.parentElement.lastElementChild.textContent), price = num(row.lastElementChild.textContent);
        var clone = row.cloneNode(true); clone.setAttribute('data-profit', '1');
        clone.firstElementChild.textContent = 'Profit';
        clone.lastElementChild.innerHTML = profitHtml(profitOf(usd, price));
        row.parentNode.insertBefore(clone, row.nextSibling);
      });
      tab.querySelectorAll('table').forEach(function (tbl) {
        var ths = tbl.querySelectorAll('thead th'), ip = -1, sp = -1;
        for (var i = 0; i < ths.length; i++) { var t = ths[i].textContent.toLowerCase(); if (t.indexOf('your price') > -1) ip = i; if (t.indexOf('supplier') > -1) sp = i; }
        if (ip < 0 || sp < 0 || tbl.querySelector('th[data-profit]')) { if (ip < 0 || sp < 0) return; }
        if (!tbl.querySelector('th[data-profit]')) { var h = document.createElement('th'); h.setAttribute('data-profit', '1'); h.textContent = 'Profit (\u20A6)'; ths[ip].parentNode.insertBefore(h, ths[ip].nextSibling); }
        tbl.querySelectorAll('tbody tr').forEach(function (tr) {
          if (tr.querySelector('td[data-profit]') || tr.children.length <= ip) return;
          if (tr.children.length === 1) return;
          var td = document.createElement('td'); td.setAttribute('data-profit', '1');
          td.innerHTML = profitHtml(profitOf(num(tr.children[sp].textContent), num(tr.children[ip].textContent)));
          tr.insertBefore(td, tr.children[ip + 1]);
        });
      });
    } catch (e) { console.warn('profit patch', e); }
    busy = false;
  }
  function watch(id) {
    var tab = document.getElementById(id); if (!tab) return;
    var timer = null;
    new MutationObserver(function () {
      if (busy) return; clearTimeout(timer); timer = setTimeout(function () { addProfit(tab); }, 150);
    }).observe(tab, { childList: true, subtree: true });
    addProfit(tab);
  }

  function start() {
    watch('tab-sms'); watch('tab-sms-server2');
    try { if (window._server3Rows && window._server3Rows.length) window.filterNumberServicesServer3(); } catch (e) {}
  }
  var tries = 0;
  (function wait() {
    if (typeof setBtnBusy === 'function' && typeof authHeaders === 'function' && document.getElementById('tab-sms-server3')) return start();
    if (++tries < 60) setTimeout(wait, 250);
  })();
})();
