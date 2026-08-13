import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  instrumentMethod, perfDisable, perfEnable, perfRecord, perfReport,
  perfSamples, perfTableRows, perfReset, summarize,
} from './metrics'

afterEach(() => {
  perfDisable()
  perfReset()
})

describe('perfRecord', () => {
  it('ignores samples while disabled', () => {
    perfRecord('x', 5)
    expect(perfSamples('x')).toBeUndefined()
  })

  it('accumulates samples while enabled', () => {
    perfEnable()
    perfRecord('x', 5)
    perfRecord('x', 7)
    expect(perfSamples('x')).toEqual([5, 7])
  })
})

describe('summarize', () => {
  it('computes stats and percentiles', () => {
    const s = summarize(Array.from({ length: 100 }, (_, i) => i + 1))
    expect(s.n).toBe(100)
    expect(s.totalMs).toBe(5050)
    expect(s.meanMs).toBeCloseTo(50.5)
    expect(s.maxMs).toBe(100)
    expect(s.p50).toBe(50)
    expect(s.p90).toBe(90)
    expect(s.p99).toBe(99)
  })

  it('handles empty and single-sample input', () => {
    expect(summarize([]).n).toBe(0)
    const s = summarize([3])
    expect(s.p50).toBe(3)
    expect(s.p99).toBe(3)
    expect(s.maxMs).toBe(3)
  })
})

describe('instrumentMethod', () => {
  class Widget {
    calls = 0
    work(n: number): number {
      this.calls++
      return n * 2
    }
  }

  it('passes through and records when enabled, is idempotent', () => {
    instrumentMethod(Widget.prototype, 'work', 'widget.work')
    instrumentMethod(Widget.prototype, 'work', 'widget.work') // no double-wrap
    const w = new Widget()
    expect(w.work(21)).toBe(42) // disabled: passthrough
    expect(perfSamples('widget.work')).toBeUndefined()
    perfEnable()
    expect(w.work(2)).toBe(4)
    expect(w.calls).toBe(2) // `this` preserved, single invocation per call
    const samples = perfSamples('widget.work')
    expect(samples).toHaveLength(1)
    expect(samples![0]).toBeGreaterThanOrEqual(0)
  })

  it('records self-time: nested instrumented calls are not double-counted', () => {
    class Views {
      render(): void {}
      fullRender(): void {
        this.render()
        this.render()
      }
    }
    instrumentMethod(Views.prototype, 'render', 'nest.render')
    instrumentMethod(Views.prototype, 'fullRender', 'nest.fullRender')
    perfEnable()
    // One now() pair per patched frame, innermost pairs nested inside the
    // outer one: fullRender enters (0), render 5→15, render 20→50,
    // fullRender exits (100).
    const clock = vi.spyOn(performance, 'now')
    for (const t of [0, 5, 15, 20, 50, 100]) clock.mockReturnValueOnce(t)
    try {
      new Views().fullRender()
    } finally {
      clock.mockRestore()
    }
    expect(perfSamples('nest.render')).toEqual([10, 30])
    // 100 total minus the 40 spent in instrumented children.
    expect(perfSamples('nest.fullRender')).toEqual([60])

    // A later top-level call must not inherit the finished frame's residue.
    const clock2 = vi.spyOn(performance, 'now')
    for (const t of [200, 207]) clock2.mockReturnValueOnce(t)
    try {
      new Views().render()
    } finally {
      clock2.mockRestore()
    }
    expect(perfSamples('nest.render')).toEqual([10, 30, 7])
  })

  it('records even when the method throws', () => {
    class Boom {
      go(): void {
        throw new Error('boom')
      }
    }
    instrumentMethod(Boom.prototype, 'go', 'boom.go')
    perfEnable()
    expect(() => new Boom().go()).toThrow('boom')
    expect(perfSamples('boom.go')).toHaveLength(1)
  })
})

describe('perfReport / perfTableRows', () => {
  it('summarizes per label, sorted by total descending', () => {
    perfEnable()
    perfRecord('small', 1)
    perfRecord('big', 10)
    perfRecord('big', 20)
    expect(perfReport()['big'].totalMs).toBe(30)
    const rows = perfTableRows()
    expect(rows.map((r) => r.label)).toEqual(['big', 'small'])
  })
})
