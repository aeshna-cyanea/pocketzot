// Assembles the offline stack: LocalConnection ↔ mini-server ↔ EnginePort.
// DEV-only entry (dynamic-imported from app.ts behind ?offline=1, so none of
// this reaches production bundles while the spike is engine-less).
//
// Engine selection: ?engine=fake replays a golden fixture (see
// fake-engine.ts; ?fixture=<name> picks one); anything else loads the real
// WASM engine worker, which needs the Phase A artifacts under
// public/offline/.

import { FakeEnginePort } from './fake-engine'
import { WorkerEnginePort } from './engine-port'
import { LocalConnection } from './local-connection'
import { createMiniServer } from './mini-server'
import { trackOfflineMsg } from './offline-state'
import { packSave, readOfflineFiles, unpackSave, writeOfflineFiles } from './save-transfer'

export interface OfflineBoot {
  conn: LocalConnection
  // Kicks the engine. Call after the game view is mounted (mounting replaces
  // conn.onMessage; anything delivered earlier would be lost).
  start(): void
  dispose(): void
}

// Whether an engine (real or fake) currently owns the IDBFS state — set for
// the span between start() and dispose(). Importing during that span would
// be clobbered by the engine's next persist, so the __pzSave.import hook
// refuses; export stays allowed (IDBFS always holds the last consistency
// checkpoint — exactly what a crash-resume would boot from).
let engineRunning = false

export function bootOffline(params: URLSearchParams): OfflineBoot {
  // Latency meter (__pzPerf in the console): always on in DEV — the phone
  // enters offline via the login footer link, which can't carry a ?perf=1
  // param on an installed PWA with no address bar. The param stays
  // meaningful for any future non-DEV offline build; the meter's cost is a
  // few timestamps per input.
  const perf = params.has('perf') || import.meta.env.DEV
  const port = params.get('engine') === 'fake'
    ? new FakeEnginePort(params.get('fixture') ?? undefined)
    : new WorkerEnginePort(perf)

  const conn = new LocalConnection()
  // Fold real-engine messages into the login card's last-character record.
  // Fake-fixture replays are excluded — they'd write a phantom "Resume …"
  // label for a character that exists only in a golden test capture.
  const real = port instanceof WorkerEnginePort
  const mini = createMiniServer(port, (msg) => {
    if (real) trackOfflineMsg(msg)
    conn.deliver(msg)
  })
  conn.onSend = (msg) => mini.handleClientMsg(msg)
  conn.onShutdown = () => mini.dispose()

  // Console diagnostics for the real engine: __pzEngine.debug() logs the
  // worker-side queue/wake snapshot.
  if (port instanceof WorkerEnginePort) {
    (window as unknown as Record<string, unknown>)['__pzEngine'] = port
  }

  installSaveHooks()

  // Ask the browser to exempt this origin's storage from eviction — the
  // offline save lives in IndexedDB, which is otherwise disposable under
  // storage pressure (Safari especially). Usually auto-granted for installed
  // PWAs; harmless to re-ask every boot.
  void navigator.storage?.persist?.()
    .then((granted) => console.log(`offline: persistent storage ${granted ? 'granted' : 'not granted'}`))
    .catch(() => { /* unsupported — nothing to do */ })

  return {
    conn,
    start: () => { engineRunning = true; mini.start() },
    dispose: () => { engineRunning = false; mini.dispose() },
  }
}

// --- Save export/import console hooks (__pzSave) ------------------------------
// DEV surface for save backup/portability; a real UI entry can come with
// productization. Export downloads a .pzsave pack of the IDBFS mount (minus
// regenerable caches); import writes one back — from a picked file, or a
// File/Blob/ArrayBuffer passed directly.

function installSaveHooks(): void {
  const w = window as unknown as Record<string, unknown>
  if (w['__pzSave']) return
  w['__pzSave'] = {
    async export(): Promise<{ files: number; bytes: number }> {
      const files = await readOfflineFiles()
      if (files.length === 0) throw new Error('no offline data to export — nothing under /crawl yet')
      let build: string | undefined
      try {
        const r = await fetch('/offline/version.json', { cache: 'no-cache' })
        if (r.ok) build = String((await r.json() as { build?: unknown }).build ?? '') || undefined
      } catch { /* offline — pack just goes unstamped */ }
      const pack = packSave(files, { exportedAt: new Date().toISOString(), build })
      const url = URL.createObjectURL(new Blob([pack.buffer as ArrayBuffer], { type: 'application/octet-stream' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `pocketzot-offline-${new Date().toISOString().slice(0, 10)}.pzsave`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      return { files: files.length, bytes: pack.byteLength }
    },

    async import(src?: File | Blob | ArrayBuffer | Uint8Array): Promise<{ files: number; exportedAt: string; build?: string }> {
      if (engineRunning) {
        throw new Error('engine is running — save & exit first (its next persist would clobber the import)')
      }
      const bytes = src === undefined ? await pickFile()
        : src instanceof Uint8Array ? src
        : src instanceof ArrayBuffer ? new Uint8Array(src)
        : new Uint8Array(await src.arrayBuffer())
      const { meta, files } = unpackSave(bytes)
      const count = await writeOfflineFiles(files)
      console.log(`offline: imported ${count} files (exported ${meta.exportedAt || 'unknown'}${meta.build ? `, engine build ${meta.build}` : ''}) — reload with ?offline=1 to play`)
      return { files: count, exportedAt: meta.exportedAt, build: meta.build }
    },
  }
}

function pickFile(): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.addEventListener('change', () => {
      const f = input.files?.[0]
      if (f) resolve(f.arrayBuffer())
      else reject(new Error('no file chosen'))
    })
    // Works from a devtools console call; if the browser demands a user
    // gesture, pass a File/ArrayBuffer to import() instead.
    input.click()
  })
}
