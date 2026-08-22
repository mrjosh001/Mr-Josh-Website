/**
 * MJ Hub — infinity loader from click until next page is ready
 * Critical: preventDefault + paint overlay BEFORE navigation, or the
 * browser unloads the page before the loader is ever visible.
 */
(function () {
  if (window.__mjPageLoader) return;
  window.__mjPageLoader = true;

  var STYLE_ID = 'mj-page-loader-style';
  var OVERLAY_ID = 'mj-page-loader';
  var PATH = 'M 16 32 C 16 16, 36 16, 48 32 C 60 48, 80 48, 80 32 C 80 16, 60 16, 48 32 C 36 48, 16 48, 16 32';
  var navigating = false;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '#'+OVERLAY_ID+'{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:#000;opacity:0;visibility:hidden;pointer-events:none}',
      '#'+OVERLAY_ID+'.is-on{opacity:1;visibility:visible;pointer-events:auto}',
      '#'+OVERLAY_ID+' .mj-inf{position:relative;width:120px;height:64px}',
      '#'+OVERLAY_ID+' .mj-inf::before{content:"";position:absolute;left:50%;top:50%;width:140px;height:140px;transform:translate(-50%,-50%);border-radius:50%;background:radial-gradient(circle,rgba(124,58,237,.4) 0%,rgba(56,189,248,.15) 40%,transparent 70%);animation:mjBloom 2.2s ease-in-out infinite;pointer-events:none}',
      '#'+OVERLAY_ID+' .mj-inf svg{position:relative;z-index:1;display:block;width:120px;height:64px;overflow:visible}',
      '#'+OVERLAY_ID+' .mj-track{fill:none;stroke:rgba(167,139,250,.25);stroke-width:3.5;stroke-linecap:round;stroke-linejoin:round}',
      '#'+OVERLAY_ID+' .mj-beam{fill:none;stroke:#e9d5ff;stroke-width:3.5;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:28 200;filter:drop-shadow(0 0 4px #c084fc) drop-shadow(0 0 12px #22d3ee) drop-shadow(0 0 20px rgba(139,92,246,.85));animation:mjBeam 1.6s linear infinite}',
      '#'+OVERLAY_ID+' .mj-lbl{position:relative;z-index:1;font-family:system-ui,-apple-system,sans-serif;font-size:12px;font-weight:500;letter-spacing:.2em;color:rgba(148,163,184,.8);text-transform:lowercase}',
      '@keyframes mjBeam{to{stroke-dashoffset:-228}}',
      '@keyframes mjBloom{0%,100%{opacity:.55;transform:translate(-50%,-50%) scale(1)}50%{opacity:1;transform:translate(-50%,-50%) scale(1.08)}}',
      '@media (prefers-reduced-motion:reduce){#'+OVERLAY_ID+' .mj-beam{animation:none;stroke-dasharray:none}#'+OVERLAY_ID+' .mj-inf::before{animation:none}}'
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
      '<div class="mj-inf" aria-hidden="true"><svg viewBox="0 0 96 64" width="120" height="64">' +
      '<path class="mj-track" d="'+PATH+'"/>' +
      '<path class="mj-beam" d="'+PATH+'"/>' +
      '</svg></div><div class="mj-lbl">loading</div>';
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  function show() {
    var el = ensureOverlay();
    el.classList.add('is-on');
    try { sessionStorage.setItem('mj_nav_loading', '1'); } catch (e) {}
  }

  function hide() {
    if (navigating) return; /* stay up while leaving */
    var el = document.getElementById(OVERLAY_ID);
    if (el) el.classList.remove('is-on');
    try { sessionStorage.removeItem('mj_nav_loading'); } catch (e) {}
  }

  function sameOrigin(url) {
    try { return new URL(url, location.href).origin === location.origin; }
    catch (e) { return false; }
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

  function go(url) {
    navigating = true;
    show();
    /* Paint at least one frame with loader visible, then navigate */
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        window.location.href = url;
      });
    });
  }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!isInternalNav(a)) return;
    e.preventDefault();
    e.stopPropagation();
    var url = a.href;
    go(url);
  }, true);

  window.addEventListener('popstate', function () {
    try { sessionStorage.setItem('mj_nav_loading', '1'); } catch (e) {}
    show();
  });

  window.addEventListener('pagehide', function () {
    try { sessionStorage.setItem('mj_nav_loading', '1'); } catch (e) {}
  });

  /* Programmatic navigations */
  try {
    var _assign = window.location.assign.bind(window.location);
    var _replace = window.location.replace.bind(window.location);
    window.location.assign = function (url) {
      if (sameOrigin(String(url))) {
        navigating = true;
        show();
        var u = String(url);
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { _assign(u); });
        });
        return;
      }
      return _assign(url);
    };
    window.location.replace = function (url) {
      if (sameOrigin(String(url))) {
        navigating = true;
        show();
        var u = String(url);
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { _replace(u); });
        });
        return;
      }
      return _replace(url);
    };
  } catch (e) {}

  function hideWhenReady() {
    navigating = false;
    setTimeout(hide, 40);
  }
  window.addEventListener('load', hideWhenReady);
  if (document.readyState === 'complete') hideWhenReady();

  try {
    if (sessionStorage.getItem('mj_nav_loading') === '1') show();
  } catch (e) {}

  window.mjShowPageLoader = show;
  window.mjHidePageLoader = function () {
    navigating = false;
    hide();
  };
})();
