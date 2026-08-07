import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { count as countFn } from './counter'

const realDev = import.meta.env.DEV

// Fresh module per test — the latch is module state.
async function freshCounter(dev = false): Promise<typeof countFn> {
  vi.resetModules()
  import.meta.env.DEV = dev
  return (await import('./counter')).count
}

describe('counter', () => {
  let sends: string[]

  beforeEach(() => {
    sends = []
    vi.stubGlobal('navigator', {
      sendBeacon: (url: string) => { sends.push(url); return true },
    })
    vi.stubGlobal('location', { search: '' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    import.meta.env.DEV = realDev
  })

  it('sends each event type once and latches duplicates', async () => {
    const count = await freshCounter()
    count('boot')
    count('play')
    count('boot')
    count('play')
    expect(sends).toEqual(['/api/e?e=boot', '/api/e?e=play'])
  })

  it('latches spectate and play independently', async () => {
    const count = await freshCounter()
    count('spectate')
    count('spectate')
    count('play')
    expect(sends).toEqual(['/api/e?e=spectate', '/api/e?e=play'])
  })

  it('forwards src=pwa from the page URL', async () => {
    const count = await freshCounter()
    vi.stubGlobal('location', { search: '?src=pwa' })
    count('boot')
    expect(sends).toEqual(['/api/e?e=boot&src=pwa'])
  })

  it('encodes set flags as letters and omits f when none are set', async () => {
    const count = await freshCounter()
    vi.stubGlobal('location', { search: '?src=pwa' })
    count('play', { ascii: true })
    count('spectate', { ascii: false })
    expect(sends).toEqual(['/api/e?e=play&f=A&src=pwa', '/api/e?e=spectate&src=pwa'])
  })

  it('is inert in DEV builds', async () => {
    const count = await freshCounter(true)
    count('boot')
    expect(sends).toEqual([])
  })

  it('never throws when sendBeacon is unavailable', async () => {
    const count = await freshCounter()
    vi.stubGlobal('navigator', {})
    expect(() => count('boot')).not.toThrow()
    expect(sends).toEqual([])
  })
})
