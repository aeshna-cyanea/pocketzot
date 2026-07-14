// The offline stand-in for the Python webtiles server: routes client
// messages to the engine over the right channel, relays engine output to
// the client, consumes the engine's starred (server-directed) control lines,
// and synthesizes the few lifecycle messages the views expect.
//
// Routing ports webtiles/process_handler.py's handle_input exactly:
// `input` text goes to the pty in ONE write; every other in-game message is
// forwarded verbatim to the binary's control socket. Engine output lines
// prefixed `*` (client_path, flush_messages, dump, exit_reason, milestone)
// are for the server and never reach clients; the rest relay raw.

import type { ClientMsg, ServerMsg } from '../ws/types'
import type { EnginePort } from './engine-port'

// In-game client messages the real server forwards verbatim to the binary's
// control socket. Everything else it handles itself — offline, those are
// either absorbed (chat) or can't occur (lobby/login flows).
const CONTROL_FORWARD_TYPES = new Set([
  'key', 'menu_hover', 'menu_scroll', 'formatted_scroller_scroll',
  'click_cell', 'ui_state_sync',
])

export interface MiniServer {
  // Begin: emits the synthetic game_client, then starts the engine.
  // Call only after the game view owns deliver (it replaces onMessage on mount).
  start(): void
  handleClientMsg(msg: ClientMsg): void
  dispose(): void
}

// Boot watchdog: the engine can go quiet mid-startup on a resumed save —
// output stops after the version/options/layout preamble (observed: a long
// silent busy stretch during save load, and a hard suspension at an invisible
// startup prompt on crash-recovery resumes). Armed per output chunk until
// real game content (map/msgs/ui-push/menu/player) proves startup finished;
// on firing it asks the port to rescue. WorkerEnginePort inspects the actual
// suspension state and picks the recovery (see engine.worker.ts nudge());
// ports that can't see engine state fall back to a spectator_joined, which is
// consumed by the input loop as a forced full resend — idempotent, never a
// game command.
const WATCHDOG_MS = 4000
const WATCHDOG_MAX_NUDGES = 3
const GAME_CONTENT_TYPES = new Set(['map', 'msgs', 'ui-push', 'menu', 'player'])

export function createMiniServer(
  port: EnginePort,
  deliver: (msg: ServerMsg) => void,
  // Starred milestone messages are server metadata (upstream folds them into
  // lobby entries), not client protocol — handed to this hook instead of
  // deliver. Fields are the engine's xlog snapshot: all strings, empty ones
  // omitted (xlog_json, hiscores.cc).
  onMilestone?: (fields: Record<string, unknown>) => void,
): MiniServer {
  let exitReason: string | null = null
  let exitMessage: string | undefined
  let ended = false
  // Once the engine has declared its exit reason the game is over — nothing
  // after it can return to the map. Overlay-teardown messages that arrive in
  // the remaining span (e.g. screen_end_game's final msgbox popping, newgame
  // cancel) are dropped so the client keeps the last screen up instead of
  // flashing the map while the engine finishes its exit persist. The
  // game-over screen itself is handled client-side (game-view's gameOverSeen
  // latch) because end_game sends exit_reason only *after* that popup closes.
  let exitDeclared = false
  let bootTimer: ReturnType<typeof setTimeout> | null = null
  let nudges = 0
  let sawGameContent = false
  let sawDisplay = false // map/player arrived — the game is actually on screen

  const disarmWatchdog = (): void => {
    if (bootTimer !== null) clearTimeout(bootTimer)
    bootTimer = null
  }

  const armWatchdog = (): void => {
    disarmWatchdog()
    if (sawGameContent || ended || nudges >= WATCHDOG_MAX_NUDGES) return
    bootTimer = setTimeout(() => {
      nudges++
      console.warn(`offline: engine quiet before any game content — nudging (${nudges}/${WATCHDOG_MAX_NUDGES})`)
      if (port.nudge) port.nudge()
      else port.sendControl(JSON.stringify({ msg: 'spectator_joined' }))
      armWatchdog()
    }, WATCHDOG_MS)
  }

  // Emits at most one terminal message: game-view routes BOTH game_ended and
  // go_lobby to exitToLobby, so a pair would double-invoke the exit callback.
  const end = (code: number): void => {
    if (ended) return
    ended = true
    disarmWatchdog()
    deliver({
      msg: 'game_ended',
      reason: exitReason ?? (code === 0 ? 'saved' : 'crash'),
      message: exitMessage,
    })
  }

  const handleStarred = (msg: Record<string, unknown>): void => {
    switch (msg['msg']) {
      case 'exit_reason': {
        // The boot preamble RESETS the stored reason to "unknown"
        // (TilesFramework::initialise, right after _send_version) — upstream's
        // server just stashes it as the process's default. It is not an exit:
        // latching exitDeclared on it would drop every subsequent overlay
        // teardown for the whole session (newgame screens that never dismiss,
        // menus that never close). Real exits always carry a specific type.
        const type = String(msg['type'] ?? 'error')
        if (type === 'unknown') break
        exitReason = type
        exitMessage = typeof msg['message'] === 'string' ? msg['message'] : undefined
        exitDeclared = true
        break
      }
      case 'milestone':
        onMilestone?.(msg)
        break
      case 'client_path':   // engine version handshake — nothing to route offline
      case 'flush_messages': // we don't queue, so every message is already flushed
      case 'dump':           // morgue file lives in the engine FS; no URL to build
        break
      default:
        console.warn('offline: unknown starred engine message', msg['msg'])
    }
  }

  const handleOutput = (chunk: string): void => {
    // Socket framing: concatenated JSON objects, one per "\n"-terminated line.
    // Dispatch the whole chunk synchronously so a turn's player+map land in
    // one task and coalesce in the game view's scheduleRender, same as a
    // batched WS frame.
    for (const line of chunk.split('\n')) {
      if (line === '') continue
      const starred = line.startsWith('*')
      let parsed: unknown
      try {
        parsed = JSON.parse(starred ? line.slice(1) : line)
      } catch {
        console.warn('offline: non-JSON engine line (ignoring):', line.slice(0, 80))
        continue
      }
      if (starred) handleStarred(parsed as Record<string, unknown>)
      else if (!ended) {
        const m = parsed as ServerMsg
        if (exitDeclared && (m.msg === 'ui-pop' || m.msg === 'close_menu' || m.msg === 'close_all_menus')) continue
        if (GAME_CONTENT_TYPES.has(m.msg)) sawGameContent = true
        if (m.msg === 'map' || m.msg === 'player') sawDisplay = true
        deliver(m)
        // Startup more(): the engine sends messages pre-game (PocketZot
        // patch in message.cc), so a --more-- before anything is on screen
        // is a boot prompt (e.g. crash-recovery notes). Answer it so boot
        // stays unattended — the messages remain in the client log. In-game
        // mores (post map/player) are the player's to dismiss.
        if (!sawDisplay && m.msg === 'msgs' && (m as { more?: boolean }).more === true) {
          console.warn('offline: answering pre-game --more-- prompt')
          port.sendKeys(' ')
        }
      }
    }
    if (sawGameContent) disarmWatchdog()
    else armWatchdog()
  }

  return {
    start(): void {
      // The version handshake the lobby normally captures for us. 'local'
      // makes getTileLoader resolve /gamedata/local/, where the engine
      // build's own enums.js is served same-origin (flag decoding stays
      // correct for the bundled engine even in ASCII).
      deliver({ msg: 'game_client', version: 'local', content: '' })
      port.onOutput = handleOutput
      port.onExit = end
      // Boot-phase progress becomes ordinary message-log lines — the same
      // surface the engine's own startup messages ("Loading databases...")
      // stream into once it's running, so the whole boot reads as one log.
      // Deliberately NOT routed through handleOutput: synthetic lines must
      // never count as game content for the watchdog, nor be scanned by the
      // pre-game --more-- auto-answer.
      port.onProgress = (text) => {
        if (!ended) deliver({ msg: 'msgs', messages: [{ text }] })
      }
      port.start()
      // The per-client handshake the Python server performs: without attach,
      // TilesFramework::has_receivers() stays false and redraw() — the path
      // that emits map/player — short-circuits (menus/options still flow,
      // which makes the failure mode deceptively partial). The engine runs
      // with -await-connection (engine.worker.ts argv), so it blocks in
      // tiles.initialise() until this lands: nothing can be drawn — and no
      // option default can be sampled — before the attach is processed. That
      // makes a boot-time spectator_joined resend unnecessary; the watchdog
      // below still sends one as a rescue if boot goes quiet.
      port.sendControl(JSON.stringify({ msg: 'attach', primary: true }))
    },

    handleClientMsg(msg: ClientMsg): void {
      if (ended) return
      if (msg.msg === 'input') {
        port.sendKeys(msg.text)
      } else if (CONTROL_FORWARD_TYPES.has(msg.msg)) {
        port.sendControl(JSON.stringify(msg))
      } else if (msg.msg === 'chat_msg' || msg.msg === 'pong') {
        // chat has no audience offline; pong never occurs (we never ping)
      } else if (msg.msg === 'go_lobby') {
        // Unreachable from an offline played game (spectator-only send sites)
        // but absorb defensively: kill the engine rather than leak it.
        ended = true
        disarmWatchdog()
        port.terminate()
      } else {
        console.warn('offline: unroutable client message absorbed:', msg.msg)
      }
    },

    dispose(): void {
      ended = true
      disarmWatchdog()
      port.terminate()
    },
  }
}
