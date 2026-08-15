// GameConnection implementation backed by the offline engine instead of a
// WebSocket. The app shell and game view consume it exactly like a live
// connection; boot.ts wires onSend into the mini-server and calls deliver()
// with engine-relayed messages.
//
// Deliberate inertnesses (both load-bearing — see the reconnect machinery):
// - onClose NEVER fires. An engine crash surfaces as a synthesized
//   game_ended{reason:'crash'} through the normal exit path; the WS
//   auto-resume state machine must never see an offline game.
// - `connected` stays true until close(): app.ts's foreground visibility
//   check treats state==='game' && !conn.connected as a dropped socket and
//   would start a resume against 'local://offline'.

import { devLog, type GameConnection, type MessageHandler, type StateHandler } from '../ws/connection'
import type { ClientMsg, ServerMsg } from '../ws/types'
import { APP_BASE_PATH } from '../base-path'
import { OFFLINE_WS_URL } from './offline-state'

export class LocalConnection implements GameConnection {
  onMessage: MessageHandler = () => {}
  onClose: StateHandler = () => {}   // never invoked — see header comment
  // Wired by boot.ts to the mini-server's handleClientMsg.
  onSend: (msg: ClientMsg) => void = () => {}
  // Wired by boot.ts to dispose the mini-server + engine when the app shell
  // closes us (e.g. showLogin's conn?.close()).
  onShutdown: () => void = () => {}
  private open = true

  get connected(): boolean {
    return this.open
  }

  // Stable pseudo-URL: parseable by `new URL()`, and never collides with a
  // real server's session/avatar/resume keys (all keyed by wsUrl).
  get wsUrl(): string {
    return OFFLINE_WS_URL
  }

  // The app base makes getTileLoader resolve the same-origin offline pack at
  // /gamedata/local/ on root deploys or /<project>/gamedata/local/ on Pages.
  get httpBase(): string {
    return APP_BASE_PATH
  }

  constructor() {
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>
      w['__dcssSimulateIn'] = (m: unknown) => this.deliver(m as ServerMsg)
    }
  }

  send(msg: ClientMsg): void {
    if (!this.open) return
    if (import.meta.env.DEV) devLog('out', msg)
    this.onSend(msg)
  }

  // Inbound entry point (mini-server → view). Synchronous: a turn's batch of
  // messages must dispatch within one task for the render coalescing to work.
  deliver(msg: ServerMsg): void {
    if (!this.open) return
    if (import.meta.env.DEV) devLog('in', msg)
    this.onMessage(msg)
  }

  close(): void {
    if (!this.open) return
    this.open = false
    this.onShutdown()
  }
}
