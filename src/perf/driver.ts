// Replay driver: pushes a recording's frames through a deliver callback with
// the recording's batch boundaries intact — one frame = one WS text frame =
// one task in live play, so a replayed frame does the same amount of work
// between paints that the live session did. Pure logic — timing sources,
// paint waits, and the deliver sink are all injected, so this is
// unit-testable without a DOM.

// One recorded WS frame: `t` = ms since recording start (monotonic clock at
// capture), `msgs` = the frame's messages after batch unwrap, in wire order.
// The enclosing file format (PzRecording) lives in recorder.ts, which owns it.
export interface PzFrame {
  t: number
  msgs: unknown[]
}

export interface DriverOpts {
  // 'fast': deliver a frame, wait for its paint, deliver the next — measures
  // per-frame cost with no idle gaps. 'real': honor recorded inter-arrival
  // times (divided by `speed`) — measures whether rendering keeps up.
  pace: 'fast' | 'real'
  speed: number
  deliver: (msg: unknown) => void
  // Resolves once the delivered batch's paint has happened (double-rAF in
  // the browser harness).
  nextPaint: () => Promise<void>
  record?: (label: string, ms: number) => void
  shouldStop?: () => boolean
  // Runs between frames (after the paint wait); the browser harness uses it
  // to block on the tile-atlas preload the first time it appears.
  onFrame?: (index: number) => void | Promise<void>
  now?: () => number
  wait?: (ms: number) => Promise<void>
}

export interface DriverResult {
  framesDelivered: number
  msgsDelivered: number
  wallMs: number
}

export async function runFrames(frames: PzFrame[], opts: DriverOpts): Promise<DriverResult> {
  const now = opts.now ?? ((): number => performance.now())
  const wait = opts.wait ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)))
  const start = now()
  let msgs = 0
  let i = 0
  for (; i < frames.length; i++) {
    if (opts.shouldStop?.()) break
    const frame = frames[i]
    if (opts.pace === 'real') {
      const ahead = frame.t / opts.speed - (now() - start)
      // Sub-4ms waits round up to a full timer tick anyway; just deliver.
      if (ahead > 4) await wait(ahead)
    }
    const t0 = now()
    for (const m of frame.msgs) {
      opts.deliver(m)
      msgs++
    }
    opts.record?.('frame.script', now() - t0)
    await opts.nextPaint()
    opts.record?.('frame.total', now() - t0)
    await opts.onFrame?.(i)
  }
  return { framesDelivered: i, msgsDelivered: msgs, wallMs: now() - start }
}
