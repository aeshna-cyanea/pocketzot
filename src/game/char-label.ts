// Shared character-label composition. The HUD titleline (stats-view), the
// login screen's offline card, and the offline lobby's slot rows all render
// the same "Name the Title" and compact-place forms, so the wire-format
// rules live here once.

import { abbrevPlace } from './place-abbrev'

// Join a character name with its wire title. The title carries its own
// joiner: ones that begin with a comma (", Duchess of …") attach without a
// space, per the reference titleline.
export function nameTitle(name: string, title?: string): string {
  return name && title
    ? (title.startsWith(',') ? name + title : `${name} ${title}`)
    : name || title || ''
}

// The abbreviated branch:depth form the lobby rows, milestones, and morgue
// notes use ("D:5", "Elf:3"); depthless places pass through bare ("Pan").
export function compactPlace(place: string, depth?: number): string {
  return depth ? `${abbrevPlace(place)}:${depth}` : abbrevPlace(place)
}

const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Extract the background ("Berserker") from the game-start welcome line —
// the ONE place the wire states it: the player message carries no job field
// (trunk tileweb.cc _send_player), while main.cc:441 prints
// "Welcome[ back], <name> the <Species> <Job>." on every start/resume.
// Anchoring on the known name AND species (both from the player message)
// makes the parse unambiguous even though names may contain spaces (offline
// allows them) and species names are multi-word ("Vine Stalker"): only the
// job is left to capture. Substring match — msgs lines carry color markup
// and same-turn messages arrive joined.
export function welcomeBackground(line: string, name: string, species: string): string | undefined {
  if (!name || !species) return undefined
  const re = new RegExp(
    `Welcome(?: back)?, ${reEscape(name)} the ${reEscape(species)} ([A-Za-z' -]+)\\.`,
  )
  return re.exec(line)?.[1]
}
