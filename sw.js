/* MJ HUB — Web Push service worker */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  var DEFAULT_BODY = 'You have a new update on MJ HUB. Log in to your dashboard.';
  var data = { body: DEFAULT_BODY, url: '/dashboard.html' };
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

  // App name already shows as "MJ HUB" — do not repeat a title.
  // Put the full message in body only (single clean line under the app name).
  var body = (data.body && String(data.body).trim()) || DEFAULT_BODY;
  // Zero-width title so iOS/Android don't invent "MJ HUB" / "from MJ HUB"
  var title = '​';

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
