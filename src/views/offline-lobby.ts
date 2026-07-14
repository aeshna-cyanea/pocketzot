// The offline "server" lobby — the on-device analog of the WebTiles lobby
// (views/lobby.ts): same header shell, but the body manages local save slots
// instead of listing live games. One slot = one character name = one
// saves/<stem>.cs package in the engine's IDBFS (see offline-state.ts
// slotStem). Save files are ground truth where the browser lets us probe
// (save-transfer.ts listOfflineSaves); the localStorage character records
// supply the display meta and stand in alone when the probe is unavailable.
//
// Mounted only while no engine runs (games mount the game view in its place),
// which is what makes import/delete safe here — nothing else owns IDBFS.

import type { GameExit } from '../ws/types'
import {
  forgetOfflineChar, loadOfflineSlots, slotStem,
  validateOfflineName, OFFLINE_NAME_MAX, type OfflineChar,
} from '../offline/offline-state'
import {
  buildExportPackFile, deleteOfflineSave, downloadPackFile, fetchEngineBuild,
  readOfflineFiles, unpackSave, writeOfflineFiles,
} from '../offline/save-transfer'
import { downloadOfflineData, probeReadiness, type Readiness } from '../offline/artifact-store'
import { compactPlace, nameTitle } from '../game/char-label'
import { escHtml } from '../game/dcss-colors'
import { maybeShowExitDialog } from './lobby'
import { attachScrollCue } from '../util/scroll-cue'

export function buildOfflineLobbyView(
  onPlay: (name: string) => void,
  onBack: () => void,
  exit?: GameExit,
): HTMLElement {
  const view = document.createElement('div')
  view.id = 'lobby-view'
  view.classList.add('offline-lobby')

  view.innerHTML = `
    <div class="lobby-header">
      <button id="lobby-back" class="lobby-btn-ghost" aria-label="Back to login">← Login</button>
      <div class="lobby-account-chip is-guest">
        <span class="lobby-chip-tag">⌂ This device</span>
      </div>
    </div>
    <div class="lobby-scroll">
      <div id="lobby-notice" class="lobby-notice" hidden></div>
      <div class="lobby-actions">
        <button type="button" id="offline-new" class="lobby-btn-primary">New character</button>
        <form id="offline-name-form" class="offline-name-form" hidden>
          <label class="login-label">
            Character name
            <input id="offline-name" type="text" maxlength="${OFFLINE_NAME_MAX}"
                   autocomplete="off" spellcheck="false" autocorrect="off" required />
          </label>
          <div id="offline-name-error" class="login-error" style="display:none" role="alert"></div>
          <button type="submit" class="lobby-btn-primary">Start game</button>
        </form>
      </div>
      <h2 class="lobby-section-title">Saved Games</h2>
      <div id="offline-saves" class="lobby-list">
        <div class="lobby-loading">Loading…</div>
      </div>
      <h2 class="lobby-section-title">Storage</h2>
      <div class="offline-device">
        <div id="offline-readiness" class="offline-device-row" hidden>
          <span id="offline-ready-glyph" class="offline-device-glyph">●</span>
          <span class="offline-device-lines">
            <span id="offline-ready-status" class="offline-device-label">Checking offline data…</span>
            <span id="offline-ready-sub" class="offline-device-sub" hidden></span>
          </span>
          <button type="button" id="offline-download" class="offline-device-btn is-accent" hidden></button>
        </div>
        <div class="offline-device-row">
          <span class="offline-device-glyph">⇅</span>
          <span class="offline-device-lines">
            <span class="offline-device-label">Backup</span>
            <span class="offline-device-sub">Saved games, morgues, and scores in one file</span>
          </span>
          <button type="button" id="offline-export" class="offline-device-btn">Export</button>
          <button type="button" id="offline-import" class="offline-device-btn">Import</button>
        </div>
      </div>
    </div>
  `

  attachScrollCue(
    view.querySelector<HTMLElement>('.lobby-header')!,
    view.querySelector<HTMLElement>('.lobby-scroll')!,
  )

  const savesEl = view.querySelector<HTMLElement>('#offline-saves')!
  const noticeEl = view.querySelector<HTMLElement>('#lobby-notice')!
  const newBtn = view.querySelector<HTMLButtonElement>('#offline-new')!
  const nameForm = view.querySelector<HTMLFormElement>('#offline-name-form')!
  const nameInput = view.querySelector<HTMLInputElement>('#offline-name')!
  const nameError = view.querySelector<HTMLElement>('#offline-name-error')!

  // Stems of the slots currently shown — the new-character collision check
  // and per-row actions key off this. Records-only when the probe is
  // unavailable (listOfflineSaves → null).
  let knownStems = new Set<string>()
  // One boot per mount: every path out of this view unmounts it, so a second
  // tap on any slot/start button would just double-boot the engine.
  let launched = false

  view.querySelector('#lobby-back')!.addEventListener('click', onBack)

  const launch = (name: string): void => {
    if (launched) return
    launched = true
    onPlay(name)
  }

  const showNotice = (text: string): void => {
    noticeEl.textContent = text
    noticeEl.hidden = text === ''
  }

  // --- New character -------------------------------------------------------

  newBtn.addEventListener('click', () => {
    newBtn.hidden = true
    nameForm.hidden = false
    nameInput.focus()
  })

  nameForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    // The collision check below needs the mount-time probe to have landed —
    // knownStems is empty until then, and a fast submit of an existing name
    // would silently resume that character instead of erroring.
    await savesReady
    const name = nameInput.value.trim()
    const problem = validateOfflineName(name)
      ?? (knownStems.has(slotStem(name)) ? 'A saved game already has that name.' : null)
    if (problem) {
      nameError.textContent = problem
      nameError.style.display = ''
      return
    }
    nameError.style.display = 'none'
    launch(name)
  })

  // --- Save slots ----------------------------------------------------------

  async function refreshSaves(): Promise<void> {
    const { stems, chars } = await loadOfflineSlots()
    if (!view.isConnected) return
    knownStems = new Set(stems)
    renderSaves(stems, chars)
  }

  function renderSaves(stems: string[], chars: Record<string, OfflineChar>): void {
    if (stems.length === 0) {
      savesEl.innerHTML = '<div class="lobby-empty">No saved games yet.</div>'
      return
    }
    // Most recently played first; recordless slots (imported saves the
    // browser knows nothing about) trail alphabetically.
    stems.sort((a, b) =>
      (chars[b]?.when ?? 0) - (chars[a]?.when ?? 0)
      || a.localeCompare(b, undefined, { sensitivity: 'base' }))
    savesEl.innerHTML = ''
    for (const stem of stems) savesEl.appendChild(buildSlotRow(stem, chars[stem]))
  }

  function buildSlotRow(stem: string, rec: OfflineChar | undefined): HTMLElement {
    const name = rec?.name ?? stem
    const who = nameTitle(name, rec?.title)
    // Metadata line: identity (XL, combo^god) truncates on the left; position
    // (turn, place) is pinned right and never truncates. The combo comes from
    // milestone snapshots, everything else from live player deltas
    // (offline-state.ts).
    const left: string[] = []
    if (rec?.xl != null) left.push(`XL${rec.xl}`)
    if (rec?.char) left.push(rec.god ? `${rec.char}^${rec.god}` : rec.char)
    else if (rec?.god) left.push(rec.god)
    const right: string[] = []
    if (rec?.turn != null) right.push(`T:${rec.turn}`)
    if (rec?.place) right.push(compactPlace(rec.place, rec.depth))
    if (left.length === 0 && right.length === 0) left.push('Saved game')

    const row = document.createElement('div')
    row.className = 'lobby-game-row offline-slot-row'
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    // The milestone line is fallback-only: rows without one (pre-capture
    // records, imported saves) stay two-line rather than reserving a blank.
    row.innerHTML = `
      <div class="lobby-game-main">
        <div class="lobby-game-toprow">
          <span class="lobby-game-user">${escHtml(who)}</span>
        </div>
        <div class="offline-slot-meta">
          <span class="offline-slot-meta-left">${escHtml(left.join(' '))}</span>
          <span class="offline-slot-meta-right">${escHtml(right.join(' '))}</span>
        </div>
        ${rec?.milestone ? `<span class="offline-slot-milestone">${escHtml(rec.milestone)}</span>` : ''}
      </div>
      <button type="button" class="offline-slot-delete" aria-label="Delete ${escHtml(name)}">✕</button>
    `
    const resume = (): void => launch(name)
    row.addEventListener('click', resume)
    row.addEventListener('keydown', (e) => {
      // Only the row's own keys: Enter/Space on the nested delete button
      // bubbles here, and preventDefault would swallow its activation.
      if (e.target !== row) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        resume()
      }
    })
    row.querySelector('.offline-slot-delete')!.addEventListener('click', (e) => {
      e.stopPropagation()
      showDeleteConfirm(row, stem, name)
    })
    return row
  }

  // Deleting a character is the one irreversible act in this lobby, so the
  // confirm is deliberately heavy: the row swaps to a single-line confirm
  // whose Delete button counts down three taps ("Delete in 3" → 2 → 1) before
  // it fires. Heavier than a yes/no, lighter than typing a word — a stray or
  // fidget tap can't get through it.
  function showDeleteConfirm(row: HTMLElement, stem: string, name: string): void {
    const clone = document.createElement('div')
    clone.className = 'lobby-game-row offline-slot-row is-confirming'
    clone.innerHTML = `
      <span class="offline-slot-confirm-label">Delete ${escHtml(name)}?</span>
      <button type="button" class="offline-slot-confirm-cancel">Cancel</button>
      <button type="button" class="offline-slot-confirm-del">Delete in 3</button>
    `
    // The confirm row is one line where the slot row is two — pin the height
    // of the row it replaces so the swap doesn't shift the list.
    clone.style.minHeight = `${row.getBoundingClientRect().height}px`
    const del = clone.querySelector<HTMLButtonElement>('.offline-slot-confirm-del')!
    let taps = 3
    del.addEventListener('click', () => {
      if (--taps > 0) {
        del.textContent = `Delete in ${taps}`
        return
      }
      del.disabled = true
      void deleteOfflineSave(stem)
        .then(() => forgetOfflineChar(stem))
        .catch((e: unknown) => showNotice(`Could not delete the save: ${String(e)}`))
        .then(() => refreshSaves())
    })
    // Cancel is a pure-UI undo: the original row (listeners intact) was never
    // removed from memory — put it back rather than re-probing IndexedDB.
    clone.querySelector('.offline-slot-confirm-cancel')!.addEventListener('click', () => {
      clone.replaceWith(row)
    })
    row.replaceWith(clone)
  }

  // --- Readiness: "am I ready for the flight?" -------------------------------
  // A probe, never a stored flag (artifact-store.ts): the status re-checks the
  // caches at mount and after every download. The button runs the engine
  // worker's exact fetch path without booting the engine, plus the tiles
  // gamedata the worker never touches. Hidden entirely when the deploy ships
  // no artifacts (the login card hides itself the same way).

  const readinessEl = view.querySelector<HTMLElement>('#offline-readiness')!
  const readyGlyphEl = view.querySelector<HTMLElement>('#offline-ready-glyph')!
  const readyStatusEl = view.querySelector<HTMLElement>('#offline-ready-status')!
  const readySubEl = view.querySelector<HTMLElement>('#offline-ready-sub')!
  const downloadBtn = view.querySelector<HTMLButtonElement>('#offline-download')!

  // One row, four slots: status glyph (● in ok/warn/dim), one-line label,
  // dim sub-line detail, right-aligned action. Every state fills the same
  // slots so the card never reflows into a different shape.
  function setReadiness(
    tone: 'ok' | 'warn' | 'dim',
    label: string,
    sub: string | null,
    button?: string,
  ): void {
    readinessEl.hidden = false
    readyGlyphEl.className = `offline-device-glyph is-${tone}`
    readyStatusEl.textContent = label
    readySubEl.hidden = sub === null
    readySubEl.textContent = sub ?? ''
    downloadBtn.hidden = button === undefined
    if (button !== undefined) downloadBtn.textContent = button
  }

  function renderReadiness(r: Readiness): void {
    if (r.state === 'ready') {
      if (r.update) setReadiness('ok', 'Ready for offline play', 'Engine update available', 'Update')
      else if (!r.tiles) setReadiness('ok', 'Ready for offline play', 'Text mode — tiles not added', 'Add tiles ~ 9 MB')
      else setReadiness('ok', 'Ready for offline play', 'Engine and tiles downloaded')
    } else if (r.state === 'not-cached') {
      setReadiness('warn', 'Not downloaded', 'Offline play needs a one-time download', 'Download ~ 21 MB')
    } else if (r.state === 'offline-not-cached') {
      setReadiness('warn', 'Not downloaded', 'No connection — connect once to download')
    } else {
      // undeployed: this checkout/deploy ships no engine. The backup row
      // stays — saves can outlive an artifact-less deploy.
      readinessEl.hidden = true
    }
  }

  async function refreshReadiness(): Promise<void> {
    const r = await probeReadiness()
    if (view.isConnected) renderReadiness(r)
  }

  downloadBtn.addEventListener('click', () => {
    downloadBtn.disabled = true
    void downloadOfflineData((label) => setReadiness('dim', label, null))
      .then((stats) => {
        // No byte count on purpose: dev/CDN layers can transparently
        // content-decode the .gz artifacts, inflating netBytes well past
        // the size the button promised.
        showNotice(stats.netBytes > 0
          ? 'Downloaded the offline engine and game assets.'
          : 'Offline data verified — everything was already downloaded.')
      })
      .catch((e: unknown) => showNotice(`Download failed: ${String(e instanceof Error ? e.message : e)}`))
      .then(() => {
        downloadBtn.disabled = false
        return refreshReadiness()
      })
  })

  void refreshReadiness()

  // --- Backup export/import --------------------------------------------------
  // Same pack format and rules as the __pzSave console hooks (offline/boot.ts):
  // whole-mount minus regenerable caches. Import is safe here by construction —
  // no engine owns IDBFS while a lobby is mounted.

  // Engine-build stamp for export packs, prefetched at mount: iOS grants
  // navigator.share only a short user-activation window after the tap, so the
  // export gesture must not spend it on the network.
  const buildStamp = fetchEngineBuild()

  view.querySelector('#offline-export')!.addEventListener('click', () => {
    void (async () => {
      try {
        const files = await readOfflineFiles()
        if (files.length === 0) {
          showNotice('Nothing to back up yet — play a game first.')
          return
        }
        // Settled long before any human reaches the button; awaiting it costs
        // a microtask, not activation time.
        const file = buildExportPackFile(files, await buildStamp)
        if (await sharePack(file)) {
          showNotice(`Backup exported (${files.length} files).`)
        }
      } catch (e) {
        showNotice(`Export failed: ${String(e)}`)
      }
    })()
  })

  // Hand the pack to the platform. On touch devices the share sheet is the
  // native save path (Save to Files / AirDrop) — an <a download> there
  // navigates the document to a Quick Look preview whose Close (X) reloads
  // the whole app back to the login screen (user report, 2026-07-13).
  // Desktop keeps the plain download anchor. Returns false when the user
  // cancelled the share sheet (nothing was exported — no success notice).
  async function sharePack(file: File): Promise<boolean> {
    // Both fall-throughs to the anchor are announced in DEV: on device the
    // console is invisible, and a silent fallback is indistinguishable from
    // the share path "not working".
    if (navigator.maxTouchPoints > 0) {
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file] })
          return true
        } catch (e) {
          if ((e as DOMException).name === 'AbortError') return false
          // NotAllowedError (gesture window expired) etc. — fall through to
          // the anchor; a preview detour beats a failed export.
          if (import.meta.env.DEV) showNotice(`DEV: share() threw ${(e as DOMException).name} — download fallback`)
        }
      } else if (import.meta.env.DEV) {
        showNotice('DEV: file share unsupported here — download fallback')
      }
    }
    downloadPackFile(file)
    return true
  }

  view.querySelector('#offline-import')!.addEventListener('click', () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.pzsave'
    input.addEventListener('change', () => {
      const f = input.files?.[0]
      if (!f) return
      void (async () => {
        try {
          const { meta, files } = unpackSave(await f.arrayBuffer())
          const count = await writeOfflineFiles(files)
          const when = meta.exportedAt ? ` from ${meta.exportedAt.slice(0, 10)}` : ''
          showNotice(`Imported ${count} files${when}.`)
        } catch (e) {
          showNotice(`Import failed: ${String(e)}`)
        }
        await refreshSaves()
      })()
    })
    input.click()
  })

  const savesReady = refreshSaves()

  if (exit) maybeShowExitDialog(view, exit)

  return view
}

