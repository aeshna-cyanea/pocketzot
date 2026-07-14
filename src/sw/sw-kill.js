// Kill switch — deploy this file AS dist/sw.js (replacing the real one) to
// retract a bad service worker (build, then `cp src/sw/sw-kill.js
// dist/sw.js`, then deploy): it deletes the shell caches and unregisters.
// skipWaiting (the one legitimate use in this project) activates it
// immediately even with clients open; once active, all fetches route to
// this worker, which has no fetch handler — straight to network, the bad
// SW silenced. No clients.claim() needed for that. With sw.js served at
// max-age=0 every client picks it up on next launch. pz-offline-artifacts
// and IDBFS saves are untouched. Runbook: dev-material/service-worker-design.md.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names
      .filter((name) => name.startsWith('pz-shell-'))
      .map((name) => caches.delete(name)))
    await self.registration.unregister()
  })())
})
