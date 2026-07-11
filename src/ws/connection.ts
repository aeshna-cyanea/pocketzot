import type { ClientMsg, ServerMsg } from './types'

export type MessageHandler = (msg: ServerMsg) => void
export type StateHandler = () => void

// The connection surface the lobby/game views and app shell actually consume.
// WsConnection is the live-server implementation; the offline engine provides
// LocalConnection (src/offline/local-connection.ts). Login/token-login deal in
// concrete WsConnection (connect, onLoginCookie) — those never apply offline.
export interface GameConnection {
  send(msg: ClientMsg): void
  close(): void
  readonly connected: boolean
  readonly wsUrl: string
  readonly httpBase: string
  onMessage: MessageHandler
  onClose: StateHandler
}

export class WsConnection implements GameConnection {
  private socket: WebSocket | null = null
  private url: string
  private intentionalClose = false

  onMessage: MessageHandler = () => {}
  onOpen: StateHandler = () => {}
  // Fires only on *unexpected* socket loss (network drop, server kick, iOS
  // suspending the app). A client-initiated close() never fires it — every
  // intentional-close call site performs its own navigation, and the reconnect
  // path must be able to treat onClose as "the connection died under us".
  onClose: StateHandler = () => {}
  // Connection-scoped hook for the rotating session token. Set once after
  // a successful login so the cookie can be persisted regardless of which
  // view currently owns onMessage.
  onLoginCookie: (cookie: string, expiresDays: number) => void = () => {}

  constructor(url: string) {
    this.url = url
  }

  get wsUrl(): string {
    return this.url
  }

  // HTTP base for version-pinned gamedata assets (tile atlases served at
  // /gamedata/<version>/). Derived from the socket URL: swap the ws scheme
  // for http and drop the trailing /socket.
  get httpBase(): string {
    return this.url.replace(/^ws/, 'http').replace(/\/socket\/?$/, '')
  }

  connect(): Promise<void> {
    // close() latches this; un-latch on (re)connect so a reused instance
    // doesn't permanently suppress onClose.
    this.intentionalClose = false
    return new Promise((resolve, reject) => {
      // Request no-compression to keep message handling simple.
      // The server will fall back gracefully if the subprotocol is unsupported.
      this.socket = new WebSocket(this.url, 'no-compression')

      this.socket.onopen = () => {
        this.onOpen()
        resolve()
      }

      this.socket.onerror = (e) => {
        reject(new Error(`WebSocket error connecting to ${this.url}`))
        console.error('WS error', e)
      }

      this.socket.onclose = () => {
        this.socket = null
        if (!this.intentionalClose) this.onClose()
      }

      this.socket.onmessage = (event) => {
        this.handleRawMessage(event.data as string)
      }

      if (import.meta.env.DEV) {
        const w = window as unknown as Record<string, unknown>
        w['__dcssSimulateIn'] = (m: unknown) => this.dispatch(m as ServerMsg)
        // Close the raw socket *without* setting intentionalClose — fires
        // onClose exactly like an unexpected drop (iOS suspension), for
        // driving the reconnect paths from the console/playwright.
        w['__dcssKillSocket'] = () => { this.socket?.close() }
      }
    })
  }

  send(msg: ClientMsg): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    if (import.meta.env.DEV) devLog('out', redactForLog(msg))
    this.socket.send(JSON.stringify(msg))
  }

  close(): void {
    this.intentionalClose = true
    this.socket?.close()
    this.socket = null
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  private handleRawMessage(data: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      console.warn('Non-JSON WS message (ignoring):', data.slice(0, 80))
      return
    }

    const obj = parsed as Record<string, unknown>

    // Server can batch messages as { msgs: [...] }
    if (Array.isArray(obj['msgs'])) {
      for (const m of obj['msgs'] as ServerMsg[]) {
        this.dispatch(m)
      }
    } else {
      this.dispatch(obj as unknown as ServerMsg)
    }
  }

  private dispatch(msg: ServerMsg): void {
    if (import.meta.env.DEV) devLog('in', redactForLog(msg))
    // Handle ping at the connection level — always respond immediately.
    if (msg.msg === 'ping') {
      this.send({ msg: 'pong' })
      return
    }
    if (msg.msg === 'login_cookie') {
      this.onLoginCookie(msg.cookie, msg.expires)
      return
    }
    this.onMessage(msg)
  }
}

// Dev-only circular WS message log accessible via window.__dcssWsLog.
// Exported so LocalConnection (offline play) logs into the same window, and
// input routing can be eyeballed identically in both transports.
type LogEntry = { dir: 'in' | 'out'; ts: number; msg: unknown }
const MAX_LOG = 200
export function devLog(dir: 'in' | 'out', msg: unknown): void {
  const w = window as unknown as Record<string, unknown>
  if (!Array.isArray(w['__dcssWsLog'])) w['__dcssWsLog'] = []
  const log = w['__dcssWsLog'] as LogEntry[]
  log.push({ dir, ts: Date.now(), msg })
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG)
}

// Strip password/cookie fields before any debug logging, so a screenshare
// or co-located devtools snoop can't read them out of __dcssWsLog.
const SENSITIVE_FIELDS = new Set(['password', 'cookie'])
function redactForLog(msg: unknown): unknown {
  if (!msg || typeof msg !== 'object') return msg
  const src = msg as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(src)) {
    out[k] = SENSITIVE_FIELDS.has(k) ? '[redacted]' : src[k]
  }
  return out
}
