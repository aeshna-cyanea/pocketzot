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
  }
}

interface CrawlFS {
  readFile(path: string): Uint8Array
  writeFile(path: string, data: Uint8Array | string): void
  mkdir(path: string): void
  syncfs(populate: boolean, cb: (err: unknown) => void): void
}

interface CrawlOverrides {
  locateFile?: (path: string) => string
  pocketzotOnOutput?: (chunk: string) => void
  onExit?: (code: number) => void
  print?: (text: string) => void
  printErr?: (text: string) => void
  pocketzotSeedCaches?: (fs: CrawlFS) => Promise<void>
}

type CrawlFactory = (overrides: CrawlOverrides) => Promise<CrawlModule>

const post = (m: WorkerOutMsg): void => {
  (self as { postMessage(m: unknown): void }).postMessage(m)
}

// A wasm trap (or any uncaught error) after startup would otherwise kill the
// worker in total silence — surface it. The engine keeps its own crash
// handling for game-level errors; this net is for runtime-level deaths
// (Asyncify stack overflow, OOM, unreachable).
self.addEventListener('error', (e: ErrorEvent) => {
  post({ type: 'log', text: `worker error: ${e.message} @ ${e.filename}:${e.lineno}` })
})
self.addEventListener('unhandledrejection', (e) => {
  const reason = (e as PromiseRejectionEvent).reason as unknown
  post({ type: 'log', text: `worker unhandled rejection: ${String(reason)}` })
})

let module_: CrawlModule | null = null
// Inputs arriving while the wasm module is still instantiating.
const pending: WorkerInMsg[] = []

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
        ? `debug: queue=${pz.queue.length} [${pz.queue.slice(0, 3).map(s => s.slice(0, 40)).join(' | ')}] wakePending=${pz.wake != null}`
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

async function seedCaches(fs: CrawlFS): Promise<void> {
  const res = await fetch('/offline/prewarm/manifest.json')
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return
  const manifest = await res.json() as {
    stamp: string | number
    files: { path: string, offset: number, size: number }[]
  }
  const stamp = String(manifest.stamp)
  let existing: string | null = null
  try {
    existing = new TextDecoder().decode(fs.readFile(PREWARM_STAMP_PATH)).trim()
  } catch { /* first boot — no stamp yet */ }
  if (existing === stamp) return

  // One pack fetch for all ~575 cache files; nothing is written until the
  // whole pack is here, so a failed fetch can't leave a half-seeded set.
  const packRes = await fetch('/offline/prewarm/prewarm.bin')
  if (!packRes.ok) throw new Error(`prewarm.bin: HTTP ${packRes.status}`)
  const pack = new Uint8Array(await packRes.arrayBuffer())

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

async function start(): Promise<void> {
  let factory: CrawlFactory
  try {
    // Fetch + blob-URL import instead of importing the path directly: the
    // Vite dev server refuses to module-serve files under public/ ("can only
    // be referenced via HTML tags"), and a blob module bypasses its
    // middleware entirely while behaving identically in production. All
    // sibling fetches (crawl.wasm, crawl.data) go through our locateFile, so
    // nothing resolves relative to the blob URL.
    const res = await fetch('/offline/crawl.js')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = new Blob([await res.text()], { type: 'text/javascript' })
    const url = URL.createObjectURL(blob)
    try {
      const mod = await import(/* @vite-ignore */ url) as { default: CrawlFactory }
      factory = mod.default
    } finally {
      URL.revokeObjectURL(url)
    }
  } catch {
    // No artifact deployed (expected until the Phase A build lands). Surface
    // through the normal exit path: mini-server turns the starred
    // exit_reason + nonzero exit into game_ended{reason:'error'}.
    post({
      type: 'lines',
      chunk: '*{"msg":"exit_reason","type":"error","message":"Offline engine not installed (missing /offline/crawl.js)."}\n',
    })
    post({ type: 'exit', code: 1 })
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
  }

  try {
    module_ = await factory({
      locateFile: (path) => `/offline/${path}`,
      pocketzotOnOutput: (chunk) => {
        if (outBuf.length === 0) queueMicrotask(flushOut)
        outBuf.push(chunk)
        if (chunk.startsWith('*{"msg":"flush_messages"')) flushOut()
      },
      onExit: (code) => { flushOut(); post({ type: 'exit', code }) },
      print: (text) => post({ type: 'log', text }),
      printErr: (text) => post({ type: 'log', text }),
      pocketzotSeedCaches: seedCaches,
    })
  } catch (e) {
    post({
      type: 'lines',
      chunk: `*${JSON.stringify({ msg: 'exit_reason', type: 'error', message: `Offline engine failed to start: ${String(e)}` })}\n`,
    })
    post({ type: 'exit', code: 1 })
    return
  }
  for (const m of pending.splice(0)) feed(m)
}

self.onmessage = (e: MessageEvent<WorkerInMsg>) => {
  const m = e.data
  if (m.type === 'start') {
    perfOn = m.perf === true
    void start()
  } else feed(m)
}
