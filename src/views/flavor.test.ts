import { describe, expect, it } from 'vitest'
import { flavorLabel, SPECTATE_LABELS } from './flavor'

// Each pool paired with the literal word its alternates stand in for.
const POOLS = [
  { name: 'SPECTATE_LABELS', pool: SPECTATE_LABELS, literal: 'Spectate' },
]

describe.each(POOLS)('flavorLabel($name)', ({ pool, literal }) => {
  const count = (word: string): number => pool.filter(w => w === word).length

  it('always returns a member of the pool', () => {
    for (let i = 0; i < 200; i++) expect(pool).toContain(flavorLabel(pool))
  })

  it('weights the literal word heaviest for first-visit grounding', () => {
    // Strictly more entries than any alternate — the weighting is the
    // repetition, so drop the duplicates and this is what notices.
    for (const word of new Set(pool)) {
      if (word !== literal) expect(count(literal)).toBeGreaterThan(count(word))
    }
  })

  it('keeps every alternate no wider than the literal word', () => {
    for (const word of pool) expect(word.length).toBeLessThanOrEqual(literal.length)
  })
})
