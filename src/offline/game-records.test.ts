import { describe, expect, it } from 'vitest'
import type { Avatar } from '../avatars'
import { joinDollRecipe, liveDollRecipe, sortRecords, stripRecordLine } from './game-records'
import { parseXlogLine, type XlogRecord } from './xlog'

// end times: 0-based months, local wall clock (see xlog.ts).
const END_NOON = '20260619120000S'   // Jul 19 12:00
const END_LATER = '20260620221149D'  // Jul 20 22:11:49

function rec(over: Partial<XlogRecord> = {}): XlogRecord {
  return { name: 'Bram', sc: '100', turn: '5000', end: END_LATER, ...over }
}

describe('sortRecords', () => {
  const oldest = rec({ sc: '50', end: END_NOON })
  const newest = rec({ sc: '10', end: END_LATER })
  const logfile = [oldest, newest] // append order: oldest first

  it('recent flips to newest-first without mutating', () => {
    expect(sortRecords(logfile, 'recent')).toEqual([newest, oldest])
    expect(logfile[0]).toBe(oldest)
  })

  it('score orders by points, newer first on ties', () => {
    expect(sortRecords(logfile, 'score')).toEqual([oldest, newest])
    const tied = [rec({ sc: '50', end: END_NOON }), rec({ sc: '50', end: END_LATER })]
    expect(sortRecords(tied, 'score')[0]).toBe(tied[1])
  })
})

describe('stripRecordLine', () => {
  const lineA = 'name=Bram:sc=100:place=D::1:end=20260619221149D:tmsg=quit the game'
  const lineB = 'name=Ecco:sc=200:end=20260620231000D:tmsg=slain by an ogre'
  const text = `${lineA}\n${lineB}\n`

  it('removes exactly the matching line, keeping the trailing newline', () => {
    expect(stripRecordLine(text, parseXlogLine(lineB))).toBe(`${lineA}\n`)
    expect(stripRecordLine(text, parseXlogLine(lineA))).toBe(`${lineB}\n`)
  })

  it('returns null when no line matches', () => {
    expect(stripRecordLine(text, { name: 'Zed' })).toBeNull()
    expect(stripRecordLine(text, { ...parseXlogLine(lineA), sc: '999' })).toBeNull()
  })

  it('matches on full field equality, not subsets', () => {
    // A record missing one of the line's fields must not match it.
    const { tmsg: _t, ...partial } = parseXlogLine(lineA)
    expect(stripRecordLine(text, partial)).toBeNull()
  })

  it('removes only the first of two identical lines (two games, one line each)', () => {
    const dup = `${lineA}\n${lineA}\n`
    expect(stripRecordLine(dup, parseXlogLine(lineA))).toBe(`${lineA}\n`)
  })
})

function avatar(over: Partial<Avatar> = {}): Avatar {
  return {
    wsUrl: 'local://offline',
    username: 'Bram',
    gameId: 'offline',
    charName: 'Bram',
    httpBase: '',
    version: 'local',
    doll: [[1, 32]],
    mcache: null,
    turn: 4000,
    outcome: { reason: 'dead', endedAt: new Date(2026, 6, 20, 22, 12, 30).getTime() },
    ...over,
  }
}

describe('joinDollRecipe', () => {
  it('joins the same-name offline avatar whose outcome time matches', () => {
    const a = avatar()
    expect(joinDollRecipe(rec(), [a])).toBe(a)
  })

  it('is case-insensitive on the name', () => {
    const a = avatar({ username: 'bram' })
    expect(joinDollRecipe(rec({ name: 'BRAM' }), [a])).toBe(a)
  })

  it('prefers the closest end time among rerolls sharing the name', () => {
    const near = avatar()
    const far = avatar({ outcome: { reason: 'dead', endedAt: new Date(2026, 6, 20, 22, 20, 0).getTime() } })
    expect(joinDollRecipe(rec(), [far, near])).toBe(near)
  })

  it('rejects out-of-window, online, live, and future-turn candidates', () => {
    expect(joinDollRecipe(rec(), [avatar({ outcome: { reason: 'dead', endedAt: new Date(2026, 6, 19, 12, 0, 0).getTime() } })])).toBeNull()
    expect(joinDollRecipe(rec(), [avatar({ wsUrl: 'wss://crawl.dcss.io/socket' })])).toBeNull()
    expect(joinDollRecipe(rec(), [avatar({ outcome: undefined })])).toBeNull()
    expect(joinDollRecipe(rec(), [avatar({ turn: 6000 })])).toBeNull()
  })

  it('never joins without a parseable end time', () => {
    expect(joinDollRecipe(rec({ end: undefined }), [avatar()])).toBeNull()
  })
})

describe('liveDollRecipe', () => {
  const live = avatar({ outcome: undefined })

  it('takes the live entry for the slot name, case-insensitively', () => {
    expect(liveDollRecipe('Bram', [live])).toBe(live)
    expect(liveDollRecipe('bram', [avatar({ username: 'BRAM', outcome: undefined })]))
      .toHaveProperty('doll')
  })

  it('ignores other slots: online servers, other game ids, unrelated names', () => {
    expect(liveDollRecipe('Bram', [avatar({ wsUrl: 'wss://crawl.dcss.io/socket', outcome: undefined })])).toBeNull()
    expect(liveDollRecipe('Bram', [avatar({ gameId: '', outcome: undefined })])).toBeNull()
    expect(liveDollRecipe('Ecco', [live])).toBeNull()
  })

  it('refuses a finished character — a same-named slot is a different life', () => {
    expect(liveDollRecipe('Bram', [avatar()])).toBeNull()
  })

  it('takes the newest entry only: a reroll never inherits the dead one', () => {
    // Store order is newest-first, so the reroll (still live) leads its
    // predecessor's outcome-stamped entry.
    expect(liveDollRecipe('Bram', [live, avatar()])).toBe(live)
    expect(liveDollRecipe('Bram', [avatar(), live])).toBeNull()
  })
})
