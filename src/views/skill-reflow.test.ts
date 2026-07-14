import { describe, it, expect } from 'vitest'
import { splitHtmlAtCol, reflowSkillCrt, plainText } from './skill-reflow'
import { HUMAN_TRAIN, GNOLL_COST, GNOLL_MASTERED_MANUAL } from './skill-reflow.fixtures'

// Measure columns exactly as the reflow does — tags dropped, each entity counted
// as the one glyph cell it occupies ("Maces &amp; Flails" is 14 columns wide, not
// 18). Every column assertion below only means anything against this, so it has
// to be the module's own definition of rendered text, not a second copy of it.
const text = plainText
const plain = (lines: string[]): string[] => lines.map(text)

describe('splitHtmlAtCol', () => {
  it('splits plain text at the column', () => {
    expect(splitHtmlAtCol('abcdef', 3)).toEqual(['abc', 'def'])
  })

  it('returns all-right for col 0 and all-left for col past the end', () => {
    expect(splitHtmlAtCol('abc', 0)).toEqual(['', 'abc'])
    expect(splitHtmlAtCol('abc', 9)).toEqual(['abc', ''])
  })

  it('splits cleanly at a span boundary without leaving an empty span', () => {
    const line = '<span class="a">L    </span><span class="b">R</span>'
    const [l, r] = splitHtmlAtCol(line, 5)
    expect(l).toBe('<span class="a">L    </span>')
    expect(r).toBe('<span class="b">R</span>')
  })

  it('closes and reopens a span that straddles the cut', () => {
    const [l, r] = splitHtmlAtCol('<span class="c">abcdef</span>', 3)
    expect(l).toBe('<span class="c">abc</span>')
    expect(r).toBe('<span class="c">def</span>')
  })

  it('counts an HTML entity as a single column', () => {
    const [l, r] = splitHtmlAtCol('a&amp;b', 2)
    expect(l).toBe('a&amp;')
    expect(r).toBe('b')
  })

  it('keeps leading spaces on the left and the right cell intact', () => {
    const line = '   <span class="b">R col</span>'
    const [l, r] = splitHtmlAtCol(line, 3)
    expect(l).toBe('   ')
    expect(r).toBe('<span class="b">R col</span>')
  })
})

// The wire format the reflow is built on: both column origins are fixed, and the
// header row is the ruler we measure them with. If these ever fail, the grid
// geometry has moved and the reflow's core assumption is void.
describe('captured grid geometry', () => {
  // Where each capture's grid ends; below it lies free-flowing help text, which
  // obeys none of this (and which the reflow must therefore not treat as a row).
  const FIXTURES = [
    { name: 'human', lines: HUMAN_TRAIN, lastGridRow: 17 },
    { name: 'gnoll', lines: GNOLL_COST, lastGridRow: 18 },
  ]

  it.each(FIXTURES)('$name: the header names both columns, 39 apart', ({ lines }) => {
    const header = text(lines[0])
    expect(header.indexOf('Skill')).toBe(6)
    expect(header.indexOf('Skill', 7)).toBe(45)
  })

  it.each(FIXTURES)('$name: no cell ever reaches the split column', ({ lines, lastGridRow }) => {
    // The left cell's last field (aptitude) is 5 wide and ends at column 39, so
    // column 40 — where the right cell starts — is blank on every grid row. This
    // is what makes a fixed-column split safe.
    for (const line of lines.slice(0, lastGridRow + 1).map(text)) {
      if (line.length > 40) expect(line[40]).toBe(' ')
    }
  })

  it.each(FIXTURES)('$name: help text below the grid is not grid-shaped', ({ lines, lastGridRow }) => {
    // It flows from column 1 and straight through the split, so a reflow that
    // guessed the grid's extent from content could swallow and bisect it.
    const help = lines.slice(lastGridRow + 1).map(text).filter(l => l.trim())
    expect(help.length).toBeGreaterThan(0)
    for (const line of help) expect(line[1]).not.toBe(' ')
  })
})

describe('reflowSkillCrt', () => {
  it('stacks left-column then right-column skills in a→z order', () => {
    const out = plain(reflowSkillCrt(HUMAN_TRAIN)!)
    const skills = out
      .map(t => /^\s*([a-z]) [+\-*] ([\w ·]+?)\s{2}/.exec(t))
      .filter(Boolean)
      .map(m => `${m![1]}:${m![2]}`)
    expect(skills).toEqual([
      'a:Fighting',
      'b:Maces · Flails',
      'c:Axes',
      'd:Polearms',
      'e:Unarmed Combat',
      'f:Armour',
      'g:Dodging',
      'h:Shields',
      'i:Stealth',
      'j:Spellcasting',
    ])
  })

  it('keeps a single column header at the top (drops the duplicated right copy)', () => {
    const out = plain(reflowSkillCrt(HUMAN_TRAIN)!)
    expect(out[0]).toBe('      Skill           Level Train  Apt')
  })

  it('re-indents right-column cells onto the left column, keeping the fields aligned', () => {
    const out = plain(reflowSkillCrt(HUMAN_TRAIN)!)
    const fighting = out.find(t => /Fighting/.test(t))!
    const spellcasting = out.find(t => /Spellcasting/.test(t))!
    // Same frame: hotkey at 2, sign at 4, name at 6 — as in the left column.
    expect(fighting.indexOf('a')).toBe(2)
    expect(spellcasting.indexOf('j')).toBe(2)
    expect(fighting.indexOf('Fighting')).toBe(6)
    expect(spellcasting.indexOf('Spellcasting')).toBe(6)
  })

  it('separates the two column groups with a blank line and a repeated header', () => {
    const out = plain(reflowSkillCrt(HUMAN_TRAIN)!)
    const lastLeft = out.findIndex(t => /Stealth/.test(t))
    const firstRight = out.findIndex(t => /Spellcasting/.test(t))
    expect(firstRight).toBeGreaterThan(lastLeft)
    const between = out.slice(lastLeft + 1, firstRight)
    expect(between).toContain('')
    expect(between.some(t => /Skill\s+Level/.test(t))).toBe(true)
  })

  it('keeps the group separators inside each column, and drops the trailing blanks', () => {
    const out = plain(reflowSkillCrt(HUMAN_TRAIN)!)
    const at = (re: RegExp): number => out.findIndex(t => re.test(t))
    // Blank rows between skill categories survive as blank rows.
    expect(out[at(/Fighting/) + 1]).toBe('')
    expect(out[at(/Unarmed Combat/) + 1]).toBe('')
    // The blank strip that padded the grid out to its full height collapses to a
    // single line of breathing room before the help text.
    expect(out[at(/Spellcasting/) + 1]).toBe('')
    expect(out[at(/Spellcasting/) + 2]).toMatch(/percentage of incoming experience/)
  })

  it('reflows the multi-column help footer to one command per line', () => {
    const out = plain(reflowSkillCrt(HUMAN_TRAIN)!)
    expect(out).toContain(' [?] Help')
    expect(out).toContain(' [=] set a skill target')
    expect(out).toContain(' [/] auto|manual mode')
    expect(out).toContain(' [*] useful|all skills')
    expect(out).toContain(' [_] enhanced|base level')
    expect(out).toContain(' [!] training|cost|targets')
  })

  it('keeps each help command intact, with colours, when split mid-span', () => {
    // The next "[" lives inside the previous command's span, as on the wire.
    const out = reflowSkillCrt(HUMAN_TRAIN)!
    const star = out.find(l => /useful\|all skills/.test(text(l)))!
    expect(text(star)).toBe(' [*] useful|all skills')
    expect(star).toContain('<span class="fg14 bg0">*</span>') // hotkey colour preserved
  })

  it('leaves the explanatory prose below the grid alone', () => {
    const out = plain(reflowSkillCrt(HUMAN_TRAIN)!)
    expect(out).toContain(
      ' The percentage of incoming experience used to train each skill is in brown.'
    )
    expect(out).toContain(' Skills enhanced by cross-training are in green.')
  })

  it('preserves cell colours through the split', () => {
    const out = reflowSkillCrt(HUMAN_TRAIN)!
    const fighting = out.find(l => /Fighting/.test(text(l)))!
    expect(fighting).toContain('<span class="fg6 bg0">31%') // training % stays brown
    const spellcasting = out.find(l => /Spellcasting/.test(text(l)))!
    expect(spellcasting).toContain('<span class="fg8 bg0">j + Spellcasting')
    expect(spellcasting).toContain('<span class="fg15 bg0">-1') // aptitude stays white
  })

  describe('distributed training (no hotkeys)', () => {
    it('stacks left then right columns with no anchor to key off', () => {
      const out = plain(reflowSkillCrt(GNOLL_COST)!)
      const skills = out
        .map(t => /^ {4}\+ ([\w ·]+?)\s{2}/.exec(t))
        .filter(Boolean)
        .map(m => m![1])
      expect(skills).toEqual([
        'Fighting',
        'Maces · Flails',
        'Axes',
        'Polearms',
        'Staves',
        'Unarmed Combat',
        'Throwing',
        'Short Blades',
        'Long Blades',
        'Ranged Weapons',
        'Armour',
        'Dodging',
        'Shields',
        'Stealth',
        'Spellcasting',
        'Conjurations',
        'Hexes',
        'Summonings',
        'Necromancy',
        'Forgecraft',
        'Translocations',
        'Alchemy',
        'Fire Magic',
        'Ice Magic',
        'Air Magic',
        'Earth Magic',
        'Invocations',
        'Evocations',
        'Shapeshifting',
      ])
    })

    it('files a right-column cell whose left half is blank into the right group', () => {
      // Wire lines 9 and 13: the left column's group separator falls opposite a
      // right-column skill, so the line has a cell on one side only.
      const out = plain(reflowSkillCrt(GNOLL_COST)!)
      const alchemy = out.findIndex(t => /Alchemy/.test(t))
      expect(out[alchemy].indexOf('Alchemy')).toBe(6) // aligned, not left as padding
      expect(alchemy).toBeGreaterThan(out.findIndex(t => /Stealth/.test(t)))
      // …and the blank it left behind still separates the left column's groups.
      expect(out[out.findIndex(t => /Throwing/.test(t)) + 1]).toBe('')
    })

    it('keeps the cost view header (Level/Cost, not Level/Train)', () => {
      const out = plain(reflowSkillCrt(GNOLL_COST)!)
      expect(out[0]).toBe('      Skill           Level Cost   Apt')
    })
  })

  describe('mastered skills (level 27: no hotkey, no sign — nothing to anchor on)', () => {
    it('keeps a mastered left cell as the grid row it is, once', () => {
      // Fighting sits directly under the header. Reading it as anything but a
      // grid row swept it into the head block, where it was then duplicated at
      // the column break.
      const out = plain(reflowSkillCrt(GNOLL_MASTERED_MANUAL)!)
      expect(out.filter(t => /Fighting/.test(t))).toHaveLength(1)
      const fighting = out.findIndex(t => /Fighting/.test(t))
      expect(out[fighting].indexOf('Fighting')).toBe(6) // aligned with the signed rows
      expect(fighting).toBe(1) // still the first row of the grid, under the header
      expect(out.filter(t => /Skill\s+Level/.test(t))).toHaveLength(2) // one header per column
    })

    it('keeps a lone mastered right cell in the right column, in order', () => {
      // Alchemy is mastered AND alone on its line (the left half is a group
      // separator) — the `Shapeshifting 27 -2` shape. It must join the right
      // column aligned, not fall through to the help footer.
      const out = plain(reflowSkillCrt(GNOLL_MASTERED_MANUAL)!)
      const alchemy = out.findIndex(t => /Alchemy/.test(t))
      expect(out[alchemy].indexOf('Alchemy')).toBe(6)
      expect(alchemy).toBeGreaterThan(out.findIndex(t => /Translocations/.test(t)))
      expect(alchemy).toBeLessThan(out.findIndex(t => /Fire Magic/.test(t)))
    })

    it('reproduces the game’s own level-column stagger rather than tidying it', () => {
      // A mastered level prints as a bare integer flush at the field's start;
      // "%4.1f" levels right-align one column further in. Cells pass through
      // untouched, so both land exactly where the terminal puts them.
      const out = plain(reflowSkillCrt(GNOLL_MASTERED_MANUAL)!)
      expect(out.find(t => /Fighting/.test(t))!.indexOf('27')).toBe(22)
      expect(out.find(t => /Alchemy/.test(t))!.indexOf('27')).toBe(22)
      expect(out.find(t => /Axes/.test(t))!.indexOf('4.4')).toBe(23)
    })
  })

  describe('skill manuals (the widest the aptitude field ever gets)', () => {
    // A manual appends a lightred "+4" to the aptitude, filling that field to its
    // full 5 columns. In the left column that pushes the cell out to column 39 —
    // one short of the split — leaving a single space before the right cell
    // instead of the usual run of padding. The right column does not move.
    //
    // The wire also runs that lightred span on past the split, over the right
    // cell's leading blanks, so this is the case that exercises splitting a span
    // that straddles the cut and reopening it on the far side.
    it('lets the left cell reach column 39 without touching the split', () => {
      const axes = text(GNOLL_MASTERED_MANUAL[4])
      expect(axes.slice(35, 40)).toBe('+8 +4') // aptitude fills its field exactly
      expect(axes[40]).toBe(' ') // …and still stops short of the right cell
    })

    it('keeps the manual in the left cell, out of the right one', () => {
      const out = reflowSkillCrt(GNOLL_MASTERED_MANUAL)!
      const axes = out.find(l => /Axes/.test(text(l)))!
      const hexes = out.find(l => /Hexes/.test(text(l)))!
      expect(text(axes)).toMatch(/\+8 \+4$/)
      expect(axes).toContain('<span class="fg12 bg0">+4') // manual stays lightred
      expect(text(hexes)).not.toMatch(/\+4/) // and does not bleed rightwards
      expect(text(hexes).indexOf('Hexes')).toBe(6) // right cell still aligned
    })

    it('keeps a right-column manual, which runs to the line’s full width', () => {
      const out = reflowSkillCrt(GNOLL_MASTERED_MANUAL)!
      const shapeshifting = out.find(l => /Shapeshifting/.test(text(l)))!
      expect(text(shapeshifting)).toMatch(/\+7 \+4$/)
      expect(shapeshifting).toContain('<span class="fg12 bg0">+4')
    })
  })

  it('passes the experience-menu title through whole (not clipped at the split)', () => {
    // Potion of experience: the same grid, under a full-width prose title.
    const title = ' You have gained great experience. Select the skills to train.'
    const out = plain(reflowSkillCrt([title, ...HUMAN_TRAIN])!)
    expect(out[0]).toBe(title)
    expect(out[1]).toBe('      Skill           Level Train  Apt') // header still deduped
    expect(out.some(t => /Spellcasting/.test(t))).toBe(true) // and the grid still stacks
  })

  it('declines to reflow a grid it cannot measure, rather than guessing', () => {
    // Without the header row there is no ruler for the columns. Returning null
    // (not the lines) is what lets game-view keep the screen pannable instead of
    // word-wrapping a 79-column grid it cannot unstack.
    expect(reflowSkillCrt(HUMAN_TRAIN.slice(1))).toBeNull()
    expect(reflowSkillCrt(['Welcome to the dungeon.', '', 'Press any key.'])).toBeNull()
  })
})
