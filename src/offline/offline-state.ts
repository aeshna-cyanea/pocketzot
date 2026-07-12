// Last-known offline character state, kept in localStorage so the login
// screen's offline card can label itself ("Resume local the Chopper — D:3")
// without booting the engine or opening its IndexedDB. boot.ts folds inbound
// messages in as they flow (player deltas, game_ended); views/login.ts reads
// it. Deliberately a leaf module: login.ts lives in the main bundle, and
// importing this must not drag the rest of src/offline/ out of its lazy chunk.

import type { ServerMsg } from '../ws/types'

const KEY = 'pocketzot:offline-last'

export interface OfflineLast {
  name?: string
  title?: string
  place?: string   // long form off the wire ("Dungeon"); depth composes "D:1"
  depth?: number
  xl?: number
  // Reason from the last game_ended ('saved', 'dead', 'quit', …). Absent
  // while a game is in progress — including after an abrupt kill, which is
  // exactly the case where the save's last persist checkpoint resumes.
  reason?: string
  when: number
}

export function getOfflineLast(): OfflineLast | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const rec = JSON.parse(raw) as OfflineLast
    return typeof rec === 'object' && rec !== null ? rec : null
  } catch {
    return null
  }
}

// Best guess from the record alone: does a resumable save exist? 'saved' and
// mid-game (no reason) both left a save behind; dead/quit/won unlinked it.
// hasOfflineSave() (save-transfer.ts) is the IDB-backed check that overrides
// this when the browser lets us probe without side effects.
export function offlineLastSaysResumable(rec: OfflineLast | null): boolean {
  return !!rec?.name && (rec.reason === undefined || rec.reason === 'saved')
}

function write(rec: OfflineLast): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(rec))
  } catch { /* storage full/blocked — the card just degrades to "New game" */ }
}

// Fold one inbound offline message into the record. Player messages are
// per-turn deltas — merge only the fields present, and skip the write unless
// something actually changed (place/xl/title change rarely; name never).
export function trackOfflineMsg(msg: ServerMsg): void {
  if (msg.msg === 'player') {
    const cur = getOfflineLast()
    const next: OfflineLast = { ...(cur ?? { when: 0 }) }
    if (msg.name) next.name = msg.name
    if (msg.title) next.title = msg.title
    if (msg.place) next.place = msg.place
    if (msg.depth !== undefined) next.depth = msg.depth
    if (msg.xl !== undefined) next.xl = msg.xl
    // A live game supersedes any previous ending.
    delete next.reason
    if (cur && cur.reason === undefined
      && cur.name === next.name && cur.title === next.title
      && cur.place === next.place && cur.depth === next.depth
      && cur.xl === next.xl) return
    next.when = Date.now()
    write(next)
  } else if (msg.msg === 'game_ended') {
    const cur = getOfflineLast()
    if (!cur?.name) return
    write({ ...cur, reason: msg.reason, when: Date.now() })
  }
}
