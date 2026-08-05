import { describe, expect, it } from 'vitest'
import { looksLikeWelcome, welcomeBackground } from './char-label'

describe('looksLikeWelcome', () => {
  it('gates the same forms the parser accepts, not other Welcome lines', () => {
    expect(looksLikeWelcome('Welcome, x the Troll Berserker.')).toBe(true)
    expect(looksLikeWelcome('<yellow>Welcome back, x the Troll Berserker.</yellow>')).toBe(true)
    expect(looksLikeWelcome('Welcome back to level 3!')).toBe(false)
    expect(looksLikeWelcome('Welcome back to the Dungeon!')).toBe(false)
  })
})

// The game-start welcome line (trunk main.cc:441):
// "<yellow>Welcome[ back], <name> the <Species> <Job>.</yellow>" — the wire's
// only statement of the background. The parse anchors on the known name and
// species from the player message, leaving only the job to capture.
describe('welcomeBackground', () => {
  it('parses new-game and resume forms', () => {
    expect(welcomeBackground('Welcome, bram the Minotaur Berserker.', 'bram', 'Minotaur'))
      .toBe('Berserker')
    expect(welcomeBackground('Welcome back, bram the Minotaur Berserker.', 'bram', 'Minotaur'))
      .toBe('Berserker')
  })

  it('works through color markup and same-turn joined lines', () => {
    const joined = '<yellow>Welcome back, bram the Minotaur Berserker.</yellow> Trog says: Kill them all!'
    expect(welcomeBackground(joined, 'bram', 'Minotaur')).toBe('Berserker')
  })

  it('handles multi-word species and jobs', () => {
    expect(welcomeBackground(
      'Welcome, x the Vine Stalker Ice Elementalist.', 'x', 'Vine Stalker',
    )).toBe('Ice Elementalist')
  })

  it('anchors on the name, so offline names containing " the " cannot mislead', () => {
    expect(welcomeBackground(
      'Welcome, Bob the Great the Troll Berserker.', 'Bob the Great', 'Troll',
    )).toBe('Berserker')
  })

  it('yields nothing on non-welcome lines or mismatched identity', () => {
    expect(welcomeBackground('Welcome back to level 3!', 'bram', 'Minotaur')).toBeUndefined()
    expect(welcomeBackground('Welcome, other the Minotaur Berserker.', 'bram', 'Minotaur')).toBeUndefined()
    expect(welcomeBackground('Welcome, bram the Minotaur Berserker.', 'bram', 'Troll')).toBeUndefined()
    expect(welcomeBackground('Welcome, bram the Minotaur Berserker.', '', 'Minotaur')).toBeUndefined()
  })
})
