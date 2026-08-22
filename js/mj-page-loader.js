/**
 * MJ Hub — page transition loader
 * Shows a full-screen infinity loader when navigating between site pages.
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
      'opacity:0;pointer-events:none;transition:opacity .28s ease;',
      '}',
      '#' + OVERLAY_ID + '.is-on{opacity:1;pointer-events:auto;}',
      '#' + OVERLAY_ID + ' .mj-inf{',
      'width:72px;height:36px;position:relative;',
      '}',
      '#' + OVERLAY_ID + ' .mj-inf svg{width:100%;height:100%;overflow:visible;}',
      '#' + OVERLAY_ID + ' .mj-inf path{',
      'fill:none;stroke:#7dd3fc;stroke-width:3.5;stroke-linecap:round;',
      'stroke-dasharray:120;stroke-dashoffset:120;',
      'filter:drop-shadow(0 0 10px rgba(56,189,248,.85));',
      'animation:mjInfDraw 1.4s ease-in-out infinite;',
      '}',
      '#' + OVERLAY_ID + ' .mj-inf path.mj-inf-2{',
      'stroke:#a78bfa;animation-delay:.15s;',
      'filter:drop-shadow(0 0 10px rgba(167,139,250,.75));',
      '}',
      '#' + OVERLAY_ID + ' .mj-lbl{',
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;',
      'font-size:13px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;',
      'color:rgba(226,232,240,.72);',
      '}',
      '@keyframes mjInfDraw{',
      '0%{stroke-dashoffset:120;opacity:.35}',
      '50%{stroke-dashoffset:0;opacity:1}',
      '100%{stroke-dashoffset:-120;opacity:.35}',
      '}',
      '@media (prefers-reduced-motion:reduce){',
      '#' + OVERLAY_ID + ' .mj-inf path{animation:none;stroke-dashoffset:0;opacity:.9}',
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
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-busy', 'true');
    el.innerHTML =
      '<div class="mj-inf" aria-hidden="true">' +
      '<svg viewBox="0 0 80 40" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M10 20 C10 8, 30 8, 40 20 C50 32, 70 32, 70 20 C70 8, 50 8, 40 20 C30 32, 10 32, 10 20"/>' +
      '<path class="mj-inf-2" d="M10 20 C10 8, 30 8, 40 20 C50 32, 70 32, 70 20 C70 8, 50 8, 40 20 C30 32, 10 32, 10 20"/>' +
      '</svg></div>' +
      '<div class="mj-lbl">Loading</div>';
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  function show() {
    var el = ensureOverlay();
    requestAnimationFrame(function () {
      el.classList.add('is-on');
    });
  }

  function hide() {
    var el = document.getElementById(OVERLAY_ID);
    if (!el) return;
    el.classList.remove('is-on');
  }

  function sameOrigin(url) {
    try {
      var u = new URL(url, location.href);
      return u.origin === location.origin;
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
      // same page hash only
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
      // Safety: if navigation is blocked, hide after a few seconds
      setTimeout(hide, 12000);
    },
    true
  );

  // Hide when page is shown (including back/forward cache)
  window.addEventListener('pageshow', hide);
  window.addEventListener('pagehide', function () {
    /* keep visible while leaving */
  });
  document.addEventListener('DOMContentLoaded', function () {
    // brief fade-out if we arrived with loader still painted from previous paint (bfcache edge)
    setTimeout(hide, 80);
  });
  window.addEventListener('load', function () {
    setTimeout(hide, 40);
  });

  // Expose for manual use (e.g. before location.href = ...)
  window.mjShowPageLoader = show;
  window.mjHidePageLoader = hide;
})();
