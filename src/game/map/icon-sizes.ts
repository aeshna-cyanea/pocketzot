// Per-icon width lookup for cell.icons stacking — drives the horizontal
// fan-out of server-supplied status icons in cell_renderer.js
// `draw_foreground` via `status_icon_size(id)`:
//   width < 0  → the icon is NOT drawn
//   width == 0 → drawn at its fixed authored position, status_shift unchanged
//   width > 0  → drawn at -status_shift, then status_shift += width
//
// The PRIMARY source is the running version's own generated
// status-icon-sizes.js, loaded from the game server through TileLoader (same
// AMD script-tag path as enums.js) — so upstream width changes arrive with
// zero client edits and the widths are self-consistent with that server's
// icon ids by construction. The table below is the bundled FALLBACK for
// servers predating the module (upstream added it May 2026; 0.34.1+ serve
// it), mirroring the flag-decode.ts / cell-flags.ts pattern. Consume widths
// via getStatusIconSizer, never the table directly.
//
// ICON_SIZE_TABLE is ported from crawl-ref/source/rltiles/icon-sizes.txt —
// the input data file that util/status-icon-sizes-gen.py compiles into the
// generated status-icon-sizes.js. DCSS is Copyright 1997–2025 Linley
// Henzell, the dev team, and contributors; GPL-2.0-or-later. Reused under
// the "or later" option as part of this AGPL-3.0-or-later work. See
// ATTRIBUTION.md and LICENSE.
//
// Table keys are the uppercase tile-constant names (the generator emits
// `case icons.<NAME.upper()>:`); resolved to numeric ids against the loaded
// tileinfo-icons module at runtime. Names not present in the running DCSS
// version's icons module are simply skipped — identical to the C++/JS switch
// falling through to the -1 default — so transcribing the whole table is safe
// across the >= 0.34 versions this client targets.

import type { TileLoader } from '../tiles/tile-loader'

// The shape both sources reduce to: numeric icons-atlas id → width, -1 = skip.
// The server module exports exactly this function; the fallback table wraps
// itself into one via tableStatusIconSizer.
export type StatusIconSizer = (id: number) => number

export const ICON_SIZE_TABLE: Record<string, number> = {
  // Width 0: fixed position (no status_shift contribution).
  BERSERK: 0, IDEALISED: 0, TOUCH_OF_BEOGH: 0, SHADOWLESS: 0, SUMMONED: 0,
  MINION: 0, UNREWARDING: 0, TESSERACT_SPAWN: 0, ANIMATED_WEAPON: 0,
  VENGEANCE_TARGET: 0, VAMPIRE_THRALL: 0, ENKINDLED_1: 0, ENKINDLED_2: 0,
  NOBODY_MEMORY_1: 0, NOBODY_MEMORY_2: 0, NOBODY_MEMORY_3: 0, PYRRHIC: 0,
  FRENZIED: 0, UNSEEN_INVIS_KNOWN: 0, UNSEEN_INVIS_REMEMBERED: 0,

  DRAIN: 6, MIGHT: 6, SWIFT: 6, DAZED: 6, HASTED: 6, SLOWED: 6, CORRODED: 6,
  INFESTED: 6, WEAKENED: 6, PETRIFIED: 6, PETRIFYING: 6, BOUND_SOUL: 6,
  POSSESSABLE: 6, PARTIALLY_CHARGED: 6, FULLY_CHARGED: 6, VITRIFIED: 6,
  CONFUSED: 6, SENTINEL_MARK: 6, DIMMED: 6,

  LACED_WITH_CHAOS: 7, CONC_VENOM: 7, FIRE_CHAMP: 7, INNER_FLAME: 7,
  PAIN_MIRROR: 7, STICKY_FLAME: 7, STRONG_WILLED: 7,

  ANGUISH: 8, FIRE_VULN: 8, RESISTANCE: 8, GHOSTLY: 8, MALMUTATED: 8,
  MAGNETISED: 8, SEEN_INVIS: 8, PHASE_SHIFT: 8,

  RECALL: 9, TELEPORTING: 9, FIGMENT: 9,

  BLIND: 10, BRILLIANCE: 10, SLOWLY_DYING: 10, WATERLOGGED: 10, STILL_WINDS: 10,
  ANTIMAGIC: 10, DEFLECT_MISSILES: 10, INJURY_BOND: 10, GLOW_LIGHT: 10,
  GLOW_HEAVY: 10, BULLSEYE: 10, CURSE_OF_AGONY: 10, REGENERATION: 10,
  RETREAT: 10, RIMEBLIGHT: 10, UNDYING_ARMS: 10, BIND: 10, SIGN_OF_RUIN: 10,
  WEAK_WILLED: 10, DOUBLED_VIGOUR: 10, KINETIC_GRAPNEL: 10, TEMPERED: 10,
  HEART: 10, UNSTABLE: 10, VEXED: 10, PARADOX: 10, WARDING: 10, SUNDERING: 10,

  CONSTRICTED: 11, VILE_CLUTCH: 11, PAIN_BOND: 11,
}

// Fallback path: resolve each named icon to its numeric id against the loaded
// tileinfo-icons module and wrap the result as a StatusIconSizer. Mirrors the
// generated `status_icon_size` switch, including its `default: -1`.
export function tableStatusIconSizer(
  iconsModule: Record<string, unknown>,
): StatusIconSizer {
  const map = new Map<number, number>()
  for (const name in ICON_SIZE_TABLE) {
    const id = iconsModule[name]
    if (typeof id === 'number') map.set(id, ICON_SIZE_TABLE[name])
  }
  return (id) => map.get(id) ?? -1
}

// One resolved sizer per TileLoader (= per game version), so the server-module
// attempt happens once per version rather than once per painted monster. Keyed
// weakly: an evicted loader's entry goes with it.
const sizerByLoader = new WeakMap<TileLoader, Promise<StatusIconSizer>>()

// The one entry point for status-icon widths: the server's own
// status-icon-sizes.js when it loads (0.34.1+), else the bundled table
// resolved against this version's tileinfo-icons. Rejects only if the icons
// module itself fails too — callers already handle that load failing.
export function getStatusIconSizer(loader: TileLoader): Promise<StatusIconSizer> {
  const cached = sizerByLoader.get(loader)
  if (cached) return cached
  const p = loader.loadStatusIconSizes()
    .then((mod) => {
      const f = mod['status_icon_size']
      if (typeof f !== 'function') throw new Error('no status_icon_size export')
      return f as StatusIconSizer
    })
    .catch((err) => {
      // Expected on pre-0.34.1 servers (module not served); on modern servers
      // this is the canary that upstream moved or reshaped the module.
      console.warn('[icon-sizes] server status-icon-sizes.js unavailable, using bundled table:',
        err instanceof Error ? err.message : err)
      return loader.getModule('icons').then(tableStatusIconSizer)
    })
  sizerByLoader.set(loader, p)
  // Evict a rejected result (both sources failed) so a later call retries,
  // matching TileLoader's own retry-on-eviction behavior.
  p.catch(() => { if (sizerByLoader.get(loader) === p) sizerByLoader.delete(loader) })
  return p
}
