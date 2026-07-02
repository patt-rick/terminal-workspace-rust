// Service worker for the Terminal Workspace remote PWA.
//
// Phase A scope: makes the client installable to a home screen, shows the
// notifications the page requests via registration.showNotification() (which
// keep working while the app is backgrounded), and focuses the app when a
// notification is tapped. Background delivery while the app is fully closed
// would need the Web Push API (VAPID + a server push) — a later addition.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// A fetch handler (even a pass-through one) is required for the install prompt.
// The app shell is always served fresh from the local server, so we don't cache.
self.addEventListener('fetch', () => {})

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
