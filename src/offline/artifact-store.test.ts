import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeCaches, type FakeCache } from '../test/fake-caches'
import {
  ARTIFACT_CACHE, GAMEDATA_CACHE, cachedGamedataBuild, downloadOfflineData,
  fetchArtifact, fetchVersion, markEngineSetComplete, newStats,
  openOfflineStores, openVersionedCache, probeReadiness,
} from './artifact-store'

// Route-map fetch stub: exact-path lookup, 404 otherwise. A `null` value
// simulates a network failure (fetch rejects).
type Routes = Record<string, { body?: string; type?: string; status?: number } | null>

function stubFetch(routes: Routes): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = String(url).replace(/\?.*$/, '')
    const r = routes[path]
    if (r === null) throw new TypeError('network down')
    if (!r) return new Response('nope', { status: 404, headers: { 'Content-Type': 'text/plain' } })
    return new Response(r.body ?? 'data', {
      status: r.status ?? 200,
      headers: { 'Content-Type': r.type ?? 'application/octet-stream' },
    })
  }))
}

const VERSION_OK: Routes = {
  '/offline/version.json': { body: '{"build":"abc123"}', type: 'application/json' },
}
// A version.json from an install.sh that stamps the game version.
const VERSION_LABELED: Routes = {
  '/offline/version.json': { body: '{"build":"abc123","version":"0.34.1"}', type: 'application/json' },
}

let store: ReturnType<typeof fakeCaches>

beforeEach(() => {
  store = fakeCaches()
  vi.stubGlobal('caches', store.storage)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function artifactCache(): Promise<FakeCache> {
  let c = store.caches.get(ARTIFACT_CACHE)
  if (!c) {
    c = (await (store.storage as { open(n: string): Promise<FakeCache> }).open(ARTIFACT_CACHE))
  }
  return c
}

async function seedEngineSet(): Promise<FakeCache> {
  const c = await artifactCache()
  await c.put('/offline/crawl.js', new Response('glue'))
  await c.put('/offline/crawl.wasm.gz', new Response('wasm'))
  await c.put('/offline/crawl.data.gz', new Response('data'))
  return c
}

describe('fetchVersion', () => {
  it('maps json / 404 / network-down to the three states', async () => {
    stubFetch(VERSION_OK)
    expect(await fetchVersion()).toEqual({ state: 'ok', build: 'abc123' })
    stubFetch({})
    expect(await fetchVersion()).toEqual({ state: 'undeployed' })
    stubFetch({ '/offline/version.json': null })
    expect(await fetchVersion()).toEqual({ state: 'unreachable' })
  })

  it('treats an SPA-fallback html 200 as undeployed', async () => {
    stubFetch({ '/offline/version.json': { body: '<!doctype html>', type: 'text/html' } })
    expect(await fetchVersion()).toEqual({ state: 'undeployed' })
  })

  it('carries the game-version label when the deploy stamps one', async () => {
    stubFetch(VERSION_LABELED)
    expect(await fetchVersion()).toEqual({ state: 'ok', build: 'abc123', version: '0.34.1' })
  })
})

describe('openVersionedCache', () => {
  it('clears the cache when the build changes, keeps it when unknown', async () => {
    const c = await seedEngineSet()
    await openVersionedCache(ARTIFACT_CACHE, { build: 'build-1' })
    await c.put('/offline/crawl.js', new Response('glue'))
    // Unknown build (offline): everything stays.
    await openVersionedCache(ARTIFACT_CACHE, null)
    expect(await c.match('/offline/crawl.js')).toBeTruthy()
    // New build: wholesale clear, new __build stamp.
    await openVersionedCache(ARTIFACT_CACHE, { build: 'build-2' })
    expect(await c.match('/offline/crawl.js')).toBeUndefined()
    expect(await (await c.match('/offline/__build'))?.text()).toBe('build-2')
  })

  it('boot rolls the gamedata store together with the engine store', async () => {
    // Seed both stores under build-1, as after a full readiness download.
    await openVersionedCache(ARTIFACT_CACHE, { build: 'build-1' })
    await openVersionedCache(GAMEDATA_CACHE, { build: 'build-1' })
    const gd = store.caches.get(GAMEDATA_CACHE)
    if (!gd) throw new Error('gamedata cache missing')
    await gd.put('/gamedata/local/main.png', new Response('atlas'))
    // Boot against a new deploy: the engine self-update must not leave the
    // previous build's tiles behind for the SW to serve (index skew).
    await openOfflineStores({ build: 'build-2' })
    expect(await gd.match('/gamedata/local/main.png')).toBeUndefined()
    expect(await (await gd.match('/gamedata/local/__build'))?.text()).toBe('build-2')
    // Offline boot (version unknown): both stores untouched.
    await gd.put('/gamedata/local/main.png', new Response('atlas'))
    await openOfflineStores(null)
    expect(await gd.match('/gamedata/local/main.png')).toBeTruthy()
  })

  it('stamps the game-version label, including onto an unchanged build', async () => {
    const c = await artifactCache()
    await openVersionedCache(ARTIFACT_CACHE, { build: 'build-1' })
    expect(await c.match('/offline/__version')).toBeUndefined()
    // Same build, version.json regenerated with the label added.
    await openVersionedCache(ARTIFACT_CACHE, { build: 'build-1', version: '0.34.1' })
    expect(await (await c.match('/offline/__version'))?.text()).toBe('0.34.1')
    expect(await (await c.match('/offline/__build'))?.text()).toBe('build-1')
  })
})

describe('fetchArtifact', () => {
  it('serves from cache without touching the network', async () => {
    const c = await seedEngineSet()
    stubFetch({})
    const stats = newStats()
    const buf = await fetchArtifact(c as unknown as Cache, stats, '/offline/crawl.js')
    expect(new TextDecoder().decode(buf)).toBe('glue')
    expect(stats).toEqual({ cacheHits: 1, netFetches: 0, netBytes: 0 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('falls through gz→plain alternatives and never caches html bodies', async () => {
    const c = await artifactCache()
    stubFetch({ '/offline/crawl.wasm': { body: 'wasm-plain' } })
    const stats = newStats()
    const buf = await fetchArtifact(
      c as unknown as Cache, stats, '/offline/crawl.wasm.gz', '/offline/crawl.wasm')
    expect(new TextDecoder().decode(buf)).toBe('wasm-plain')
    expect(await c.match('/offline/crawl.wasm')).toBeTruthy()

    stubFetch({ '/offline/missing': { body: '<!doctype html>', type: 'text/html' } })
    await expect(fetchArtifact(c as unknown as Cache, newStats(), '/offline/missing'))
      .rejects.toThrow('HTTP 404')
    expect(await c.match('/offline/missing')).toBeUndefined()
  })
})

describe('markEngineSetComplete', () => {
  it('refuses a partial set and stamps a full one', async () => {
    const c = await artifactCache()
    await c.put('/offline/crawl.js', new Response('glue'))
    expect(await markEngineSetComplete(c as unknown as Cache)).toBe(false)

    await seedEngineSet()
    expect(await markEngineSetComplete(c as unknown as Cache)).toBe(true)
    expect(await c.match('/offline/__complete')).toBeTruthy()
  })

  it('requires the prewarm pack once its manifest is cached', async () => {
    const c = await seedEngineSet()
    await c.put('/offline/prewarm/manifest.json', new Response('{}'))
    expect(await markEngineSetComplete(c as unknown as Cache)).toBe(false)
    await c.put('/offline/prewarm/prewarm.bin.gz', new Response('pack'))
    expect(await markEngineSetComplete(c as unknown as Cache)).toBe(true)
  })
})

describe('probeReadiness', () => {
  it('maps marker/version combinations to the four states', async () => {
    stubFetch(VERSION_OK)
    expect(await probeReadiness()).toEqual({ state: 'not-cached' })

    stubFetch({})
    expect(await probeReadiness()).toEqual({ state: 'undeployed' })

    stubFetch({ '/offline/version.json': null })
    expect(await probeReadiness()).toEqual({ state: 'offline-not-cached' })

    const c = await seedEngineSet()
    await markEngineSetComplete(c as unknown as Cache)
    await c.put('/offline/__build', new Response('abc123'))
    stubFetch(VERSION_OK)
    expect(await probeReadiness()).toEqual({ state: 'ready', tiles: false, update: false, deploy: 'ok' })
  })

  it('is ready offline once marked, and flags a newer deploy as update', async () => {
    const c = await seedEngineSet()
    await markEngineSetComplete(c as unknown as Cache)
    await c.put('/offline/__build', new Response('abc123'))
    stubFetch({ '/offline/version.json': null })
    expect(await probeReadiness()).toEqual({ state: 'ready', tiles: false, update: false, deploy: 'unreachable' })

    stubFetch({ '/offline/version.json': { body: '{"build":"NEWER"}', type: 'application/json' } })
    expect(await probeReadiness()).toEqual({ state: 'ready', tiles: false, update: true, deploy: 'ok' })
  })

  it('labels the downloadable and cached sets with their game versions', async () => {
    stubFetch(VERSION_LABELED)
    expect(await probeReadiness()).toEqual({ state: 'not-cached', version: '0.34.1' })

    // Cached + stamped set, offline: the cached label still names it.
    const c = await seedEngineSet()
    await markEngineSetComplete(c as unknown as Cache)
    await c.put('/offline/__build', new Response('abc123'))
    await c.put('/offline/__version', new Response('0.34.1'))
    stubFetch({ '/offline/version.json': null })
    expect(await probeReadiness()).toEqual(
      { state: 'ready', tiles: false, update: false, deploy: 'unreachable', version: '0.34.1' })

    // A newer labeled deploy names the update target too.
    stubFetch({ '/offline/version.json': { body: '{"build":"NEWER","version":"0.35-a0"}', type: 'application/json' } })
    expect(await probeReadiness()).toEqual(
      { state: 'ready', tiles: false, update: true, deploy: 'ok', version: '0.34.1', updateVersion: '0.35-a0' })
  })
})

describe('cachedGamedataBuild', () => {
  it('returns the build only for a verified-complete pack, offline-safely', async () => {
    stubFetch({ '/offline/version.json': null }) // must never be consulted anyway
    expect(await cachedGamedataBuild()).toBeNull()

    const c = (await (store.storage as { open(n: string): Promise<FakeCache> }).open(GAMEDATA_CACHE))
    await c.put('/gamedata/local/__build', new Response('abc123'))
    expect(await cachedGamedataBuild()).toBeNull() // build stamped but set incomplete

    await c.put('/gamedata/local/__complete', new Response('1'))
    expect(await cachedGamedataBuild()).toBe('abc123')
    expect(vi.mocked(fetch)).not.toHaveBeenCalled() // read-only cache probe
  })
})

describe('downloadOfflineData', () => {
  it('fetches engine + tiles, stamps both markers, reports stats', async () => {
    stubFetch({
      ...VERSION_LABELED,
      '/offline/crawl.js': { body: 'glue' },
      '/offline/crawl.wasm.gz': { body: 'wasm' },
      '/offline/crawl.data.gz': { body: 'data' },
      // no prewarm on this deploy — tolerated
      '/gamedata/local/manifest.json': { body: '{"files":["enums.js","player.png"]}', type: 'application/json' },
      '/gamedata/local/enums.js': { body: 'enums', type: 'text/javascript' },
      '/gamedata/local/player.png': { body: 'png', type: 'image/png' },
    })
    const labels: string[] = []
    const stats = await downloadOfflineData((l) => labels.push(l))
    expect(stats.netFetches).toBe(6)
    expect(stats.netBytes).toBeGreaterThan(0)
    expect(labels[0]).toMatch(/engine/i)
    expect(labels.at(-1)).toMatch(/tiles 2\/2/)

    const engine = store.caches.get(ARTIFACT_CACHE)!
    const tiles = store.caches.get(GAMEDATA_CACHE)!
    expect(await engine.match('/offline/__complete')).toBeTruthy()
    expect(await tiles.match('/gamedata/local/__complete')).toBeTruthy()
    expect(await probeReadiness()).toEqual(
      { state: 'ready', tiles: true, update: false, deploy: 'ok', version: '0.34.1' })
  })

  it('converges to ready on a deploy that ships no tiles at all', async () => {
    // Nothing left to fetch is what both the status row and the play gate
    // ask; leaving the empty set unmarked would strand the gate forever.
    stubFetch({
      ...VERSION_OK,
      '/offline/crawl.js': { body: 'glue' },
      '/offline/crawl.wasm.gz': { body: 'wasm' },
      '/offline/crawl.data.gz': { body: 'data' },
    })
    await downloadOfflineData(() => {})
    expect(await probeReadiness()).toEqual(
      { state: 'ready', tiles: true, update: false, deploy: 'ok' })
  })

  it('does not mark the tiles set complete when the file list is unreachable', async () => {
    // A mid-download network drop must not read as "this deploy ships no
    // tiles": marking the empty set complete would claim the tiles are on
    // device forever, with no button left that could fetch them.
    await openVersionedCache(ARTIFACT_CACHE, { build: 'abc123' })
    await seedEngineSet()
    stubFetch({
      ...VERSION_OK,
      '/gamedata/local/manifest.json': null,
      '/gamedata/local/enums.js': null,
    })
    await expect(downloadOfflineData(() => {})).rejects.toThrow(/unreachable/)
    const tiles = store.caches.get(GAMEDATA_CACHE)!
    expect(await tiles.match('/gamedata/local/__complete')).toBeUndefined()
    expect(await probeReadiness()).toEqual(
      { state: 'ready', tiles: false, update: false, deploy: 'ok' })
  })

  it('refuses to run without a reachable deploy', async () => {
    stubFetch({ '/offline/version.json': null })
    await expect(downloadOfflineData(() => {})).rejects.toThrow('offline')
    stubFetch({})
    await expect(downloadOfflineData(() => {})).rejects.toThrow('no offline engine')
  })
})
