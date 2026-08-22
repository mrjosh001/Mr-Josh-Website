/**
 * MJ Hub — infinity page loader (overlay on navigation)
 * Style: glowing infinity mark + "Loading" on dark field (reference: ∞ loop).
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
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;',
      'background:rgba(5,7,13,.92);',
      '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);',
      'opacity:0;visibility:hidden;pointer-events:none;',
      'transition:opacity .22s ease,visibility .22s ease;',
      '}',
      '#' + OVERLAY_ID + '.is-on{opacity:1;visibility:visible;pointer-events:auto;}',
      '#' + OVERLAY_ID + ' .mj-inf-wrap{',
      'width:88px;height:48px;position:relative;',
      'filter:drop-shadow(0 0 12px rgba(167,139,250,.55)) drop-shadow(0 0 22px rgba(56,189,248,.35));',
      '}',
      '#' + OVERLAY_ID + ' .mj-inf-wrap svg{width:100%;height:100%;overflow:visible;}',
      '#' + OVERLAY_ID + ' .mj-inf-wrap path{',
      'fill:none;stroke:#c4b5fd;stroke-width:3.2;stroke-linecap:round;stroke-linejoin:round;',
      'stroke-dasharray:140;stroke-dashoffset:140;',
      'animation:mjInfFlow 1.35s ease-in-out infinite;',
      '}',
      '#' + OVERLAY_ID + ' .mj-inf-wrap path.mj-inf-glow{',
      'stroke:#67e8f9;stroke-width:2.4;opacity:.95;',
      'filter:drop-shadow(0 0 6px #22d3ee);',
      'animation-delay:.08s;',
      '}',
      '#' + OVERLAY_ID + ' .mj-lbl{',
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;',
      'font-size:11px;font-weight:600;letter-spacing:.18em;text-transform:lowercase;',
      'color:rgba(148,163,184,.85);',
      '}',
      '@keyframes mjInfFlow{',
      '0%{stroke-dashoffset:140;opacity:.4}',
      '45%{stroke-dashoffset:0;opacity:1}',
      '100%{stroke-dashoffset:-140;opacity:.4}',
      '}',
      '@media (prefers-reduced-motion:reduce){',
      '#' + OVERLAY_ID + ' .mj-inf-wrap path{animation:none;stroke-dashoffset:0;opacity:.95}',
      '}'
    ].join('');
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  var INF_SVG =
    '<div class="mj-inf-wrap" aria-hidden="true">' +
    '<svg viewBox="0 0 80 40" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M12 20 C12 10, 22 8, 28 14 C34 20, 36 26, 40 20 C44 14, 46 8, 52 14 C58 20, 68 30, 68 20 C68 10, 58 8, 52 14 C46 20, 44 26, 40 20 C36 14, 34 8, 28 14 C22 20, 12 30, 12 20 Z"/>' +
    '<path class="mj-inf-glow" d="M12 20 C12 10, 22 8, 28 14 C34 20, 36 26, 40 20 C44 14, 46 8, 52 14 C58 20, 68 30, 68 20 C68 10, 58 8, 52 14 C46 20, 44 26, 40 20 C36 14, 34 8, 28 14 C22 20, 12 30, 12 20 Z"/>' +
    '</svg></div>';

  function ensureOverlay() {
    injectStyle();
    var el = document.getElementById(OVERLAY_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-busy', 'true');
    el.innerHTML = INF_SVG + '<div class="mj-lbl">loading</div>';
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  function show() {
    var el = ensureOverlay();
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

  try {
    var _assign = window.location.assign.bind(window.location);
    var _replace = window.location.replace.bind(window.location);
    window.location.assign = function (url) {
      try { if (sameOrigin(String(url))) show(); } catch (e) {}
      return _assign(url);
    };
    window.location.replace = function (url) {
      try { if (sameOrigin(String(url))) show(); } catch (e) {}
      return _replace(url);
    };
  } catch (e) {}

  window.addEventListener('pageshow', hide);
  window.addEventListener('load', function () { setTimeout(hide, 40); });
  document.addEventListener('DOMContentLoaded', function () { setTimeout(hide, 80); });

  try {
    if (sessionStorage.getItem('mj_nav_loading') === '1') show();
  } catch (e) {}

  window.mjShowPageLoader = show;
  window.mjHidePageLoader = hide;
})();
