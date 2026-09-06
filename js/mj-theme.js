(function () {
  if (window.__mjTheme) return;
  window.__mjTheme = true;
  function resolve() {
    var pref = 'system';
    try { pref = localStorage.getItem('mjhub-theme-pref') || 'system'; } catch (e) {}
    if (pref === 'light') return 'light';
    if (pref === 'dark') return 'dark';
    try {
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch (e2) {
      return 'dark';
    }
  }
  function apply() {
    var t = resolve();
    try { document.documentElement.setAttribute('data-theme', t); } catch (e) {}
  }
  window.mjApplyTheme = apply;
  apply();
  try {
    var mq = window.matchMedia('(prefers-color-scheme: light)');
    var onMq = function () {
      var pref = 'system';
      try { pref = localStorage.getItem('mjhub-theme-pref') || 'system'; } catch (e) {}
      if (pref === 'system') apply();
    };
    if (mq.addEventListener) mq.addEventListener('change', onMq);
    else if (mq.addListener) mq.addListener(onMq);
  } catch (e) {}
  window.addEventListener('storage', function (e) {
    if (!e) return;
    if (e.key === 'mjhub-theme-pref' || e.key === 'mjhub-theme') apply();
  });
})();
