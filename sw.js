/* MJ HUB — Web Push service worker */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  var DEFAULT_TITLE = 'Update';
  var DEFAULT_BODY = 'You have a new update on MJ HUB. Log in to your dashboard.';
  var data = { title: DEFAULT_TITLE, body: DEFAULT_BODY, url: '/dashboard.html' };
  try {
    if (event.data) {
      var parsed = event.data.json();
      if (parsed) data = Object.assign(data, parsed);
    }
  } catch (_) {
    try {
      var t = event.data && event.data.text();
      if (t) data.body = t;
    } catch (_) {}
  }

  // Lagos Life style: TITLE (bold) + body. iOS shows "from MJ HUB" under the title.
  var title = (data.title && String(data.title).trim()) || DEFAULT_TITLE;
  // Never use bare app name as title — looks like "MJ HUB from MJ HUB"
  if (/^mj\s*hub$/i.test(title)) title = DEFAULT_TITLE;

  var body = (data.body && String(data.body).trim()) || DEFAULT_BODY;

  var options = {
    body: body,
    icon: data.icon || '/img/IMG_3027.png',
    badge: data.badge || '/img/IMG_3027.png',
    data: { url: data.url || '/dashboard.html' },
    vibrate: [120, 60, 120],
    requireInteraction: false
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/dashboard.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
