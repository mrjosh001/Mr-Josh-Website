/* MJ HUB — Shared mobile pull-to-refresh
 * Loaded through mj-page-loader.js so supported pages use one consistent implementation.
 * Pages can opt out with <body data-no-ptr> or mark inner areas with [data-no-ptr].
 */
(function (w, d) {
  'use strict';
  if (w.__mjPullRefreshReady || !('ontouchstart' in w)) return;
  w.__mjPullRefreshReady = true;

  var THRESHOLD = 80, MAX_PULL = 130, RESIST = 0.5;
  var ID = 'mjPtr';
  var ind, arc, main;
  var startY = 0, startX = 0, pull = 0;
  var tracking = false, pulling = false, refreshing = false;

  function boot() {
    if (d.getElementById(ID) || (d.body && d.body.hasAttribute('data-no-ptr'))) return;
    var style = d.createElement('style');
    style.id = 'mj-ptr-shared-style';
    style.textContent =
      'html,body{overscroll-behavior-y:contain}' +
      '#'+ID+'{position:fixed;left:50%;top:calc(64px + env(safe-area-inset-top,0px));z-index:1500;width:42px;height:42px;margin-left:-21px;border-radius:50%;display:grid;place-items:center;background:var(--card-solid,var(--card,#0f1524));border:1px solid var(--border,rgba(148,163,184,.2));box-shadow:0 8px 24px rgba(0,0,0,.28);opacity:0;pointer-events:none;transform:translateY(-60px);will-change:transform,opacity}' +
      '#'+ID+'.anim{transition:transform .28s cubic-bezier(.2,.8,.2,1),opacity .2s ease}' +
      '#'+ID+' svg{width:26px;height:26px;display:block;transform:rotate(-90deg)}' +
      '#'+ID+' .ptr-track{fill:none;stroke:var(--border,rgba(148,163,184,.25));stroke-width:3}' +
      '#'+ID+' .ptr-arc{fill:none;stroke:var(--primary,#3b6ef5);stroke-width:3;stroke-linecap:round;stroke-dasharray:62.83;stroke-dashoffset:62.83}' +
      '#'+ID+'.loading svg{animation:mjPtrSpin .8s linear infinite}' +
      '#'+ID+'.loading .ptr-arc{stroke-dashoffset:44}' +
      '@keyframes mjPtrSpin{from{transform:rotate(-90deg)}to{transform:rotate(270deg)}}' +
      '@media(prefers-reduced-motion:reduce){#'+ID+'.loading svg{animation-duration:1.6s}}';
    (d.head || d.documentElement).appendChild(style);

    ind = d.createElement('div');
    ind.id = ID;
    ind.setAttribute('aria-hidden', 'true');
    ind.innerHTML = '<svg viewBox="0 0 26 26"><circle class="ptr-track" cx="13" cy="13" r="10"/><circle class="ptr-arc" cx="13" cy="13" r="10"/></svg>';
    d.body.appendChild(ind);
    arc = ind.querySelector('.ptr-arc');
    main = d.querySelector('.main-content');
    bind();
  }

  function atTop() {
    var y = w.scrollY || d.documentElement.scrollTop || d.body.scrollTop || 0;
    return y <= 0;
  }
  function blocked(target) {
    if (refreshing || (d.body && d.body.hasAttribute('data-no-ptr'))) return true;
    if (d.body.style.overflow === 'hidden' || d.documentElement.style.overflow === 'hidden') return true;
    if (!target || !target.closest) return false;
    if (target.closest('.activity-history-drawer,.currency-modal,.floating-action-modal,.sidebar,.overlay.active,.confirm-modal-card,.modal,.modal-backdrop,input,textarea,select,button,[contenteditable="true"],[data-no-ptr]')) return true;
    var el = target;
    while (el && el !== d.body) {
      var oy = w.getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight && el.scrollTop > 0) return true;
      el = el.parentElement;
    }
    return false;
  }
  function render(distance) {
    var p = Math.min(1, distance / THRESHOLD);
    ind.style.opacity = String(Math.min(1, p * 1.2));
    ind.style.transform = 'translateY(' + (Math.min(distance, MAX_PULL) - 52) + 'px) rotate(' + (p * 270) + 'deg)';
    arc.style.strokeDashoffset = String(62.83 * (1 - p));
    if (main) main.style.transform = 'translateY(' + Math.min(distance, MAX_PULL) * 0.55 + 'px)';
  }
  function reset(animated) {
    if (animated) {
      ind.classList.add('anim');
      if (main) main.style.transition = 'transform .28s cubic-bezier(.2,.8,.2,1)';
    }
    ind.style.opacity = '0';
    ind.style.transform = 'translateY(-60px)';
    arc.style.strokeDashoffset = '62.83';
    if (main) main.style.transform = '';
    w.setTimeout(function () {
      ind.classList.remove('anim');
      if (main) main.style.transition = '';
    }, 320);
  }
  function release() {
    if (!tracking && !pulling) return;
    var shouldRefresh = pulling && pull >= THRESHOLD;
    tracking = false;
    pulling = false;
    if (shouldRefresh) {
      refreshing = true;
      ind.classList.add('anim', 'loading');
      ind.style.opacity = '1';
      ind.style.transform = 'translateY(' + (THRESHOLD * 0.6) + 'px)';
      arc.style.strokeDashoffset = '';
      if (main) {
        main.style.transition = 'transform .28s cubic-bezier(.2,.8,.2,1)';
        main.style.transform = 'translateY(' + (THRESHOLD * 0.35) + 'px)';
      }
      if (w.navigator.vibrate) { try { w.navigator.vibrate(10); } catch (e) {} }
      w.setTimeout(function () { w.location.reload(); }, 450);
    } else if (pull > 0) {
      reset(true);
    }
    pull = 0;
  }
  function bind() {
    d.addEventListener('touchstart', function (e) {
      tracking = false;
      pulling = false;
      if (!e.touches || e.touches.length !== 1 || !atTop() || blocked(e.target)) return;
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      pull = 0;
      tracking = true;
    }, { passive: true });

    d.addEventListener('touchmove', function (e) {
      if (!tracking || refreshing || !e.touches || !e.touches[0]) return;
      var dy = e.touches[0].clientY - startY;
      var dx = e.touches[0].clientX - startX;
      if (!pulling) {
        if (dy <= 6 || Math.abs(dx) > dy) { if (dy < -6) tracking = false; return; }
        if (!atTop()) { tracking = false; return; }
        pulling = true;
        ind.classList.remove('anim');
      }
      pull = dy * RESIST;
      if (e.cancelable) e.preventDefault();
      render(pull);
    }, { passive: false });

    d.addEventListener('touchend', release, { passive: true });
    d.addEventListener('touchcancel', release, { passive: true });
  }

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})(window, document);
