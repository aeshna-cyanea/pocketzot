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
