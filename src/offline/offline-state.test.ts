// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeStorage } from '../test/fake-storage'

vi.stubGlobal('localStorage', fakeStorage())

import {
  getOfflineChars, forgetOfflineChar, offlineMilestoneTracker, offlineTracker,
  reconcileOfflineChars, slotStem, validateOfflineName,
} from './offline-state'
import type { ServerMsg } from '../ws/types'

const KEY = 'pocketzot:offline-chars'
const LEGACY_KEY = 'pocketzot:offline-last'

beforeEach(() => {
  localStorage.clear()
})

describe('slotStem', () => {
  it('strips the same characters the engine strips from save filenames', () => {
    expect(slotStem('Bram')).toBe('Bram')
    expect(slotStem('My Guy')).toBe('MyGuy')
    expect(slotStem('a.b c_d-e')).toBe('abc_d-e')
  })
})

describe('validateOfflineName', () => {
  it('accepts engine-legal names', () => {
    for (const name of ['Bram', 'My Guy', 'a-b_c.d', '123']) {
      expect(validateOfflineName(name), name).toBeNull()
    }
  })

  it('rejects empty, overlong, illegal-char, and stemless names', () => {
    expect(validateOfflineName('')).toMatch(/enter/i)
    expect(validateOfflineName('x'.repeat(31))).toMatch(/30/)
    expect(validateOfflineName('a/b')).toMatch(/letters/i)
    expect(validateOfflineName('née')).toMatch(/letters/i)
    expect(validateOfflineName('. .')).toMatch(/letter or number/i)
  })
})

describe('offlineTracker', () => {
  it('builds the slot record from player deltas under the boot name', () => {
    const track = offlineTracker('My Guy')
    track({ msg: 'player', name: 'My Guy', title: 'Chopper', place: 'D:1', xl: 1 } as ServerMsg)
    track({ msg: 'player', place: 'D:3', xl: 4 } as ServerMsg)
    const rec = getOfflineChars()['MyGuy']!
    expect(rec.name).toBe('My Guy')
    expect(rec.title).toBe('Chopper')
    expect(rec.place).toBe('D:3')
    expect(rec.xl).toBe(4)
  })

  it('tracks two slots independently', () => {
    offlineTracker('Bram')({ msg: 'player', name: 'Bram', xl: 5 } as ServerMsg)
    offlineTracker('Zia')({ msg: 'player', name: 'Zia', xl: 2 } as ServerMsg)
    const map = getOfflineChars()
    expect(Object.keys(map).sort()).toEqual(['Bram', 'Zia'])
    expect(map['Bram']!.xl).toBe(5)
    expect(map['Zia']!.xl).toBe(2)
  })

  it('skips the write when a player delta changes nothing', () => {
    const track = offlineTracker('Bram')
    track({ msg: 'player', name: 'Bram', place: 'D:1' } as ServerMsg)
    const before = localStorage.getItem(KEY)
    const spy = vi.spyOn(localStorage, 'setItem')
    track({ msg: 'player', hp: 12 } as ServerMsg)
    expect(spy).not.toHaveBeenCalled()
    expect(localStorage.getItem(KEY)).toBe(before)
    spy.mockRestore()
  })

  it('keeps the record on save/crash endings and drops it on save-unlinking ones', () => {
    for (const [reason, kept] of [
      ['saved', true], ['crash', true], ['error', true],
      ['dead', false], ['quit', false], ['won', false], ['bailed out', false], ['cancel', false],
    ] as const) {
      const track = offlineTracker('Bram')
      track({ msg: 'player', name: 'Bram', place: 'D:2' } as ServerMsg)
      track({ msg: 'game_ended', reason } as ServerMsg)
      expect('Bram' in getOfflineChars(), reason).toBe(kept)
      localStorage.clear()
    }
  })

  it('ignores game_ended with no prior record', () => {
    offlineTracker('Bram')({ msg: 'game_ended', reason: 'saved' } as ServerMsg)
    expect(getOfflineChars()).toEqual({})
  })

  it('folds god, treating the empty string as godless', () => {
    const track = offlineTracker('Bram')
    track({ msg: 'player', name: 'Bram', god: 'Okawaru' } as ServerMsg)
    expect(getOfflineChars()['Bram']!.god).toBe('Okawaru')
    track({ msg: 'player', god: '' } as ServerMsg)
    expect(getOfflineChars()['Bram']!.god).toBeUndefined()
  })

  it('batches turn-only advances and writes on drift or another change', () => {
    const track = offlineTracker('Bram')
    track({ msg: 'player', name: 'Bram', turn: 100 } as ServerMsg)
    // Small advance: batched, not written.
    track({ msg: 'player', turn: 110 } as ServerMsg)
    expect(getOfflineChars()['Bram']!.turn).toBe(100)
    // A meta change flushes the whole delta, current turn included.
    track({ msg: 'player', turn: 120, xl: 2 } as ServerMsg)
    expect(getOfflineChars()['Bram']!.turn).toBe(120)
    // Drifting past the batch window writes turn alone.
    track({ msg: 'player', turn: 120 + 64 } as ServerMsg)
    expect(getOfflineChars()['Bram']!.turn).toBe(184)
  })

  it('folds the batched turn into a meta write whose delta omits turn', () => {
    const track = offlineTracker('Bram')
    track({ msg: 'player', name: 'Bram', turn: 100 } as ServerMsg)
    track({ msg: 'player', turn: 110 } as ServerMsg) // batched
    // Meta changes on the same turn, so the delta omits it — the write must
    // carry the batched 110, not regress to the last written 100.
    track({ msg: 'player', xl: 2 } as ServerMsg)
    expect(getOfflineChars()['Bram']!.turn).toBe(110)
    expect(getOfflineChars()['Bram']!.xl).toBe(2)
  })

  it('flushes the batched turn on game_ended', () => {
    const track = offlineTracker('Bram')
    track({ msg: 'player', name: 'Bram', turn: 100 } as ServerMsg)
    track({ msg: 'player', turn: 130 } as ServerMsg)
    track({ msg: 'game_ended', reason: 'saved' } as ServerMsg)
    expect(getOfflineChars()['Bram']!.turn).toBe(130)
  })
})

describe('offlineMilestoneTracker', () => {
  it('captures the milestone text and combo, ignoring snapshot position fields', () => {
    offlineMilestoneTracker('My Guy')({
      char: 'DjCj', milestone: 'fell down a shaft to D:5.',
      xl: '11', place: 'D:5', god: 'Okawaru', turn: '923',
    })
    const rec = getOfflineChars()['MyGuy']!
    expect(rec.char).toBe('DjCj')
    expect(rec.milestone).toBe('fell down a shaft to D:5.')
    expect(rec.xl).toBeUndefined()
    expect(rec.place).toBeUndefined()
    expect(rec.god).toBeUndefined()
    expect(rec.turn).toBeUndefined()
  })

  it('overwrites the previous milestone and skips no-op repeats', () => {
    const track = offlineMilestoneTracker('Bram')
    track({ char: 'MiBe', milestone: 'began the quest for the Orb.' })
    track({ char: 'MiBe', milestone: 'killed Sigmund.' })
    expect(getOfflineChars()['Bram']!.milestone).toBe('killed Sigmund.')
    const spy = vi.spyOn(localStorage, 'setItem')
    track({ char: 'MiBe', milestone: 'killed Sigmund.' })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('ignores messages with neither field', () => {
    offlineMilestoneTracker('Bram')({ type: 'begin', xl: '1' })
    expect(getOfflineChars()).toEqual({})
  })
})

describe('reconcileOfflineChars', () => {
  it('drops records whose save file is gone and keeps the rest', () => {
    offlineTracker('Bram')({ msg: 'player', name: 'Bram' } as ServerMsg)
    offlineTracker('Zia')({ msg: 'player', name: 'Zia' } as ServerMsg)
    const map = reconcileOfflineChars(['Zia'])
    expect(Object.keys(map)).toEqual(['Zia'])
    expect(Object.keys(getOfflineChars())).toEqual(['Zia'])
  })

  it('leaves records alone when the probe is unavailable', () => {
    offlineTracker('Bram')({ msg: 'player', name: 'Bram' } as ServerMsg)
    expect(Object.keys(reconcileOfflineChars(null))).toEqual(['Bram'])
  })
})

describe('forgetOfflineChar', () => {
  it('removes one slot record', () => {
    offlineTracker('Bram')({ msg: 'player', name: 'Bram' } as ServerMsg)
    forgetOfflineChar('Bram')
    expect(getOfflineChars()).toEqual({})
  })
})

describe('legacy migration', () => {
  it('carries a resumable single-character record into the map', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ name: 'local', title: 'Chopper', place: 'Dungeon', depth: 3, xl: 4, when: 1 }))
    const map = getOfflineChars()
    expect(map['local']).toMatchObject({ name: 'local', title: 'Chopper', place: 'Dungeon', depth: 3, xl: 4 })
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
  })

  it('drops an ended legacy record', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ name: 'local', reason: 'dead', when: 1 }))
    expect(getOfflineChars()).toEqual({})
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
  })
})
