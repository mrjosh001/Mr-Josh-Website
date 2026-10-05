/* MJ HUB — Web Push service worker */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'MJ HUB', body: 'You have an update', url: '/dashboard.html' };
  try {
    if (event.data) {
      const parsed = event.data.json();
      data = Object.assign(data, parsed || {});
    }
  } catch (_) {
    try {
      const t = event.data && event.data.text();
      if (t) data.body = t;
    } catch (_) {}
  }
  const title = data.title || 'MJ HUB';
  const options = {
    body: data.body || '',
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
  const url = (event.notification.data && event.notification.data.url) || '/dashboard.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
