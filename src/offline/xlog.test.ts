import { describe, expect, it } from 'vitest'
import { PROBE_LINE } from '../test/xlog-probe'
import { morgueFileName, parseXlog, parseXlogLine, xlogTimeMs } from './xlog'

describe('parseXlogLine', () => {
  it('parses a real engine line', () => {
    const rec = parseXlogLine(PROBE_LINE)
    expect(rec['name']).toBe('TmsgProbe')
    expect(rec['race']).toBe('Minotaur')
    expect(rec['cls']).toBe('Berserker')
    expect(rec['ktyp']).toBe('quitting')
    expect(rec['tmsg']).toBe('quit the game')
    expect(rec['seed']).toBe('4855153004609807531')
    expect(rec['dam']).toBe('-9999')
  })

  it('unescapes :: to a literal colon', () => {
    expect(parseXlogLine(PROBE_LINE)['place']).toBe('D:1')
    expect(parseXlogLine('a=1::2:b=x::')).toEqual({ a: '1:2', b: 'x:' })
    expect(parseXlogLine('a=::x::')).toEqual({ a: ':x:' })
  })

  it('skips fields without a key=value shape', () => {
    expect(parseXlogLine('junk:a=1:=v:')).toEqual({ a: '1' })
  })
})

describe('parseXlog', () => {
  it('splits lines and skips blanks', () => {
    const recs = parseXlog(`${PROBE_LINE}\n\na=1\n`)
    expect(recs).toHaveLength(2)
    expect(recs[0]['name']).toBe('TmsgProbe')
    expect(recs[1]).toEqual({ a: '1' })
  })
})

describe('xlogTimeMs', () => {
  it('reads the 0-based month as-is into a local Date', () => {
    // end=20260620… was written on July 20 — month 06 is the 0-based index.
    expect(xlogTimeMs('20260620221149D')).toBe(new Date(2026, 6, 20, 22, 11, 49).getTime())
  })
  it('accepts the S suffix and no suffix', () => {
    expect(xlogTimeMs('20260001030405S')).toBe(new Date(2026, 0, 1, 3, 4, 5).getTime())
    expect(xlogTimeMs('20260001030405')).toBe(new Date(2026, 0, 1, 3, 4, 5).getTime())
  })
  it('rejects malformed values', () => {
    expect(xlogTimeMs(undefined)).toBeNull()
    expect(xlogTimeMs('')).toBeNull()
    expect(xlogTimeMs('2026062022114')).toBeNull()
    expect(xlogTimeMs('yesterday')).toBeNull()
  })
})

describe('morgueFileName', () => {
  it('rebuilds the exact filename the engine wrote (1-based month)', () => {
    // Live-observed pair: end=20260620221149D ↔ morgue-TmsgProbe-20260720-221149.txt
    expect(morgueFileName('TmsgProbe', '20260620221149D')).toBe(
      'morgue-TmsgProbe-20260720-221149.txt',
    )
  })
  it('strips filename-unsafe characters like the engine', () => {
    expect(morgueFileName('A B.C', '20260620221149D')).toBe('morgue-ABC-20260720-221149.txt')
  })
  it('rolls a December (0-based 11) into month 12', () => {
    expect(morgueFileName('X', '20251101020304S')).toBe('morgue-X-20251201-020304.txt')
  })
  it('returns null without a parseable end time', () => {
    expect(morgueFileName('X', undefined)).toBeNull()
    expect(morgueFileName('X', 'garbage')).toBeNull()
  })
})
