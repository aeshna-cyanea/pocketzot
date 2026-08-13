import { describe, expect, it } from 'vitest'
import { runFrames, type PzFrame } from './driver'

const frames: PzFrame[] = [
  { t: 0, msgs: [{ msg: 'player' }, { msg: 'map' }] },
  { t: 100, msgs: [{ msg: 'msgs' }] },
  { t: 200, msgs: [{ msg: 'map' }] },
]

describe('runFrames', () => {
  it('fast pace: delivers every message in order, one paint wait per frame', async () => {
    const delivered: string[] = []
    let paints = 0
    const result = await runFrames(frames, {
      pace: 'fast',
      speed: 1,
      deliver: (m) => delivered.push((m as { msg: string }).msg),
      nextPaint: () => { paints++; return Promise.resolve() },
    })
    expect(delivered).toEqual(['player', 'map', 'msgs', 'map'])
    expect(paints).toBe(3)
    expect(result.framesDelivered).toBe(3)
    expect(result.msgsDelivered).toBe(4)
  })

  it('records frame.script and frame.total per frame', async () => {
    const labels: string[] = []
    await runFrames(frames.slice(0, 2), {
      pace: 'fast',
      speed: 1,
      deliver: () => {},
      nextPaint: () => Promise.resolve(),
      record: (label) => labels.push(label),
    })
    expect(labels).toEqual(['frame.script', 'frame.total', 'frame.script', 'frame.total'])
  })

  it('real pace: waits out recorded inter-arrival gaps, scaled by speed', async () => {
    let clock = 0
    const waits: number[] = []
    await runFrames(frames, {
      pace: 'real',
      speed: 2, // 0/100/200ms recorded → 0/50/100ms targets
      deliver: () => {},
      nextPaint: () => { clock += 1; return Promise.resolve() }, // 1ms "paint"
      now: () => clock,
      wait: (ms) => { waits.push(ms); clock += ms; return Promise.resolve() },
    })
    expect(waits).toEqual([49, 49])
  })

  it('real pace skips sub-tick waits instead of sleeping', async () => {
    const waits: number[] = []
    let clock = 0
    await runFrames([{ t: 0, msgs: [{}] }, { t: 3, msgs: [{}] }], {
      pace: 'real',
      speed: 1,
      deliver: () => {},
      nextPaint: () => Promise.resolve(),
      now: () => clock++,
      wait: (ms) => { waits.push(ms); return Promise.resolve() },
    })
    expect(waits).toEqual([])
  })

  it('stops between frames when shouldStop trips', async () => {
    const delivered: unknown[] = []
    let stop = false
    const result = await runFrames(frames, {
      pace: 'fast',
      speed: 1,
      deliver: (m) => { delivered.push(m); stop = true },
      nextPaint: () => Promise.resolve(),
      shouldStop: () => stop,
    })
    expect(result.framesDelivered).toBe(1)
    expect(delivered).toHaveLength(2) // the tripping frame finishes its batch
  })

  it('runs the onFrame hook after each frame paint', async () => {
    const indices: number[] = []
    await runFrames(frames, {
      pace: 'fast',
      speed: 1,
      deliver: () => {},
      nextPaint: () => Promise.resolve(),
      onFrame: (i) => { indices.push(i) },
    })
    expect(indices).toEqual([0, 1, 2])
  })
})
