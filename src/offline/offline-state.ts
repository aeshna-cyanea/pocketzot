// Last-known offline character state, kept in localStorage so the login
// screen's offline card and the offline lobby can label save slots ("Bram the
// Chopper — D:3") without booting the engine or opening its IndexedDB. One
// record per save slot, keyed by the slot's save-file stem (see slotStem);
// boot.ts folds inbound messages in as they flow (player deltas, game_ended).
// A record existing means "we believe this slot has a resumable save" — the
// IDBFS probe (save-transfer.ts listOfflineSaves) is ground truth where the
// browser allows it, and reconcileOfflineChars trues the records up against
// it. Deliberately a leaf module: login.ts lives in the main bundle, and
// importing this must not drag the rest of src/offline/ out of its lazy
// chunk — save-transfer.ts, the one module imported here, is the other leaf.

import type { ServerMsg } from '../ws/types'
import { listOfflineSaves } from './save-transfer'

const KEY = 'pocketzot:offline-chars'
// Pre-slots single-character record, migrated into KEY on first read.
const LEGACY_KEY = 'pocketzot:offline-last'

export interface OfflineChar {
  name: string
  title?: string
  place?: string   // long form off the wire ("Dungeon"); depth composes "D:1"
  depth?: number
  xl?: number
  god?: string
  turn?: number
  // From the engine's starred milestone messages (xlog snapshots — see
  // offlineMilestoneTracker): the 4-letter species/background combo (fixed
  // for the character's life) and the latest milestone text.
  char?: string
  milestone?: string
  when: number
}

// --- Character names ----------------------------------------------------------

export const OFFLINE_NAME_MAX = 30 // MAX_NAME_LENGTH (externs.h)

// The engine names the save file after the character with these characters
// removed (strip_filename_unsafe_chars, stringutil.cc) — the stem is both the
// save's on-disk identity (saves/<stem>.cs) and our record key.
export function slotStem(name: string): string {
  return name.replace(/[ .&`"'|;{}()[\]<>*%$#@!~?]/g, '')
}

// Client-side port of validate_player_name (ng-input.cc): the engine allows
// alphanumerics plus "- . _ space", at most 30 chars. iswalnum under the
// engine's C locale is ASCII-only, so non-ASCII letters are rejected here
// rather than discovered at boot. Returns the problem, or null when valid.
export function validateOfflineName(name: string): string | null {
  if (!name) return 'Enter a name.'
  if (name.length > OFFLINE_NAME_MAX) return `Names are at most ${OFFLINE_NAME_MAX} characters.`
  if (!/^[A-Za-z0-9._ -]+$/.test(name)) return 'Letters, numbers, spaces, and - . _ only.'
  if (!slotStem(name)) return 'A name needs at least one letter or number.'
  return null
}

// --- Records -------------------------------------------------------------------

// Parsed-map cache, keyed on the raw stored string: getOfflineChars runs on
// every player delta (offlineTracker), so re-parsing the whole map per turn
// would put the very allocation TURN_WRITE_EVERY batches away right back on
// the hot path. Comparing the raw string keeps the cache coherent against
// writes from anywhere (other tabs, tests) without an event hook.
let cachedRaw: string | null = null
let cached: Record<string, OfflineChar> = {}

export function getOfflineChars(): Record<string, OfflineChar> {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      if (raw !== cachedRaw) {
        const map = JSON.parse(raw) as Record<string, OfflineChar>
        cached = typeof map === 'object' && map !== null ? map : {}
        cachedRaw = raw
      }
      return cached
    }
    return migrateLegacy()
  } catch {
    return {}
  }
}

// The pre-slots record described exactly one character (hardwired name
// "local"). Carry it over when it still points at a live save — its `reason`
// field said how the last game ended ('saved' and mid-game left a save;
// dead/quit/won unlinked it).
function migrateLegacy(): Record<string, OfflineChar> {
  const map: Record<string, OfflineChar> = {}
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return map
    localStorage.removeItem(LEGACY_KEY)
    const rec = JSON.parse(raw) as { name?: string; title?: string; place?: string
      depth?: number; xl?: number; reason?: string; when?: number }
    if (rec?.name && (rec.reason === undefined || rec.reason === 'saved')) {
      map[slotStem(rec.name)] = {
        name: rec.name, title: rec.title, place: rec.place,
        depth: rec.depth, xl: rec.xl, when: rec.when ?? Date.now(),
      }
      write(map)
    }
  } catch { /* corrupt legacy record — nothing to carry over */ }
  return map
}

function write(map: Record<string, OfflineChar>): void {
  try {
    const raw = JSON.stringify(map)
    localStorage.setItem(KEY, raw)
    cachedRaw = raw
    cached = map
  } catch { /* storage full/blocked — labels just degrade to the stem */ }
}

export function forgetOfflineChar(stem: string): void {
  const map = getOfflineChars()
  if (!(stem in map)) return
  delete map[stem]
  write(map)
}

// True the records up against the actual save files (stems from
// listOfflineSaves). null = the browser couldn't be probed — records stand.
// Drops records whose save is gone (wiped IDB, deletion from another tab);
// files with no record are the caller's to label by stem alone.
export function reconcileOfflineChars(stems: string[] | null): Record<string, OfflineChar> {
  const map = getOfflineChars()
  if (stems === null) return map
  const live = new Set(stems)
  let changed = false
  for (const stem of Object.keys(map)) {
    if (!live.has(stem)) { delete map[stem]; changed = true }
  }
  if (changed) write(map)
  return map
}

// One-call slot resolution for the display surfaces (login card, offline
// lobby): probe IDBFS for the actual save files, true the records up against
// them, and fall back to the records' own keys when the probe is unavailable
// (null means "unknowable — records stand", not "no saves").
export async function loadOfflineSlots(): Promise<{ stems: string[]; chars: Record<string, OfflineChar> }> {
  const probed = await listOfflineSaves()
  const chars = reconcileOfflineChars(probed)
  return { stems: probed ?? Object.keys(chars), chars }
}

// Endings that unlink the save (end.cc): the slot is gone with them. Anything
// else — 'saved', crash/error (the save's last persist checkpoint resumes) —
// leaves the record in place. Unknown reasons conservatively keep it; resuming
// a missing slot just starts a new game under that name.
const SAVE_GONE = new Set(['dead', 'quit', 'won', 'bailed out', 'cancel'])

// How far the recorded turn count may lag the live one. `turn` advances on
// every player delta; writing localStorage per turn would put a sync write on
// the hot per-turn path for a display-only field, so turn-only changes are
// batched — flushed when any other field changes, every TURN_WRITE_EVERY
// turns, and exactly on game_ended.
const TURN_WRITE_EVERY = 64

// Fold one game's inbound messages into its slot record. Bound to the boot
// name because game_ended carries no identity — and pre-game messages don't
// either. Player messages are per-turn deltas: merge only the fields present,
// and skip the write unless something actually changed (place/xl/title change
// rarely; name never; turn always — see TURN_WRITE_EVERY).
export function offlineTracker(name: string): (msg: ServerMsg) => void {
  const stem = slotStem(name)
  // Latest turn seen but not yet worth its own write.
  let pendingTurn: number | undefined
  return (msg: ServerMsg): void => {
    if (msg.msg === 'player') {
      const map = getOfflineChars()
      const cur = map[stem]
      const next: OfflineChar = { ...(cur ?? { name, when: 0 }) }
      if (msg.name) next.name = msg.name
      if (msg.title) next.title = msg.title
      if (msg.place) next.place = msg.place
      if (msg.depth !== undefined) next.depth = msg.depth
      if (msg.xl !== undefined) next.xl = msg.xl
      // god: "" is meaningful (godless — e.g. after abandoning), not absent.
      if (msg.god !== undefined) {
        if (msg.god) next.god = msg.god
        else delete next.god
      }
      if (msg.turn !== undefined) next.turn = msg.turn
      // A batched turn can be newer than both cur.turn and an absent
      // msg.turn (deltas omit unchanged fields) — fold it in so a
      // meta-triggered write can't regress the recorded turn to the last
      // written one.
      else if (pendingTurn !== undefined) next.turn = pendingTurn
      const metaChanged = !cur
        || cur.name !== next.name || cur.title !== next.title
        || cur.place !== next.place || cur.depth !== next.depth
        || cur.xl !== next.xl || cur.god !== next.god
      if (!metaChanged) {
        if (next.turn === cur.turn) return
        // Turn moved but nothing else: batch, unless it drifted far enough
        // (or backwards — a new game reusing the slot name).
        if (next.turn !== undefined && cur.turn !== undefined
          && next.turn > cur.turn && next.turn - cur.turn < TURN_WRITE_EVERY) {
          pendingTurn = next.turn
          return
        }
      }
      pendingTurn = undefined
      next.when = Date.now()
      map[stem] = next
      write(map)
    } else if (msg.msg === 'game_ended') {
      const map = getOfflineChars()
      if (SAVE_GONE.has(msg.reason)) {
        if (stem in map) { delete map[stem]; write(map) }
      } else if (map[stem]) {
        map[stem] = {
          ...map[stem],
          ...(pendingTurn !== undefined && { turn: pendingTurn }),
          when: Date.now(),
        }
        write(map)
      }
      pendingTurn = undefined
    }
  }
}

// Fold one starred milestone message (mini-server hands over the parsed xlog
// snapshot; every field is a string, empty ones omitted). Only two fields are
// taken: the milestone text and the species/background combo ("DjCj") — the
// snapshot's xl/place/god/turn go stale between milestones, so those keep
// coming from the per-turn player deltas instead.
export function offlineMilestoneTracker(name: string): (fields: Record<string, unknown>) => void {
  const stem = slotStem(name)
  return (fields: Record<string, unknown>): void => {
    const milestone = typeof fields['milestone'] === 'string' ? fields['milestone'] : undefined
    const combo = typeof fields['char'] === 'string' ? fields['char'] : undefined
    if (milestone === undefined && combo === undefined) return
    const map = getOfflineChars()
    const cur = map[stem]
    const next: OfflineChar = { ...(cur ?? { name, when: 0 }) }
    if (milestone !== undefined) next.milestone = milestone
    if (combo !== undefined) next.char = combo
    if (cur && cur.milestone === next.milestone && cur.char === next.char) return
    next.when = Date.now()
    map[stem] = next
    write(map)
  }
}
