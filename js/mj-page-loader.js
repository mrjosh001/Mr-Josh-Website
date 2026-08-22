/**
 * MJ Hub — page transition loader
 * Visible when user clicks to another HTML page (not first-paint only).
 */
(function () {
  if (window.__mjPageLoader) return;
  window.__mjPageLoader = true;

  var STYLE_ID = 'mj-page-loader-style';
  var OVERLAY_ID = 'mj-page-loader';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '#' + OVERLAY_ID + '{',
      'position:fixed;inset:0;z-index:2147483000;',
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;',
      'background:#05070d;',
      'opacity:0;visibility:hidden;pointer-events:none;',
      'transition:opacity .2s ease,visibility .2s ease;',
      '}',
      '#' + OVERLAY_ID + '.is-on{opacity:1;visibility:visible;pointer-events:auto;}',
      '#' + OVERLAY_ID + ' .mj-spin{',
      'width:40px;height:40px;border-radius:50%;',
      'border:3px solid rgba(125,211,252,.22);',
      'border-top-color:#7dd3fc;',
      'animation:mjSpin .65s linear infinite;',
      'box-shadow:0 0 20px rgba(56,189,248,.35);',
      '}',
      '#' + OVERLAY_ID + ' .mj-lbl{',
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;',
      'font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;',
      'color:rgba(226,232,240,.75);',
      '}',
      '@keyframes mjSpin{to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion:reduce){',
      '#' + OVERLAY_ID + ' .mj-spin{animation:none;border-top-color:#7dd3fc;opacity:.9}',
      '}'
    ].join('');
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  function ensureOverlay() {
    injectStyle();
    var el = document.getElementById(OVERLAY_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-busy', 'true');
    el.innerHTML =
      '<div class="mj-spin" aria-hidden="true"></div>' +
      '<div class="mj-lbl">Loading</div>';
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  function show() {
    var el = ensureOverlay();
    // force reflow so transition always runs
    void el.offsetWidth;
    el.classList.add('is-on');
    try { sessionStorage.setItem('mj_nav_loading', '1'); } catch (e) {}
  }

  function hide() {
    var el = document.getElementById(OVERLAY_ID);
    if (el) el.classList.remove('is-on');
    try { sessionStorage.removeItem('mj_nav_loading'); } catch (e) {}
  }

  function sameOrigin(url) {
    try {
      return new URL(url, location.href).origin === location.origin;
    } catch (e) {
      return false;
    }
  }

  function isInternalNav(a) {
    if (!a || a.tagName !== 'A') return false;
    if (a.hasAttribute('download')) return false;
    if (a.target && a.target !== '' && a.target !== '_self') return false;
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) === '#') return false;
    if (/^(mailto:|tel:|javascript:)/i.test(href)) return false;
    if (!sameOrigin(href)) return false;
    try {
      var u = new URL(href, location.href);
      if (u.pathname === location.pathname && u.search === location.search) return false;
    } catch (e) {}
    return true;
  }

  document.addEventListener(
    'click',
    function (e) {
      if (e.defaultPrevented) return;
      if (e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target && e.target.closest ? e.target.closest('a') : null;
      if (!isInternalNav(a)) return;
      show();
      setTimeout(hide, 15000);
    },
    true
  );

  // Programmatic navigations: location.href = '...'
  var _assign = window.location.assign.bind(window.location);
  var _replace = window.location.replace.bind(window.location);
  try {
    window.location.assign = function (url) {
      try {
        if (sameOrigin(String(url))) show();
      } catch (e) {}
      return _assign(url);
    };
    window.location.replace = function (url) {
      try {
        if (sameOrigin(String(url))) show();
      } catch (e) {}
      return _replace(url);
    };
  } catch (e) {}

  window.addEventListener('pageshow', hide);
  window.addEventListener('load', function () {
    setTimeout(hide, 30);
  });
  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(hide, 60);
  });

  // If we arrived from another MJ page, show boot until load
  try {
    if (sessionStorage.getItem('mj_nav_loading') === '1') {
      show();
    }
  } catch (e) {}

  window.mjShowPageLoader = show;
  window.mjHidePageLoader = hide;
})();
