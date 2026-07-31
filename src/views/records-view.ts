// The offline records browser ("Past games"): every finished game off the
// engine's logfile as full character cards, sortable by recency or score;
// tapping a card opens its morgue verbatim (fit-terminal keeps the 80-col
// dump aligned on a phone). Rides the crypt-view full-screen shell and is
// opened from the offline lobby only — so no engine owns IDBFS while the
// morgue reads (and record deletes) run. The caller passes the records it
// already read for its row label; nothing else can touch the logfile while
// this full-screen view is up, so the snapshot stays valid for its lifetime.
// Dolls come from each record's own morgue sidecar (game-records.ts,
// materialized by the lobby before this opens) — a deterministic file
// lookup rather than a store join, with the live join kept only as the
// fallback for a record whose sidecar never landed (the lobby's materialize
// is best-effort, and a store write can fail under storage pressure). The
// fallback fades on its own as the avatar history rolls characters off;
// the sidecar is what makes an old record's doll durable. Deletes are signalled
// through `onChange` — the caller re-reads the file rather than trusting our
// in-memory filter.

import { listAllAvatars } from '../avatars'
import {
  deleteGameRecord, joinDollRecipe, readDollSidecars, readMorgueText, sortRecords,
  type RecordsSort,
} from '../offline/game-records'
import type { XlogRecord } from '../offline/xlog'
import { cardHeadline, renderCharCard, xlogToCard, type CharCardModel } from './char-card'
import { mountCryptShell } from './crypt-view'
import { deleteCountdownButtons } from './delete-countdown'
import { fitToWidth } from './fit-terminal'

export function openGameRecords(
  records: readonly XlogRecord[],
  onChange?: () => void,
): void {
  if (document.querySelector('.records-view')) return // already open
  const { view } = mountCryptShell('records-view', `
      <div class="records-sort">
        <button type="button" class="records-sort-btn is-active" data-sort="recent">Recent</button>
        <button type="button" class="records-sort-btn" data-sort="score">Top scores</button>
      </div>`,
    '<div class="records-list"></div>')

  const listEl = view.querySelector<HTMLElement>('.records-list')!
  // One sidecar read and one card build per open (keyed by record reference —
  // sortRecords copies the array only): re-sorts and post-delete re-renders
  // just re-append the cached elements, so dolls never repaint. The list
  // fills when the read lands (a few ms — one IDBFS transaction); sort taps
  // in that window re-render nothing and settle with the fill.
  let live: readonly XlogRecord[] = records
  let mode: RecordsSort = 'recent'
  let cards = new Map<XlogRecord, HTMLElement>()
  void readDollSidecars(records)
    .catch(() => new Map<XlogRecord, string>())
    .then((dolls) => {
      if (!view.isConnected) return
      const avatars = records.length > 0 ? listAllAvatars() : []
      cards = new Map(records.map((rec): [XlogRecord, HTMLElement] => {
        const url = dolls.get(rec)
        // The join rides along even when a sidecar exists: it's the card's
        // repaint fallback if the sidecar PNG turns out undecodable
        // (char-card's <img> error path).
        const model = xlogToCard(rec, url, joinDollRecipe(rec, avatars))
        return [rec, renderCharCard(model, {
          onOpen: () => openMorgue(model, rec, () => {
            live = live.filter((r) => r !== rec)
            render()
            onChange?.()
          }),
        })]
      }))
      render()
    })

  function render(): void {
    listEl.innerHTML = ''
    if (live.length === 0) {
      listEl.innerHTML = '<div class="lobby-empty">No finished games yet.</div>'
      return
    }
    for (const rec of sortRecords(live, mode)) {
      const card = cards.get(rec)
      if (card) listEl.append(card)
    }
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
    pre.textContent = text ?? 'No morgue file for this game.'
    fitToWidth(pre)
  }).catch(() => {
    pre.textContent = 'Could not read the morgue file.'
  })

  // Delete confirm: swap title+✕ for Cancel + countdown, in place.
  const header = view.querySelector<HTMLElement>('.crypt-header')!
  const titleEl = view.querySelector<HTMLElement>('.records-morgue-title')!
  const xBtn = view.querySelector<HTMLButtonElement>('.records-morgue-del')!
  xBtn.addEventListener('click', () => {
    // No "Delete X?" label: the record fills the screen, so the buttons say
    // the rest — and a label would truncate at phone width anyway.
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
