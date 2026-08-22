/**
 * MJ Hub — graceful degradation
 * Soft failures: offline, missing JS libs, broken images, optional features
 */
(function (w, d) {
  'use strict';

  function ensureBanner() {
    var el = d.getElementById('mj-offline-banner');
    if (el) return el;
    el = d.createElement('div');
    el.id = 'mj-offline-banner';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.hidden = true;
    el.innerHTML =
      '<strong>You are offline.</strong> ' +
      '<span>Some actions will not work until your connection returns.</span>';
    d.body.appendChild(el);
    return el;
  }

  function setOffline(off) {
    try {
      d.documentElement.classList.toggle('is-offline', !!off);
      var b = ensureBanner();
      b.hidden = !off;
      if (off) b.classList.add('is-visible');
      else b.classList.remove('is-visible');
    } catch (e) {}
  }

  function onOnline() { setOffline(false); }
  function onOffline() { setOffline(true); }

  // Broken images → placeholder
  function softImages() {
    d.addEventListener(
      'error',
      function (e) {
        var t = e.target;
        if (!t || t.tagName !== 'IMG') return;
        if (t.dataset.mjSoft === '1') return;
        t.dataset.mjSoft = '1';
        t.style.visibility = 'hidden';
        t.alt = t.alt || 'Image unavailable';
        // keep layout: low-opacity mark
        try {
          t.style.visibility = 'visible';
          t.style.opacity = '0.35';
          t.style.objectFit = 'contain';
          if (!t.getAttribute('src') || /supabase|avatar|logo/i.test(t.src || '')) {
            // leave broken logo as alt text only
          }
        } catch (err) {}
      },
      true
    );
  }

  // If critical Supabase SDK never loaded
  function checkSupabase() {
    var needs = /auth|dashboard|boosters|sms|logs/i.test(location.pathname + location.href);
    if (!needs) return;
    setTimeout(function () {
      if (w.supabase || w.supabaseClient) return;
      var box = d.getElementById('mj-js-fallback');
      if (!box) {
        box = d.createElement('div');
        box.id = 'mj-js-fallback';
        box.className = 'mj-js-fallback';
        box.setAttribute('role', 'alert');
        box.innerHTML =
          '<p><strong>MJ Hub needs a working connection.</strong></p>' +
          '<p>A required script did not load. Check your network, disable strict blockers for this site, then refresh.</p>' +
          '<p><button type="button" onclick="location.reload()">Refresh page</button> ' +
          '<a href="/">Go to home</a></p>';
        if (d.body) d.body.insertBefore(box, d.body.firstChild);
      }
    }, 4000);
  }

  // Safe optional feature runner
  function soft(fn, label) {
    try {
      return fn();
    } catch (e) {
      try {
        console.warn('[mj soft]', label || 'feature', e);
      } catch (e2) {}
      return undefined;
    }
  }

  w.mjSoft = soft;
  w.mjSetOffline = setOffline;

  function init() {
    softImages();
    setOffline(!w.navigator.onLine);
    w.addEventListener('online', onOnline);
    w.addEventListener('offline', onOffline);
    checkSupabase();

    // Reduced motion: pause decorative animations if user prefers
    try {
      if (w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        d.documentElement.classList.add('reduce-motion');
      }
    } catch (e) {}
  }

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', init);
  else init();
})(window, document);
