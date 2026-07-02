// Service worker for the Terminal Workspace remote PWA.
//
// Scope: installability, an offline-capable app shell (network-first with cache
// fallback, so the installed app opens instantly even when the server is
// briefly unreachable), and notifications via registration.showNotification()
// (which keep working while the app is backgrounded). Background delivery while
// the app is fully closed would need the Web Push API (VAPID + a server push) —
// a later addition.

const SHELL_CACHE = 'tw-shell-v1'
const SHELL_URLS = ['/', '/manifest.webmanifest', '/icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

// Network-first for the shell: fresh when the server is up (no stale UI after
// an app update), cached when it isn't. WebSocket upgrades and POSTs (e.g.
// /pair) never hit this path — only GETs are intercepted.
self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin) return
  if (!SHELL_URLS.includes(url.pathname)) return
  event.respondWith(
    fetch(req)
      .then((resp) => {
        const copy = resp.clone()
        caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy))
        return resp
      })
      .catch(() => caches.match(req).then((hit) => hit ?? Response.error()))
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus()
      }
      return self.clients.openWindow ? self.clients.openWindow('/') : undefined
    })
  )
})
