// Finished-game records: the engine's xlog logfile read straight out of
// IDBFS — no engine needed (save-transfer.ts owns the database access rules)
// — plus the pure sort/join helpers the records browser builds its list
// from. The doll joins against the avatars store live here too, both halves
// together: joinDollRecipe for a finished game, liveDollRecipe for the save a
// lobby slot still holds. Reading is safe by construction wherever the
// offline lobby is mounted (nothing else owns the mount there); a mid-game
// read would just see the last persist checkpoint. Paths verified live
// (dev-material/character-cards.md "Step zero").

import { avatarSlotKey, type Avatar } from '../avatars'
import type { DollRecipe } from '../views/avatar-tiles'
import { OFFLINE_GAME_ID, OFFLINE_WS_URL } from './offline-state'
import { deleteOfflineFiles, readOfflineFile, writeOfflineFiles } from './save-transfer'
import { morgueFileName, parseXlog, parseXlogLine, xlogTimeMs, type XlogRecord } from './xlog'

export const LOGFILE_PATH = '/crawl/saves/logfile'
export const MORGUE_DIR = '/crawl/morgue/'

// Every finished game, chronological (the engine appends). We read only
// logfile, never the capped `scores` file — sorting client-side covers both
// views from one parse.
export async function readGameRecords(): Promise<XlogRecord[]> {
  const bytes = await readOfflineFile(LOGFILE_PATH)
  if (bytes === null) return []
  return parseXlog(new TextDecoder().decode(bytes))
}

// A morgue dump's text, or null when missing. Guarded to the morgue dir so a
// crafted DumpRef can't read arbitrary mount files (saves, RC).
export async function readMorgueText(path: string): Promise<string | null> {
  if (!path.startsWith(MORGUE_DIR)) return null
  const bytes = await readOfflineFile(path)
  return bytes === null ? null : new TextDecoder().decode(bytes)
}

// Remove `rec`'s line from raw logfile text, or null when no line parses to
// an equal record. First match only — byte-identical duplicate lines are
// distinct games (engine appends one per finished game), deleted one per call.
// Pure; the IDBFS write lives in deleteGameRecord.
export function stripRecordLine(text: string, rec: XlogRecord): string | null {
  const lines = text.split('\n')
  const idx = lines.findIndex((l) => l.trim() !== '' && recordsEqual(parseXlogLine(l), rec))
  if (idx < 0) return null
  lines.splice(idx, 1)
  return lines.join('\n')
}

function recordsEqual(a: XlogRecord, b: XlogRecord): boolean {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k])
}

// Delete one finished game's record: its logfile line plus its morgue
// .txt/.lst pair. The `scores` file deliberately keeps its copy — we never
// read it, and it's the engine's own file to maintain. Engine-stopped-only,
// like every mutation on this surface.
export async function deleteGameRecord(rec: XlogRecord): Promise<void> {
  const bytes = await readOfflineFile(LOGFILE_PATH)
  const stripped = bytes === null ? null : stripRecordLine(new TextDecoder().decode(bytes), rec)
  if (stripped !== null) {
    await writeOfflineFiles([
      { path: LOGFILE_PATH, mode: 0o100664, mtimeMs: Date.now(), data: new TextEncoder().encode(stripped) },
    ])
  }
  const morgue = rec['name'] ? morgueFileName(rec['name'], rec['end']) : null
  if (morgue) {
    await deleteOfflineFiles([
      MORGUE_DIR + morgue,
      MORGUE_DIR + morgue.replace(/\.txt$/, '.lst'),
    ])
  }
}

export type RecordsSort = 'recent' | 'score'

// Non-mutating: 'recent' orders newest-first by end time (no reliance on the
// input being logfile append order); 'score' by points, newer first on ties.
export function sortRecords(recs: readonly XlogRecord[], mode: RecordsSort): XlogRecord[] {
  const out = [...recs]
  const at = (r: XlogRecord): number => xlogTimeMs(r['end']) ?? 0
  if (mode === 'score') {
    const sc = (r: XlogRecord): number => Number(r['sc']) || 0
    out.sort((a, b) => sc(b) - sc(a) || at(b) - at(a))
  } else {
    out.sort((a, b) => at(b) - at(a))
  }
  return out
}

// The client stamps outcome.endedAt when it receives game_ended — seconds
// after the engine's death_time, so a generous window still can't cross two
// games of the same character.
const JOIN_WINDOW_MS = 10 * 60_000

// Best-effort xlog→doll join against the avatars store. Offline entries are
// keyed (local://offline, character name), and rerolls share that key
// (avatars.ts is a history), so among same-name entries pick by end-time
// proximity, with the avatar's last capture turn ≤ the entry's final turn
// count as a sanity check. The store caps at 20 globally, so most of a long
// logfile won't join — callers degrade to no-thumbnail.
export function joinDollRecipe(rec: XlogRecord, avatars: readonly Avatar[]): DollRecipe | null {
  const name = rec['name']?.toLowerCase()
  if (!name) return null
  const end = xlogTimeMs(rec['end'])
  if (end === null) return null
  const turns = Number(rec['turn'])
  let best: Avatar | null = null
  let bestGap = Infinity
  for (const a of avatars) {
    if (a.wsUrl !== OFFLINE_WS_URL || a.username.toLowerCase() !== name) continue
    if (a.turn != null && Number.isFinite(turns) && a.turn > turns) continue
    if (!a.outcome) continue // live save — its logfile entry doesn't exist yet
    const gap = Math.abs(a.outcome.endedAt - end)
    if (gap <= JOIN_WINDOW_MS && gap < bestGap) {
      best = a
      bestGap = gap
    }
  }
  return best
}

// The doll for a LIVE offline save (the lobby's slot rows) — the other half
// of the store from joinDollRecipe. The slot's current entry is its first
// match in the newest-first list (the same entry saveAvatar upserts against),
// which is the character the save file belongs to. An outcome on it means
// that character finished and the engine unlinked its save, so a slot
// carrying the name again is a different life and must not borrow the dead
// one's doll.
export function liveDollRecipe(name: string, avatars: readonly Avatar[]): DollRecipe | null {
  const key = avatarSlotKey({ wsUrl: OFFLINE_WS_URL, username: name, gameId: OFFLINE_GAME_ID })
  const cur = avatars.find((a) => avatarSlotKey(a) === key)
  return cur && !cur.outcome ? cur : null
}
