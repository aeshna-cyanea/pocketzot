// EnginePort that replays a golden fixture (src/golden/) as if the WASM
// engine were emitting it, so the whole offline seam — LocalConnection,
// mini-server, game-view — runs and can be verified before the Phase A
// engine artifact exists. Runs inline (no Worker), so it works in vitest too.
//
// Behavior: start() emits a boot burst (the engine's real startup shape:
// a starred client_path line, then `version`), plus the fixture's first
// frame group. Each subsequent input/control message received advances one
// frame group — walk the whole fixture with arrow taps. Sending the text
// "S" (crawl's save key) emits a starred exit_reason and exits — the
// scripted stand-in for save-and-quit.

import type { ServerMsg } from '../ws/types'
import type { EnginePort } from './engine-port'

interface GoldenFixture {
  description: string
  messages: ServerMsg[]
}

// Message types that only the Python webtiles server (or the DGL wrapper)
// originates. Golden captures are whole inbound streams, so they can contain
// these; the game binary never emits them, and neither must the fake engine.
const SERVER_ONLY_TYPES = new Set([
  'login_success', 'login_fail', 'auth_error', 'login_cookie', 'register_fail',
  'ping', 'close', 'set_layer', 'layer', 'show_dialog', 'hide_dialog',
  'game_started', 'watching_started', 'stale_processes', 'force_terminate?',
  'game_ended', 'go_lobby', 'lobby_entry', 'lobby_remove', 'lobby_complete',
  'lobby_clear', 'html', 'set_game_links', 'game_client', 'chat',
  'update_spectators', 'super_hide_chat',
])

const fixtures = import.meta.glob<GoldenFixture>('../golden/*.golden.json', {
  eager: true,
  import: 'default',
})

export const DEFAULT_FIXTURE = '05-kobold-combat'

function loadFixture(name: string): ServerMsg[] {
  const entry = Object.entries(fixtures).find(([path]) => path.includes(name))
  if (!entry) throw new Error(`fake-engine: no golden fixture matching "${name}"`)
  return entry[1].messages.filter(m => !SERVER_ONLY_TYPES.has(m.msg))
}

// One "frame group" per player message: a player and everything up to (not
// including) the next player travel together, mirroring how a turn's batch
// arrives. Fixtures that don't lead with player msgs (e.g. the newgame
// capture) get their whole preamble attached to the first group.
function groupFrames(messages: ServerMsg[]): ServerMsg[][] {
  const groups: ServerMsg[][] = []
  let current: ServerMsg[] = []
  for (const m of messages) {
    if (m.msg === 'player' && current.length > 0) {
      groups.push(current)
      current = []
    }
    current.push(m)
  }
  if (current.length > 0) groups.push(current)
  return groups
}

export class FakeEnginePort implements EnginePort {
  onOutput: (chunk: string) => void = () => {}
  onExit: (code: number) => void = () => {}
  private groups: ServerMsg[][]
  private next = 0
  private exited = false

  constructor(fixtureName: string = DEFAULT_FIXTURE) {
    this.groups = groupFrames(loadFixture(fixtureName))
  }

  start(): void {
    // Real engine boot shape: starred client_path first, then version.
    this.emitLines([
      '*{"msg":"client_path","path":"/fake","version":"0.34-fake"}',
      '{"msg":"version","text":"Fake Crawl 0.34 (golden replay)"}',
    ])
    this.emitNextGroup()
  }

  sendKeys(text: string): void {
    if (this.exited) return
    if (text.includes('S')) {
      this.emitLines(['*{"msg":"exit_reason","type":"saved"}'])
      this.exited = true
      this.onExit(0)
      return
    }
    this.emitNextGroup()
  }

  sendControl(json: string): void {
    if (this.exited) return
    // Escape (keycode 27) also saves-and-exits, so the touch UI has a way out.
    const parsed = JSON.parse(json) as { msg?: string; keycode?: number }
    if (parsed.msg === 'key' && parsed.keycode === 27) {
      this.sendKeys('S')
      return
    }
    this.emitNextGroup()
  }

  terminate(): void {
    this.exited = true
  }

  // Whether the fixture has unplayed frame groups (test convenience).
  get exhausted(): boolean {
    return this.next >= this.groups.length
  }

  private emitNextGroup(): void {
    if (this.exhausted) return
    const group = this.groups[this.next++]
    this.emitLines(group.map(m => JSON.stringify(m)))
  }

  private emitLines(lines: string[]): void {
    // One chunk per flush, newline-terminated per message — the real socket
    // framing (tileweb.cc finish_message appends "\n" per JSON object).
    this.onOutput(lines.map(l => l + '\n').join(''))
  }
}
