// One source of truth for the offline artifact stores: cache names, paths,
// version handling, cache-first fetch, gunzip, set-complete markers, the
// readiness probe, and the explicit-download prefetch. Shared by
// engine.worker.ts (boot-time fetch path) and the readiness surface
// (offline-lobby download button, login-card subline) so the two can never
// disagree about where bytes live or what "ready" means. Leaf module: no
// DOM, safe in both the worker and the main bundle.
//
// Two Cache API stores, both keyed on /offline/version.json's build id via a
// synthetic __build entry and cleared wholesale when it changes:
// - pz-offline-artifacts (/offline/*): engine glue + wasm + data + prewarm,
//   gzipped at rest, read only by the engine worker.
// - pz-offline-gamedata (/gamedata/local/*): tile atlases + tileinfo modules
//   + enums.js. Populated ONLY by the explicit download below (organic tile
//   use stays plain HTTP); served offline by the service worker's
//   cache-first /gamedata/local/ route (script tags can't read the Cache API
//   themselves).
//
// "Ready" is a probe, never a stored flag (CacheStorage is evictable): a
// __complete marker written only after the full set is verified present in
// the cache — fetchArtifact deliberately swallows quota failures on
// cache.put, so fetch-success alone doesn't mean cached. The probe is then
// one cache lookup, offline-safe.

export const ARTIFACT_CACHE = 'pz-offline-artifacts'
export const GAMEDATA_CACHE = 'pz-offline-gamedata'

// Synthetic entries (leading __ can't collide with real files).
const BUILD_KEYS: Record<string, string> = {
  [ARTIFACT_CACHE]: '/offline/__build',
  [GAMEDATA_CACHE]: '/gamedata/local/__build',
}
// Game-version label of the cached set ("0.34.1"), stamped alongside __build
// so the readiness surface can name what's on the device while offline.
const VERSION_KEYS: Record<string, string> = {
  [ARTIFACT_CACHE]: '/offline/__version',
  [GAMEDATA_CACHE]: '/gamedata/local/__version',
}
const COMPLETE_KEYS: Record<string, string> = {
  [ARTIFACT_CACHE]: '/offline/__complete',
  [GAMEDATA_CACHE]: '/gamedata/local/__complete',
}

// The boot-critical engine set, as fetchArtifact alternative-lists (gzipped
// name first, plain fallback for older installs). Prewarm is optional at
// deploy time but all-or-nothing once its manifest is present.
const ENGINE_GLUE = ['/offline/crawl.js']
const ENGINE_WASM = ['/offline/crawl.wasm.gz', '/offline/crawl.wasm']
const ENGINE_DATA = ['/offline/crawl.data.gz', '/offline/crawl.data']
const PREWARM_MANIFEST = ['/offline/prewarm/manifest.json']
const PREWARM_BIN = ['/offline/prewarm/prewarm.bin.gz', '/offline/prewarm/prewarm.bin']

// Tiles gamedata file set when the install ships no manifest.json (installs
// before 2026-07-14). The manifest, when present, is authoritative — the
// atlas set can change across engine versions.
const GAMEDATA_FALLBACK_FILES = [
  'enums.js',
  'tileinfo-dngn.js',
  ...['feat', 'floor', 'gui', 'icons', 'main', 'player', 'wall']
    .flatMap((tex) => [`${tex}.png`, `tileinfo-${tex}.js`]),
]

export type Log = (text: string) => void

export interface FetchStats {
  cacheHits: number
  netFetches: number
  netBytes: number
}

export const newStats = (): FetchStats => ({ cacheHits: 0, netFetches: 0, netBytes: 0 })

// --- version.json ------------------------------------------------------------

export type VersionInfo =
  // `version` is the game version the pack was built from (CRAWL_VERSION_SHORT,
  // e.g. "0.34.1" or "0.35-a0") — display-only, absent on older installs.
  | { state: 'ok'; build: string; version?: string }
  // Confirmed 200-but-not-json or 404: this deploy ships no artifacts.
  | { state: 'undeployed' }
  // Network failure — offline, or the server is unreachable.
  | { state: 'unreachable' }

export async function fetchVersion(timeoutMs = 4000): Promise<VersionInfo> {
  try {
    const r = await fetch('/offline/version.json', {
      cache: 'no-cache',
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    })
    if (r.ok && (r.headers.get('content-type') ?? '').includes('json')) {
      const json = await r.json() as { build?: unknown; version?: unknown }
      const build = String(json.build ?? '')
      if (build) {
        const version = typeof json.version === 'string' && json.version !== '' ? json.version : undefined
        return version !== undefined ? { state: 'ok', build, version } : { state: 'ok', build }
      }
    }
    return { state: 'undeployed' }
  } catch {
    return { state: 'unreachable' }
  }
}

// --- versioned caches ----------------------------------------------------------

// Open one of the two stores, clearing it wholesale when `v.build` names a
// different engine build than its contents (null = version unknown right
// now — trust whatever the cache holds; an offline boot must not wipe it).
// Callers with a fetchVersion result pass its ok-state through, which also
// stamps the game-version label (__version) for the readiness surface.
export async function openVersionedCache(
  name: string,
  v: { build: string; version?: string } | null,
  log?: Log,
): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null
  try {
    const cache = await caches.open(name)
    if (v !== null) {
      const buildKey = BUILD_KEYS[name]
      const stored = await (await cache.match(buildKey))?.text()
      if (stored !== v.build) {
        for (const req of await cache.keys()) await cache.delete(req)
        await cache.put(buildKey, new Response(v.build))
        if (stored !== undefined)
          log?.(`engine build ${stored} -> ${v.build}: ${name} cleared`)
      }
      // Unconditional: a version.json regenerated with the label added (or
      // fixed) leaves the content-derived build id untouched.
      if (v.version !== undefined)
        await cache.put(VERSION_KEYS[name], new Response(v.version))
    }
    return cache
  } catch (e) {
    // Cache API unavailable/broken — callers fall back to plain network.
    // Logged because this silently downgrades every boot to a re-download.
    log?.(`${name} unavailable: ${String(e)}`)
    return null
  }
}

// Open BOTH stores rolled to the deployed build off one version answer —
// the only way any caller (worker boot, readiness download) acquires the
// pair. The SW serves /gamedata/local/* cache-first, so the tiles store
// must roll in lockstep with the engine or an updated engine renders
// against the previous build's tiles (shifted tile indices — trees in
// hallways). A single fetchVersion keying both stores also can't straddle
// a deploy the way two independent fetches (worker + window) could.
// Gamedata is cleared, not refetched: tile requests fall through to the
// network of the same deploy that declared the build, and the readiness
// surface offers to finish the download.
//
// In practice only the readiness download passes a build: engine updates
// are consented there, and boot passes null to pin itself to the cached
// pair (engine.worker.ts openArtifactCache).
export async function openOfflineStores(
  v: { build: string; version?: string } | null,
  log?: Log,
): Promise<{ engine: Cache | null; gamedata: Cache | null }> {
  const [gamedata, engine] = await Promise.all([
    openVersionedCache(GAMEDATA_CACHE, v, log),
    openVersionedCache(ARTIFACT_CACHE, v, log),
  ])
  return { engine, gamedata }
}

// --- cache-first fetch ---------------------------------------------------------

// Thrown when no alternative could be served. `status` is the last HTTP
// status seen, or 0 for a network failure — the distinction callers need to
// tell "this deploy doesn't ship the file" from "we couldn't ask". An
// SPA-fallback html body reports 404: the file isn't there either way.
export class ArtifactError extends Error {
  constructor(readonly status: number, path: string) {
    super(`artifact ${path}: HTTP ${status || 'unreachable'}`)
    this.name = 'ArtifactError'
  }
}

// A confirmed "this deploy ships no such file", as opposed to any failure to
// find out (network drop mid-download, 5xx). Only the former may be read as
// "nothing left to fetch".
const isAbsent = (e: unknown): boolean => e instanceof ArtifactError && e.status === 404

// Cache-first fetch of one artifact; tries `paths` in order (gzipped name
// first, plain fallback for older installs). Never caches an HTML body — a
// SPA-fallback 200 for a missing file must not become a sticky cache entry.
// A quota failure on cache.put is swallowed (served uncached); the
// __complete markers below re-verify presence, so a swallowed put can't
// masquerade as readiness.
export async function fetchArtifact(
  cache: Cache | null,
  stats: FetchStats,
  ...paths: string[]
): Promise<ArrayBuffer> {
  for (const p of paths) {
    const hit = cache && await cache.match(p)
    if (hit) { stats.cacheHits++; return hit.arrayBuffer() }
  }
  let lastStatus = 0
  for (const p of paths) {
    const res = await fetch(p).catch(() => null)
    if (!res || !res.ok) { lastStatus = res?.status ?? 0; continue }
    if ((res.headers.get('content-type') ?? '').includes('text/html')) { lastStatus = 404; continue }
    if (cache) await cache.put(p, res.clone()).catch(() => { /* quota — serve uncached */ })
    stats.netFetches++
    const buf = await res.arrayBuffer()
    stats.netBytes += buf.byteLength
    return buf
  }
  throw new ArtifactError(lastStatus, paths[0])
}

// Transparent gunzip, keyed on magic bytes rather than filename: handles
// plain files, and a CDN that already content-decoded the body, identically.
export async function gunzipIfNeeded(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const b = new Uint8Array(buf)
  if (b.length < 2 || b[0] !== 0x1f || b[1] !== 0x8b) return buf
  if (typeof DecompressionStream === 'undefined')
    throw new Error('gzipped engine artifact but DecompressionStream is unavailable')
  const ds = new DecompressionStream('gzip')
  return new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer()
}

// --- set-complete markers --------------------------------------------------------

async function anyCached(cache: Cache, alts: string[]): Promise<boolean> {
  for (const p of alts) if (await cache.match(p)) return true
  return false
}

// Are the three boot-critical artifacts in the cache? Boot asks this before
// falling through to the network, where the deploy serves only its current
// build (engine.worker.ts openArtifactCache). Prewarm is not part of the
// question: it's optional at deploy time and re-seeds itself.
export async function bootArtifactsCached(cache: Cache | null): Promise<boolean> {
  if (!cache) return false
  for (const alts of [ENGINE_GLUE, ENGINE_WASM, ENGINE_DATA]) {
    if (!await anyCached(cache, alts)) return false
  }
  return true
}

// The build id stamped on the cached engine set (undefined = never stamped,
// i.e. nothing has been downloaded into this store yet).
export async function cachedEngineBuild(cache: Cache | null): Promise<string | undefined> {
  if (!cache) return undefined
  return (await cache.match(BUILD_KEYS[ARTIFACT_CACHE]))?.text()
}

// Verify the boot-critical engine set is actually IN the cache, then write
// the marker. Called after any flow that attempted the full set (worker
// boot, explicit download); returns false when something is missing (quota
// dropped a put) so callers can surface it.
export async function markEngineSetComplete(cache: Cache | null): Promise<boolean> {
  if (!cache) return false
  if (!await bootArtifactsCached(cache)) return false
  // Prewarm is optional at deploy time, but a cached manifest with no pack
  // is a partial set — require the pair together.
  if (await anyCached(cache, PREWARM_MANIFEST) && !await anyCached(cache, PREWARM_BIN)) return false
  await cache.put(COMPLETE_KEYS[ARTIFACT_CACHE], new Response('1')).catch(() => { /* quota */ })
  return true
}

async function markGamedataComplete(cache: Cache, files: string[]): Promise<boolean> {
  for (const f of files) {
    if (!await cache.match(`/gamedata/local/${f}`)) return false
  }
  await cache.put(COMPLETE_KEYS[GAMEDATA_CACHE], new Response('1')).catch(() => { /* quota */ })
  return true
}

// Marker present / absent / no cache storage at all. The third answer is a
// real condition, not a variant of "absent": CacheStorage is a
// secure-context-only API, so a phone pointed at a plain-http dev origin has
// no `caches` whatsoever, and a browser can refuse to open one besides
// (private windows). Absent is fixed by downloading; unavailable can't be
// fixed by any button, and collapsing them offers a download that is
// guaranteed to throw.
async function markerState(name: string): Promise<boolean | undefined> {
  if (typeof caches === 'undefined') return undefined
  try {
    return !!await (await caches.open(name)).match(COMPLETE_KEYS[name])
  } catch {
    return undefined
  }
}

async function hasMarker(name: string): Promise<boolean> {
  return await markerState(name) === true
}

// The tiles pack for consumers outside the engine path (the doll shelf's
// atlas-dedup seeding): the build id of a verified-complete
// /gamedata/local/ set, or null when absent/incomplete. Read-only cache
// probes — offline-safe, never mutates, never touches the network. The
// build id matters because the pack's URLs are stable across engine
// updates while the content changes, so anything derived from pack
// content (e.g. its tileinfo fingerprint) must be keyed by build.
export async function cachedGamedataBuild(): Promise<string | null> {
  if (typeof caches === 'undefined') return null
  try {
    const cache = await caches.open(GAMEDATA_CACHE)
    if (!await cache.match(COMPLETE_KEYS[GAMEDATA_CACHE])) return null
    const build = await (await cache.match(BUILD_KEYS[GAMEDATA_CACHE]))?.text()
    return build || null
  } catch {
    return null
  }
}

// --- readiness probe -------------------------------------------------------------

export type Readiness =
  // Engine set verified cached; tiles = gamedata set too; update = we are
  // online and the deploy has a newer build (the cached set still boots
  // offline by design). deploy = the fetchVersion answer, so consumers can
  // gate offered actions (a download can only succeed when 'ok') and word
  // the reason honestly ('unreachable' = connect and retry; 'undeployed' =
  // this deploy has nothing to download, ever). version labels the CACHED
  // set ("0.34.1", from the __version stamp); updateVersion labels what an
  // update would install — both display-only and absent when the install
  // predates the stamp.
  | { state: 'ready'; tiles: boolean; update: boolean; deploy: 'ok' | 'undeployed' | 'unreachable'; version?: string; updateVersion?: string }
  // Online, deploy confirmed, nothing (complete) cached — downloadable.
  // version labels the downloadable pack when the deploy declares it.
  | { state: 'not-cached'; version?: string }
  // This deploy ships no artifacts — hide the offline surfaces.
  | { state: 'undeployed' }
  // No network and no cached set: can't play, can't download right now.
  | { state: 'offline-not-cached' }
  // This browser has no cache storage to keep artifacts in (markerState).
  // Not a download away from ready — no download can succeed — but not a
  // dead end either: the engine boots straight off the network, since
  // fetchArtifact falls back to plain fetch on a null cache. So: playable
  // while connected, never playable offline — a wording that stays true
  // when the deploy is momentarily unreachable, which is why that case
  // lands here too. Unlabelled by the game version the others carry —
  // nothing is being installed to name.
  | { state: 'no-store' }

// Can this device play right now, cache alone? Both offline surfaces ask it
// — the lobby to gate a launch, the login card to word its subline — and
// they must never disagree, which is this module's whole job. The engine
// without its tiles is not playable: a missing pack misrenders the map.
// Note 'no-store' is deliberately false here: such a device can start a game
// (the lobby's gate says so) but only over the network, and a home-screen
// card promising offline play would be lying about the one case that matters.
export const canPlayOffline = (r: Readiness): boolean => r.state === 'ready' && r.tiles

// Neither surface renders that answer as a verdict ("Ready to play offline"
// / "Not ready…"). Both state what is on the device and what it costs — the
// payload has a name and a size, and a capability follows from those — so
// the wording lives in the views, next to the state each one shows.

export async function probeReadiness(): Promise<Readiness> {
  // Read-only on purpose: rendering a screen must never clear a cache
  // (openVersionedCache mutates on build change; only boot/download do that).
  const [engineMarker, tilesReady, version] = await Promise.all([
    markerState(ARTIFACT_CACHE),
    hasMarker(GAMEDATA_CACHE),
    fetchVersion(),
  ])
  // No cache storage: nothing is cached and nothing can be, so the cached-set
  // questions below are all moot. Only an undeployed answer still matters —
  // that dead end is the same with or without storage. Unreachable folds into
  // no-store instead: its sub-line ("games need the network") is the one
  // instruction this device can follow, and its open gate fails a launch tap
  // with an honest network error — where offline-not-cached would advise
  // "Connect once to download" (unsatisfiable here: connecting lands back on
  // no-store, which has no button) behind a closed gate whose tap runs the
  // download and throws on the missing cache.
  if (engineMarker === undefined) {
    if (version.state === 'undeployed') return { state: 'undeployed' }
    return { state: 'no-store' }
  }
  if (engineMarker) {
    const r: Readiness = {
      state: 'ready', tiles: tilesReady, update: false, deploy: version.state,
    }
    try {
      const cache = await caches.open(ARTIFACT_CACHE)
      const storedVersion = await (await cache.match(VERSION_KEYS[ARTIFACT_CACHE]))?.text()
      if (storedVersion) r.version = storedVersion
      if (version.state === 'ok') {
        const stored = await cachedEngineBuild(cache)
        r.update = stored !== undefined && stored !== version.build
        if (r.update && version.version !== undefined) r.updateVersion = version.version
      }
    } catch { /* unreadable — no update hint / no label */ }
    return r
  }
  if (version.state === 'ok') {
    return version.version !== undefined
      ? { state: 'not-cached', version: version.version }
      : { state: 'not-cached' }
  }
  if (version.state === 'undeployed') return { state: 'undeployed' }
  return { state: 'offline-not-cached' }
}

// --- explicit download -----------------------------------------------------------

// The readiness button: run the worker's exact fetch path (same caches, same
// alternative-lists, same html guard) without booting the engine, plus the
// tiles gamedata the worker never touches. Cache-first throughout, so a
// re-run after a partial failure only fetches what's missing, and an
// "update" run (openVersionedCache clears on the new build) refetches
// everything.
export async function downloadOfflineData(
  onProgress: (label: string) => void,
): Promise<FetchStats> {
  const version = await fetchVersion()
  if (version.state === 'undeployed') throw new Error('no offline engine on this deploy')
  if (version.state === 'unreachable') throw new Error('offline — connect to download')
  const stats = newStats()

  onProgress('Downloading engine…')
  const { engine: cache, gamedata } = await openOfflineStores(version)
  if (!cache) throw new Error('cache storage unavailable')
  await Promise.all([
    fetchArtifact(cache, stats, ...ENGINE_GLUE),
    fetchArtifact(cache, stats, ...ENGINE_WASM),
    fetchArtifact(cache, stats, ...ENGINE_DATA),
  ])
  onProgress('Downloading first-run data…')
  try {
    await fetchArtifact(cache, stats, ...PREWARM_MANIFEST)
    await fetchArtifact(cache, stats, ...PREWARM_BIN)
  } catch { /* prewarm not deployed — engine builds its caches on first boot */ }
  if (!await markEngineSetComplete(cache))
    throw new Error('engine data did not fit in storage')

  if (gamedata) {
    // A deploy with no /gamedata/local at all (null, and only then) marks
    // the empty set complete: "nothing left to fetch" is the question both
    // the status row and the play gate ask, and leaving it unmarked would
    // strand a gated lobby on "Download incomplete" with no download that
    // could ever finish it. A failed lookup throws instead — marking an
    // empty set complete because the network dropped would claim the tiles
    // are on device forever, with no button left to fetch them.
    const files = await gamedataFileList(gamedata, stats) ?? []
    for (const [i, f] of files.entries()) {
      onProgress(`Downloading tiles ${i + 1}/${files.length}…`)
      await fetchArtifact(gamedata, stats, `/gamedata/local/${f}`)
    }
    if (!await markGamedataComplete(gamedata, files))
      throw new Error('tile data did not fit in storage')
  }
  return stats
}

// The gamedata file list: manifest.json when the install ships one (also
// cached, so offline re-verification keeps working), the fixed pre-manifest
// set otherwise. Returns null ONLY for a deploy that confirmably ships no
// gamedata; any failure to find out propagates, because the caller reads
// null as "nothing left to fetch" and marks the empty set complete.
async function gamedataFileList(cache: Cache, stats: FetchStats): Promise<string[] | null> {
  try {
    const raw = await fetchArtifact(cache, stats, '/gamedata/local/manifest.json')
    const files = (JSON.parse(new TextDecoder().decode(raw)) as { files?: unknown }).files
    if (Array.isArray(files) && files.every((f) => typeof f === 'string') && files.length > 0)
      return files
  } catch (e) {
    // An absent or malformed manifest still falls through to the probe below
    // (older installs ship none); an unreachable one does not.
    if (e instanceof ArtifactError && !isAbsent(e)) throw e
  }
  // Distinguish "no manifest but files exist" from "no gamedata deployed":
  // probe the one file every install ships.
  try {
    await fetchArtifact(cache, stats, `/gamedata/local/${GAMEDATA_FALLBACK_FILES[0]}`)
    return GAMEDATA_FALLBACK_FILES
  } catch (e) {
    if (!isAbsent(e)) throw e
    return null
  }
}
