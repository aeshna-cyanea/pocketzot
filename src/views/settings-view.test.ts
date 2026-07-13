// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeStorage } from '../test/fake-storage'

vi.stubGlobal('localStorage', fakeStorage())

import { openSettings } from './settings-view'
import {
  builtinSets, cloneSet, encodeControlSet, getActiveControlSet,
  listControlSets, newSetId, saveControlSet,
} from '../game/input/control-sets'
import {
  getPref, LOGIN_SPRITES_CHANGED_EVENT, MONSTER_LIST_MODE_CHANGED_EVENT,
  RENDER_MODE_CHANGED_EVENT,
} from '../prefs'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  document.body.innerHTML = ''
})

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)]

// Strict on ambiguity: sections share segment labels ("Hidden" is both a
// monster-list and a sprites option), and a document-wide match would silently
// resolve by render order. Scope with a root — segGroup for a radiogroup.
function findButton(label: string, root: ParentNode = document): HTMLButtonElement {
  const hits = [...root.querySelectorAll('button')].filter(b => b.textContent === label)
  if (!hits.length) throw new Error(`no button "${label}"`)
  if (hits.length > 1) throw new Error(`ambiguous button "${label}" (${hits.length}) — pass a root`)
  return hits[0] as HTMLButtonElement
}

// A segPref radiogroup, by its aria-label (the section heading).
const segGroup = (label: string) => $(`[aria-label="${label}"]`)!

// A saved custom set whose first two tabs are 3×3 — a second list row to
// switch to, and a 3-col source for the editor's grid-widening tests.
function seedThreeColSet() {
  const set = cloneSet(builtinSets()[0], newSetId(), 'Three cols')
  for (const tab of set.tabs.slice(0, 2)) {
    tab.cols = 3
    tab.slots = tab.slots.slice(0, 9)
  }
  saveControlSet(set)
  return set
}

describe('settings overlay', () => {
  it('lists the built-in set with the active one marked', () => {
    openSettings()
    const rows = $$('.set-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].classList.contains('active')).toBe(true)
    expect(rows[0].querySelector('.set-name')!.textContent).toBe('Standard')
    expect($$('.set-badge')).toHaveLength(1)
  })

  it('activates a set when its row is tapped', () => {
    const custom = seedThreeColSet()
    openSettings()
    $$('.set-row-main')[1].click()
    expect(getActiveControlSet().id).toBe(custom.id)
    expect($$('.set-row')[1].classList.contains('active')).toBe(true)
  })

  it('imports a valid string as a new active custom set, and reports bad ones', () => {
    openSettings()
    findButton('Import…').click()
    const field = $<HTMLTextAreaElement>('.settings-import-field')!

    field.value = 'garbage'
    findButton('Import').click()
    expect($('.settings-error')!.hidden).toBe(false)
    expect($('.settings-error')!.textContent).toContain('not a control-set')

    findButton('Import…').click()  // list re-rendered the collapsed area; reopen
    const field2 = $<HTMLTextAreaElement>('.settings-import-field')!
    field2.value = encodeControlSet({ ...builtinSets()[0], name: 'Imported set' })
    findButton('Import').click()

    const names = $$('.set-name').map(e => e.textContent)
    expect(names).toContain('Imported set')
    expect(getActiveControlSet().name).toBe('Imported set')
  })

  it('duplicates a built-in into an editable custom set', () => {
    openSettings()
    $$('.set-row-more')[0].click()
    findButton('Duplicate').click()
    expect(listControlSets()).toHaveLength(2)
    const custom = listControlSets()[1]
    expect(custom.builtin).toBeUndefined()
    expect(custom.name).toBe('My controls')
    expect(custom.tabs).toEqual(builtinSets()[0].tabs)
  })

  it('creates, edits, and saves a new set through the editor', () => {
    openSettings()
    findButton('＋ New set').click()

    // editor is showing, seeded from the active (Standard) set
    expect($('.settings-h')!.textContent).toBe('New control set')
    const nameInput = $<HTMLInputElement>('.ed-name-input')!
    nameInput.value = 'Edited set'

    // rename the first tab
    const charInput = $<HTMLInputElement>('.ed-tab-char')!
    charInput.value = 'Q'
    charInput.dispatchEvent(new Event('input', { bubbles: true }))

    // an appears-empty label (space) is ignored; blur restores the kept name
    charInput.value = ' '
    charInput.dispatchEvent(new Event('input', { bubbles: true }))
    charInput.dispatchEvent(new Event('blur', { bubbles: true }))
    expect(charInput.value).toBe('Q')

    // shrink the first tab to 3×3
    const firstTabBox = $('.ed-tab')!
    findButton('3×3', firstTabBox).click()
    expect($$('.ed-tab')[0].querySelectorAll('.ed-slot')).toHaveLength(9)

    // reassign its first slot to a macro via the picker
    $$('.ed-slot')[0].click()
    const pickerInput = $<HTMLInputElement>('.ed-picker-text')!
    pickerInput.value = 'za.'
    findButton('Set').click()
    expect($$('.ed-slot')[0].textContent).toBe('za.')

    findButton('Save').click()

    const saved = listControlSets().find(s => s.name === 'Edited set')!
    expect(saved).toBeDefined()
    expect(saved.tabs[0].name).toBe('Q')
    expect(saved.tabs[0].cols).toBe(3)
    expect(saved.tabs[0].slots[0]).toEqual({ text: 'za.' })
    expect(saved.tabs[0].slots).toHaveLength(9)
    // a brand-new set becomes active on save
    expect(getActiveControlSet().id).toBe(saved.id)
  })

  it('a new set opens with every tab at 3×4 even when cloned from a 3×3 set', () => {
    seedThreeColSet()
    openSettings()
    $$('.set-row-main')[1].click()  // activate the custom set (3×3 first tabs)
    findButton('＋ New set').click()
    for (const tab of $$('.ed-tab')) {
      expect(tab.querySelectorAll('.ed-slot')).toHaveLength(12)
    }
    // the 3×3 source keys occupy the first three columns; col 4 is empty
    const faces = [...$$('.ed-tab')[0].querySelectorAll('.ed-slot')].map(s => s.textContent)
    expect(faces.slice(0, 4)).toEqual(['⇥', '5', 'i', '·'])
  })

  it('toggling a tab 4→3→4 in the editor keeps the 4th-column keys', () => {
    openSettings()
    findButton('＋ New set').click()
    const firstTabBox = $('.ed-tab')!
    findButton('3×3', firstTabBox).click()
    findButton('3×4', $('.ed-tab')!).click()
    const faces = $$('.ed-tab')[0].querySelectorAll('.ed-slot')
    expect(faces).toHaveLength(12)
    expect(faces[3].textContent).toBe('o')  // Standard @ row 1 col 4 restored
  })

  it('views a built-in set read-only with inert key faces', () => {
    openSettings()
    $$('.set-row-more')[0].click()
    findButton('View', $$('.set-row-actions')[0]).click()

    expect($('.settings-h')!.textContent).toContain('Standard')
    expect($('.settings-h .set-badge')).not.toBeNull()
    expect($('.ed-name-input')).toBeNull()          // read-only: no name field
    expect($('.ed-size-btn')).toBeNull()            // …and no size toggles
    expect($$('.ed-slot')).toHaveLength(3 * 12)     // Standard's real grids

    // slots are inert faces — no buttons, no tap-narration
    const slot = $$('.ed-slot')[0]
    expect(slot.textContent).toBe('⇥')
    expect(slot.tagName).toBe('DIV')
    slot.click()
    expect($('.ed-slot-info')).toBeNull()

    findButton('Back').click()
    expect($$('.settings-h').map(h => h.textContent)).toContain('Touch controls')
  })

  it('offers Duplicate & edit from a built-in view, saving nothing until Save', () => {
    openSettings()
    $$('.set-row-more')[0].click()
    findButton('View', $$('.set-row-actions')[0]).click()
    findButton('Duplicate & edit').click()
    expect($('.settings-h')!.textContent).toBe('New control set')
    expect(listControlSets()).toHaveLength(1)  // still unsaved
    findButton('Save').click()
    expect(listControlSets()).toHaveLength(2)
  })

  it('views a custom set with an Edit shortcut', () => {
    openSettings()
    $$('.set-row-more')[0].click()
    findButton('Duplicate').click()
    $$('.set-row-more')[1].click()
    findButton('View', $$('.set-row-actions')[1]).click()
    expect($('.settings-h')!.textContent).toBe('My controls')
    expect($('.settings-h .set-badge')).toBeNull()
    findButton('Edit').click()
    expect($('.settings-h')!.textContent).toBe('Edit control set')
  })

  it('describes the current key and typed text in the picker info line', () => {
    openSettings()
    findButton('＋ New set').click()
    $$('.ed-slot')[0].click()  // Standard slot 1 = Tab
    const info = $('.ed-picker-info')!
    expect(info.textContent).toContain('auto-fight')

    const pickerInput = $<HTMLInputElement>('.ed-picker-text')!
    pickerInput.value = 'o'
    pickerInput.dispatchEvent(new Event('input', { bubbles: true }))
    expect(info.textContent).toContain('Auto-explore')
    pickerInput.value = ''
    pickerInput.dispatchEvent(new Event('input', { bubbles: true }))
    expect(info.textContent).toContain('auto-fight')  // back to the current key
  })

  it('assigns a special key on the second tap only', () => {
    openSettings()
    findButton('＋ New set').click()
    $$('.ed-slot')[0].click()
    const f1 = findButton('F1', $('.ed-picker-keys')!)
    f1.click()
    expect($$('.ed-slot')[0].textContent).toBe('⇥')  // armed, not assigned
    expect(f1.classList.contains('armed')).toBe(true)
    expect($('.ed-picker-info')!.textContent).toContain('tap again')
    f1.click()
    expect($$('.ed-slot')[0].textContent).toBe('F1')
    expect($('.ed-picker')!.hidden).toBe(true)
  })

  it('marks the slot\'s current special key in the picker', () => {
    openSettings()
    findButton('＋ New set').click()
    $$('.ed-slot')[0].click()  // holds Tab
    const marked = $$('.ed-key.current')
    expect(marked).toHaveLength(1)
    expect(marked[0].textContent).toBe('⇥')
  })

  it('moves a key by swapping it with a tapped destination', () => {
    openSettings()
    findButton('＋ New set').click()
    $$('.ed-slot')[0].click()
    findButton('Move').click()
    expect($('.ed-move-hint')!.hidden).toBe(false)
    expect($('.ed-picker')!.hidden).toBe(true)
    expect($$('.ed-slot')[0].classList.contains('picking')).toBe(true)

    $$('.ed-slot')[1].click()  // swap ⇥ with 5
    const faces = $$('.ed-slot').map(s => s.textContent)
    expect(faces.slice(0, 2)).toEqual(['5', '⇥'])
    expect($('.ed-move-hint')!.hidden).toBe(true)
  })

  it('cancels a move by tapping the source slot again', () => {
    openSettings()
    findButton('＋ New set').click()
    $$('.ed-slot')[0].click()
    findButton('Move').click()
    $$('.ed-slot')[0].click()
    expect($('.ed-move-hint')!.hidden).toBe(true)
    expect($$('.ed-slot')[0].textContent).toBe('⇥')  // unchanged
  })

  it('accepts a surrogate-pair emoji tab label but not two characters', () => {
    openSettings()
    findButton('＋ New set').click()
    const charInput = $<HTMLInputElement>('.ed-tab-char')!

    charInput.value = 'ab'
    charInput.dispatchEvent(new Event('input', { bubbles: true }))
    charInput.dispatchEvent(new Event('blur', { bubbles: true }))
    expect(charInput.value).toBe('@')  // rejected, original kept

    charInput.value = '🦋'
    charInput.dispatchEvent(new Event('input', { bubbles: true }))
    charInput.dispatchEvent(new Event('blur', { bubbles: true }))
    expect(charInput.value).toBe('🦋')

    findButton('Save').click()
    const saved = listControlSets().find(s => s.name === 'My controls')!
    expect(saved.tabs[0].name).toBe('🦋')
  })

  it('deletes a custom set only after arming the button', () => {
    openSettings()
    $$('.set-row-more')[0].click()
    findButton('Duplicate').click()
    expect(listControlSets()).toHaveLength(2)

    $$('.set-row-more')[1].click()
    const del = findButton('Delete')
    del.click()
    expect(listControlSets()).toHaveLength(2)  // armed, not deleted
    expect(del.textContent).toBe('Really delete?')
    del.click()
    expect(listControlSets()).toHaveLength(1)
  })

  it('morphs the Export button to "Copied ✓" on clipboard success', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    })
    openSettings()
    $$('.set-row-more')[0].click()
    const exp = findButton('Export')
    exp.click()
    await vi.waitFor(() => expect(exp.textContent).toBe('Copied ✓'))
    expect(exp.classList.contains('flash')).toBe(true)
    expect(exp.disabled).toBe(true)
  })

  it('shows the home page as sections', () => {
    openSettings()
    const headings = $$('.settings-h').map(h => h.textContent)
    expect(headings).toEqual([
      'Map display', 'Monster list', 'Character sprites', 'Touch controls', 'Help',
    ])
  })

  it('switches the render mode, persisting and firing the live-apply event', () => {
    const fired = vi.fn()
    window.addEventListener(RENDER_MODE_CHANGED_EVENT, fired)
    try {
      openSettings()
      const [ascii, tiles] = [findButton('ASCII'), findButton('Tiles')]
      expect(ascii.classList.contains('active')).toBe(true)  // default pref
      expect(ascii.getAttribute('aria-checked')).toBe('true')

      tiles.click()
      expect(getPref('mapRenderMode')).toBe('tiles')
      expect(fired).toHaveBeenCalledTimes(1)
      expect(tiles.classList.contains('active')).toBe(true)
      expect(tiles.getAttribute('aria-checked')).toBe('true')
      expect(ascii.classList.contains('active')).toBe(false)
      expect(ascii.getAttribute('aria-checked')).toBe('false')

      tiles.click()  // already active: no-op, no spurious event
      expect(fired).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(RENDER_MODE_CHANGED_EVENT, fired)
    }
  })

  it('switches the monster-list mode, persisting and firing the live-apply event', () => {
    const fired = vi.fn()
    window.addEventListener(MONSTER_LIST_MODE_CHANGED_EVENT, fired)
    try {
      openSettings()
      const seg = segGroup('Monster list')
      const [hidden, full] = [findButton('Hidden', seg), findButton('Full', seg)]
      expect(full.classList.contains('active')).toBe(true)  // default pref

      hidden.click()
      expect(getPref('monsterListMode')).toBe('hidden')
      expect(fired).toHaveBeenCalledTimes(1)
      expect(hidden.classList.contains('active')).toBe(true)
      expect(full.classList.contains('active')).toBe(false)

      hidden.click()  // already active: no-op, no spurious event
      expect(fired).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(MONSTER_LIST_MODE_CHANGED_EVENT, fired)
    }
  })

  it('switches character sprites, persisting and firing the live-apply event', () => {
    const fired = vi.fn()
    window.addEventListener(LOGIN_SPRITES_CHANGED_EVENT, fired)
    try {
      openSettings()
      const seg = segGroup('Character sprites')  // the monster list also has a "Hidden"
      const [hidden, shown] = [findButton('Hidden', seg), findButton('Shown', seg)]
      expect(shown.classList.contains('active')).toBe(true)  // default pref

      hidden.click()
      expect(getPref('loginSprites')).toBe(false)
      expect(fired).toHaveBeenCalledTimes(1)
      expect(hidden.classList.contains('active')).toBe(true)
      expect(shown.classList.contains('active')).toBe(false)
    } finally {
      window.removeEventListener(LOGIN_SPRITES_CHANGED_EVENT, fired)
    }
  })

  it('opens a help doc on top of the settings card', () => {
    openSettings()
    findButton('Gestures').click()
    const backdrops = $$('.doc-backdrop')  // settings reuses the doc shell
    expect(backdrops).toHaveLength(2)
    expect(backdrops[1].querySelector('.doc-title')!.textContent).toBe('Gestures')
    expect(backdrops[1].classList.contains('settings-backdrop')).toBe(false)
  })

  it('closes one overlay layer per Escape, topmost first', () => {
    openSettings()
    findButton('Gestures').click()
    expect($$('.doc-backdrop')).toHaveLength(2)
    const esc = () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    esc()
    // only the top (Gestures) doc closes; the settings card underneath survives
    const remaining = $$('.doc-backdrop')
    expect(remaining).toHaveLength(1)
    expect(remaining[0].querySelector('.doc-title')!.textContent).toBe('Settings')
    esc()
    expect($$('.doc-backdrop')).toHaveLength(0)
  })

  it('opens the Gestures doc extracted from ABOUT.md', () => {
    openSettings()
    findButton('Gestures').click()
    const doc = $$('.doc-backdrop')[1]
    expect(doc.querySelector('.doc-title')!.textContent).toBe('Gestures')
    // the extracted section, not the whole About doc
    expect(doc.querySelector('.doc-body')!.textContent).toContain('minimap')
    expect(doc.querySelector('.doc-body')!.textContent).not.toContain('unofficial')
  })

  it('exports to a visible fallback when the clipboard is unavailable', () => {
    // Force the no-clipboard path so the assertion is deterministic (the
    // clipboard path resolves asynchronously).
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    openSettings()
    $$('.set-row-more')[0].click()
    findButton('Export').click()
    const out = $<HTMLTextAreaElement>('.settings-export-out textarea')!
    expect(out.value).toBe(encodeControlSet(builtinSets()[0]))
  })
})
