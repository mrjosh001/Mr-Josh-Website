(function () {
  if (window.__mjHapticBound) return;
  window.__mjHapticBound = true;

  function tick() {
    try {
      if (navigator.vibrate) navigator.vibrate(12);
    } catch (e) {}
  }

  function isControl(el) {
    if (!el || !el.closest) return false;
    return !!el.closest(
      'button, a, [role="button"], [onclick], input[type="button"], input[type="submit"], input[type="reset"], summary, select, .nav-item, .filter-tab, .promo-card, .ps-buy, .sidebar-link, .btn, .icon-btn'
    );
  }

  document.addEventListener(
    'touchstart',
    function (e) {
      if (isControl(e.target)) tick();
    },
    { passive: true }
  );

  document.addEventListener(
    'click',
    function (e) {
      if (e.pointerType === 'touch') return;
      if (isControl(e.target)) tick();
    },
    { passive: true }
  );
})();
