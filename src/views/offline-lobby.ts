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
import {
  canPlayOffline, downloadOfflineData, NOT_READY_LABEL, probeReadiness, READY_LABEL,
  type Readiness,
} from '../offline/artifact-store'
import { compactPlace, nameTitle } from '../game/char-label'
import { escHtml } from '../game/dcss-colors'
import { deleteCountdownButtons } from './delete-countdown'
import { maybeShowExitDialog } from './lobby'
import { openRcEditor } from './rc-editor'
import { openGameRecords } from './records-view'
import { readGameRecords } from '../offline/game-records'
import type { XlogRecord } from '../offline/xlog'
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
      <div id="offline-readiness" class="offline-ready offline-device-row" hidden>
        <span id="offline-ready-glyph" class="offline-device-glyph is-dot">●</span>
        <span class="offline-device-lines">
          <span id="offline-ready-status" class="offline-device-label">Checking offline data…</span>
          <span id="offline-ready-sub" class="offline-device-sub"></span>
        </span>
        <button type="button" id="offline-download" class="offline-device-btn is-accent" hidden></button>
      </div>
      <div class="lobby-actions">
        <button type="button" id="offline-new" class="lobby-btn-primary">New game</button>
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
      <h2 class="lobby-section-title" id="offline-records-title" hidden>Past Games</h2>
      <div id="offline-records-row" class="lobby-game-row offline-records-row" role="button" tabindex="0" hidden>
        <div class="lobby-game-main">
          <div class="lobby-game-toprow">
            <span class="lobby-game-user">Scores and morgues</span>
          </div>
          <div class="offline-slot-meta">
            <span class="offline-slot-meta-left" id="offline-records-sub"></span>
          </div>
        </div>
      </div>
      <h2 class="lobby-section-title">Storage</h2>
      <div class="offline-device">
        <div class="offline-device-row">
          <span class="offline-device-glyph">✎</span>
          <span class="offline-device-lines">
            <span class="offline-device-label">Options file</span>
            <span class="offline-device-sub">init.txt</span>
          </span>
          <button type="button" id="offline-rc" class="offline-device-btn">Edit</button>
        </div>
        <div class="offline-device-row">
          <span class="offline-device-glyph">⇅</span>
          <span class="offline-device-lines">
            <span class="offline-device-label">Backup</span>
            <span class="offline-device-sub">Saves, morgues, scores, and options</span>
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
  // The play gate (see the readiness section): offline play needs the whole
  // on-device set, so while it's incomplete every launch control runs the
  // download first and then continues into the game it was asked for. Null
  // until the mount-time probe lands.
  let readiness: Readiness | null = null
  let downloading = false

  view.querySelector('#lobby-back')!.addEventListener('click', onBack)

  const launch = (name: string): void => {
    if (launched) return
    launched = true
    onPlay(name)
  }

  // Every launch control routes through here: with the set on device the tap
  // just does its thing, and without it the tap becomes the download and
  // then the thing — rather than a dead end pointing at another row. The
  // ready path stays synchronous so a focus() still lands inside the tap and
  // phones raise the keyboard; the download path can't preserve that.
  function gatedRun(action: () => void): void {
    if (gateOpen()) {
      action()
      return
    }
    void (async () => {
      await readinessProbe
      if (gateOpen() || await runDownload('gate')) action()
    })()
  }

  const gatedLaunch = (name: string): void => {
    // Silent while a download runs: the status row is carrying its live
    // progress label ("Downloading tiles 3/12…"), which answers why the tap
    // did nothing better than a notice repeating it would.
    if (launched || downloading) return
    gatedRun(() => launch(name))
  }

  const showNotice = (text: string): void => {
    noticeEl.textContent = text
    noticeEl.hidden = text === ''
  }

  // --- New character -------------------------------------------------------

  function showNameForm(): void {
    newBtn.hidden = true
    nameForm.hidden = false
    nameInput.focus()
  }

  newBtn.addEventListener('click', () => gatedRun(showNameForm))

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
    gatedLaunch(name)
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
    const resume = (): void => gatedLaunch(name)
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
  // armed with the shared three-tap countdown (delete-countdown.ts).
  function showDeleteConfirm(row: HTMLElement, stem: string, name: string): void {
    const clone = document.createElement('div')
    clone.className = 'lobby-game-row offline-slot-row is-confirming'
    clone.innerHTML = `<span class="offline-slot-confirm-label">Delete ${escHtml(name)}?</span>`
    // The confirm row is one line where the slot row is two — pin the height
    // of the row it replaces so the swap doesn't shift the list.
    clone.style.minHeight = `${row.getBoundingClientRect().height}px`
    const { cancelBtn, delBtn } = deleteCountdownButtons(() => {
      void deleteOfflineSave(stem)
        .then(() => forgetOfflineChar(stem))
        .catch((e: unknown) => showNotice(`Could not delete the save: ${String(e)}`))
        .then(() => refreshSaves())
    })
    // Cancel is a pure-UI undo: the original row (listeners intact) was never
    // removed from memory — put it back rather than re-probing IndexedDB.
    cancelBtn.addEventListener('click', () => {
      clone.replaceWith(row)
    })
    clone.append(cancelBtn, delBtn)
    row.replaceWith(clone)
  }

  // --- Past games ------------------------------------------------------------
  // The section (title + entry row) appears once the logfile has at least one
  // entry (game-records.ts). Records only change when a game ends, which
  // unmounts this lobby — so the mount-time read stays fresh for the row's
  // lifetime and is handed to the browser as-is.

  const recordsRow = view.querySelector<HTMLElement>('#offline-records-row')!
  void readGameRecords().then((recs) => {
    if (!view.isConnected || recs.length === 0) return
    let live: readonly XlogRecord[] = recs
    const subEl = view.querySelector<HTMLElement>('#offline-records-sub')!
    const titleEl = view.querySelector<HTMLElement>('#offline-records-title')!
    const sync = (): void => {
      subEl.textContent = `${live.length} finished game${live.length === 1 ? '' : 's'}`
      titleEl.hidden = live.length === 0
      recordsRow.hidden = live.length === 0
    }
    sync()
    // The browser reports deletes back so the row's count stays true.
    const open = (): void => openGameRecords(live, (remaining) => {
      live = remaining
      sync()
    })
    recordsRow.addEventListener('click', open)
    recordsRow.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        open()
      }
    })
  }).catch(() => {}) // no records row on a probe failure — nothing to browse

  // --- Readiness: "am I ready for the flight?" -------------------------------
  // A probe, never a stored flag (artifact-store.ts): the status re-checks the
  // caches at mount and after every download. The button runs the engine
  // worker's exact fetch path without booting the engine, plus the tiles
  // gamedata the worker never touches. Hidden entirely when the deploy ships
  // no artifacts (the login card hides itself the same way).
  //
  // The row answers three questions in one line, so it sits at the top of the
  // lobby — above the play controls — rather than under "Storage", which is a
  // disk heading for a capability question:
  //   1. am I ready?      → Ready / Not ready to play offline, three states
  //                         total ("partly downloaded" is still not ready, it
  //                         just costs fewer MB to fix).
  //   2. what do I press?  → at most one button, right there.
  //   3. when do I update? → the Update button exists only when there is an
  //                         update, and nothing mentions updating otherwise.
  // Ready is the common case on every launch after the first, so a yes with
  // nothing to press renders as a flat one-line strip; anything actionable
  // (or wrong) is promoted to a full card row.
  //
  // Readiness also gates play (gatedLaunch), but the play controls keep their
  // normal labels: with this row directly above them stating the size, the
  // consent is on screen and adjacent, and "New game" always reads
  // "New game".

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
    // Quiet when the answer is yes and there is nothing to press.
    readinessEl.classList.toggle('is-slim', tone === 'ok' && button === undefined)
    readyGlyphEl.className = `offline-device-glyph is-dot is-${tone}`
    readyGlyphEl.textContent = tone === 'ok' ? '●' : '○'
    readyStatusEl.textContent = label
    // Empty sub collapses (CSS :empty) — the row's min-height holds the
    // shape, so nothing hops when a state switches to download progress.
    readySubEl.textContent = sub ?? ''
    downloadBtn.hidden = button === undefined
    if (button !== undefined) downloadBtn.textContent = button
  }

  // Same game version = a rebuild, and updating is a nothing-burger. A
  // different one is not: the new binary migrates saved games forward on
  // load with no way back. Every surface that can start a download asks this
  // before wording itself.
  function migratesSaves(r: Readiness): boolean {
    return r.state === 'ready' && r.update
      && r.updateVersion !== undefined && r.version !== undefined
      && r.updateVersion !== r.version
  }

  function renderReadiness(r: Readiness): void {
    // Sub-lines name the game version of the pack ("DCSS 0.34.1") when the
    // deploy/cache declares one (version.json `version`, __version stamp —
    // artifact-store.ts); older installs fall back to the unversioned copy.
    if (r.state === 'ready') {
      // Tiles before updates: an available update still plays, a missing
      // tiles half does not — and this row must never read "ready" while
      // gateOpen() is shut, which is exactly what it would do in the state
      // that has both.
      if (!r.tiles) {
        // Engine cached but the tiles half of the set is missing (an
        // interrupted download, or partial eviction). Tiles aren't optional
        // — a stale or absent pack misrenders the map — so this is still
        // "not ready", it just costs less to fix. The button only appears
        // when a download could succeed; an unreachable deploy gets the
        // remedy instead, an artifact-less one no false advice.
        //
        // The deploy only serves its current build at the artifact paths, so
        // finishing necessarily takes any pending update with it. When that
        // crosses a game version, the sub-line says so — pressing the button
        // is then the consent for both.
        setReadiness('warn', NOT_READY_LABEL,
          r.deploy === 'unreachable' ? 'Connect once to finish the download'
            : r.deploy !== 'ok' ? 'Tile data missing'
              : migratesSaves(r)
                ? `Also installs DCSS ${r.updateVersion} — updates saved games`
                : '9 MB left — tile data',
          r.deploy === 'ok' ? 'Finish' : undefined)
      } else if (r.update) {
        setReadiness('ok', READY_LABEL,
          r.updateVersion === undefined ? 'Update available'
            : migratesSaves(r) ? `DCSS ${r.updateVersion} available — updates your saved games`
              : `DCSS ${r.updateVersion} available`,
          'Update')
      } else {
        setReadiness('ok', READY_LABEL, r.version ? `DCSS ${r.version}` : null)
      }
    } else if (r.state === 'not-cached') {
      setReadiness('dim', NOT_READY_LABEL,
        r.version ? `21 MB — DCSS ${r.version}` : '21 MB', 'Download')
    } else if (r.state === 'offline-not-cached') {
      setReadiness('warn', NOT_READY_LABEL, 'Connect once to download')
    } else {
      // undeployed: this checkout/deploy ships no engine. The backup row
      // stays — saves can outlive an artifact-less deploy.
      readinessEl.hidden = true
    }
  }

  // Open when the device holds a complete set — an available engine update
  // does not close it (the cached build still plays, and updating is its own
  // consented tap). A deploy that ships no artifacts opens it too: there is
  // nothing to download, so boot should fail on its own terms rather than
  // behind a button that cannot help.
  function gateOpen(): boolean {
    if (readiness === null) return false
    return readiness.state === 'undeployed' || canPlayOffline(readiness)
  }

  async function refreshReadiness(): Promise<void> {
    const r = await probeReadiness()
    if (!view.isConnected) return
    readiness = r
    renderReadiness(r)
  }

  // The single download path, shared by the status row's button ('button')
  // and by the play gate ('gate'). Resolves true when the device came out of
  // it ready to play.
  async function runDownload(from: 'button' | 'gate'): Promise<boolean> {
    if (downloading) return false
    // Nothing can be fetched while the deploy isn't answering — say that
    // plainly instead of letting downloadOfflineData throw the same fact
    // back as a failure.
    if (readiness?.state === 'offline-not-cached'
      || (readiness?.state === 'ready' && readiness.deploy === 'unreachable')) {
      showNotice('No connection — connect once to download the offline data.')
      return false
    }
    // The deploy serves only its current build, so finishing a partial set
    // installs any pending update along with it. A tap on a play control
    // ("New game", a save row) is not consent to migrate saved games
    // across a game version, so hand that decision back to the status row's
    // button. Silently: the row is directly above, already says "Not ready
    // to play offline", already names what Finish would install, and is
    // already the only button on screen — a notice restating it in warning
    // yellow says the same thing twice.
    if (from === 'gate' && readiness !== null && migratesSaves(readiness)) return false
    downloading = true
    downloadBtn.disabled = true
    newBtn.disabled = true
    showNotice('')
    try {
      // No success notice: the status row flipping to "Ready to play
      // offline" is the confirmation, and it's the one worth reading.
      await downloadOfflineData((label) => setReadiness('dim', label, null))
    } catch (e) {
      showNotice(`Download failed: ${String(e instanceof Error ? e.message : e)}`)
    }
    downloading = false
    downloadBtn.disabled = false
    newBtn.disabled = false
    await refreshReadiness()
    return gateOpen()
  }

  downloadBtn.addEventListener('click', () => { void runDownload('button') })

  const readinessProbe = refreshReadiness()

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
          showNotice('Backup exported.')
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

  // --- Options (RC) file -----------------------------------------------------
  // Safe here for the same reason as import: no engine owns IDBFS while a
  // lobby is mounted. The editor writes only on Save (rc-editor.ts).

  view.querySelector('#offline-rc')!.addEventListener('click', () => {
    void openRcEditor(showNotice).catch((e: unknown) => showNotice(`Could not open the options file: ${String(e)}`))
  })

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
          await writeOfflineFiles(files)
          // The refreshed slot list below is what shows *what* landed; the
          // notice just dates the pack it came from.
          const when = meta.exportedAt ? ` from ${meta.exportedAt.slice(0, 10)}` : ''
          showNotice(`Backup imported${when}.`)
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

