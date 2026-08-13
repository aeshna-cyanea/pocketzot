// Raw WS frame recorder behind window.__dcssRec, for the perf replay harness
// (?replay=…, see replay.ts). Records at the frame level — connection.ts taps
// handleRawMessage BEFORE JSON parse and batch unwrap — because a whole
// {msgs:[…]} batch dispatches in one task in live play: preserving that
// grouping is what makes a replayed frame do the same work between paints
// that the real session did. __dcssWsLog can't be the source: it's
// post-unwrap (grouping destroyed), capped at 200, wall-clock.
//
// DEV builds only (the tap call in connection.ts and the __dcssRec install
// below are both DEV-gated, so prod bundles tree-shake this module away
// entirely — the sole other importer, replay.ts, is behind app.ts's DEV-gated
// dynamic import, so no prod chunk holds even PZREC_FORMAT; verified by
// grepping dist for 'pzrec'). On-device recording still works: the phone PWA
// pointed at the LAN dev server runs a DEV build.
//
// Online (WsConnection) sessions only: offline games deliver through
// LocalConnection, which has no raw-frame seam — nothing records there and
// save() just warns. Profile the offline stack via ?engine=fake fixtures.
//
// Console workflow (start any time — lobby is best, so game_client and the
// initial map dump are captured; a tiles replay needs that version):
//   __dcssRec.start()          — begin capture
//   …play the sequence to profile…
//   __dcssRec.stop()           — returns {frames, ms}
//   __dcssRec.save('name')     — downloads name.pzrec.json (scrubs
//                                login_cookie/ping, keeps batch grouping)
// Then move the file into recordings/ at the repo root (gitignored; served
// only by the dev server) and open ?replay=name&mode=ascii|tiles.

import type { PzFrame } from './driver'

export const PZREC_FORMAT = 'pzrec/1'

// The on-disk .pzrec.json shape. Owned here, next to the format version it
// carries and the assembler that produces it.
export interface PzRecording {
  format: string // PZREC_FORMAT ('pzrec/1')
  wsUrl: string
  httpBase: string
  recordedAt?: string
  durationMs?: number
  frames: PzFrame[]
}

interface RawFrame {
  t: number
  raw: string
}

// Recording holds every raw frame string; a forgotten start() over a long
// session would otherwise grow without bound. Both caps are far above any
// deliberate capture (a 7-minute spectate was ~1k frames averaging 2.5 KB).
// The byte budget is the one that actually binds: captures run on the phone
// against the LAN dev server, where 20k frames of map dumps would evict the
// tab long before the frame count tripped.
const MAX_REC_FRAMES = 20_000
const MAX_REC_BYTES = 24 * 1024 * 1024

let active = false
let t0 = 0
let frames: RawFrame[] = []
let recBytes = 0
let recWsUrl = ''
let recHttpBase = ''

// The hot-path tap — called by WsConnection.handleRawMessage for every
// inbound WS text frame. The connection's own accessors supply wsUrl and
// httpBase (so the socket→gamedata-host derivation lives only in
// WsConnection.httpBase), read once on the first recorded frame — never on
// the idle path, where this returns after one boolean test.
export function recordFrame(raw: string, source: { readonly wsUrl: string; readonly httpBase: string }): void {
  if (!active) return
  if (!recWsUrl) {
    recWsUrl = source.wsUrl
    recHttpBase = source.httpBase
  }
  if (frames.length >= MAX_REC_FRAMES || recBytes >= MAX_REC_BYTES) {
    active = false
    console.warn(`[rec] cap reached (${frames.length} frames, ${Math.round(recBytes / 1024)} KB) — recording stopped`)
    return
  }
  recBytes += raw.length
  frames.push({ t: performance.now() - t0, raw })
}

// Pure assembly, exported for tests: parse each raw frame, unwrap {msgs:[…]}
// into the frame's message list (grouping preserved via the frame records
// themselves), drop messages the view never sees, drop frames that end up
// empty or were never JSON.
//
// Must match the set WsConnection.dispatch consumes without forwarding:
// ping is answered at the connection layer; login_cookie is a credential
// and must not be written to disk.
const SCRUB_TYPES = new Set(['ping', 'login_cookie'])

function lastT(raw: RawFrame[]): number {
  return raw.length ? Math.round(raw[raw.length - 1].t) : 0
}

export function assembleRecording(raw: RawFrame[], wsUrl: string, httpBase: string, recordedAt: string): PzRecording {
  const out: PzFrame[] = []
  for (const f of raw) {
    let parsed: unknown
    try {
      parsed = JSON.parse(f.raw)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const obj = parsed as Record<string, unknown>
    const msgs = Array.isArray(obj['msgs']) ? (obj['msgs'] as unknown[]) : [parsed]
    const kept = msgs.filter((m) => !SCRUB_TYPES.has((m as { msg?: string }).msg ?? ''))
    if (kept.length) out.push({ t: Math.round(f.t), msgs: kept })
  }
  return {
    format: PZREC_FORMAT,
    wsUrl,
    httpBase,
    recordedAt,
    durationMs: lastT(raw),
    frames: out,
  }
}

function clear(): void {
  frames = []
  recBytes = 0
  recWsUrl = ''
  recHttpBase = ''
}

function start(): void {
  active = true
  t0 = performance.now()
  clear()
  console.log('[rec] recording… __dcssRec.stop() when done')
}

function stop(): { frames: number; ms: number } {
  active = false
  const ms = lastT(frames)
  console.log(`[rec] stopped: ${frames.length} frames over ${ms}ms — __dcssRec.save('name') to download`)
  return { frames: frames.length, ms }
}

// The assembled recording as an object (no download) — for playwright
// workflows that page.evaluate the JSON out instead of clicking through
// the browser's download UI.
function json(): PzRecording {
  active = false
  return assembleRecording(frames, recWsUrl, recHttpBase, new Date().toISOString())
}

async function save(name = 'session'): Promise<void> {
  if (!frames.length) {
    console.warn('[rec] nothing recorded')
    return
  }
  const rec = json()
  // Same download path as offline save export: target=_blank + deferred
  // revoke, so touch browsers that fetch the blob asynchronously (iOS
  // Safari) don't lose the capture to a synchronous revocation. Imported
  // lazily so the WS transport (which imports this module for the tap)
  // doesn't pin the offline save stack into the entry chunk.
  const { downloadPackFile } = await import('../offline/save-transfer')
  downloadPackFile(new File([JSON.stringify(rec)], `${name}.pzrec.json`, { type: 'application/json' }))
  console.log(`[rec] saved ${name}.pzrec.json: ${rec.frames.length} frames — move into recordings/ (repo root) and open ?replay=${name}`)
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __dcssRec: unknown }).__dcssRec = {
    start,
    stop,
    save,
    json,
    clear, // drop a saved capture without starting a new one
    status: (): { active: boolean; frames: number; kb: number } =>
      ({ active, frames: frames.length, kb: Math.round(recBytes / 1024) }),
  }
}
