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
  window.mjApplyTheme = apply;
  apply();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
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
