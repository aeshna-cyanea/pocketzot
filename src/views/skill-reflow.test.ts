import { describe, it, expect } from 'vitest'
import { splitHtmlAtCol, reflowSkillCrt } from './skill-reflow'

// Strip tags so tests can assert on rendered text without span noise.
const text = (html: string): string => html.replace(/<[^>]*>/g, '')

describe('splitHtmlAtCol', () => {
  it('splits plain text at the column', () => {
    expect(splitHtmlAtCol('abcdef', 3)).toEqual(['abc', 'def'])
  })

  it('returns all-right for col 0 and all-left for col past the end', () => {
    expect(splitHtmlAtCol('abc', 0)).toEqual(['', 'abc'])
    expect(splitHtmlAtCol('abc', 9)).toEqual(['abc', ''])
  })

  it('splits cleanly at a span boundary without leaving an empty span', () => {
    // Apt span closes exactly at the cut; right cell opens its own span.
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

describe('reflowSkillCrt', () => {
  // A compact stand-in for the real grid: header, two filled rows, an
  // empty-left row (right column longer than left), then help text. Column
  // positions mirror the real layout (right column begins at index 20).
  const L = (s: string): string => `<span class="fg7 bg0">${s}</span>`
  const lines = [
    '  Skill      Level    Skill      Level', // header (dup right copy)
    `  ${'a - Fighting    +0'.padEnd(19)}${L('c - Spellcasting +11')}`,
    `  ${'b - Dodging     +1'.padEnd(19)}${L('d - Conjurations +11')}`,
    `  ${''.padEnd(19)}${L('e - Hexes        +11')}`,
    '',
    ' The species aptitude is in white.',
  ]

  it('stacks left-column then right-column skills in a→z order', () => {
    const out = reflowSkillCrt(lines).map(text)
    const skills = out
      .map(t => (/^\s*([a-z]) [+\-*] (\w+)/.exec(t)))
      .filter(Boolean)
      .map(m => `${m![1]}:${m![2]}`)
    expect(skills).toEqual(['a:Fighting', 'b:Dodging', 'c:Spellcasting', 'd:Conjurations', 'e:Hexes'])
  })

  it('keeps a single column header (drops the duplicated right copy)', () => {
    const out = reflowSkillCrt(lines).map(text)
    expect(out[0]).toBe('  Skill      Level')
  })

  it('re-indents right-column cells to match the left column', () => {
    const out = reflowSkillCrt(lines).map(text)
    const indentOf = (s: string): number => /^( *)/.exec(s)![1].length
    const aRow = out.find(t => /Fighting/.test(t))!
    const cRow = out.find(t => /Spellcasting/.test(t))!
    expect(indentOf(cRow)).toBe(indentOf(aRow))
  })

  it('separates the two column groups with a blank line and a repeated header', () => {
    const out = reflowSkillCrt(lines).map(text)
    const lastLeft = out.findIndex(t => /Dodging/.test(t)) // last left-column skill
    const firstRight = out.findIndex(t => /Spellcasting/.test(t)) // first right-column skill
    expect(firstRight).toBeGreaterThan(lastLeft)
    const between = out.slice(lastLeft + 1, firstRight)
    expect(between).toContain('') // blank separator
    expect(between.some(t => /Skill.*Level/.test(t))).toBe(true) // repeated header
  })

  it('passes single-spaced help text through unchanged', () => {
    const out = reflowSkillCrt(lines)
    expect(out[out.length - 1]).toBe(' The species aptitude is in white.')
  })

  it('reflows the multi-column help footer to one command per line', () => {
    const input = [
      '  a - Fighting    +0',
      '',
      ' [?] Help                [=] set a skill target',
      ' [/] auto mode    [*] all skills    [!] targets',
    ]
    const out = reflowSkillCrt(input).map(text)
    expect(out).toContain(' [?] Help')
    expect(out).toContain(' [=] set a skill target')
    expect(out).toContain(' [/] auto mode')
    expect(out).toContain(' [*] all skills')
    expect(out).toContain(' [!] targets')
  })

  it('keeps each help command intact, with colours, when split mid-span', () => {
    // The next "[" lives inside the previous command's span — as on the wire.
    const line =
      ' <span class="fg7 bg0">[</span><span class="fg14 bg0">/</span>' +
      '<span class="fg7 bg0">] auto mode    [</span><span class="fg14 bg0">*</span>' +
      '<span class="fg7 bg0">] all</span>'
    const out = reflowSkillCrt([' a - X  +0', '', line])
    const star = out.find(l => /\] all/.test(text(l)))!
    expect(text(star)).toBe(' [*] all')
    expect(star).toContain('<span class="fg14 bg0">*</span>') // key colour preserved
  })

  it('still collapses padding on non-command (prose) help lines', () => {
    const input = ['  a - Fighting    +0', '', ' The cost   is   in   cyan.']
    const out = reflowSkillCrt(input).map(text)
    expect(out).toContain(' The cost is in cyan.')
  })

  it('preserves the lightred manual "+4" inside the left cell, colours intact', () => {
    // Manual fills the fixed-width apt field; the right hotkey stays put.
    const manualLine =
      `  <span class="fg7 bg0">a - Fighting    </span><span class="fg15 bg0">+0</span><span class="fg9 bg0">+4</span> ` +
      `<span class="fg7 bg0">c - Hexes        +11</span>`
    const out = reflowSkillCrt([manualLine])
    // a in the left cell with its manual marker, c in the right cell.
    expect(out.some(l => /a - Fighting/.test(text(l)) && /\+4/.test(text(l)) && l.includes('fg9'))).toBe(true)
    const cCell = out.find(l => /c - Hexes/.test(text(l)))!
    expect(cCell).toContain('<span class="fg7 bg0">c - Hexes')
    // The "+4" must not bleed into the right (c) cell.
    expect(text(cCell)).not.toMatch(/\+4/)
  })

  it('leaves non-skill content untouched', () => {
    const plain = ['Welcome to the dungeon.', '', 'Press any key.']
    expect(reflowSkillCrt(plain)).toEqual(plain)
  })

  describe('distributed training (no hotkeys)', () => {
    // Gnoll-style menu: no skill is selectable, so rows carry only the
    // training sign — `    + Fighting   0.2   0.2   +8`. Mirrors the wire
    // (right column starts at index 20 in this compact stand-in).
    const bare = [
      '  Skill      Level    Skill      Level',
      `  ${'+ Fighting     +8'.padEnd(18)}${L('+ Spellcasting  +8')}`,
      `  ${'+ Dodging      +8'.padEnd(18)}${L('+ Conjurations  +6')}`,
      `  ${''.padEnd(18)}${L('+ Hexes         +6')}`,
      '',
      ' The species aptitude is in white.',
    ]

    it('stacks left then right columns by the sign anchor', () => {
      const out = reflowSkillCrt(bare).map(text)
      const skills = out
        .map(t => (/^\s*\+ (\w+)/.exec(t)))
        .filter(Boolean)
        .map(m => m![1])
      expect(skills).toEqual(['Fighting', 'Dodging', 'Spellcasting', 'Conjurations', 'Hexes'])
    })

    it('keeps a single column header', () => {
      const out = reflowSkillCrt(bare).map(text)
      expect(out[0]).toBe('  Skill      Level')
    })

    it('does not anchor on a sign glyph mid-word', () => {
      // "extra- Cool" style: sign not preceded by a space must not split.
      const linesWithProse = [...bare, ' costs extra- Cool down first.']
      const out = reflowSkillCrt(linesWithProse).map(text)
      expect(out).toContain(' costs extra- Cool down first.')
    })

    it('ignores bare signs when the menu has lettered rows', () => {
      // A prose bullet below a lettered grid must not extend the grid range.
      const withBullet = [
        '  a - Fighting    +0  c - Spellcasting +11',
        '',
        ' - Casting spells of this school.',
      ]
      const out = reflowSkillCrt(withBullet).map(text)
      expect(out).toContain(' - Casting spells of this school.')
    })
  })

  it('keeps an all-unanchorable grid edge row (mastered + untrainable cells)', () => {
    // First grid line: left cell mastered (27, no hotkey/sign), right cell
    // currently untrainable (no sign) — nothing on the line anchors, but it
    // must stay a grid row, not get truncated as a second header line.
    const lines = [
      '  Skill        Level    Skill        Level',
      `  ${'  Fighting     27'.padEnd(19)}${L('  Spellcasting  0.0')}`,
      `  ${'b - Dodging   4.2'.padEnd(19)}${L('d - Conjurations 1.0')}`,
      '',
      ' The species aptitude is in white.',
    ]
    const out = reflowSkillCrt(lines).map(text)
    expect(out.some(t => /Fighting\s+27/.test(t))).toBe(true)
    expect(out.some(t => /Spellcasting\s+0\.0/.test(t))).toBe(true) // right cell not dropped
    expect(out[0]).toBe('  Skill        Level') // header still deduped to one copy
  })

  it('repeats only the header — not a mastered row above the grid — at the column break', () => {
    // Real bug: a mastered skill (27) loses hotkey and sign, so its row can't
    // anchor; sitting above the first lettered row (wire shape: header,
    // Fighting, blank, grid) it was swept into `head` and duplicated when the
    // head block was repeated before the right-column group.
    const lines = [
      '  Skill        Level      Skill        Level',
      '    Fighting     27',
      '',
      `  ${'a - Maces       11.7'.padEnd(24)}${L('l - Evocations   7.0')}`,
      `  ${'b - Axes        18.0'.padEnd(24)}${L('m - Shapeshift   0.0')}`,
    ]
    const out = reflowSkillCrt(lines).map(text)
    expect(out.filter(t => /Fighting/.test(t))).toHaveLength(1)
    // The mastered row still renders, in its original spot above the grid.
    const fighting = out.findIndex(t => /Fighting/.test(t))
    const aRow = out.findIndex(t => /Maces/.test(t))
    expect(fighting).toBeGreaterThan(-1)
    expect(fighting).toBeLessThan(aRow)
    // The header itself is still repeated before the right-column group.
    const lRow = out.findIndex(t => /Evocations/.test(t))
    expect(out.slice(aRow + 1, lRow).some(t => /Skill\s+Level/.test(t))).toBe(true)
  })

  it('does not split a prose footer that touches the right column (no blank above it)', () => {
    // Real bug: the two-column grid's last skill row is immediately followed by
    // the explanatory prose (no blank separator on the wire). The prose is long
    // enough to have text on both sides of the right column, so the grid-range
    // walk must reject it by the missing inter-column gap, not swallow + split it.
    const lines = [
      `  ${'a - Fighting    +0'.padEnd(20)}${L('c - Spellcasting +11')}`,
      `  ${'b - Dodging     +1'.padEnd(20)}${L('d - Conjurations +11')}`,
      ' The relative cost of raising each skill is in cyan.',
      ' Skills enhanced by cross-training are in green.',
    ]
    const out = reflowSkillCrt(lines).map(text)
    expect(out).toContain(' The relative cost of raising each skill is in cyan.')
    expect(out).toContain(' Skills enhanced by cross-training are in green.')
  })

  it('aligns a lone mastered right cell below the last lettered row (Shapeshifting case)', () => {
    // Seen live: mastered Shapeshifting is the right column's last row, and the
    // left column ended earlier — so the line has a blank left half and sits
    // below the last anchorable line. It must join the right-column group
    // aligned, not fall through to the help footer and get its padding
    // collapsed flush-left.
    const lines = [
      `  ${'a - Fighting    +0'.padEnd(19)}${L('c - Spellcasting +11')}`,
      `  ${'b - Dodging     +1'.padEnd(19)}${L('d - Conjurations +11')}`,
      `  ${''.padEnd(19)}${L('    Shapeshifting 27  -2')}`,
      '',
      ' The species aptitude is in white.',
    ]
    const out = reflowSkillCrt(lines).map(text)
    const idx = out.findIndex(t => /Shapeshifting/.test(t))
    expect(out[idx]).toBe('      Shapeshifting 27  -2') // aligned under the other names
    expect(idx).toBeGreaterThan(out.findIndex(t => /Conjurations/.test(t)))
    expect(out).toContain(' The species aptitude is in white.')
  })

  it('keeps a lone mastered left cell below the last lettered row in the left group', () => {
    const lines = [
      `  ${'a - Fighting    +0'.padEnd(19)}${L('c - Spellcasting +11')}`,
      `  ${'b - Dodging     +1'.padEnd(19)}${L('d - Conjurations +11')}`,
      '    Shields       27',
      '',
      ' The species aptitude is in white.',
    ]
    const out = reflowSkillCrt(lines).map(text)
    const idx = out.findIndex(t => /Shields/.test(t))
    expect(out[idx]).toBe('    Shields       27') // alignment untouched
    expect(idx).toBeLessThan(out.findIndex(t => /Spellcasting/.test(t)))
  })

  it('does not swallow short help prose adjacent to the grid as a left cell', () => {
    // A short prose line has content only left of the split, like a lone
    // mastered left cell — its single leading space is what tells them apart.
    const lines = [
      `  ${'a - Fighting    +0'.padEnd(19)}${L('c - Spellcasting +11')}`,
      ' Targets, if any.',
    ]
    const out = reflowSkillCrt(lines).map(text)
    expect(out).toContain(' Targets, if any.')
    expect(out.indexOf(' Targets, if any.')).toBeGreaterThan(out.findIndex(t => /Spellcasting/.test(t)))
  })

  it('passes the experience-menu title through whole (not clipped at the column split)', () => {
    // Potion of experience: a full-width prose title above the header. Head
    // lines used to be unconditionally split at the grid column, truncating it
    // to "…great experience. Select".
    const lines = [
      ' You have gained great experience. Select the skills to train.',
      `  ${'Skill      Level'.padEnd(19)}Skill      Level`,
      `  ${'a - Fighting    +0'.padEnd(19)}${L('c - Spellcasting +11')}`,
    ]
    const out = reflowSkillCrt(lines).map(text)
    expect(out[0]).toBe(' You have gained great experience. Select the skills to train.')
    expect(out[1]).toBe('  Skill      Level') // header still deduped to the left copy
  })

  it('splits a mastered right cell (no hotkey, no sign) at the grid column', () => {
    const lines = [
      `  ${'a - Fighting    +0'.padEnd(19)}${L('c - Spellcasting +11')}`,
      `  ${'b - Dodging     +1'.padEnd(19)}${L('    Invocations 27.0')}`,
    ]
    const out = reflowSkillCrt(lines).map(text)
    const dodging = out.find(t => /Dodging/.test(t))!
    expect(dodging).not.toMatch(/Invocations/) // not misfiled as one wide left row
    expect(out.some(t => /Invocations 27\.0/.test(t))).toBe(true)
  })
})
