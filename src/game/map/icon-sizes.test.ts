import { afterEach, describe, expect, it, vi } from 'vitest'
import { getStatusIconSizer, tableStatusIconSizer, ICON_SIZE_TABLE } from './icon-sizes'
import type { TileLoader } from '../tiles/tile-loader'

// Structural stand-in for the two TileLoader methods getStatusIconSizer
// touches. Each test builds a fresh object, so the per-loader WeakMap memo
// never leaks state across tests.
function fakeLoader(opts: {
  serverModule?: Record<string, unknown>
  serverError?: Error
  iconsModule?: Record<string, unknown>
}) {
  const loadStatusIconSizes = vi.fn(() =>
    opts.serverError ? Promise.reject(opts.serverError) : Promise.resolve(opts.serverModule ?? {}))
  const getModule = vi.fn(() => Promise.resolve(opts.iconsModule ?? {}))
  const loader = { loadStatusIconSizes, getModule } as unknown as TileLoader
  return { loader, loadStatusIconSizes, getModule }
}

afterEach(() => vi.restoreAllMocks())

describe('tableStatusIconSizer', () => {
  it('resolves table names to ids via the icons module; unknown ids → -1', () => {
    const sizer = tableStatusIconSizer({ DRAIN: 42, BERSERK: 7, NOT_IN_TABLE: 9 })
    expect(sizer(42)).toBe(ICON_SIZE_TABLE.DRAIN)   // 6
    expect(sizer(7)).toBe(ICON_SIZE_TABLE.BERSERK)  // 0
    expect(sizer(9)).toBe(-1)                       // module name not in table
    expect(sizer(12345)).toBe(-1)                   // id unknown entirely
  })

  it('skips table names absent from the running version (era fallback)', () => {
    const sizer = tableStatusIconSizer({})
    expect(sizer(1)).toBe(-1)
  })
})

describe('getStatusIconSizer', () => {
  it('prefers the server module and never touches the fallback', async () => {
    const status_icon_size = (id: number) => (id === 5 ? 10 : -1)
    const { loader, getModule } = fakeLoader({ serverModule: { status_icon_size } })
    const sizer = await getStatusIconSizer(loader)
    expect(sizer(5)).toBe(10)
    expect(sizer(6)).toBe(-1)
    expect(getModule).not.toHaveBeenCalled()
  })

  it('falls back to the bundled table when the script load fails (pre-0.34.1 server)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { loader, getModule } = fakeLoader({
      serverError: new Error('failed to load status-icon-sizes.js'),
      iconsModule: { CONSTRICTED: 88 },
    })
    const sizer = await getStatusIconSizer(loader)
    expect(sizer(88)).toBe(ICON_SIZE_TABLE.CONSTRICTED)  // 11
    expect(getModule).toHaveBeenCalledWith('icons')
    expect(warn).toHaveBeenCalled()
  })

  it('treats a module without a status_icon_size function as a load failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { loader } = fakeLoader({
      serverModule: { status_icon_size: 'not a function' },
      iconsModule: { RECALL: 3 },
    })
    const sizer = await getStatusIconSizer(loader)
    expect(sizer(3)).toBe(ICON_SIZE_TABLE.RECALL)  // 9
    expect(warn).toHaveBeenCalled()
  })

  it('memoizes per loader: one server attempt, distinct loaders stay isolated', async () => {
    const a = fakeLoader({ serverModule: { status_icon_size: () => 1 } })
    const b = fakeLoader({ serverModule: { status_icon_size: () => 2 } })
    const [s1, s2] = await Promise.all([getStatusIconSizer(a.loader), getStatusIconSizer(a.loader)])
    expect(s1).toBe(s2)
    expect(a.loadStatusIconSizes).toHaveBeenCalledTimes(1)
    const sb = await getStatusIconSizer(b.loader)
    expect(sb(0)).toBe(2)
    expect(s1(0)).toBe(1)
  })
})
