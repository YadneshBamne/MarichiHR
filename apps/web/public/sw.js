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

// Page loads go to the network; only when that fails (offline) does the offline page show
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return
  event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')))
})
