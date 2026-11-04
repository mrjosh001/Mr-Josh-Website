/* MJ HUB — Web Push service worker */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  var DEFAULT_TITLE = 'Update';
  var DEFAULT_BODY = 'You have a new update. Open your dashboard.';
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

  var title = (data.title && String(data.title).trim()) || DEFAULT_TITLE;
  var body = (data.body && String(data.body).trim()) || DEFAULT_BODY;

  // Never show bare app name as the bold title
  if (/^mj\s*hub$/i.test(title)) title = DEFAULT_TITLE;
  title = title.replace(/\s*from\s*MJ\s*HUB\s*/gi, '').trim() || DEFAULT_TITLE;
  body = body.replace(/\s*from\s*MJ\s*HUB\s*/gi, '').trim() || DEFAULT_BODY;

  // SMS-style: phone title + full message body (like native WhatsApp SMS)
  var isSms = String(data.type || '') === 'sms_code' || /^\+?\d[\d\s().-]{8,}$/.test(title);

  var options = {
    body: body,
    icon: data.icon || '/img/IMG_3027.png',
    badge: data.badge || '/img/IMG_3027.png',
    data: { url: data.url || (isSms ? '/sms-history.html' : '/dashboard.html') },
    vibrate: isSms ? [80, 40, 80, 40, 120] : [120, 60, 120],
    requireInteraction: !!isSms,
    tag: isSms ? ('sms-' + title.replace(/\s+/g, '')) : (data.tag || undefined),
    renotify: !!isSms
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
