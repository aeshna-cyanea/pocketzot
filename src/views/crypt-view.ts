import { listAllAvatars } from '../avatars'
import { paintAvatars } from './avatar-tiles'
import { pickCryptLine } from './crypt-flavor'
import { mountOverlay } from './overlay'
import { attachScrollCue } from '../util/scroll-cue'

// Full-screen "crypt": the complete retained character history (../avatars),
// painted as a vertical-scrolling 4-wide grid of doll sprites. An opaque full
// screen, not a modal card — so it's dismissed with a "← Back" ghost button (the
// same chrome as the lobby), top-left; Escape also closes it (mountOverlay).
// Mounted on document.body above the login view, opened by tapping the login doll
// strip. The grid mirrors the strip's newest-first order (newest top-left), so the
// strip reads as the crypt's top row.
//
// Heading: a random thematic line (./crypt-flavor) shown on each open, in the
// smaller flavor style (it's prose, not a wordmark).
export function openCrypt(): void {
  if (document.querySelector('.crypt-view')) return // already open — ignore re-taps
  const { view } = mountCryptShell('', '', `
      <p class="crypt-flavor"></p>
      <div class="crypt-grid"></div>
  `)
  // Set via textContent (the flavor lines are author-written plain text).
  view.querySelector<HTMLElement>('.crypt-flavor')!.textContent = pickCryptLine()
  // Scale 2.5 (80px): bigger than the login strip's 64px teaser, but small enough
  // that four fit per row on a phone (the .crypt-grid wraps at 4-ish, centered).
  void paintAvatars(view.querySelector<HTMLElement>('.crypt-grid')!, listAllAvatars(), 2.5, 'crypt-doll')
}

// The full-screen shell shared by the crypt, the records browser, and its
// morgue drill-down: pinned header with the "← Back" ghost button (the same
// chrome as the lobby), scrollable body, scroll-edge cue (hairline under the
// pinned bar while content is scrolled beneath it), Escape dismissal.
// Callers fill the header's right side and the body — static markup only,
// this goes through innerHTML.
export function mountCryptShell(
  extraClass: string,
  headerHtml: string,
  bodyHtml: string,
): { view: HTMLElement; close: () => void } {
  const view = document.createElement('div')
  view.className = extraClass ? `crypt-view ${extraClass}` : 'crypt-view'
  view.innerHTML = `
    <header class="crypt-header">
      <button type="button" class="crypt-back lobby-btn-ghost" aria-label="Back">← Back</button>
      ${headerHtml}
    </header>
    <div class="crypt-scroll">${bodyHtml}</div>
  `
  attachScrollCue(
    view.querySelector<HTMLElement>('.crypt-header')!,
    view.querySelector<HTMLElement>('.crypt-scroll')!,
  )
  const close = mountOverlay(view) // body-mount + Escape-to-close
  const backBtn = view.querySelector<HTMLElement>('.crypt-back')!
  backBtn.addEventListener('click', close)
  // Move focus off the trigger into the dialog, so an Esc dismiss doesn't
  // flip the trigger into :focus-visible and leave a focus ring on it.
  backBtn.focus({ preventScroll: true })
  return { view, close }
}
