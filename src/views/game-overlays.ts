// Standalone full-screen overlay renderers, split out of game-view.ts: the
// character-creation flow (newgame-choice grid, newgame-random-combo confirm,
// seed-selection) plus the msgwin-get-line input dialog. Each owns one
// ui-push type wholesale — none of them share the title/body/actions frame
// the describe-*/menu overlays get from showUiPush. They build their DOM
// into ctx.overlay (#ui-overlay) after ctx.enterLayout()/ctx.renderOverlay()
// swaps the screen from map/HUD/log to overlay layout, and reach everything
// stateful (WS sends, virtual keyboard, focus) through OverlayScreenCtx so
// no game-view closure state leaks in here.
import type { ClientMsg } from '../ws/types'
import { dcssToHtml, escHtml } from '../game/dcss-colors'
import { stripDcss, type SpellBook } from './overlay-body'

export interface NewgameButton {
  hotkey?: string | number
  label?: string
  labels?: string[]
  x?: number
  y?: number
  description?: string
  highlight_colour?: number
  tile?: Array<{t: number; tex: number}>
}

export interface NewgameGridLabel {
  x: number
  y: number
  label: string
}

export interface NewgameItems {
  buttons?: NewgameButton[]
  labels?: NewgameGridLabel[]
  width?: number
  height?: number
}

export interface UiPushMsg {
  type: string
  title?: string
  prompt?: string
  body?: string
  text?: string
  desc?: string
  tile?: { t: number; tex: number } | Array<{ t: number; tex: number }>
  tiles?: Array<{ t: number; tex: number }>
  highlight?: string
  information?: string
  features?: string
  changes?: string
  actions?: string
  // formatted-scroller: footer text (scroller.cc m_more). Usually empty —
  // scroller set_more() clears it — but carries real content on e.g. the
  // fatal-error popup ("Hit any key to exit…") and arena results.
  more?: string
  feats?: Array<{ title?: string; body?: string; quote?: string; tile?: { t: number; tex: number } }>
  fg_idx?: number  // describe-monster: monster's primary tile id (texture inferred)
  doll?: Array<[number, number]>  // describe-monster: player-doll part [tile_id, ymax] entries
  mcache?: Array<[number, number, number]> | null  // describe-monster: humanoid+equipment [tile_id, xofs, yofs]
  flag?: number | number[]  // describe-monster: status overlay bitmask (attitude, behavior, …); [lo, hi] when MDAM/threat bits overflow 32 bits
  icons?: number[]  // describe-monster: pre-decoded extra icon tile ids
  // describe-monster / describe-item: spell list rendered where SPELLSET_PLACEHOLDER
  // appears in the body. Each book has a header label and a list of spells.
  spellset?: SpellBook[]
  // describe-monster: optional pane fields (cycled via `!` in reference client).
  quote?: string
  status?: string
  // describe-god fields
  name?: string
  colour?: number
  is_altar?: boolean
  description?: string
  favour?: string
  powers_list?: string
  powers?: string
  wrath?: string
  extra?: string
  service_fee?: string
  'main-items'?: NewgameItems
  'sub-items'?: NewgameItems
  // seed-selection: explanatory paragraph rendered below the body, above
  // the pregenerate checkbox; show_pregen_toggle hides the checkbox on
  // dgamelaunch builds (server config), preserving Begin/Clear/Daily.
  footer?: string
  show_pregen_toggle?: boolean
  // msgwin-get-line: stamped by the server; required so our ui_state_sync
  // echoes back the same id (server drops mismatched syncs).
  generation_id?: number
  // formatted-scroller (message log, lookup help, morgue, …): server-side
  // FS_START_AT_END flag (scroller.cc emits it alongside the push). The push
  // is followed by ui-state scroll=INT32_MAX, but those may arrive in a
  // separate WS frame — honoring this flag during the initial render
  // guarantees the first paint is at the bottom even when they don't batch.
  start_at_end?: boolean
}

// The game-view surface these screens render against. All callbacks close
// over game-view's live elements/state so the screens themselves stay inert.
export interface OverlayScreenCtx {
  // #ui-overlay — enterLayout/renderOverlay clear it; screens build into it.
  overlay: HTMLElement
  // Outbound WS send (conn.send).
  send(msg: ClientMsg): void
  // Swap the screen from map/HUD/log to overlay layout: clear + show the
  // overlay, hide everything else. touch:false also hides the touch controls.
  enterLayout(opts?: { touch?: boolean }): void
  // enterLayout + the standard overlay title header; buildBody appends the
  // rest into `overlay` below it.
  renderOverlay(title: string, buildBody: () => void): void
  // Open the virtual keyboard, flagged so overlay teardown auto-closes it.
  autoOpenKbd(): void
  // Return focus to the game view so physical-keyboard input keeps flowing.
  focusView(): void
}

// ?/ search prompts ("Describe what?", "Find what?", ...) arrive as ui-push
// msgwin-get-line — only when a popup layout is already open or no game is
// running (message.cc:1646); in-play line prompts (Ctrl-F, travel depth)
// use the in-log init_input path, and G's branch picker is a tag:"travel"
// menu. The server drives the field via
// ui-state-sync (widget_id "input") and we echo each edit back, so
// generation_id must match. game-view's ui-state-sync handler finds the
// field by its .input-dialog-field class.
export function showInputDialog(ctx: OverlayScreenCtx, msg: UiPushMsg): void {
  const genId = msg.generation_id
  // Touch controls stay visible (enterLayout default) — the kbd-overlay is a
  // fixed-position child of them, and `display:none` on the parent would hide
  // the keyboard too. The keyboard covers the d-pad anyway when open.
  ctx.enterLayout()

  const wrap = document.createElement('div')
  wrap.className = 'input-dialog'

  if (msg.prompt) {
    const promptEl = document.createElement('div')
    promptEl.className = 'input-dialog-prompt'
    promptEl.innerHTML = dcssToHtml(msg.prompt)
    wrap.appendChild(promptEl)
  }

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'input-dialog-field'
  input.autocomplete = 'off'
  input.autocapitalize = 'off'
  input.spellcheck = false
  input.inputMode = 'none'

  input.addEventListener('input', () => {
    if (genId === undefined) return
    ctx.send({
      msg: 'ui_state_sync',
      widget_id: 'input',
      text: input.value,
      cursor: input.selectionStart ?? input.value.length,
      generation_id: genId,
    })
  })

  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      ctx.send({ msg: 'key', keycode: 13 })
    } else if (e.key === 'Escape') {
      e.preventDefault()
      ctx.send({ msg: 'key', keycode: 27 })
    }
  })

  wrap.appendChild(input)
  ctx.overlay.appendChild(wrap)
  ctx.autoOpenKbd()
  requestAnimationFrame(() => input.focus())
}

// Custom-seed entry on newgame. The server pushes title/body/footer text
// and a show_pregen_toggle flag, then drives the seed input and pregen
// checkbox via ui-state-sync (widget_id "seed" / "pregenerate"). Buttons
// use hotkeys: Enter=Begin, '-'=Clear, 'd'=Daily — the server's button
// handlers update the seed input server-side and echo back via sync.
export function showSeedSelection(ctx: OverlayScreenCtx, msg: UiPushMsg): void {
  const genId = msg.generation_id
  // Touch controls stay visible so the kbd-overlay child stays mounted (see
  // showInputDialog for the same reason).
  ctx.enterLayout()

  const wrap = document.createElement('div')
  wrap.className = 'seed-selection'

  if (msg.title) {
    const header = document.createElement('div')
    header.className = 'seed-header'
    header.innerHTML = dcssToHtml(msg.title)
    wrap.appendChild(header)
  }

  if (msg.body) {
    const bodyText = document.createElement('div')
    bodyText.className = 'seed-body-text fg7'
    bodyText.innerHTML = dcssToHtml(msg.body)
    wrap.appendChild(bodyText)
  }

  const row = document.createElement('div')
  row.className = 'seed-input-row'
  const label = document.createElement('span')
  label.className = 'seed-input-label'
  label.textContent = 'Seed:'
  row.appendChild(label)

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'seed-input-field'
  input.autocomplete = 'off'
  input.autocapitalize = 'off'
  input.spellcheck = false
  input.inputMode = 'numeric'
  input.pattern = '\\d*'
  // Revert non-digit input to the last valid value, matching the reference
  // client's _keyfun_seed_input behaviour. Stored on dataset so the
  // ui-state-sync handler can keep it in sync when the server pre-fills.
  input.dataset.lastValid = ''
  input.addEventListener('input', () => {
    if (!/^\d*$/.test(input.value)) {
      input.value = input.dataset.lastValid ?? ''
      return
    }
    input.dataset.lastValid = input.value
    if (genId === undefined) return
    ctx.send({
      msg: 'ui_state_sync',
      widget_id: 'seed',
      text: input.value,
      cursor: input.selectionStart ?? input.value.length,
      generation_id: genId,
    })
  })
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      ctx.send({ msg: 'key', keycode: 13 })
    } else if (e.key === 'Escape') {
      e.preventDefault()
      ctx.send({ msg: 'key', keycode: 27 })
    }
  })
  row.appendChild(input)

  function makeHotkeyBtn(textHtml: string, keycode: number): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.className = 'seed-btn'
    btn.innerHTML = dcssToHtml(textHtml)
    btn.addEventListener('click', () => {
      ctx.send({ msg: 'key', keycode })
      requestAnimationFrame(() => input.focus())
    })
    return btn
  }
  row.appendChild(makeHotkeyBtn('<brown>[-] Clear</brown>', 45))
  row.appendChild(makeHotkeyBtn('<brown>[d] Daily</brown>', 100))
  wrap.appendChild(row)

  if (msg.footer) {
    const footer = document.createElement('div')
    footer.className = 'seed-footer fg7'
    footer.innerHTML = dcssToHtml(msg.footer)
    wrap.appendChild(footer)
  }

  if (msg.show_pregen_toggle) {
    const pregenLabel = document.createElement('label')
    pregenLabel.className = 'seed-pregen'
    const pregen = document.createElement('input')
    pregen.type = 'checkbox'
    pregen.className = 'seed-pregen-checkbox'
    pregen.addEventListener('change', () => {
      if (genId === undefined) return
      ctx.send({
        msg: 'ui_state_sync',
        widget_id: 'pregenerate',
        checked: pregen.checked,
        generation_id: genId,
      })
    })
    const txt = document.createElement('span')
    txt.textContent = 'Fully pregenerate the dungeon'
    pregenLabel.append(pregen, txt)
    wrap.appendChild(pregenLabel)
  }

  const bar = document.createElement('div')
  bar.className = 'seed-button-bar'
  const beginBtn = document.createElement('button')
  beginBtn.className = 'seed-btn seed-btn-primary'
  beginBtn.textContent = '[Enter] Begin!'
  beginBtn.addEventListener('click', () => {
    ctx.send({ msg: 'key', keycode: 13 })
  })
  bar.appendChild(beginBtn)
  wrap.appendChild(bar)

  ctx.overlay.appendChild(wrap)
  ctx.autoOpenKbd()
  requestAnimationFrame(() => input.focus())
}

// "Do you want to play this combination?" confirm after picking a fully
// random character (newgame-random-combo).
export function showRandomCombo(ctx: OverlayScreenCtx, msg: UiPushMsg): void {
  const title = stripDcss(msg.prompt ?? msg.title ?? '')
  ctx.renderOverlay(title, () => {
    const bodyEl = document.createElement('div')
    bodyEl.className = 'overlay-body fg7'
    bodyEl.textContent = 'Do you want to play this combination?'
    ctx.overlay.appendChild(bodyEl)

    const bar = document.createElement('div')
    bar.className = 'overlay-footer overlay-actions'
    const choices: Array<{ key: string; label: string }> = [
      { key: 'Y', label: 'Yes (Y)' },
      { key: 'n', label: 'Reroll (n)' },
      { key: 'q', label: 'Quit (q)' },
    ]
    for (const c of choices) {
      const btn = document.createElement('button')
      btn.className = 'action-btn'
      btn.textContent = c.label
      btn.addEventListener('click', () => {
        ctx.send({ msg: 'input', text: c.key })
        ctx.focusView()
      })
      bar.appendChild(btn)
    }
    ctx.overlay.appendChild(bar)
  })
}

// Species/background/weapon selection grid (ui-push newgame-choice; wire
// shape documented in CLAUDE.md). Rendered as a CSS grid (--ngc-cols) with
// a two-tap confirm UX: first tap shows the description + highlights, second
// tap sends the hotkey. The caller decides what happens to the menu-controls
// bar afterwards (played games get an Esc bar; spectators get nothing) —
// see game-view's dispatch.
export function showNewgameChoice(ctx: OverlayScreenCtx, msg: UiPushMsg): void {
  ctx.enterLayout({ touch: false })

  const wrap = document.createElement('div')
  wrap.className = 'ngc-wrap'
  ctx.overlay.appendChild(wrap)

  const titleHtml = msg.title ?? msg.prompt ?? ''
  if (titleHtml) {
    const titleEl = document.createElement('div')
    titleEl.className = 'overlay-title'
    titleEl.innerHTML = dcssToHtml(titleHtml)
    wrap.appendChild(titleEl)
  }

  // Description panel updated on first tap; second tap on same item confirms
  const descEl = document.createElement('div')
  descEl.className = 'ngc-desc'
  descEl.innerHTML = '<em>Tap to preview, tap again to confirm.</em>'
  let pendingKey: string | null = null
  let pendingBtn: HTMLButtonElement | null = null

  function sendHotkey(hotkey: string | number | undefined): void {
    if (typeof hotkey === 'number') {
      // Non-printable (Bksp=8, Tab=9, Esc=27) must go via {key, keycode};
      // {input, text} is for printable chars only.
      if (hotkey < 32 || hotkey === 127) ctx.send({ msg: 'key', keycode: hotkey })
      else ctx.send({ msg: 'input', text: String.fromCharCode(hotkey) })
    } else if (hotkey) {
      ctx.send({ msg: 'input', text: String(hotkey) })
    }
  }

  function makeBtnHandler(btn: NewgameButton, btnEl: HTMLButtonElement): () => void {
    const keyChar = typeof btn.hotkey === 'number' ? String.fromCharCode(btn.hotkey) : String(btn.hotkey ?? '')
    return () => {
      if (pendingKey === keyChar && pendingBtn === btnEl) {
        sendHotkey(btn.hotkey)
        ctx.focusView()
      } else {
        pendingBtn?.classList.remove('ngc-selected')
        pendingKey = keyChar
        pendingBtn = btnEl
        btnEl.classList.add('ngc-selected')
        const plain = stripDcss(String(btn.labels?.[0] ?? btn.label ?? '')).trim()
        const dashIdx = plain.indexOf(' - ')
        const name = dashIdx >= 0 ? plain.slice(dashIdx + 3) : plain
        const desc = btn.description ?? ''
        descEl.innerHTML =
          `<strong>${escHtml(name)}</strong>${desc ? `<br><span class="ngc-desc-text">${escHtml(desc)}</span>` : ''}<br><em class="ngc-confirm-hint">Tap again to confirm.</em>`
      }
      ctx.focusView()
    }
  }

  function buildGrid(items: NewgameItems, extraClass?: string): HTMLElement {
    const cols = items.width ?? 1
    const buttons = items.buttons ?? []
    const colLabels = items.labels ?? []

    const gridEl = document.createElement('div')
    gridEl.className = extraClass ? `ngc-grid ${extraClass}` : 'ngc-grid'
    gridEl.style.setProperty('--ngc-cols', String(cols))

    // Column header row (y:0 labels)
    if (colLabels.length > 0) {
      for (let c = 0; c < cols; c++) {
        const lbl = colLabels.find(l => l.x === c && l.y === 0)
        const hdr = document.createElement('div')
        hdr.className = 'ngc-col-header'
        if (lbl) hdr.innerHTML = dcssToHtml(lbl.label)
        gridEl.appendChild(hdr)
      }
    }

    // Sort buttons by row then column; fill gaps with empty divs
    const sorted = [...buttons].sort((a, b) => ((a.y ?? 0) - (b.y ?? 0)) || ((a.x ?? 0) - (b.x ?? 0)))
    let curRow = -1
    let curCol = 0

    for (const btn of sorted) {
      const bx = btn.x ?? 0
      const by = btn.y ?? 0
      if (by !== curRow) {
        // Pad rest of previous row
        while (curRow >= 0 && curCol < cols) { gridEl.appendChild(document.createElement('div')); curCol++ }
        curRow = by; curCol = 0
      }
      // Pad columns before this button
      while (curCol < bx) { gridEl.appendChild(document.createElement('div')); curCol++ }

      const labels = btn.labels ?? (btn.label !== undefined ? [btn.label] : [])
      const main = String(labels[0] ?? '').trim()
      const suffix = labels.length >= 2 ? String(labels[1]).trim() : ''
      const btnEl = document.createElement('button')
      btnEl.className = 'ngc-btn'
      if (suffix) {
        // Weapon menu: main label + apt suffix as right-aligned column
        const mainSpan = document.createElement('span')
        mainSpan.className = 'ngc-btn-main'
        mainSpan.innerHTML = dcssToHtml(main)
        const suffixSpan = document.createElement('span')
        suffixSpan.className = 'ngc-btn-suffix'
        suffixSpan.innerHTML = dcssToHtml(suffix)
        btnEl.append(mainSpan, suffixSpan)
      } else {
        btnEl.innerHTML = dcssToHtml(main)
      }
      btnEl.addEventListener('click', makeBtnHandler(btn, btnEl))
      gridEl.appendChild(btnEl)
      curCol++
    }
    return gridEl
  }

  const mainItems = msg['main-items']
  if (mainItems?.buttons?.length) {
    wrap.appendChild(buildGrid(mainItems))
  }

  wrap.appendChild(descEl)

  const subItems = msg['sub-items']
  if (subItems?.buttons?.length) {
    wrap.appendChild(buildGrid(subItems, 'ngc-sub-grid'))
  }

  ctx.focusView()
}
