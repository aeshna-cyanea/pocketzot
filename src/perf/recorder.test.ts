import { describe, expect, it } from 'vitest'
import { assembleRecording, PZREC_FORMAT } from './recorder'

const AT = '2026-08-11T00:00:00.000Z'
const WS = 'wss://crawl.dcss.io/socket'
const HTTP = 'https://crawl.dcss.io'

describe('assembleRecording', () => {
  it('preserves batch grouping and unwraps {msgs:[…]} per frame', () => {
    const rec = assembleRecording([
      { t: 0.4, raw: '{"msgs":[{"msg":"player","hp":10},{"msg":"map","cells":[]}]}' },
      { t: 100.6, raw: '{"msg":"msgs","messages":[]}' },
    ], WS, HTTP, AT)
    expect(rec.format).toBe(PZREC_FORMAT)
    expect(rec.wsUrl).toBe(WS)
    expect(rec.httpBase).toBe(HTTP)
    expect(rec.frames).toHaveLength(2)
    expect(rec.frames[0].t).toBe(0)
    expect(rec.frames[0].msgs.map((m) => (m as { msg: string }).msg)).toEqual(['player', 'map'])
    expect(rec.frames[1].t).toBe(101)
    expect(rec.frames[1].msgs).toHaveLength(1)
  })

  it('scrubs ping and login_cookie, drops frames left empty', () => {
    const rec = assembleRecording([
      { t: 0, raw: '{"msg":"ping"}' },
      { t: 1, raw: '{"msg":"login_cookie","cookie":"secret%123","expires":7}' },
      { t: 2, raw: '{"msgs":[{"msg":"ping"},{"msg":"map"}]}' },
    ], WS, HTTP, AT)
    expect(rec.frames).toHaveLength(1)
    expect(rec.frames[0].msgs).toEqual([{ msg: 'map' }])
    expect(JSON.stringify(rec)).not.toContain('secret')
  })

  it('skips non-JSON and non-object frames', () => {
    const rec = assembleRecording([
      { t: 0, raw: 'garbage' },
      { t: 1, raw: '42' },
      { t: 2, raw: '{"msg":"map"}' },
    ], WS, HTTP, AT)
    expect(rec.frames).toHaveLength(1)
  })

  it('stamps duration from the last raw frame', () => {
    const rec = assembleRecording([
      { t: 0, raw: '{"msg":"map"}' },
      { t: 4999.5, raw: '{"msg":"ping"}' }, // scrubbed but still bounds duration
    ], WS, HTTP, AT)
    expect(rec.durationMs).toBe(5000)
    expect(assembleRecording([], WS, HTTP, AT).durationMs).toBe(0)
  })
})
