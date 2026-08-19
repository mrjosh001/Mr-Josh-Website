/** MJ Hub skeleton helpers */
window.mjSkeleton = {
  cards: function (n) {
    n = n || 3;
    var html = '<div class="mj-skel mj-skel-wrap">';
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
    var html = '<div class="mj-skel mj-skel-wrap"><div class="mj-skel-grid">';
    for (var i = 0; i < n; i++) {
      html += '<div class="mj-skel-tile mj-skel-pulse"></div>';
    }
    return html + '</div></div>';
  },
  lines: function (n) {
    n = n || 4;
    var html = '<div class="mj-skel mj-skel-wrap">';
    for (var i = 0; i < n; i++) {
      html += '<div class="mj-skel-line full mj-skel-pulse" style="width:' + (90 - i * 10) + '%"></div>';
    }
    return html + '</div>';
  }
};
