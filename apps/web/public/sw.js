// MarichiHR service worker: makes the app installable and shows a friendly page when the phone is offline.
// It deliberately caches almost nothing: app code and API data always come from the network, so a new deploy is
// picked up on the next load and nobody sees stale pay or leave figures.
const CACHE = 'marichihr-shell-v1'
const SHELL = ['/offline.html', '/icon-192.png', '/favicon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  )
})

// Push notifications: show them; a click opens (or focuses) the app at the notification's link
self.addEventListener('push', (event) => {
  let d = {}
  try { d = event.data ? event.data.json() : {} } catch { d = { title: 'MarichiHR', body: event.data ? event.data.text() : '' } }
  event.waitUntil(self.registration.showNotification(d.title || 'MarichiHR', { body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', data: { link: d.link || '/' } }))
})
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.link || '/', self.location.origin).href
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.startsWith(self.location.origin))
    return open ? open.navigate(url).then((c) => c && c.focus()) : self.clients.openWindow(url)
  }))
})

// Page loads go to the network; only when that fails (offline) does the offline page show
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return
  event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')))
})
