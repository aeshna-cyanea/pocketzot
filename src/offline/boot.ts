// Assembles the offline stack: LocalConnection ↔ mini-server ↔ EnginePort.
// Dynamic-imported from app.ts (offline-lobby slot tap or ?offline=1) so the
// engine machinery stays out of the main bundle.
//
// Engine selection: ?engine=fake replays a golden fixture (see
// fake-engine.ts; ?fixture=<name> picks one); anything else loads the real
// WASM engine worker, which needs the Phase A artifacts under
// public/offline/.

import { FakeEnginePort } from './fake-engine'
import { WorkerEnginePort } from './engine-port'
import { LocalConnection } from './local-connection'
import { createMiniServer } from './mini-server'
import { offlineMilestoneTracker, offlineTracker } from './offline-state'
import {
  buildExportPackFile, downloadPackFile, fetchEngineBuild,
  readOfflineFiles, unpackSave, writeOfflineFiles,
} from './save-transfer'

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

export function bootOffline(params: URLSearchParams, name: string): OfflineBoot {
  // Latency meter (__pzPerf in the console): always on in DEV — the phone
  // enters offline via the login footer link, which can't carry a ?perf=1
  // param on an installed PWA with no address bar. The param stays
  // meaningful for any future non-DEV offline build; the meter's cost is a
  // few timestamps per input.
  const perf = params.has('perf') || import.meta.env.DEV
  const port = params.get('engine') === 'fake'
    ? new FakeEnginePort(params.get('fixture') ?? undefined)
    : new WorkerEnginePort(perf, name)

  const real = port instanceof WorkerEnginePort
  const conn = new LocalConnection()
  // Fold real-engine messages into this slot's character record (name is the
  // slot identity — game_ended carries none of its own). Fake-fixture replays
  // are excluded — they'd write a phantom "Resume …" label for a character
  // that exists only in a golden test capture.
  const track = real ? offlineTracker(name) : undefined
  const mini = createMiniServer(port, (msg) => {
    track?.(msg)
    conn.deliver(msg)
  }, real ? offlineMilestoneTracker(name) : undefined)
  conn.onSend = (msg) => mini.handleClientMsg(msg)
  conn.onShutdown = () => mini.dispose()

  // Console diagnostics for the real engine: __pzEngine.debug() logs the
  // worker-side queue/wake snapshot.
  if (real) {
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
// Console twins of the offline lobby's Export/Import buttons (the real UI,
// views/offline-lobby.ts) — kept for mid-game export (the lobby doesn't exist
// then) and scripted use. Export downloads a .pzsave pack of the IDBFS mount
// (minus regenerable caches); import writes one back — from a picked file, or
// a File/Blob/ArrayBuffer passed directly.

function installSaveHooks(): void {
  const w = window as unknown as Record<string, unknown>
  if (w['__pzSave']) return
  w['__pzSave'] = {
    async export(): Promise<{ files: number; bytes: number }> {
      const files = await readOfflineFiles()
      if (files.length === 0) throw new Error('no offline data to export — nothing under /crawl yet')
      const file = buildExportPackFile(files, await fetchEngineBuild())
      downloadPackFile(file)
      return { files: files.length, bytes: file.size }
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
