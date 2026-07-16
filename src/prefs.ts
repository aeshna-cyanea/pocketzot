import { SPECTATE_SERVERS } from './servers'

const KEY = 'pocketzot:prefs'

// Live-apply events, fired (on window) by setPref itself whenever the named
// pref actually changes — writers never dispatch by hand. Mirrors
// CONTROLS_CHANGED_EVENT in control-sets.ts.

// Lets a live game view swap renderers immediately when the settings page
// (or the two-finger gesture) changes mapRenderMode.
export const RENDER_MODE_CHANGED_EVENT = 'pocketzot:render-mode-changed'
// Same live-apply contract for the monster-list mode (settings ⇄ the in-game
// chevron, which only walks collapsed⇄full) and the login-screen character
// sprites (settings opens over the still-mounted login view).
export const MONSTER_LIST_MODE_CHANGED_EVENT = 'pocketzot:monster-list-mode-changed'
export const LOGIN_SPRITES_CHANGED_EVENT = 'pocketzot:login-sprites-changed'

const PREF_EVENTS: Partial<Record<keyof Prefs, string>> = {
  mapRenderMode: RENDER_MODE_CHANGED_EVENT,
  monsterListMode: MONSTER_LIST_MODE_CHANGED_EVENT,
  loginSprites: LOGIN_SPRITES_CHANGED_EVENT,
}

// 'hidden' is reachable only from the settings page — once hidden there is no
// in-game chip left to tap, so the chevron never cycles into it.
export type MonsterListMode = 'hidden' | 'collapsed' | 'full'

export interface Prefs {
  lastGuestSpectateWsUrl: string | null
  monsterListMode: MonsterListMode
  mapRenderMode: 'ascii' | 'tiles'
  controlSetId: string
  // Character-sprite shelf on the login screen (and with it the crypt, whose
  // only entry point it is). Avatar recipes keep being captured while off, so
  // re-enabling restores a fully populated shelf.
  loginSprites: boolean
  // Date (## YYYY-MM-DD heading) of the newest CHANGELOG.md entry the user has
  // opened "What's new" for. null (or any mismatch) = unread dot shows; a
  // fresh install deliberately starts unread so the first launch surfaces the
  // release notes. See isChangelogUnread in views/docs.ts.
  changelogSeen: string | null
}

const DEFAULTS: Prefs = {
  lastGuestSpectateWsUrl: null,
  monsterListMode: 'full',
  mapRenderMode: 'ascii',
  controlSetId: 'standard',
  loginSprites: true,
  changelogSeen: null,
}

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<Prefs> & { monsterListCollapsed?: boolean }
    const prefs = { ...DEFAULTS, ...parsed }
    // Migrate the pre-tri-state boolean; the stale key lingers in storage
    // harmlessly. Only while the new key is absent — a later explicit choice
    // must not be overridden by the old flag.
    if (parsed.monsterListMode === undefined && parsed.monsterListCollapsed !== undefined) {
      prefs.monsterListMode = parsed.monsterListCollapsed ? 'collapsed' : 'full'
    }
    return prefs
  } catch {
    return { ...DEFAULTS }
  }
}

export function getPref<K extends keyof Prefs>(k: K): Prefs[K] {
  return load()[k]
}

export function setPref<K extends keyof Prefs>(k: K, v: Prefs[K]): void {
  const prefs = load()
  if (JSON.stringify(prefs[k]) === JSON.stringify(v)) return  // no-op: no write, no event
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...prefs, [k]: v }))
  } catch {}
  const event = PREF_EVENTS[k]
  if (event) window.dispatchEvent(new Event(event))
}

export function getLastSpectateServer(): string | null {
  const v = getPref('lastGuestSpectateWsUrl')
  return v && SPECTATE_SERVERS.some(s => s.wsUrl === v) ? v : null
}

export function setLastSpectateServer(wsUrl: string): void {
  setPref('lastGuestSpectateWsUrl', wsUrl)
}
