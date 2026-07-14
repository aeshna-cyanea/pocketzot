// PocketZot service worker — app-shell offline (phase 1: shell precache).
// This file is a TEMPLATE: the pz-sw-precache plugin in vite.config.ts
// replaces the two double-underscore tokens below and writes the result to
// dist/sw.js. It is a classic (non-module) worker script.
// Design + failure-mode analysis: dev-material/service-worker-design.md.
// Bad-deploy escape hatch: src/sw/sw-kill.js.
/* global self, caches */
'use strict'

// { version, shellHtml, shellHeaders, assets: ['/assets/…', …, manifest + icons] }
const PRECACHE = __PRECACHE_MANIFEST__

__CLASSIFY__

const CACHE_NAME = 'pz-shell-' + PRECACHE.version
// The shell is cached under '/' — Pages 308-redirects /index.html to /.
const SHELL_URL = '/'
// Bounds lie-fi only (a fetch that hangs instead of failing). Genuinely
// offline, fetch() rejects in milliseconds and the fallback serves the
// precache immediately — this timer never delays an airplane-mode launch.
const NAV_TIMEOUT_MS = 4000

self.addEventListener('install', (event) => {
  // All-or-nothing: any failure rejects waitUntil and the old SW + old
  // cache stay fully in charge. No skipWaiting anywhere: the new SW takes
  // over only once every old-shell client is gone, so a running page can
  // always lazy-import its own hash-named chunks (the offline stack is a
  // dynamic import) from its own complete precache.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    try {
      // The shell document ships embedded in this file rather than fetched
      // at install: a mid-deploy fetch of '/' could pair a newer deploy's
      // HTML with this build's asset list — the exact skew this design
      // exists to kill. shellHeaders carries public/_headers' `/*` block —
      // a SW-synthesized response never traverses the edge, so CSP and the
      // other security headers (header-only, no <meta> fallback) must be
      // baked in or SW-served documents would run without them.
      await cache.put(SHELL_URL, new Response(PRECACHE.shellHtml, {
        headers: PRECACHE.shellHeaders,
      }))
      await cache.addAll(PRECACHE.assets)
    } catch (err) {
      // All-or-nothing at the storage layer too: without this, a failed
      // addAll leaves a shell-only residue cache behind (unservable, but
      // orphaned until a later generation's activate reaps it).
      await caches.delete(CACHE_NAME)
      throw err
    }
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable()
    }
    // Old shell generations are deleted only here, after their last client
    // is gone. pz-offline-artifacts and pz-gamedata-* are never touched.
    const names = await caches.keys()
    await Promise.all(names
      .filter((name) => name.startsWith('pz-shell-') && name !== CACHE_NAME)
      .map((name) => caches.delete(name)))
  })())
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  const strategy = classify(url, {
    method: event.request.method,
    mode: event.request.mode,
    sameOrigin: url.origin === self.location.origin,
  })
  if (strategy === 'network-first') {
    event.respondWith(shellNetworkFirst(event))
  } else if (strategy === 'cache-first') {
    event.respondWith(cacheFirst(event.request))
  }
  // 'passthrough': no respondWith — the browser handles it as if no SW
  // existed (and skips the SW-startup cost via early return).
})

async function shellNetworkFirst(event) {
  try {
    const response = await withTimeout(navigationFetch(event), NAV_TIMEOUT_MS)
    // Navigations carry redirect:'manual', so a legitimate redirect arrives
    // as an ok:false opaqueredirect — pass it through for the browser to
    // follow. Anything else non-ok (edge 5xx error page) loses to the
    // known-good cached shell. Captive-portal 200s are undetectable; they
    // win here exactly as they would with no SW at all.
    if (response.ok || response.type === 'opaqueredirect') return response
    return (await cachedShell()) || response
  } catch (_err) {
    // A missing cached shell should be impossible (install is atomic);
    // degrade to plain network rather than synthesize an error page.
    return (await cachedShell()) || fetch(event.request)
  }
}

function cachedShell() {
  // Pinned to this SW's own generation on purpose: the shell must stay
  // self-consistent with the asset set installed alongside it.
  return caches.match(SHELL_URL, { cacheName: CACHE_NAME, ignoreVary: true })
}

async function navigationFetch(event) {
  const preloaded = await event.preloadResponse
  return preloaded || fetch(event.request)
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('nav-timeout')), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

async function cacheFirst(request) {
  // Deliberately UNPINNED — searches every cache generation, not just this
  // SW's own: a page that got fresh post-deploy HTML from the network while
  // the old SW was still active must be able to lazy-import its new-hash
  // chunks offline from the cache the *waiting* SW just installed (the
  // offline stack is a dynamic import). Safe for hash-named immutable
  // assets; a miss still falls through to network. ignoreVary is
  // load-bearing: servers stamp `Vary: Origin` on assets, and the page's
  // crossorigin module-script/stylesheet requests carry an Origin header
  // the install-time addAll fetch didn't — without it, every offline
  // chunk load Vary-misses the cache and dies on the network fallback.
  const cached = await caches.match(request, { ignoreVary: true })
  return cached || fetch(request)
}
