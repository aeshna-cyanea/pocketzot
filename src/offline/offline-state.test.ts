// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeStorage } from '../test/fake-storage'

vi.stubGlobal('localStorage', fakeStorage())

import { getOfflineLast, offlineLastSaysResumable, trackOfflineMsg } from './offline-state'
import type { ServerMsg } from '../ws/types'

const KEY = 'pocketzot:offline-last'

beforeEach(() => {
  localStorage.clear()
})

describe('trackOfflineMsg', () => {
  it('builds the record from player deltas', () => {
    trackOfflineMsg({ msg: 'player', name: 'local', title: 'Chopper', place: 'D:1', xl: 1 } as ServerMsg)
    trackOfflineMsg({ msg: 'player', place: 'D:3', xl: 4 } as ServerMsg)
    const rec = getOfflineLast()!
    expect(rec.name).toBe('local')
    expect(rec.title).toBe('Chopper')
    expect(rec.place).toBe('D:3')
    expect(rec.xl).toBe(4)
  })

  it('skips the write when a player delta changes nothing', () => {
    trackOfflineMsg({ msg: 'player', name: 'local', place: 'D:1' } as ServerMsg)
    const before = localStorage.getItem(KEY)
    const spy = vi.spyOn(localStorage, 'setItem')
    trackOfflineMsg({ msg: 'player', hp: 12 } as ServerMsg)
    expect(spy).not.toHaveBeenCalled()
    expect(localStorage.getItem(KEY)).toBe(before)
    spy.mockRestore()
  })

  it('stamps game_ended reason and clears it on the next game', () => {
    trackOfflineMsg({ msg: 'player', name: 'local', place: 'D:2' } as ServerMsg)
    trackOfflineMsg({ msg: 'game_ended', reason: 'dead' } as ServerMsg)
    expect(getOfflineLast()!.reason).toBe('dead')
    trackOfflineMsg({ msg: 'player', place: 'D:1' } as ServerMsg)
    expect(getOfflineLast()!.reason).toBeUndefined()
  })

  it('ignores game_ended with no prior character', () => {
    trackOfflineMsg({ msg: 'game_ended', reason: 'saved' } as ServerMsg)
    expect(getOfflineLast()).toBeNull()
  })
})

describe('offlineLastSaysResumable', () => {
  it('is false with no record and true mid-game', () => {
    expect(offlineLastSaysResumable(null)).toBe(false)
    trackOfflineMsg({ msg: 'player', name: 'local' } as ServerMsg)
    expect(offlineLastSaysResumable(getOfflineLast())).toBe(true)
  })

  it('is true after saved, false after dead/quit/won', () => {
    trackOfflineMsg({ msg: 'player', name: 'local' } as ServerMsg)
    for (const [reason, expected] of [['saved', true], ['dead', false], ['quit', false], ['won', false]] as const) {
      trackOfflineMsg({ msg: 'player', name: 'local' } as ServerMsg)
      trackOfflineMsg({ msg: 'game_ended', reason } as ServerMsg)
      expect(offlineLastSaysResumable(getOfflineLast())).toBe(expected)
    }
  })
})
