window.mjSkeleton = {
  _t0: 0,
  cards: function (n) {
    n = n || 3;
    var html = '<div class="mj-skel mj-skel-wrap" aria-hidden="true">';
    for (var i = 0; i < n; i++) {
      html += '<div class="mj-skel-card">' +
        '<div class="mj-skel-row" style="margin-top:0;margin-bottom:12px">' +
        '<div class="mj-skel-line lg mj-skel-pulse" style="margin:0;flex:1"></div>' +
        '<div class="mj-skel-pill mj-skel-pulse"></div></div>' +
        '<div class="mj-skel-line full mj-skel-pulse"></div>' +
        '<div class="mj-skel-line md mj-skel-pulse"></div>' +
        '<div class="mj-skel-bar mj-skel-pulse"></div></div>';
    }
    return html + '</div>';
  },
  grid: function (n) {
    n = n || 6;
    var html = '<div class="mj-skel mj-skel-wrap" aria-hidden="true"><div class="mj-skel-grid">';
    for (var i = 0; i < n; i++) html += '<div class="mj-skel-tile mj-skel-pulse"></div>';
    return html + '</div></div>';
  },
  lines: function (n) {
    n = n || 4;
    var html = '<div class="mj-skel mj-skel-wrap" aria-hidden="true">';
    for (var i = 0; i < n; i++) {
      html += '<div class="mj-skel-line full mj-skel-pulse" style="width:' + (92 - i * 12) + '%"></div>';
    }
    return html + '</div>';
  },
  /** Show skeleton at least minMs so fast APIs still feel intentional */
  paint: function (el, type, count, minMs) {
    if (!el) return function (done) { if (done) done(); };
    this._t0 = Date.now();
    minMs = minMs == null ? 280 : minMs;
    var fn = this[type] || this.cards;
    el.innerHTML = fn.call(this, count || 3);
    el.setAttribute('data-skel-on', '1');
    return function finish(renderFn) {
      var wait = Math.max(0, minMs - (Date.now() - window.mjSkeleton._t0));
      setTimeout(function () {
        if (typeof renderFn === 'function') renderFn();
        el.removeAttribute('data-skel-on');
      }, wait);
    };
  }
};
