(function () {
  function pref() {
    try {
      return localStorage.getItem('mjhub-theme-pref')
        || localStorage.getItem('mjhub-theme')
        || localStorage.getItem('mjhub_theme')
        || 'system';
    } catch (e) { return 'system'; }
  }
  function resolve() {
    var p = pref();
    if (p === 'light' || p === 'dark') return p;
    try { return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; }
    catch (e) { return 'dark'; }
  }
  function apply() {
    var t = resolve();
    try { document.documentElement.setAttribute('data-theme', t); } catch (e) {}
    try { if (document.body) document.body.setAttribute('data-theme', t); } catch (e2) {}
  }
  function wireLogo() {
    var local = '/img/IMG_3027.png';
    var imgs = document.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var s = imgs[i].getAttribute('src') || '';
      if (/avatars\/(mjhub-mark-only|mjhub-logo-dark-clear|light%20background|dark%20background)/i.test(s) || /mjhub-mark-only\.png/i.test(s)) {
        imgs[i].setAttribute('src', local);
      }
    }
  }
  window.mjApplyTheme = apply;
  apply();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { apply(); wireLogo(); });
  } else {
    wireLogo();
  }
  try {
    var mq = window.matchMedia('(prefers-color-scheme: light)');
    var onMq = function () { if (pref() === 'system') apply(); };
    if (mq.addEventListener) mq.addEventListener('change', onMq);
    else if (mq.addListener) mq.addListener(onMq);
  } catch (e) {}
  window.addEventListener('storage', function (e) {
    if (e && (e.key === 'mjhub-theme-pref' || e.key === 'mjhub-theme' || e.key === 'mjhub_theme')) apply();
  });
})();
