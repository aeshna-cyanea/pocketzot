// The seam between the offline mini-server and a DCSS engine. Mirrors the
// process boundary the Python webtiles server sits on: the engine's outbound
// Unix-socket datagrams become `onOutput` chunks of newline-delimited JSON
// lines (a line may be prefixed `*` — a control message for the server, never
// relayed to the client), and the two inbound channels map to `sendControl`
// (the socket: key/menu/ui control JSON) and `sendKeys` (the pty: typed-key
// bytes). WorkerEnginePort hosts the real WASM build; FakeEnginePort
// (fake-engine.ts) replays golden fixtures so the whole seam runs without it.

export interface EnginePort {
  // Begin emitting. Wire onOutput/onExit before calling.
  start(): void
  // Control-channel JSON, one message per call — the server-to-binary socket
  // datagram equivalent (key, menu_hover, menu_scroll, …, forwarded verbatim).
  sendControl(json: string): void
  // Typed-key text — the pty write. The whole string must reach the engine's
  // input buffer in one write (the atomicity the spell rail's "za" relies on).
  sendKeys(text: string): void
  // Boot-watchdog rescue for an engine that has gone quiet before reaching
  // the game (see mini-server.ts). Implementations that can see the engine's
  // suspension state pick a targeted rescue; the default fallback is a
  // spectator_joined over the control channel (idempotent full resend).
  nudge?(): void
  onOutput: (chunk: string) => void
  onExit: (code: number) => void
  terminate(): void
}

// Messages between WorkerEnginePort and engine.worker.ts.
export type WorkerInMsg =
  | { type: 'start'; perf?: boolean }
  | { type: 'control'; json: string }
  | { type: 'keys'; text: string }
  // Boot-watchdog rescue: the worker inspects the engine's suspension state
  // (pocketzot.wake / queue) and picks the right recovery — see the worker.
  | { type: 'nudge' }
  // Reply arrives as a {type:'log'} snapshot of the queue/wake state.
  | { type: 'debug' }
export type WorkerOutMsg =
  | { type: 'lines'; chunk: string }
  | { type: 'exit'; code: number }
  // Engine stdout/stderr, relayed because WebKit doesn't surface worker
  // console output to the page.
  | { type: 'log'; text: string }
  // ?perf=1: worker-side input→first-output duration for the last input.
  | { type: 'perf'; engineMs: number }

// Input-latency instrumentation (?perf=1). One sample per input, split into
// where the milliseconds live:
//   engine  — worker-measured: input reaches the worker → first engine
//             output flush (Asyncify wake + the turn's processing)
//   transit — the remainder of send → first chunk on the main thread
//             (postMessage both ways + task-queue waits)
//   stream  — first → last output chunk of the turn (each chunk is its own
//             main-thread task; `chunks` counts them — this is also renders-
//             per-input pressure, since scheduleRender coalesces per task)
//   render  — last chunk's arrival → the next animation frame (dispatch +
//             DOM work + frame wait)
// Console: __pzPerf.summary() → p50/p90 per field; __pzPerf.samples for raw.
interface PerfSample {
  total: number; engine: number; transit: number
  stream: number; render: number; chunks: number
}

class PerfMeter {
  readonly samples: PerfSample[] = []
  private tSend = 0
  private engineMs = 0
  private tFirst = 0
  private tLast = 0
  private tPaint = 0
  private chunks = 0
  private active = false
  private raf = 0
  private quiet: ReturnType<typeof setTimeout> | null = null

  constructor() {
    (window as unknown as Record<string, unknown>)['__pzPerf'] = this
  }

  input(): void {
    // A turn's chunks trickle over ~10 ms with gaps longer than a frame, so
    // the sample closes on a quiet window, not on first-frame-after-chunk
    // (measured: that undercounts — it catches the instant input_mode echo
    // and misses the player/map burst). A new input finalizes a still-open
    // sample first (fast tapping shorter than the quiet window).
    if (this.active) this.finalize()
    this.tSend = performance.now()
    this.engineMs = 0
    this.tFirst = 0
    this.tPaint = 0
    this.chunks = 0
    this.active = true
  }

  engine(ms: number): void {
    if (this.active) this.engineMs = ms
  }

  // Call on chunk ARRIVAL (before dispatch) so the frame that follows
  // includes the handlers' synchronous DOM work.
  chunk(): void {
    if (!this.active) return
    const now = performance.now()
    if (this.tFirst === 0) this.tFirst = now
    this.tLast = now
    this.chunks++
    // tPaint tracks the first frame after the most recent chunk.
    cancelAnimationFrame(this.raf)
    this.raf = requestAnimationFrame(() => { this.tPaint = performance.now() })
    if (this.quiet !== null) clearTimeout(this.quiet)
    this.quiet = setTimeout(() => this.finalize(), 120)
  }

  private finalize(): void {
    if (!this.active) return
    this.active = false
    if (this.quiet !== null) clearTimeout(this.quiet)
    this.quiet = null
    if (this.chunks === 0) return // input produced no output — not a turn
    const tPaint = Math.max(this.tPaint, this.tLast)
    this.samples.push({
      total: tPaint - this.tSend,
      engine: this.engineMs,
      transit: this.tFirst - this.tSend - this.engineMs,
      stream: this.tLast - this.tFirst,
      render: tPaint - this.tLast,
      chunks: this.chunks,
    })
    if (this.samples.length > 500) this.samples.shift()
  }

  summary(): Record<string, string> {
    const q = (a: number[], p: number): number => {
      if (a.length === 0) return 0
      const s = [...a].sort((x, y) => x - y)
      return s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))]
    }
    const out: Record<string, string> = { samples: String(this.samples.length) }
    for (const f of ['total', 'engine', 'transit', 'stream', 'render', 'chunks'] as const) {
      const vals = this.samples.map(s => s[f])
      out[f] = `p50 ${q(vals, 0.5).toFixed(1)}  p90 ${q(vals, 0.9).toFixed(1)}`
    }
    return out
  }
}

// Hosts the Emscripten engine build in a dedicated Worker (kept off the main
// thread: level generation and long turns run seconds even natively). The
// artifact set (crawl.js glue + .wasm + .data) is deploy-time content under
// public/offline/, never bundled — see engine.worker.ts.
export class WorkerEnginePort implements EnginePort {
  onOutput: (chunk: string) => void = () => {}
  onExit: (code: number) => void = () => {}
  private worker: Worker | null = null
  private meter: PerfMeter | null = null
  // DEV diagnostics: last raw engine output chunks, pre-parse (so losses in
  // the mini-server's line handling are visible). __pzEngine.chunks in the
  // console.
  readonly chunks: { ts: number; len: number; head: string }[] = []

  constructor(private readonly perf = false) {}

  start(): void {
    if (this.perf) this.meter = new PerfMeter()
    this.worker = new Worker(new URL('./engine.worker.ts', import.meta.url), {
      type: 'module',
    })
    this.worker.onmessage = (e: MessageEvent<WorkerOutMsg>) => {
      const m = e.data
      if (m.type === 'lines') {
        this.meter?.chunk()
        if (import.meta.env.DEV) {
          this.chunks.push({ ts: Date.now(), len: m.chunk.length, head: m.chunk.slice(0, 120) })
          if (this.chunks.length > 300) this.chunks.shift()
        }
        this.onOutput(m.chunk)
      } else if (m.type === 'exit') this.onExit(m.code)
      else if (m.type === 'log') console.log('[engine]', m.text)
      else if (m.type === 'perf') this.meter?.engine(m.engineMs)
    }
    this.post({ type: 'start', perf: this.perf })
  }

  sendControl(json: string): void {
    // Special keys (arrows, Ctrl-…) arrive as {msg:"key"} control messages —
    // count them as inputs alongside typed text.
    if (json.startsWith('{"msg":"key"')) this.meter?.input()
    this.post({ type: 'control', json })
  }

  sendKeys(text: string): void {
    this.meter?.input()
    this.post({ type: 'keys', text })
  }

  nudge(): void {
    this.post({ type: 'nudge' })
  }

  // DEV diagnostics: ask the worker to log the engine queue state.
  debug(): void {
    this.post({ type: 'debug' })
  }

  terminate(): void {
    this.worker?.terminate()
    this.worker = null
  }

  private post(msg: WorkerInMsg): void {
    this.worker?.postMessage(msg)
  }
}
