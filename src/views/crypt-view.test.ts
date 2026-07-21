// @vitest-environment happy-dom
// The crypt's tap-a-doll drill-down: openCrypt wires each painted doll as a
// tap target (via paintAvatars' decorate hook, index-mapped to the avatars
// list) and openAvatarCard floats the character's card as a centered modal.
// renderCharCard's layout is pinned by char-card.test.ts — these tests cover
// the modal wiring: dialog roles, dismissal, and the morgue-URL tap-through.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Avatar } from '../avatars'
import { fakeStorage } from '../test/fake-storage'
import { openAvatarCard, openCrypt } from './crypt-view'

// Synchronous stand-in for paintAvatars: one box per avatar, decorated with
// its list index — the shape the real orchestration guarantees
// (avatar-tiles.test.ts pins the index mapping across filtered entries).
vi.mock('./avatar-tiles', () => ({
  paintAvatars: vi.fn(async (
    container: HTMLElement,
    avatars: readonly unknown[],
    _scale: number,
    cls: string,
    _signal?: AbortSignal,
    decorate?: (el: HTMLElement, i: number) => void,
  ) => {
    avatars.forEach((_a, i) => {
      const el = document.createElement('div')
      el.classList.add(cls)
      container.append(el)
      decorate?.(el, i)
    })
  }),
}))

function deadAvatar(): Avatar {
  return {
    wsUrl: 'wss://crawl.dcss.io/socket', username: 'u', gameId: 'dcss-0.34',
    charName: 'Bram', title: 'the Chopper', species: 'Minotaur', god: 'Trog',
    xl: 9, place: 'Dungeon', depth: 7,
    httpBase: 'https://crawl.dcss.io', version: 'abc', doll: [[1, 32]], mcache: null,
    turn: 12345, seenAt: 1,
    outcome: { reason: 'dead', message: 'Slain by an orc', dump: 'https://crawl.dcss.io/morgue/u/morgue-u-1', endedAt: 2 },
  } as Avatar
}

const backdrop = (): HTMLElement | null => document.querySelector<HTMLElement>('.crypt-card-backdrop')

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage())
})

afterEach(() => {
  // Unwind whatever a test left open so the shared overlay stack stays clean
  // (bounded — a stuck overlay should fail the next assertion, not hang here).
  for (let i = 0; i < 8 && document.querySelector('.crypt-card-backdrop, .crypt-view'); i++) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  }
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('openAvatarCard', () => {
  it('shows the character card as a labeled dialog', () => {
    openAvatarCard(deadAvatar())
    const bd = backdrop()!
    expect(bd.getAttribute('role')).toBe('dialog')
    expect(bd.getAttribute('aria-label')).toBe('Bram the Chopper')
    expect(bd.querySelector('.char-card-head')!.textContent).toContain('Bram')
    expect(bd.querySelector('.char-card-sub')!.textContent).toContain('Minotaur')
  })

  it('closes on backdrop tap but not on a tap inside the card', () => {
    const a = deadAvatar()
    delete a.outcome // no dump → the card itself is inert
    openAvatarCard(a)
    const bd = backdrop()!
    bd.querySelector<HTMLElement>('.char-card')!.click()
    expect(backdrop()).not.toBeNull()
    bd.click()
    expect(backdrop()).toBeNull()
  })

  it('closes on Escape', () => {
    openAvatarCard(deadAvatar())
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(backdrop()).toBeNull()
  })

  it('opens the morgue URL in a new tab from the card tap', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    openAvatarCard(deadAvatar())
    const card = backdrop()!.querySelector<HTMLElement>('.char-card')!
    expect(card.classList.contains('char-card-tappable')).toBe(true)
    card.click()
    expect(open).toHaveBeenCalledWith('https://crawl.dcss.io/morgue/u/morgue-u-1.txt', '_blank', 'noopener')
  })

  it('renders a non-tappable card when there is no morgue dump', () => {
    const a = deadAvatar()
    a.outcome = { reason: 'quit', endedAt: 2 }
    openAvatarCard(a)
    const card = backdrop()!.querySelector<HTMLElement>('.char-card')!
    expect(card.classList.contains('char-card-tappable')).toBe(false)
    expect(card.querySelector('.char-card-open')).toBeNull()
  })
})

describe('openCrypt doll taps', () => {
  it('makes each doll a labeled button that opens its card', async () => {
    localStorage.setItem('pocketzot:avatars', JSON.stringify([deadAvatar()]))
    openCrypt()
    await vi.waitFor(() => {
      expect(document.querySelector('.crypt-doll')).not.toBeNull()
    })
    const doll = document.querySelector<HTMLElement>('.crypt-doll')!
    expect(doll.getAttribute('role')).toBe('button')
    expect(doll.getAttribute('aria-label')).toBe('Bram the Chopper')
    doll.click()
    expect(backdrop()!.querySelector('.char-card-head')!.textContent).toContain('Bram')
  })
})
