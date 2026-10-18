// MJ HUB click-triggered press animation only. No vibration/haptic feedback.
(function () {
  'use strict';
  if (window.__mjPressFeedbackBound) return;
  window.__mjPressFeedbackBound = true;

  var selector = [
    'button', 'a[href]', '[role="button"]', '[onclick]',
    'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]',
    'input[type="checkbox"]', 'input[type="radio"]', 'summary', 'select',
    '.nav-item', '.filter-tab', '.promo-card', '.ps-buy', '.sidebar-link',
    '.btn', '.icon-btn', '[data-click-feedback]', '[data-press]'
  ].join(',');

  function findControl(target) {
    return target && target.closest ? target.closest(selector) : null;
  }

  function press(event) {
    var control = findControl(event.target);
    if (!control || control.disabled || control.getAttribute('aria-disabled') === 'true') return;
    if (control.dataset.mjPressAnimating === 'true') return;

    control.dataset.mjPressAnimating = 'true';
    var previousTransform = control.style.transform;
    var previousTransition = control.style.transition;
    control.style.transition = (previousTransition ? previousTransition + ', ' : '') + 'transform 110ms ease';
    control.style.transform = (previousTransform && previousTransform !== 'none' ? previousTransform + ' ' : '') + 'scale(.975)';

    window.setTimeout(function () {
      control.style.transform = previousTransform;
      control.style.transition = previousTransition;
      delete control.dataset.mjPressAnimating;
    }, 120);
  }

  document.addEventListener('click', press, true);

  /* Server 3 supplier fallback is loaded here because every MJ SMS page
   * already includes this tiny common script. It is isolated to mj-sms-s3. */
  try {
    if (/\/mj-sms-s3\.html$/i.test(window.location.pathname) && !window.__mjS3LiveFallbackScript) {
      window.__mjS3LiveFallbackScript = true;
      var s=document.createElement('script');
      s.src='/js/mj-sms-s3-live-fallback.js?v=20261018';
      s.defer=true;
      document.head.appendChild(s);
    }
  } catch(e) {}
})();