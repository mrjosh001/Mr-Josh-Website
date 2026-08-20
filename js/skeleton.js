/**
 * MJ Hub skeleton helpers
 * Usage:
 *   MJSkeleton.show(el)
 *   MJSkeleton.hide(el)
 *   MJSkeleton.wrap(el, { lines: 3 })
 */
(function (w) {
  var reduce = w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function show(el) {
    if (!el) return;
    el.setAttribute('data-skeleton', 'loading');
    el.classList.add('skeleton');
  }
  function hide(el) {
    if (!el) return;
    el.removeAttribute('data-skeleton');
    el.classList.remove('skeleton', 'sk-pulse');
  }
  function lines(n) {
    var h = '';
    for (var i = 0; i < n; i++) {
      var wdt = i === 0 ? 'w70' : i === n - 1 ? 'w40' : 'w90';
      h += '<div class="skeleton skeleton-line ' + wdt + '"></div>';
    }
    return h;
  }
  function cardPlaceholder() {
    return (
      '<div class="skeleton-card" aria-hidden="true">' +
      '<div class="skeleton skeleton-avatar"></div>' +
      lines(3) +
      '</div>'
    );
  }
  w.MJSkeleton = { show: show, hide: hide, lines: lines, cardPlaceholder: cardPlaceholder, reduce: !!reduce };
})(window);
