import type { Avatar } from '../avatars'
import { bakedDollUrl, dropBakedDoll, ensureDollBaked } from '../game/tiles/avatar-bake'
import { cachedFingerprint, resolvePlayerLoader, seedLocalPlayerAtlas } from '../game/tiles/atlas-dedup'
import type { TileLoader } from '../game/tiles/tile-loader'
import { CELL, renderTiles, dollTileSpec } from '../game/tiles/tile-view'

// Paint saved-character doll recipes (../avatars) into `container` as DOM
// tile-stacks — the same CSS-background tile path the in-game monster panel uses
// (no canvas, so no atlas CORS/taint problem). Shared by the login strip and the
// crypt grid. Each doll's atlas resolves through resolvePlayerLoader
// (../game/tiles/atlas-dedup): recipes whose versions share a player-tileinfo
// fingerprint render off ONE downloaded atlas instead of one per version dir —
// trunk rebuilds mint a new version hash for byte-identical atlases, so without
// this a crypt of dcss-git characters re-downloads the same ~1.2 MB PNG per
// build. A doll is appended only once a compatible atlas resolves, so a pruned
// or unreachable version is skipped outright rather than appended as a blank
// box. Append order follows the list order.
//
// Baked thumbnails (../game/tiles/avatar-bake) are preferred over live
// resolution wherever one exists: they place synchronously with no atlas,
// network, or live version dir needed. Entries without a bake go through the
// live path, which first lets the on-device tiles pack claim its fingerprint
// group (seedLocalPlayerAtlas) so matching recipes render off the same-origin
// /gamedata/local/ atlas — airplane-mode capable — and get baked for next time.
//
// `signal`: aborting it stops any not-yet-resolved dolls from being appended.
// The loads (already in flight) are left to settle; only the insert is skipped.
// Callers that repaint the same container (the login strip toggling its pref)
// pass a fresh signal each time and abort the previous paint, so a slow atlas
// from a superseded call can't land in — or duplicate — the current render.
// The subset of an Avatar that painting actually reads — the doll recipe and
// its atlas identity. Full Avatars satisfy it structurally; the char-card
// model carries exactly this shape for entries joined from other sources.
export type DollRecipe = Pick<Avatar, 'doll' | 'mcache' | 'httpBase' | 'version' | 'fp'>

// `decorate`: called once per placed doll element with the avatar's index in
// the ORIGINAL `avatars` list (empty-spec entries are filtered before painting,
// so the placement index alone would drift past them). The crypt uses it to
// wire per-doll tap targets. A baked thumbnail that self-heals re-places a
// fresh element, which is decorated again — attach listeners, don't toggle.
export async function paintAvatars(
  container: HTMLElement,
  avatars: readonly DollRecipe[],
  scale: number,
  cls: string,
  signal?: AbortSignal,
  decorate?: (el: HTMLElement, index: number) => void,
): Promise<void> {
  const entries = avatars
    .map((a, idx) => ({ spec: dollTileSpec({ doll: a.doll, mcache: a.mcache }), httpBase: a.httpBase, version: a.version, fp: a.fp, idx }))
    .filter((e) => e.spec.length > 0)
  // Start the local-pack group claim now, but only make the LIVE path wait on
  // it: baked entries place immediately, and on the first paint after a pack
  // download the seed's tileinfo load must not delay them. Unbaked entries
  // have to await it anyway — resolving before the claim exists would race
  // them onto their cross-origin atlases.
  const seeded = seedLocalPlayerAtlas()
  // Append each doll the moment ITS atlas resolves, so one slow or unreachable
  // gamedata host can't hold up the dolls behind it (loads run concurrently;
  // the loader registry dedups per version and atlas-dedup per fingerprint).
  // A failed resolve is skipped outright — no blank box — and each doll is
  // inserted at its stored index, so the row stays in list order regardless of
  // which atlas wins the race.
  const placed: Array<HTMLElement | undefined> = []
  const place = (i: number, el: HTMLElement): void => {
    if (signal?.aborted) return
    el.classList.add(cls)
    decorate?.(el, entries[i].idx)
    // Insert before the nearest already-placed later doll to preserve list order.
    let before: HTMLElement | null = null
    for (let j = i + 1; j < entries.length; j++) {
      const p = placed[j]
      if (p) { before = p; break }
    }
    container.insertBefore(el, before)
    placed[i] = el
  }
  // The fingerprint that names this entry's atlas layout: stamped on the
  // entry at capture when available (authoritative — survives the offline
  // pack's content shifting under its constant coords), else the persistent
  // cache filled by earlier live resolves of this version.
  const fpOf = (e: typeof entries[number]): string | null =>
    e.fp ?? cachedFingerprint(e.httpBase, e.version)
  // Resolve one entry live: place its tile-stack, and bake a thumbnail for
  // next time (ensureDollBaked no-ops for cross-origin loaders and existing
  // bakes; fire-and-forget — the paint never waits on a bake).
  const resolveLive = async (e: typeof entries[number], i: number): Promise<TileLoader | null> => {
    await seeded
    const loader = await resolvePlayerLoader(e.httpBase, e.version)
    if (!loader) return null
    place(i, renderTiles(loader, e.spec, scale))
    const fp = fpOf(e)  // a cache-filling resolve may have just minted it
    if (fp != null) void ensureDollBaked(loader, fp, e.spec)
    return loader
  }
  const resolved = await Promise.all(entries.map(async (e, i) => {
    // Baked thumbnail first: instant, and independent of any atlas being
    // reachable. Falls through when this entry's layout was never
    // fingerprinted or never baked.
    const fp = fpOf(e)
    const baked = fp != null ? bakedDollUrl(fp, e.spec) : null
    if (fp != null && baked != null) {
      const img = bakedImg(baked, scale)
      // Self-heal: a stored data-URL that no longer decodes would otherwise
      // be a permanently broken box (the baked path skips live resolution).
      // Drop the bad bake and re-render this doll live.
      img.addEventListener('error', () => {
        dropBakedDoll(fp, e.spec)
        img.remove()
        placed[i] = undefined
        void resolveLive(e, i)
      })
      place(i, img)
      return 'baked' as const
    }
    return resolveLive(e, i)
  }))
  // Second chance for dolls whose version dir is dead: group claims are
  // first-resolver-wins, so a dead-but-newest entry can claim its fingerprint
  // group, fail on its own atlas, and give up before a live same-fingerprint
  // sibling re-claims (seen live: a pruned trunk build alongside a later one).
  // Now that every first attempt has settled, retry the failures whose
  // fingerprint is cached — the only rescuable ones; without a fingerprint
  // there is no group to match, and the entry's own atlas already failed.
  await Promise.all(resolved.map(async (r, i) => {
    if (r) return
    const e = entries[i]
    if (fpOf(e) == null) return
    await resolveLive(e, i)
  }))
}

// A baked thumbnail as a plain <img>, sized like the tile-stack box it stands
// in for (the bake is native 32×32; CSS scales it, pixelated). Exported for
// the character card's sidecar dolls, which arrive as ready data URLs.
export function bakedImg(url: string, scale: number): HTMLElement {
  const img = document.createElement('img')
  img.className = 'doll-bake'
  img.src = url
  img.alt = ''
  img.style.width = `${CELL * scale}px`
  img.style.height = `${CELL * scale}px`
  return img
}
