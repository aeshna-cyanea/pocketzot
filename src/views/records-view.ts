// The offline records browser ("Past games"): every finished game off the
// engine's logfile as full character cards, sortable by recency or score;
// tapping a card opens its morgue verbatim (fit-terminal keeps the 80-col
// dump aligned on a phone). Rides the crypt-view full-screen shell and is
// opened from the offline lobby only — so no engine owns IDBFS while the
// morgue reads (and record deletes) run. The caller passes the records it
// already read for its row label; they only change when a game ends, which
// unmounts the lobby — or via the morgue view's own delete, reported back
// through `onChange` so the lobby row's count stays true.

import { listAllAvatars } from '../avatars'
import {
  deleteGameRecord, joinDollRecipe, readMorgueText, sortRecords, type RecordsSort,
} from '../offline/game-records'
import type { XlogRecord } from '../offline/xlog'
import { cardHeadline, renderCharCard, xlogToCard, type CharCardModel } from './char-card'
import { mountCryptShell } from './crypt-view'
import { deleteCountdownButtons } from './delete-countdown'
import { fitToWidth } from './fit-terminal'

export function openGameRecords(
  records: readonly XlogRecord[],
  onChange?: (remaining: readonly XlogRecord[]) => void,
): void {
  if (document.querySelector('.records-view')) return // already open
  const { view } = mountCryptShell('records-view', `
      <div class="records-sort">
        <button type="button" class="records-sort-btn is-active" data-sort="recent">Recent</button>
        <button type="button" class="records-sort-btn" data-sort="score">Top scores</button>
      </div>`,
    '<div class="records-list"></div>')

  const listEl = view.querySelector<HTMLElement>('.records-list')!
  // One store read, one join pass, and one card build per open (keyed by
  // record reference — sortRecords copies the array only): re-sorts and
  // post-delete re-renders just re-append the cached elements, so dolls
  // never repaint.
  const avatars = listAllAvatars()
  let live: readonly XlogRecord[] = records
  let mode: RecordsSort = 'recent'
  const cards = new Map(records.map((rec): [XlogRecord, HTMLElement] => {
    const model = xlogToCard(rec, joinDollRecipe(rec, avatars))
    return [rec, renderCharCard(model, {
      onOpen: () => openMorgue(model, rec, () => {
        live = live.filter((r) => r !== rec)
        render()
        onChange?.(live)
      }),
    })]
  }))

  function render(): void {
    listEl.innerHTML = ''
    if (live.length === 0) {
      listEl.innerHTML = '<div class="lobby-empty">No finished games yet.</div>'
      return
    }
    for (const rec of sortRecords(live, mode)) listEl.append(cards.get(rec)!)
  }

  for (const btn of view.querySelectorAll<HTMLButtonElement>('.records-sort-btn')) {
    btn.addEventListener('click', () => {
      view.querySelectorAll('.records-sort-btn').forEach((b) => b.classList.toggle('is-active', b === btn))
      mode = btn.dataset['sort'] as RecordsSort
      render()
    })
  }
  render()
}

// The morgue drill-down: the dump verbatim in a pre, font-fit to the screen
// width so the 80-column tables stay aligned (same treatment as server
// morgues). Stacks over the list via the shared shell — Escape/Back unwind
// one layer at a time. Also owns the record's one destructive action: the ✕
// swaps the header's right side for the delete-countdown confirm
// (delete-countdown.ts) — the detail view scopes the delete to exactly the
// record being looked at.
function openMorgue(model: CharCardModel, rec: XlogRecord, onDeleted: () => void): void {
  const dump = model.dump
  if (dump?.kind !== 'idbfs') return
  const { view, close } = mountCryptShell('records-morgue', `
      <span class="records-morgue-title"></span>
      <button type="button" class="offline-slot-delete records-morgue-del" aria-label="Delete this record">✕</button>`,
    '<pre class="records-morgue-pre">Loading…</pre>')
  view.querySelector<HTMLElement>('.records-morgue-title')!.textContent = cardHeadline(model)
  const pre = view.querySelector<HTMLElement>('.records-morgue-pre')!
  void readMorgueText(dump.path).then((text) => {
    if (!view.isConnected) return
    pre.textContent = text ?? 'The morgue file for this game is gone.'
    fitToWidth(pre)
  }).catch(() => {
    pre.textContent = 'Could not read the morgue file.'
  })

  // Delete confirm: swap title+✕ for Cancel + countdown, in place.
  const header = view.querySelector<HTMLElement>('.crypt-header')!
  const titleEl = view.querySelector<HTMLElement>('.records-morgue-title')!
  const xBtn = view.querySelector<HTMLButtonElement>('.records-morgue-del')!
  xBtn.addEventListener('click', () => {
    // No "Delete X?" label: the slot rows need one to name WHICH slot, but
    // here the record fills the screen — the buttons say the rest, and a
    // label would truncate at phone width anyway.
    const confirm = document.createElement('div')
    confirm.className = 'records-morgue-confirm'
    const { cancelBtn, delBtn } = deleteCountdownButtons(() => {
      void deleteGameRecord(rec).then(() => {
        close()
        onDeleted()
      }, () => {
        // Countdown stays spent — retrying after a transient IDB failure
        // shouldn't demand three more taps.
        delBtn.disabled = false
        delBtn.textContent = 'Failed — retry'
      })
    })
    cancelBtn.addEventListener('click', () => {
      confirm.replaceWith(titleEl, xBtn)
    })
    confirm.append(cancelBtn, delBtn)
    titleEl.remove()
    xBtn.remove()
    header.append(confirm)
  })
}
