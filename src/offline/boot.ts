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

export interface OfflineBoot {
  conn: LocalConnection
  // Kicks the engine. Call after the game view is mounted (mounting replaces
  // conn.onMessage; anything delivered earlier would be lost).
  start(): void
  dispose(): void
}

export function bootOffline(params: URLSearchParams): OfflineBoot {
  const port = params.get('engine') === 'fake'
    ? new FakeEnginePort(params.get('fixture') ?? undefined)
    : new WorkerEnginePort(params.has('perf'))

  const conn = new LocalConnection()
  const mini = createMiniServer(port, (msg) => conn.deliver(msg))
  conn.onSend = (msg) => mini.handleClientMsg(msg)
  conn.onShutdown = () => mini.dispose()

  // Console diagnostics for the real engine: __pzEngine.debug() logs the
  // worker-side queue/wake snapshot.
  if (port instanceof WorkerEnginePort) {
    (window as unknown as Record<string, unknown>)['__pzEngine'] = port
  }

  return {
    conn,
    start: () => mini.start(),
    dispose: () => mini.dispose(),
  }
}
