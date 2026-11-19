/* MJ HUB Admin Support — isolated Web Push service worker */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  var data = { title: 'New customer support message', body: 'A customer sent a support message.', url: '/admin-support.html' };
  try {
    if (event.data) data = Object.assign(data, event.data.json() || {});
  } catch (_) {}
  var title = String(data.title || 'New customer support message').trim();
  var options = {
    body: String(data.body || 'A customer sent a support message.').trim(),
    icon: data.icon || '/img/IMG_3027.png',
    badge: data.badge || '/img/IMG_3027.png',
    data: { url: String(data.url || '/admin-support.html') },
    tag: data.tag || 'mjhub-admin-support',
    renotify: true
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || '/admin-support.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
      for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (client.url && new URL(client.url).origin === self.location.origin && 'focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
