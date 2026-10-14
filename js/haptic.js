// MJ HUB subtle press animation and optional vibration only. No click confirmation UI.
(function () {
  if (window.__mjHapticBound) return;
  window.__mjHapticBound = true;

  function findControl(el) {
    if (!el || !el.closest) return null;
    return el.closest(
      'button, a[href], [role="button"], [onclick], input[type="button"], input[type="submit"], input[type="reset"], input[type="checkbox"], input[type="radio"], summary, select, .nav-item, .filter-tab, .promo-card, .ps-buy, .sidebar-link, .btn, .icon-btn, [data-click-feedback]'
    );
  }

  function vibrate() {
    try {
      if (navigator.vibrate) navigator.vibrate(12);
    } catch (e) {}
  }

  function press(e) {
    var control = findControl(e.target);
    if (!control || control.disabled || control.getAttribute('aria-disabled') === 'true') return;
    vibrate();

    if (control.dataset.mjPressAnimating === 'true') return;
    control.dataset.mjPressAnimating = 'true';

    var hadTransform = control.style.transform;
    var hadTransition = control.style.transition;
    control.style.transition = (hadTransition ? hadTransition + ', ' : '') + 'transform 100ms ease';
    control.style.transform = (hadTransform && hadTransform !== 'none' ? hadTransform + ' ' : '') + 'scale(.98)';

    setTimeout(function () {
      control.style.transform = hadTransform;
      control.style.transition = hadTransition;
      delete control.dataset.mjPressAnimating;
    }, 110);
  }

  document.addEventListener('click', press, true);
  document.addEventListener('touchstart', function (e) {
    if (findControl(e.target)) vibrate();
  }, { passive: true });
})();
