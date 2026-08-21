/**
 * MJ Hub — Instagram/Twitter-style skeleton loaders
 * Exposes: window.MJSkeleton and window.mjSkeleton (alias)
 * Methods: show, hide, lines, cardPlaceholder, grid(n), cards(n), list(n)
 */
(function (w) {
  var reduce = w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function show(el) {
    if (!el) return;
    el.setAttribute('data-skeleton', 'loading');
    el.classList.add('is-skeleton-loading');
  }
  function hide(el) {
    if (!el) return;
    el.removeAttribute('data-skeleton');
    el.classList.remove('is-skeleton-loading', 'skeleton', 'sk-pulse');
  }
  function lines(n) {
    n = n || 3;
    var h = '';
    for (var i = 0; i < n; i++) {
      var wdt = i === 0 ? 'w70' : i === n - 1 ? 'w40' : 'w90';
      h += '<div class="sk-bone sk-line ' + wdt + '"></div>';
    }
    return h;
  }
  function cardPlaceholder() {
    return (
      '<div class="sk-card" aria-hidden="true">' +
      '<div class="sk-bone sk-avatar"></div>' +
      '<div class="sk-card-body">' + lines(3) + '</div>' +
      '</div>'
    );
  }
  /** Product / service grid placeholders */
  function grid(count) {
    count = Math.max(1, Math.min(12, count || 6));
    var h = '<div class="sk-grid" aria-hidden="true" aria-busy="true">';
    for (var i = 0; i < count; i++) {
      h +=
        '<div class="sk-grid-item">' +
        '<div class="sk-bone sk-thumb"></div>' +
        '<div class="sk-bone sk-line w90"></div>' +
        '<div class="sk-bone sk-line w60"></div>' +
        '<div class="sk-bone sk-line w40"></div>' +
        '</div>';
    }
    h += '</div>';
    return h;
  }
  /** List / order / country row placeholders */
  function cards(count) {
    count = Math.max(1, Math.min(10, count || 4));
    var h = '<div class="sk-cards" aria-hidden="true" aria-busy="true">';
    for (var i = 0; i < count; i++) {
      h +=
        '<div class="sk-card-row">' +
        '<div class="sk-bone sk-avatar"></div>' +
        '<div class="sk-card-body">' +
        '<div class="sk-bone sk-line w70"></div>' +
        '<div class="sk-bone sk-line w90"></div>' +
        '</div>' +
        '<div class="sk-bone sk-pill"></div>' +
        '</div>';
    }
    h += '</div>';
    return h;
  }
  function list(count) {
    return cards(count);
  }

  var api = {
    show: show,
    hide: hide,
    lines: lines,
    cardPlaceholder: cardPlaceholder,
    grid: grid,
    cards: cards,
    list: list,
    reduce: !!reduce
  };
  w.MJSkeleton = api;
  w.mjSkeleton = api; // pages call lowercase
})(window);
