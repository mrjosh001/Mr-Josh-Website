/* MJ Hub – Tiny Apple-style motion helpers
   Zero dependencies. Safe additive layer.
   Works with css/mj-apple-fluid.css
*/
(function () {
  'use strict';

  var SELECTOR = '[data-press], .btn, .primary-btn, .secondary-btn, .icon-btn, .quick-action-item, button:not(:disabled), a.btn';

  function clearTransform(el) {
    if (el) el.style.transform = '';
  }

  document.addEventListener('pointerdown', function (e) {
    var el = e.target.closest(SELECTOR);
    if (!el) return;
    // Skip structural chrome
    if (el.closest('.navbar, .header, .bottom-nav, .sidebar, header, main')) return;
    el.style.transform = 'scale(0.97)';
  }, { passive: true });

  document.addEventListener('pointerup', function (e) {
    var el = e.target.closest(SELECTOR);
    clearTransform(el);
  }, { passive: true });

  document.addEventListener('pointercancel', function (e) {
    var el = e.target.closest(SELECTOR);
    clearTransform(el);
  }, { passive: true });

  // Also clear on mouse leave for desktop
  document.addEventListener('pointerleave', function (e) {
    var el = e.target.closest(SELECTOR);
    clearTransform(el);
  }, { passive: true });
})();
