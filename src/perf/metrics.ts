// Perf-harness duration aggregator: one flat map of label → duration samples.
//
// Fed three ways: explicit perfRecord calls (the replay driver's per-frame
// timings), the conn.onMessage wrapper (per-message-type handler cost), and
// prototype patching via instrumentMethod — which is how the map/HUD hot
// paths are measured without touching their source. Everything is inert
// until perfEnable(): a patched method checks the flag and calls straight
// through, so an installed-but-idle patch costs one boolean test per call.
// No DOM, no storage — safe to import anywhere (including tests).

let enabled = false
const samples = new Map<string, number[]>()

export function perfEnable(): void {
  enabled = true
}

export function perfDisable(): void {
  enabled = false
}

export function perfReset(): void {
  samples.clear()
}

export function perfRecord(label: string, ms: number): void {
  if (!enabled) return
  const arr = samples.get(label)
  if (arr) arr.push(ms)
  else samples.set(label, [ms])
}

// Raw samples for a label (live array — don't mutate), for consumers that
// need more than the summary (e.g. the replay's over-budget frame counts).
export function perfSamples(label: string): readonly number[] | undefined {
  return samples.get(label)
}

export interface StatSummary {
  n: number
  totalMs: number
  meanMs: number
  maxMs: number
  p50: number
  p90: number
  p99: number
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  // ceil(p/100 * n) ≥ 1 for every p we take, so the index is already ≥ 0.
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

export function summarize(arr: readonly number[]): StatSummary {
  const sorted = [...arr].sort((a, b) => a - b)
  const total = sorted.reduce((s, v) => s + v, 0)
  return {
    n: sorted.length,
    totalMs: total,
    meanMs: sorted.length ? total / sorted.length : 0,
    maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
  }
}

export function perfReport(): Record<string, StatSummary> {
  const out: Record<string, StatSummary> = {}
  for (const [label, arr] of samples) out[label] = summarize(arr)
  return out
}

// Rows for console.table, sorted by total time descending, values rounded
// to keep the table scannable. Takes an already-computed report when the
// caller has one (summarizing sorts every label's samples — a finished run
// renders the same snapshot to console.table and to the on-screen panel).
export function perfTableRows(stats: Record<string, StatSummary> = perfReport()): Array<Record<string, string | number>> {
  const r = (v: number): number => Math.round(v * 100) / 100
  return Object.entries(stats)
    .sort((a, b) => b[1].totalMs - a[1].totalMs)
    .map(([label, s]) => ({
      label,
      n: s.n,
      total: r(s.totalMs),
      mean: r(s.meanMs),
      p50: r(s.p50),
      p90: r(s.p90),
      p99: r(s.p99),
      max: r(s.maxMs),
    }))
}

interface Patched {
  __pzPatched?: boolean
}

// Replace a prototype method with `wrap(original)`. Idempotent (re-patching
// is a no-op), and a missing method warns instead of installing a bogus one:
// the method names binding the harness to the measured code are plain
// strings, and a rename must not silently present as "that path is free
// now" — the worst way for a profiler to be wrong. Shared by
// instrumentMethod and by replay.ts's atlas-preload observer.
export function patchMethod(
  proto: object,
  method: string,
  wrap: (orig: (...args: unknown[]) => unknown) => (this: unknown, ...args: unknown[]) => unknown,
): void {
  const holder = proto as Record<string, unknown>
  const orig = holder[method]
  if ((orig as Patched | undefined)?.__pzPatched) return
  if (typeof orig !== 'function') {
    console.warn(`[perf] patchMethod: no method '${method}' to patch`)
    return
  }
  const patched = wrap(orig as (...args: unknown[]) => unknown)
  ;(patched as Patched).__pzPatched = true
  holder[method] = patched
}

// Instrumented time consumed by calls nested under the currently-running
// patched frame. Single accumulator, not a stack: each frame saves the
// parent's value on entry and restores it (plus its own full elapsed time)
// on exit. Sound because patched methods are synchronous.
let nestedMs = 0

// Patch a prototype method so every call records its synchronous duration
// under `label`. Idempotent; `this`, arguments, and the return value pass
// through untouched. Only for synchronous methods — an async method would
// record time-to-promise, not real work.
//
// Recorded durations are SELF-time: time spent inside nested instrumented
// calls is subtracted, so instrumented labels are additive and a call chain
// like fitToContainer → fullRender → render bills each stretch of wall time
// to exactly one label. (Explicit perfRecord labels — frame.*, msg.* — are
// untouched and stay inclusive.)
export function instrumentMethod(proto: object, method: string, label: string): void {
  patchMethod(proto, method, (fn) =>
    // `arguments` instead of a rest parameter: a rest materializes an array
    // on every call, inflating the very numbers being measured.
    function (this: unknown): unknown {
      const args = arguments as unknown as unknown[]
      if (!enabled) return fn.apply(this, args)
      const parentNested = nestedMs
      nestedMs = 0
      const t0 = performance.now()
      try {
        return fn.apply(this, args)
      } finally {
        const elapsed = performance.now() - t0
        perfRecord(label, elapsed - nestedMs)
        nestedMs = parentNested + elapsed
      }
    })
}
