// Reflow the DCSS skill menu (`m`) from its native two-column terminal layout
// into a single column, so it fits a phone screen without horizontal panning.
//
// The server renders the skill menu as a fixed 79-column grid and sends it as
// `txt` lines (HTML with fg/bg colour spans). Skills fill the LEFT column top
// to bottom (a–g…), then the RIGHT column (h–u…), so reading every left cell
// followed by every right cell reproduces the natural a→z order in one column.
//
// We split each grid line at the right column's position and stack the halves.
// The split is located by the right-column cell anchor's *position* (the
// hotkey letter, or the training sign when the menu has no hotkeys), never by
// counting spaces: a skill with a training manual appends a "+4" inside its
// fixed-width aptitude field, which changes the inter-column spacing — the trap
// that the `extractSkillHotkeys` space-anchored regex originally fell into.

import { SKILL_HOTKEY_RE } from './skill-hotkeys'

// Distributed training (Gnolls) makes no skill selectable, so the server
// assigns no hotkey letters (SkillMenuEntry::is_selectable) and a row is just
// `S Name` — sign + name. This anchor is looser than the lettered
// SKILL_HOTKEY_RE (a prose bullet "- Casting…" would match), so it's consulted
// only when the whole menu has no lettered row.
const BARE_ROW_RE = /[+\-*] [A-Z]/g

// A left-column hotkey sits at the indent (col ~2); the right column starts far
// past the 20-wide name field. Any hotkey at/after this column is the right one.
const RIGHT_COL_MIN = 20

// Visual (rendered) text of an HTML line: tags removed, every entity collapsed
// to a single cell so indices line up with splitHtmlAtCol's column counting.
function plainText(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&[a-zA-Z0-9#]+;/g, '·')
}

// Column indices where skill cells start on this line. In lettered mode the
// anchor (and the cell) starts at the hotkey letter; in bare mode at the sign.
// A cell is always preceded by a space (one, in the manual case) or the line
// start; requiring that kills two mid-text traps — prose like "extra - Cool",
// and a gnoll manual's "+8 +4 + Spellcasting", whose digit would otherwise
// pass for a lettered anchor (`4 + S`) and flip the mode.
function rowAnchors(plain: string, lettered: boolean): number[] {
  const out: number[] = []
  for (const m of plain.matchAll(lettered ? SKILL_HOTKEY_RE : BARE_ROW_RE)) {
    const i = m.index ?? 0
    if (i > 0 && plain[i - 1] !== ' ') continue
    out.push(i)
  }
  return out
}

// Column index of the right-column cell start, or -1 if the line has none.
function rightAnchorCol(plain: string, lettered: boolean): number {
  for (const i of rowAnchors(plain, lettered)) {
    if (i >= RIGHT_COL_MIN) return i
  }
  return -1
}

function closeTagFor(openTag: string): string {
  const m = /^<\s*([a-zA-Z0-9]+)/.exec(openTag)
  return m ? `</${m[1]}>` : ''
}

// Split an HTML fragment at a visual column (rendered glyph cells; tags count
// for nothing, an entity counts as one). Tags left open across the cut are
// closed on the left half and reopened on the right, so both halves are
// well-formed and keep their colours. Spans that would be left empty by the
// cut are elided rather than emitted as `<span></span>`.
export function splitHtmlAtCol(html: string, col: number): [string, string] {
  if (col <= 0) return ['', html]
  let left = ''
  let right = ''
  let visCol = 0
  let i = 0
  const n = html.length
  const open: string[] = [] // opening tags currently in scope (logical stack)
  let crossed = false
  let pending: string[] = [] // tags closed at the cut, awaiting reopen on the right

  const emitRight = (s: string): void => {
    if (pending.length) {
      right += pending.join('')
      pending = []
    }
    right += s
  }

  while (i < n) {
    const ch = html[i]
    if (ch === '<') {
      const gt = html.indexOf('>', i)
      const end = gt === -1 ? n : gt + 1
      const tag = html.slice(i, end)
      i = end
      const isClose = tag.startsWith('</')
      const isSelf = tag.endsWith('/>')
      if (!crossed) {
        left += tag
        if (isClose) open.pop()
        else if (!isSelf) open.push(tag)
      } else if (isClose) {
        open.pop()
        if (pending.length) pending.pop() // never reopened → drop both halves
        else right += tag // already reopened on the right → close it
      } else if (isSelf) {
        emitRight(tag)
      } else {
        emitRight(tag)
        open.push(tag)
      }
      continue
    }
    // A single rendered glyph: a plain char or an HTML entity.
    let glyph: string
    if (ch === '&') {
      const semi = html.indexOf(';', i)
      if (semi !== -1 && semi - i <= 10) {
        glyph = html.slice(i, semi + 1)
        i = semi + 1
      } else {
        glyph = ch
        i++
      }
    } else {
      glyph = ch
      i++
    }
    if (!crossed) {
      left += glyph
      visCol++
      if (visCol === col) {
        for (let k = open.length - 1; k >= 0; k--) left += closeTagFor(open[k])
        pending = [...open]
        crossed = true
      }
    } else {
      emitRight(glyph)
      visCol++
    }
  }
  return [left, right]
}

// Extract the visual columns [start, end) of an HTML fragment (end omitted =
// to the end). Built on splitHtmlAtCol, so spans straddling either edge are
// closed/reopened and colours survive.
function sliceHtmlCols(html: string, start: number, end?: number): string {
  const [, rest] = splitHtmlAtCol(html, start)
  if (end === undefined) return rest
  return splitHtmlAtCol(rest, end - start)[0]
}

// Drop trailing spaces, including any tucked just inside the final close tag(s)
// (e.g. "Help  </span>" → "Help</span>").
function trimTrailingHtml(html: string): string {
  return html.replace(/ +(?=(?:<\/[^>]+>)*$)/g, '')
}

// A command marker in the help footer: "[" + a single key glyph + "]".
const CMD_MARKER = /\[\S\]/g

// The help footer is a 2–3 column grid of `[key] label` commands. Split each
// such line into one command per line (preserving the state colours inside
// labels like auto|manual). Non-command lines (prose) just get their alignment
// padding collapsed so they wrap as plain text instead of mid-phrase.
function reflowHelpLine(html: string): string[] {
  const cmds = [...plainText(html).matchAll(CMD_MARKER)]
  if (cmds.length < 2) return [html.replace(/ {2,}/g, ' ')]
  const out: string[] = []
  for (let k = 0; k < cmds.length; k++) {
    const start = cmds[k].index ?? 0
    const end = k + 1 < cmds.length ? cmds[k + 1].index : undefined
    out.push(' ' + trimTrailingHtml(sliceHtmlCols(html, start, end)))
  }
  return out
}

// Reflow the ordered CRT lines of a skill menu into a single column. Returns a
// new ordered array. If the lines don't look like a skill grid (no skill rows),
// they're returned unchanged.
export function reflowSkillCrt(lines: string[]): string[] {
  const plains = lines.map(plainText)
  // Prefer the lettered anchor; the bare one is consulted only when no line in
  // the whole menu has a hotkey (distributed training hides them all at once).
  const lettered = plains.some(p => rowAnchors(p, true).length > 0)
  const gridIdx: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (rowAnchors(plains[i], lettered).length > 0) gridIdx.push(i)
  }
  if (gridIdx.length === 0) return lines

  let first = gridIdx[0]
  let last = gridIdx[gridIdx.length - 1]

  // Representative right-column position, used to split the (anchor-less)
  // column-header line: the most common right-anchor column across grid rows.
  const counts = new Map<number, number>()
  for (const i of gridIdx) {
    const c = rightAnchorCol(plains[i], lettered)
    if (c >= 0) counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  let repRight = 41 // matches MIN_COLS/2 + indent; only a fallback
  let bestN = 0
  for (const [c, n] of counts) if (n > bestN) ((bestN = n), (repRight = c))

  // A row whose cells are all mastered or currently-untrainable has no anchor
  // anywhere (those cells lose both hotkey and sign — get_prefix renders two
  // spaces), so a grid edge made of such rows sits outside [first, last] and
  // would be misfiled as header or help text. Extend the range over adjacent
  // grid-shaped lines; the column-header line and the blank separator above
  // the help text both stop the walk.
  const HEADER_RE = /^\s*Skill\s+Level/
  // The fixed-width grid always pads the left column so a run of spaces sits
  // immediately before the right cell. Prose footers ("…each skill is in
  // cyan.") flow continuously across that column, so a letter (or a lone
  // inter-word space) lands just before repRight. Requiring the inter-column
  // gap is what stops the walk from swallowing — and then splitting — a long
  // explanatory line whose two halves both happen to be non-empty.
  //
  // A mastered cell can also sit alone on its line, past the other column's
  // end (seen live: mastered Shapeshifting as the right column's last row,
  // below the last lettered line). One-sided lines have no gap to test, so
  // instead: a lone right cell is anything past repRight with a blank left
  // half (prose always starts near column 0), and a lone left cell must start
  // at the grid's indent — two or more leading spaces — where help prose gets
  // exactly one.
  const gridRow = (i: number): boolean => {
    if (bestN === 0 || i < 0 || i >= lines.length) return false
    const p = plains[i]
    if (HEADER_RE.test(p)) return false
    const left = p.slice(0, repRight).trim() !== ''
    const right = p.slice(repRight).trim() !== ''
    if (left && right) return p[repRight - 1] === ' ' && p[repRight - 2] === ' '
    if (right) return true
    return left && p.startsWith('  ')
  }
  while (gridRow(first - 1)) first--
  while (gridRow(last + 1)) last++

  const leftCells: string[] = []
  const rightCells: string[] = []
  for (let i = first; i <= last; i++) {
    const html = lines[i]
    const plain = plains[i]
    let col = rightAnchorCol(plain, lettered)
    // A mastered skill (level 27) loses both its hotkey and its training sign,
    // so its cell can't anchor. If the line still has content in the right
    // column's territory, split at the representative column instead of
    // misfiling the whole line as left-only.
    if (col < 0 && bestN > 0 && plain.slice(repRight).trim()) col = repRight
    if (col < 0) {
      // Left-only skill row, or a blank/spacer line within the grid.
      if (plain.trim()) leftCells.push(html)
      continue
    }
    const [l, r] = splitHtmlAtCol(html, col)
    if (plainText(l).trim()) leftCells.push(l)
    if (plainText(r).trim()) rightCells.push(r)
  }

  // Left cells keep the grid's leading indent (the left column sits at col ~2);
  // right cells were sliced at their anchor, so they start flush. Re-indent the
  // right cells to match so every row's Level/Cost/Apt columns line up. Use the
  // minimum indent: a mastered cell starts two columns deeper (its hotkey and
  // sign render as spaces), so the shallowest cell marks the true column edge.
  let indent = 2
  let found = false
  for (const c of leftCells) {
    const m = /^( *)\S/.exec(plainText(c))
    if (m && (!found || m[1].length < indent)) {
      indent = m[1].length
      found = true
    }
  }
  const pad = ' '.repeat(indent)
  const rightOut = rightCells.map(c => pad + c)

  // Lines above the grid. Three shapes turn up here: the column header, which
  // renders once per column and is cut down to its left copy (recognised by
  // HEADER_RE, or by the inter-column gap for other two-sided lines);
  // full-width prose — the experience menu's "You have gained great
  // experience…" title — which flows across the split column and must pass
  // through whole (padding collapsed so it wraps, like footer prose); and
  // lines with nothing right of the split (blank spacers, a mastered first
  // row whose line can't anchor), kept verbatim so grid alignment survives.
  // Only true header lines may be repeated at the column break below, or a
  // mastered row would duplicate.
  const head: string[] = []
  for (let i = 0; i < first; i++) {
    const p = plains[i]
    const hasRight = p.slice(repRight).trim() !== ''
    const gapped = p[repRight - 1] === ' ' && p[repRight - 2] === ' '
    if (hasRight && (HEADER_RE.test(p) || gapped)) {
      const [l] = splitHtmlAtCol(lines[i], repRight)
      head.push(l.replace(/\s+$/, ''))
    } else if (hasRight) {
      head.push(lines[i].replace(/ {2,}/g, ' '))
    } else {
      head.push(lines[i].replace(/\s+$/, ''))
    }
  }
  const headRepeat = head.filter(l => HEADER_RE.test(plainText(l)))

  // Stack the two columns, but keep the break between them: a blank line plus a
  // repeated header. The original two-column view shows the header above each
  // column, and the left/right split is a meaningful grouping (physical vs.
  // magic skills) that players navigate by position — so preserve it.
  const body: string[] = [...leftCells]
  if (leftCells.length && rightOut.length) body.push('', ...headRepeat)
  body.push(...rightOut)

  // Explanatory / help text below the grid: the command footer is itself a
  // multi-column grid, so reflow it to one command per line; prose lines just
  // get their padding collapsed so they wrap cleanly.
  const tail: string[] = []
  for (const line of lines.slice(last + 1)) tail.push(...reflowHelpLine(line))

  return [...head, ...body, ...tail]
}
