/* VirtualSMS USA rental list in the admin dashboard: same card layout as the GotSMS list.
   Uses the existing admin functions (edit price / hide / auto / load) untouched; this only changes how the list renders. */
(function () {
  'use strict';
  function esc(v) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(v == null ? '' : v);
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function usd(v) {
    var s = Number(v || 0).toFixed(4);
    return '$' + s.replace(/(\.\d\d)0{1,2}$/, '$1');
  }
  function profit(sup, sell) {
    try { return window.smsProfitHtml(window.smsProfitOf(sup, sell)); } catch (e) { return '—'; }
  }
  function status(r) {
    if (r.admin_hidden) return { t: 'HIDDEN', on: false };
    if (!r.is_available) return { t: 'OUT', on: false };
    return { t: 'ACTIVE', on: true };
  }
  function renderVsRent() {
    var q = String((document.getElementById('vsRentSearch') || {}).value || '').toLowerCase().trim();
    var rows = (window._vsRentPlans || []).filter(function (r) {
      return !q || String(r.service_name || '').toLowerCase().indexOf(q) !== -1;
    });
    var tbody = document.getElementById('vsRentTableBody');
    var cards = document.getElementById('vsRentMobileCards');
    if (!rows.length) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No VirtualSMS rows. Click Sync VirtualSMS.</td></tr>';
      if (cards) cards.innerHTML = '<div class="empty-state">No VirtualSMS rows.</div>';
      return;
    }
    if (cards) {
      cards.classList.remove('mobile-only');
      cards.innerHTML = rows.map(function (r) {
        var st = status(r), admin = r.price_source === 'admin';
        var badge = st.on ? 'background:rgba(52,211,153,.15);color:#34d399;' : 'background:rgba(148,163,184,.12);color:#94a3b8;';
        return '<div class="m-card" data-id="' + esc(r.id) + '" style="margin-bottom:12px;padding:14px;border:1px solid var(--border);border-radius:14px;background:var(--card);">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:10px;">' +
            '<div style="min-width:0;">' +
              '<div style="font-weight:800;font-size:15px;margin-bottom:2px;">USA</div>' +
              '<div style="font-size:13px;color:var(--muted);font-weight:600;">' + esc(r.service_name || '') + ' · ' + esc(r.duration_label || '') + '</div>' +
            '</div>' +
            '<span style="flex-shrink:0;font-size:11px;font-weight:800;padding:4px 10px;border-radius:999px;' + badge + '">' + st.t + '</span>' +
          '</div>' +
          '<div style="display:grid;grid-template-columns:1fr auto;gap:6px 12px;font-size:13px;margin-bottom:12px;">' +
            '<span style="color:var(--muted);">Supplier Price</span>' +
            '<span style="font-weight:700;color:#fbbf24;text-align:right;">' + usd(r.supplier_price_usd) + '</span>' +
            '<span style="color:var(--muted);">Your Price</span>' +
            '<span style="font-weight:800;color:#34d399;text-align:right;">₦' + Number(r.price_ngn || 0).toLocaleString() + (admin ? ' <span style="font-size:10px;color:#fbbf24;">admin</span>' : '') + '</span>' +
            '<span style="color:var(--muted);">Profit</span>' +
            '<span style="font-weight:800;text-align:right;">' + profit(r.supplier_price_usd, r.price_ngn) + '</span>' +
            '<span style="color:var(--muted);">Stock</span>' +
            '<span style="font-weight:700;text-align:right;">' + (r.is_available && !r.admin_hidden ? 1 : 0) + '</span>' +
          '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
            '<button type="button" class="btn btn-ghost btn-sm" data-act="edit"><i class="fas fa-pen"></i> Edit Price</button>' +
            '<button type="button" class="btn btn-ghost btn-sm" data-act="hide">' + (r.admin_hidden ? '<i class="fas fa-eye"></i> Show' : '<i class="fas fa-eye-slash"></i> Hide') + '</button>' +
            '<button type="button" class="btn btn-ghost btn-sm" data-act="auto" title="Reset to automatic markup"><i class="fas fa-wand-magic-sparkles"></i> Auto</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }
    if (tbody) {
      tbody.innerHTML = rows.map(function (r) {
        var st = status(r), admin = r.price_source === 'admin';
        return '<tr data-id="' + esc(r.id) + '">' +
          '<td>' + esc(r.service_name || '') + ' · ' + esc(r.duration_label || '') + '</td>' +
          '<td>USA</td>' +
          '<td>' + usd(r.supplier_price_usd) + '</td>' +
          '<td>₦' + Number(r.price_ngn || 0).toLocaleString() + (admin ? ' <span style="font-size:10px;color:#fbbf24;">admin</span>' : '') + '</td>' +
          '<td>' + profit(r.supplier_price_usd, r.price_ngn) + '</td>' +
          '<td>' + (st.on ? '<span style="color:#34d399;font-weight:700">ACTIVE</span>' : st.t) + '</td>' +
          '<td><button type="button" class="btn btn-ghost btn-sm" data-act="edit">Edit</button> ' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="hide">' + (r.admin_hidden ? 'Show' : 'Hide') + '</button> ' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="auto">Auto</button></td>' +
        '</tr>';
      }).join('');
    }
  }
  function onAction(e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    var holder = btn.closest('[data-id]');
    if (!holder) return;
    var id = holder.getAttribute('data-id');
    var r = (window._vsRentPlans || []).filter(function (x) { return String(x.id) === id; })[0];
    if (!r) return;
    var act = btn.getAttribute('data-act');
    if (act === 'edit') window.editVirtualSmsRentPrice(r.id, Number(r.price_ngn || 0));
    else if (act === 'hide') window.toggleVirtualSmsRentPlan(r.id, !r.admin_hidden);
    else if (act === 'auto') window.resetVirtualSmsRentPrice(r.id);
  }
  function setProgress() {
    var p = document.getElementById('vsRentSyncProgress');
    if (p && !/Syncing/.test(p.textContent || '') && (window._vsRentPlans || []).length) {
      p.textContent = window._vsRentPlans.length + ' VirtualSMS rows in bank';
    }
  }
  function restyleHeader() {
    var panel = document.getElementById('usaRentVirtualPanel');
    if (!panel || panel.getAttribute('data-gotsms-look')) return;
    panel.setAttribute('data-gotsms-look', '1');
    // Title like the GotSMS panel
    var head = panel.firstElementChild;
    if (head) {
      head.outerHTML = '<div class="panel-title" style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;"><span>USA Platform Rental (VirtualSMS)</span></div>';
    }
    // Refresh button label
    var btns = panel.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (/Refresh plans/i.test(btns[i].textContent)) btns[i].innerHTML = '<i class="fas fa-list"></i> Refresh list';
    }
    // Webhook settings move into a collapsed block at the bottom so the list sits right under search, like GotSMS
    var kids = panel.children, box = null;
    for (var j = 0; j < kids.length; j++) {
      if (/Webhook subscriptions/.test(kids[j].textContent || '') && kids[j].querySelector('#btnSetupVsRentWebhook')) { box = kids[j]; break; }
    }
    if (box) {
      var d = document.createElement('details');
      d.style.cssText = 'margin-top:14px;';
      var s = document.createElement('summary');
      s.style.cssText = 'cursor:pointer;font-weight:800;font-size:13px;margin-bottom:10px;';
      s.textContent = 'Webhook settings';
      d.appendChild(s);
      box.style.marginTop = '10px';
      d.appendChild(box);
      panel.appendChild(d);
    }
    var cardsEl = document.getElementById('vsRentMobileCards');
    if (cardsEl) cardsEl.addEventListener('click', onAction);
    var tb = document.getElementById('vsRentTableBody');
    if (tb) tb.addEventListener('click', onAction);
    var th = panel.querySelector('thead tr');
    if (th) th.innerHTML = '<th>Service / plan</th><th>Country</th><th>Supplier USD</th><th>Sell ₦</th><th>Profit ₦</th><th>Status</th><th>Action</th>';
  }
  function install() {
    if (typeof window.filterVirtualSmsRentPlans !== 'function') return false;
    window.filterVirtualSmsRentPlans = function () { renderVsRent(); setProgress(); };
    var origLoad = window.loadVirtualSmsRentPlans;
    if (typeof origLoad === 'function') {
      window.loadVirtualSmsRentPlans = async function () {
        var out = await origLoad.apply(this, arguments);
        setProgress();
        return out;
      };
    }
    restyleHeader();
    renderVsRent();
    setProgress();
    return true;
  }
  function boot() {
    if (install()) return;
    var tries = 0, t = setInterval(function () { if (install() || ++tries > 40) clearInterval(t); }, 250);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
