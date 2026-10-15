/* MJ HUB eSIM dashboard navigation.
 * Activity filtering is handled by dashboard.html against the canonical transactions rows.
 * Do not synthesize a second activity record from esim_orders.
 */
(function (w, d) {
  'use strict';

  w.toggleEsimMenu = function (event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    var submenu = d.getElementById('esimSubmenu');
    var trigger = d.querySelector('.esim-nav-group > a[aria-controls="esimSubmenu"]');
    var chevron = d.getElementById('esimMenuChevron');
    if (!submenu) return;

    var isOpen = submenu.getAttribute('data-open') === 'true';
    if (isOpen) {
      submenu.style.maxHeight = '0px';
      submenu.setAttribute('data-open', 'false');
    } else {
      submenu.style.maxHeight = submenu.scrollHeight + 'px';
      submenu.setAttribute('data-open', 'true');
    }
    if (trigger) trigger.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
    if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
  };

  function syncSubmenuHeight() {
    var submenu = d.getElementById('esimSubmenu');
    if (submenu && submenu.getAttribute('data-open') === 'true') {
      submenu.style.maxHeight = submenu.scrollHeight + 'px';
    }
  }

  if (d.readyState === 'loading') {
    d.addEventListener('DOMContentLoaded', syncSubmenuHeight);
  } else {
    syncSubmenuHeight();
  }
  w.addEventListener('resize', syncSubmenuHeight);
})(window, document);
