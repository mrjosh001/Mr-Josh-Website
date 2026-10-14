(function () {
  if (window.__mjHapticBound) return;
  window.__mjHapticBound = true;

  var toastTimer = null;
  var lastControl = null;

  function tick() {
    try {
      if (navigator.vibrate) navigator.vibrate(12);
    } catch (e) {}
  }

  function findControl(el) {
    if (!el || !el.closest) return null;
    return el.closest(
      'button, a[href], [role="button"], [onclick], input[type="button"], input[type="submit"], input[type="reset"], input[type="checkbox"], input[type="radio"], summary, select, .nav-item, .filter-tab, .promo-card, .ps-buy, .sidebar-link, .btn, .icon-btn, [data-click-feedback]'
    );
  }

  function controlLabel(el) {
    if (!el) return 'Action';
    var label = el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.value || '';
    label = String(label).replace(/\s+/g, ' ').trim();
    return label.slice(0, 54) || 'Action';
  }

  function showFeedback(el) {
    var toast = document.getElementById('mj-click-feedback');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'mj-click-feedback';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      toast.style.cssText = [
        'position:fixed',
        'left:50%',
        'bottom:calc(24px + env(safe-area-inset-bottom, 0px))',
        'transform:translate(-50%, 12px)',
        'z-index:2147483647',
        'display:flex',
        'align-items:center',
        'gap:9px',
        'max-width:calc(100vw - 28px)',
        'padding:11px 16px',
        'border:1px solid rgba(255,255,255,.16)',
        'border-radius:999px',
        'background:#111827',
        'color:#fff',
        'box-shadow:0 8px 28px rgba(0,0,0,.28)',
        'font:600 13px/1.3 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
        'opacity:0',
        'pointer-events:none',
        'transition:opacity .16s ease,transform .16s ease',
        'white-space:nowrap',
        'overflow:hidden',
        'text-overflow:ellipsis'
      ].join(';');
      toast.innerHTML = '<span aria-hidden="true" style="display:inline-grid;place-items:center;width:20px;height:20px;flex:0 0 20px;border-radius:50%;background:#16a34a;color:#fff;font-size:13px;">✓</span><span id="mj-click-feedback-text"></span>';
      (document.body || document.documentElement).appendChild(toast);
    }
    var text = document.getElementById('mj-click-feedback-text');
    if (text) text.textContent = controlLabel(el);
    toast.style.opacity = '1';
    toast.style.transform = 'translate(-50%, 0)';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.style.opacity = '0';
      toast.style.transform = 'translate(-50%, 12px)';
    }, 1400);
  }

  function feedback(e) {
    var control = findControl(e.target);
    if (!control) return;
    if (control.disabled || control.getAttribute('aria-disabled') === 'true') return;
    if (control.id === 'mj-click-feedback' || control.closest('#mj-click-feedback')) return;
    tick();
    if (control !== lastControl) {
      control.style.setProperty('transition', (control.style.transition ? control.style.transition + ',' : '') + 'transform 100ms ease');
      control.style.setProperty('transform', (control.style.transform && control.style.transform !== 'none' ? control.style.transform + ' ' : '') + 'scale(.98)');
      setTimeout(function () {
        if (!control || !control.style) return;
        control.style.removeProperty('transform');
      }, 110);
    }
    lastControl = control;
    showFeedback(control);
  }

  document.addEventListener('click', feedback, true);
  document.addEventListener('touchstart', function (e) {
    if (findControl(e.target)) tick();
  }, { passive: true });
})();