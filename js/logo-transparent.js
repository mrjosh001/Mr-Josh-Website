/**
 * MJ Hub — client-side logo background removal
 * Supabase assets may still be JPEG with a solid plate; this makes near-bg
 * pixels transparent so the mark blends on light/dark UI.
 */
(function () {
  if (window.__mjLogoFx) return;
  window.__mjLogoFx = true;

  var cache = Object.create(null);
  var SELECTOR = [
    'img.brand-logo',
    'img.sidebar-brand-logo-img',
    'img.brand-logo-img',
    'img.login-logo-img',
    '#brandLogo',
    '#navBrandLogo',
    '#sidebarBrandLogo',
    '#welcomeModalLogo',
    '.logo img',
    'img[src*="avatars"][src*="logo"]',
    'img[src*="avatars"][src*="background"]'
  ].join(',');

  function keyFor(src, theme) {
    return String(src || '') + '|' + String(theme || '');
  }

  function processToTransparent(img) {
    return new Promise(function (resolve) {
      try {
        var src = img.currentSrc || img.src;
        if (!src || src.indexOf('data:') === 0 || src.indexOf('blob:') === 0) {
          resolve(false);
          return;
        }
        var theme =
          document.documentElement.getAttribute('data-theme') ||
          localStorage.getItem('mjhub-theme') ||
          'dark';
        var cacheKey = keyFor(src, theme);
        if (cache[cacheKey]) {
          img.src = cache[cacheKey];
          img.style.background = 'transparent';
          resolve(true);
          return;
        }

        var probe = new Image();
        probe.crossOrigin = 'anonymous';
        probe.onload = function () {
          try {
            var w = probe.naturalWidth || probe.width;
            var h = probe.naturalHeight || probe.height;
            if (!w || !h) {
              resolve(false);
              return;
            }
            var canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(probe, 0, 0);
            var imageData = ctx.getImageData(0, 0, w, h);
            var d = imageData.data;

            function px(x, y) {
              var i = (y * w + x) * 4;
              return [d[i], d[i + 1], d[i + 2]];
            }
            // Sample corners for background colour
            var samples = [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)];
            var br = 0,
              bg = 0,
              bb = 0;
            for (var s = 0; s < samples.length; s++) {
              br += samples[s][0];
              bg += samples[s][1];
              bb += samples[s][2];
            }
            br = (br / samples.length) | 0;
            bg = (bg / samples.length) | 0;
            bb = (bb / samples.length) | 0;

            var hard = 48;
            var soft = 90;
            for (var i = 0; i < d.length; i += 4) {
              var r = d[i],
                g = d[i + 1],
                b = d[i + 2];
              var dist = Math.abs(r - br) + Math.abs(g - bg) + Math.abs(b - bb);
              // Also kill pure near-black / near-white plates
              var nearBlack = r < 28 && g < 28 && b < 40 && br < 50;
              var nearWhite = r > 235 && g > 235 && b > 235 && br > 200;
              if (dist < hard || nearBlack || nearWhite) {
                d[i + 3] = 0;
              } else if (dist < soft) {
                d[i + 3] = Math.max(0, Math.min(255, ((dist - hard) / (soft - hard)) * 255));
              }
            }
            ctx.putImageData(imageData, 0, 0);
            var out = canvas.toDataURL('image/png');
            cache[cacheKey] = out;
            img.src = out;
            img.style.background = 'transparent';
            img.style.backgroundColor = 'transparent';
            resolve(true);
          } catch (err) {
            resolve(false);
          }
        };
        probe.onerror = function () {
          resolve(false);
        };
        // Cache-bust once so canvas is not tainted by a stale opaque cache if any
        probe.src = src + (src.indexOf('?') >= 0 ? '&' : '?') + 'mjfx=1';
      } catch (e) {
        resolve(false);
      }
    });
  }

  function run(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var list = scope.querySelectorAll(SELECTOR);
    for (var i = 0; i < list.length; i++) {
      processToTransparent(list[i]);
    }
  }

  function boot() {
    run(document);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Re-run when theme flips or logos are swapped
  var obs = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (m.type === 'attributes' && (m.attributeName === 'data-theme' || m.attributeName === 'src')) {
        run(document);
        return;
      }
      if (m.addedNodes && m.addedNodes.length) run(document);
    }
  });
  obs.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
    childList: true,
    subtree: true
  });

  window.mjProcessLogos = run;
})();
