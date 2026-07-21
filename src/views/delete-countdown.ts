// The three-tap delete countdown: the shared arming mechanism for the
// offline surfaces' irreversible deletes (slot rows in the offline lobby,
// record cards in the records browser). Deliberately heavy: the Delete
// button counts down three taps ("Delete in 3" → 2 → 1) before it fires —
// heavier than a yes/no, lighter than typing a word, so a stray or fidget
// tap can't get through. Returns the Cancel/Delete pair unmounted; the
// caller owns placement, Cancel wiring, and failure copy. The countdown
// stays spent after firing, so a caller that re-enables the button on
// failure (records-view) gets a one-tap retry.

export function deleteCountdownButtons(
  onConfirm: () => void,
): { cancelBtn: HTMLButtonElement; delBtn: HTMLButtonElement } {
  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'offline-slot-confirm-cancel'
  cancelBtn.textContent = 'Cancel'
  const delBtn = document.createElement('button')
  delBtn.type = 'button'
  delBtn.className = 'offline-slot-confirm-del'
  delBtn.textContent = 'Delete in 3'
  let taps = 3
  delBtn.addEventListener('click', () => {
    if (--taps > 0) {
      delBtn.textContent = `Delete in ${taps}`
      return
    }
    delBtn.disabled = true
    onConfirm()
  })
  return { cancelBtn, delBtn }
}
