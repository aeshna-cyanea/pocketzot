// Assembles the offline stack: LocalConnection ↔ mini-server ↔ EnginePort.
// DEV-only entry (dynamic-imported from app.ts behind ?offline=1, so none of
// this reaches production bundles while the spike is engine-less).
//
// Engine selection: ?engine=fake replays a golden fixture (see
// fake-engine.ts; ?fixture=<name> picks one); anything else loads the real
// WASM engine worker, which needs the Phase A artifacts under
// public/offline/.

import { getPref, setPref } from '../prefs'
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

  // No local tile atlases yet (offline tiles is a follow-up): a persisted
  // tiles pref would mount the game view onto atlases that 404. Force the
  // pref to ASCII before the view builds — persisting is deliberate (the
  // settings page then shows the true state; switching back online is one
  // toggle). The in-game gestures can still switch to tiles mid-session;
  // that's a dev poking at it, not a trap.
  if (getPref('mapRenderMode') === 'tiles') {
    console.warn('offline: tile mode has no local atlases yet — render mode switched to ASCII')
    setPref('mapRenderMode', 'ascii')
  }

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
