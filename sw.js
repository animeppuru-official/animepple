// アニメップル：Web Push通知用のService Worker
// リポジトリのルート（index.htmlと同じ階層）に sw.js として置いてください

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'アニメップル', body: '新着があります' }; }
  const title = data.title || 'アニメップル';
  const options = {
    body: data.body || '掲示板に新着があります',
    icon: data.icon || 'https://animepple.com/mascot.png',
    badge: 'https://animepple.com/mascot.png',
    data: { url: data.url || 'https://animepple.com/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || 'https://animepple.com/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
