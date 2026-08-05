// Pure routing decision for the service worker's fetch handler, kept as its
// own module so vitest can table-test it without a SW environment
// (classify.test.ts). The build plugin in vite.config.ts inlines this file
// into dist/sw.js (stripping the `export` keywords), so it must stay
// dependency-free, classic-script-safe JS: no imports, no TS syntax.
// Full routing table + rationale: dev-material/service-worker-design.md.

// Precached one-off files beyond the shell document and /assets/*
// (installability offline). The build plugin reads this list too, so
// classify and the precache manifest can't drift.
export const PRECACHE_EXTRAS = [
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
]

// classify(url, {method, mode, sameOrigin}) →
//   'network-first' | 'cache-first' | 'passthrough'
// 'passthrough' never sees respondWith — browser default handling (game
// servers, WS upgrades, the analytics beacon, SEO mirrors, shots).
export function classify(url, ctx) {
  if (ctx.method !== 'GET' || !ctx.sameOrigin) return 'passthrough'
  const path = url.pathname
  // Offline-tiles gamedata: populated only by the readiness download
  // (artifact-store.ts, pz-offline-gamedata) — served cache-first here
  // because tileinfo <script> tags and atlas images can't read the Cache
  // API themselves; a miss falls through to network, so online tile use is
  // unaffected.
  if (path.startsWith('/gamedata/local/')) return 'cache-first'
  // The engine-artifact cache (worker-owned, version.json-keyed) and any
  // other gamedata own their caching; intercepting here would double-cache
  // ~13 MB and fight their version logic.
  if (path.startsWith('/offline/') || path.startsWith('/gamedata/')) {
    return 'passthrough'
  }
  if (ctx.mode === 'navigate') {
    // Only the app shell gets the offline treatment; about/changelog/morgue
    // pages are SEO mirrors, and in-app docs ship in the bundle.
    return path === '/' || path === '/index.html' ? 'network-first' : 'passthrough'
  }
  if (path.startsWith('/assets/')) return 'cache-first'
  if (PRECACHE_EXTRAS.indexOf(path) !== -1) return 'cache-first'
  return 'passthrough'
}
