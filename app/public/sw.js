// Cache the app shell and immutable same-origin build assets only.
const CACHE = 'kindependence-shell-v2'
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.add('./index.html')).then(() => self.skipWaiting()))
})
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('kindependence-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', event => {
  const req = event.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== self.location.origin) return
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('./index.html')))
    return
  }
  if (!/\/assets\/[^/]+-[\w-]+\.(js|css|woff2?|png|svg)$/.test(url.pathname)) return
  event.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(req)
    if (cached) return cached
    const response = await fetch(req)
    if (response.ok && response.type === 'basic') await cache.put(req, response.clone())
    return response
  }))
})
