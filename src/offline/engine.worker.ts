// Dedicated Worker hosting the Emscripten DCSS engine. Thin by design: all
// protocol logic lives in mini-server.ts on the main thread; this shell only
// moves strings across the thread boundary and loads the engine artifact.
//
// The artifact is deploy-time content at /offline/crawl.js (+ .wasm/.data,
// Phase A build outputs; gitignored like the SEO mirrors) — never bundled,
// hence the @vite-ignore dynamic import. This file is ALSO the contract spec
// the Phase A build must satisfy:
//
//   export default function createCrawl(overrides): Promise<Module>
//     — standard Emscripten MODULARIZE factory, built with -sEXPORT_ES6
//       -sENVIRONMENT=worker. The engine's IDBFS mount + syncfs wiring is
//       the glue's own preRun concern, not ours.
//   overrides.pocketzotOnOutput(chunk)
//     — called with each engine→server socket flush: newline-terminated JSON
//       lines, `*`-prefixed for server-directed control lines.
//   overrides.onExit(code)
//     — Emscripten exit hook (build with the runtime allowed to exit).
//   Module.pocketzot.pushControl(json) / Module.pocketzot.pushKeys(text)
//     — enqueue a control datagram / pty bytes into the shimmed pselect
//       queue. One pushKeys call = one pty write (input atomicity).

import type { WorkerInMsg, WorkerOutMsg } from './engine-port'

interface CrawlModule {
  pocketzot: {
    queue: string[]
    wake: unknown
    pushControl(json: string): void
    pushKeys(text: string): void
    // Heap gauge (absent in engine builds before 2026-07-14).
    heapBytes?(): number
  }
}

interface CrawlFS {
  readFile(path: string): Uint8Array
  writeFile(path: string, data: Uint8Array | string): void
  mkdir(path: string): void
  syncfs(populate: boolean, cb: (err: unknown) => void): void
}

interface CrawlOverrides {
  arguments?: string[]
  locateFile?: (path: string) => string
  pocketzotOnOutput?: (chunk: string) => void
  onExit?: (code: number) => void
  print?: (text: string) => void
  printErr?: (text: string) => void
  pocketzotSeedCaches?: (fs: CrawlFS) => Promise<void>
  // Pre-fetched engine bytes: with these provided the Emscripten glue does
  // no artifact fetches of its own, which is what routes everything through
  // the worker's cache+gunzip path below.
  wasmBinary?: Uint8Array
  getPreloadedPackage?: (name: string, size: number) => ArrayBuffer
}

type CrawlFactory = (overrides: CrawlOverrides) => Promise<CrawlModule>

const post = (m: WorkerOutMsg): void => {
  (self as { postMessage(m: unknown): void }).postMessage(m)
}

// Every exit path funnels through postExit so a crash can't double-report
// after a normal exit (or vice versa) — the mini-server synthesizes exactly
// one game_ended from the first exit it sees.
let exitPosted = false
function postExit(code: number): void {
  if (exitPosted) return
  exitPosted = true
  post({ type: 'exit', code })
}

// A wasm trap (or any uncaught error) after startup kills the engine but not
// the worker — without an exit the client would sit on a frozen map forever:
// the boot watchdog is disarmed once game content flows, LocalConnection
// never fires onClose, and no exit_reason is coming. Synthesize the crash
// exit the same way the artifact-failure path does; the mini-server turns it
// into game_ended{reason:'crash'}, which keeps the slot record (the save's
// last persist checkpoint resumes). The engine keeps its own crash handling
// for game-level errors; this net is for runtime-level deaths (Asyncify
// stack overflow, OOM, unreachable).
function crashed(text: string): void {
  post({ type: 'log', text })
  if (exitPosted) return
  post({
    type: 'lines',
    chunk: `*${JSON.stringify({ msg: 'exit_reason', type: 'crash', message: 'The offline engine crashed. Your last save checkpoint is intact — resume to pick up from it.' })}\n`,
  })
  postExit(1)
}
self.addEventListener('error', (e: ErrorEvent) => {
  crashed(`worker error: ${e.message} @ ${e.filename}:${e.lineno}`)
})
self.addEventListener('unhandledrejection', (e) => {
  const reason = (e as PromiseRejectionEvent).reason as unknown
  crashed(`worker unhandled rejection: ${String(reason)}`)
})

let module_: CrawlModule | null = null
// Inputs arriving while the wasm module is still instantiating.
const pending: WorkerInMsg[] = []

// Heap gauge: wasm memory only ever grows (ALLOW_MEMORY_GROWTH under a
// 512 MB MAXIMUM_MEMORY ceiling), so growth events are rare — a handful per
// session. Sampled once at module-ready and per output flush; each new high
// posts a `heap` message so on-device sessions passively collect the curve.
let lastHeapBytes = 0

function sampleHeap(): void {
  const bytes = module_?.pocketzot.heapBytes?.() ?? 0
  if (bytes > lastHeapBytes) {
    lastHeapBytes = bytes
    post({ type: 'heap', bytes })
  }
}

// ?perf=1 latency probe: stamp when an input reaches the worker, report the
// duration to the batched output flush it produces — the full engine turn
// (Asyncify wake + processing + emission), no postMessage transit.
// Overwritten by a newer input if the previous one produced no output
// (swallowed key, prompt half-entered).
let perfOn = false
let tInput: number | null = null

function feed(m: WorkerInMsg): void {
  if (perfOn
      && (m.type === 'keys' || (m.type === 'control' && m.json.startsWith('{"msg":"key"'))))
    tInput = performance.now()
  if (m.type === 'debug') {
    const pz = module_?.pocketzot
    post({
      type: 'log',
      text: pz
        ? `debug: queue=${pz.queue.length} [${pz.queue.slice(0, 3).map(s => s.slice(0, 40)).join(' | ')}] wakePending=${pz.wake != null} heap=${((pz.heapBytes?.() ?? 0) / 1048576).toFixed(1)} MB`
        : `debug: module not ready, ${pending.length} pending`,
    })
    return
  }
  if (m.type === 'nudge') {
    nudge()
    return
  }
  if (!module_) {
    pending.push(m)
    return
  }
  if (m.type === 'control') module_.pocketzot.pushControl(m.json)
  else if (m.type === 'keys') module_.pocketzot.pushKeys(m.text)
}

// Boot-watchdog rescue: the engine went quiet before emitting any game
// content (map/msgs/ui-push). Pick the recovery by suspension state:
// - busy (no wake pending): a long self-resuming operation (observed: a
//   multi-second silent stretch during save load). Pushing anything now
//   would be consumed MID-startup — the trigger for the glyphless-map
//   corruption — so do nothing and let the watchdog re-check later.
// - suspended with our handshake still queued: a lost wake (the Asyncify
//   race the shim header warns about). Push spectator_joined: the push
//   fires the wake and, once startup finishes, forces an idempotent full
//   resend.
// - suspended with an EMPTY queue: everything was consumed and the engine
//   awaits a KEY pre-game — an invisible startup prompt (observed on
//   crash-recovery resume: an any-key more() that only ever existed on the
//   fake-curses screen). Answer with a space (safe or neutral at every
//   pre-game prompt: more() accepts it, menus page, yesno re-asks), then
//   spectator_joined so whatever state follows is fully resent.
function nudge(): void {
  const pz = module_?.pocketzot
  if (!pz) {
    post({ type: 'log', text: 'nudge: module not ready — skipped' })
    return
  }
  if (pz.wake == null) {
    post({ type: 'log', text: 'nudge: engine busy (no wake pending) — skipped' })
    return
  }
  if (pz.queue.length > 0) {
    post({ type: 'log', text: 'nudge: lost wake — re-firing via spectator_joined' })
    pz.pushControl(JSON.stringify({ msg: 'spectator_joined' }))
    return
  }
  post({ type: 'log', text: 'nudge: engine awaiting a key pre-game — answering prompt' })
  pz.pushKeys(' ')
  pz.pushControl(JSON.stringify({ msg: 'spectator_joined' }))
}

// ---- Artifact delivery: Cache API + gzip -----------------------------------
// The engine artifacts are immutable per build (~46 MB raw; install.sh ships
// the big three gzipped, ~13 MB total). They're fetched through a Cache API
// store — plain caches.open() from this dedicated worker; the app-shell
// service worker passes /offline/* through untouched — and kept compressed
// at rest, gunzipped per boot via DecompressionStream (native zlib speed;
// well under wasm-instantiation time). /offline/version.json names the
// current build: on change the cache is cleared and refetched; when it's
// unreachable (no network) the existing cache boots the engine anyway. The
// mechanics live in artifact-store.ts, shared with the readiness surface
// (offline-lobby download button) so boot and prefetch can never disagree
// about paths or version handling.

import {
  fetchArtifact, fetchVersion, gunzipIfNeeded,
  markEngineSetComplete, newStats, openOfflineStores,
} from './artifact-store'

const workerLog = (text: string): void => post({ type: 'log', text })

async function openArtifactCache(): Promise<Cache | null> {
  const version = await fetchVersion()
  const { engine } = await openOfflineStores(
    version.state === 'ok' ? version : null,
    workerLog,
  )
  return engine
}

// Boot diagnostics: where the artifact bytes actually came from. netBytes
// counts wire bytes (compressed sizes), for the "Downloaded N MB" boot line.
const stats = newStats()

// First-boot cache seeding, run by the engine glue after IDBFS hydration and
// before main() (pre.js's pocketzotSeedCaches hook). The engine build ships
// its derived caches (description DBs + des cache, baked by the engine
// itself under node — wasm/bake-caches.mjs) as /offline/prewarm/*; copying
// them in beats the in-engine build (~13 s desktop, worse on phones) that a
// fresh device would otherwise pay on first launch. The stamp file keys the
// seed to the engine build: after an engine update we overwrite rather than
// leave the engine to detect the stale caches and rebuild in-browser.
// Any failure is non-fatal (pre.js catches): boot continues, engine rebuilds.
const PREWARM_STAMP_PATH = '/crawl/.pocketzot-prewarm'

async function seedCaches(fs: CrawlFS, cache: Cache | null): Promise<void> {
  let manifest: { stamp: string | number, files: { path: string, offset: number, size: number }[] }
  try {
    const raw = await fetchArtifact(cache, stats, '/offline/prewarm/manifest.json')
    manifest = JSON.parse(new TextDecoder().decode(raw)) as typeof manifest
  } catch {
    return // no prewarm shipped — the engine builds its caches itself
  }
  const stamp = String(manifest.stamp)
  let existing: string | null = null
  try {
    existing = new TextDecoder().decode(fs.readFile(PREWARM_STAMP_PATH)).trim()
  } catch { /* first boot — no stamp yet */ }
  if (existing === stamp) return

  post({ type: 'progress', text: 'Preparing first-run data...' })
  // One pack fetch for all ~575 cache files; nothing is written until the
  // whole pack is here, so a failed fetch can't leave a half-seeded set.
  const pack = new Uint8Array(await gunzipIfNeeded(await fetchArtifact(
    cache, stats, '/offline/prewarm/prewarm.bin.gz', '/offline/prewarm/prewarm.bin')))

  for (const f of manifest.files) {
    const path = `/crawl/${f.path}`
    let dir = ''
    for (const part of path.split('/').slice(1, -1)) {
      dir += `/${part}`
      try { fs.mkdir(dir) } catch { /* exists */ }
    }
    fs.writeFile(path, pack.subarray(f.offset, f.offset + f.size))
  }
  fs.writeFile(PREWARM_STAMP_PATH, stamp)
  await new Promise<void>((resolve) => fs.syncfs(false, () => resolve()))
  post({ type: 'log', text: `seeded ${manifest.files.length} prewarmed cache files (stamp ${stamp})` })
}

async function start(name: string): Promise<void> {
  // Boot-phase progress: the mini-server turns these into message-log lines,
  // covering the pre-first-output window (download, wasm instantiation, cache
  // seeding) that would otherwise be a silent black screen. This first line
  // is the only signal during a first boot's ~13 MB artifact download.
  post({ type: 'progress', text: 'Loading the offline engine...' })
  const cache = await openArtifactCache()
  let factory: CrawlFactory
  let wasmBinary: Uint8Array
  let dataBuffer: ArrayBuffer
  let glueSetsCrawlDir = false
  try {
    // All three artifacts go through the cache+gunzip path; wasm and data
    // are handed to the glue as bytes (wasmBinary / getPreloadedPackage), so
    // the glue performs no fetches of its own. The glue itself is fetched +
    // blob-URL imported rather than imported by path: the Vite dev server
    // refuses to module-serve files under public/ ("can only be referenced
    // via HTML tags"), and a blob module bypasses its middleware entirely
    // while behaving identically in production.
    const [glueBuf, wasmBuf, dataBuf] = await Promise.all([
      fetchArtifact(cache, stats, '/offline/crawl.js'),
      fetchArtifact(cache, stats, '/offline/crawl.wasm.gz', '/offline/crawl.wasm').then(gunzipIfNeeded),
      fetchArtifact(cache, stats, '/offline/crawl.data.gz', '/offline/crawl.data').then(gunzipIfNeeded),
    ])
    wasmBinary = new Uint8Array(wasmBuf)
    dataBuffer = dataBuf
    post({ type: 'log', text: `artifacts loaded: ${stats.cacheHits} from cache, ${stats.netFetches} from network` })
    // Only worth a user-facing line when bytes actually crossed the network
    // (first boot / build update); the cached path lands here in ~100 ms.
    if (stats.netFetches > 0) {
      post({
        type: 'progress',
        text: `Downloaded ${(stats.netBytes / 1048576).toFixed(1)} MB of engine data (cached for next time).`,
      })
    }
    // Version-skew guard: the cached artifact set can be older than this
    // client (openArtifactCache serves the cache whenever version.json is
    // unreachable or missing — e.g. an artifact-less deploy, or offline once
    // the shell itself is SW-cached). Engine builds before 2026-07-14 don't
    // set ENV.CRAWL_DIR in pre.js; booting one dir-less would silently write
    // saves to MEMFS, where they vanish on reload. Sniff the glue for the
    // marker (a property name, so it survives minification) and fall back to
    // the legacy -dir flag when absent.
    glueSetsCrawlDir = new TextDecoder().decode(glueBuf).includes('CRAWL_DIR')
    const blob = new Blob([glueBuf], { type: 'text/javascript' })
    const url = URL.createObjectURL(blob)
    try {
      const mod = await import(/* @vite-ignore */ url) as { default: CrawlFactory }
      factory = mod.default
    } finally {
      URL.revokeObjectURL(url)
    }
  } catch (e) {
    // No artifact deployed (expected on a checkout without an engine
    // install). Surface through the normal exit path: mini-server turns the
    // starred exit_reason + nonzero exit into game_ended{reason:'error'}.
    post({
      type: 'lines',
      chunk: `*${JSON.stringify({ msg: 'exit_reason', type: 'error', message: `Offline engine not installed or unreachable (${String(e)}).` })}\n`,
    })
    postExit(1)
    return
  }

  // Turn batching, porting the webtiles server's semantics: the engine emits
  // one line per finish_message while it computes a turn (measured: 6 lines
  // over ~16 ms per trivial move), and signals end-of-turn with a starred
  // *flush_messages — upstream's server buffers per client and flushes on
  // that signal, which is why online clients get one batched frame per turn.
  // Buffer here and post ONE chunk per flush: one main-thread task, one
  // coalesced render, instead of a task+render per line. The signal check
  // runs synchronously inside the wasm's output callback, so it works while
  // the engine is still executing; the microtask fallback covers suspension
  // paths that emit without signalling (microtasks only run once Asyncify
  // unwinds the stack, i.e. exactly when the engine has gone quiet).
  const outBuf: string[] = []
  const flushOut = (): void => {
    if (outBuf.length === 0) return
    if (tInput !== null) {
      post({ type: 'perf', engineMs: performance.now() - tInput })
      tInput = null
    }
    const chunk = outBuf.join('')
    outBuf.length = 0
    post({ type: 'lines', chunk })
    sampleHeap()
  }

  try {
    module_ = await factory({
      // pre.js supplies a similar argv when the host doesn't; the override
      // exists to set the character name, which is also the save slot —
      // crawl resumes saves/<munged name>.cs when present, else starts a
      // new game under that name.
      // -await-connection (upstream passes it too, process_handler.py) blocks
      // startup until the mini-server's attach lands, so options whose
      // defaults sample is_controlled_from_web() (prompt_menu,
      // reduce_animations, …) read true on EVERY read_init_file — without it
      // a resumed save reads options before ever polling the control queue
      // and yesno() falls back to log-line prompts. No boot deadlock: the
      // factory promise resolves before callMain, so once main suspends in
      // _await_connection the pending queue below drains and wakes it. Do NOT
      // add the flag to pre.js's default argv — the engine repo's
      // bake-caches.mjs run has no host to send attach and would hang.
      // No -dir on current builds: pre.js sets ENV.CRAWL_DIR instead — the
      // -dir flag was processed in both of main()'s parse_args passes plus
      // validate_basedirs, printing "Setting crawl_dir..." 3x into the boot
      // log; the env path assigns silently. Older cached builds still get
      // -dir (glueSetsCrawlDir sniff above).
      arguments: [
        '-headless', '-webtiles-socket', 'pocketzot',
        ...(glueSetsCrawlDir ? [] : ['-dir', '/crawl']),
        '-name', name, '-await-connection',
      ],
      locateFile: (path) => `/offline/${path}`,
      pocketzotOnOutput: (chunk) => {
        if (outBuf.length === 0) queueMicrotask(flushOut)
        outBuf.push(chunk)
        if (chunk.startsWith('*{"msg":"flush_messages"')) flushOut()
      },
      onExit: (code) => { flushOut(); postExit(code) },
      print: (text) => post({ type: 'log', text }),
      printErr: (text) => post({ type: 'log', text }),
      pocketzotSeedCaches: (fs) => seedCaches(fs, cache),
      wasmBinary,
      getPreloadedPackage: (_name, size) => {
        if (size !== dataBuffer.byteLength)
          post({ type: 'log', text: `crawl.data size mismatch: glue expects ${size}, have ${dataBuffer.byteLength}` })
        return dataBuffer
      },
    })
  } catch (e) {
    post({
      type: 'lines',
      chunk: `*${JSON.stringify({ msg: 'exit_reason', type: 'error', message: `Offline engine failed to start: ${String(e)}` })}\n`,
    })
    postExit(1)
    return
  }
  sampleHeap()
  // Everything the engine needs was fetched (factory resolved; prewarm went
  // through seedCaches) — verify it actually landed in the cache and stamp
  // the readiness marker, so an organic online boot counts as "downloaded"
  // on the readiness surface. Verification matters: fetchArtifact swallows
  // quota failures on cache.put, so fetch-success alone proves nothing.
  void markEngineSetComplete(cache).then((complete) => {
    if (!complete) workerLog('artifact set incomplete after boot (storage quota?) — not marked offline-ready')
  })
  for (const m of pending.splice(0)) feed(m)
}

self.onmessage = (e: MessageEvent<WorkerInMsg>) => {
  const m = e.data
  if (m.type === 'start') {
    perfOn = m.perf === true
    void start(m.name)
  } else feed(m)
}
