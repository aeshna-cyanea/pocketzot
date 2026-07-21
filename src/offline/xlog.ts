// xlogfile parsing — the format the engine appends one line per finished game
// to /crawl/saves/logfile (and scores): fields joined with ':', each
// 'key=value', with ':' inside values escaped as '::' (hiscores.cc
// _xlog_escape — seen live: place=D::1). Two date quirks, both verified
// against a real entry (dev-material/character-cards.md "Step zero"): xlog
// date fields ("20260620221149D") carry a 0-BASED month — make_date_string
// (tags.cc) writes tm_mon raw — plus a trailing local-DST marker (D/S),
// while the morgue filename derived from the same instant uses a 1-based
// month (make_file_time, stringutil.cc). Leaf module: pure string
// processing (slotStem aside), safe in the main bundle.

import { slotStem } from './offline-state'

export type XlogRecord = Record<string, string>

// One record per non-blank line; fields without '=' are skipped.
export function parseXlog(text: string): XlogRecord[] {
  const out: XlogRecord[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    out.push(parseXlogLine(line))
  }
  return out
}

export function parseXlogLine(line: string): XlogRecord {
  const rec: XlogRecord = {}
  let field = ''
  const commit = (): void => {
    const eq = field.indexOf('=')
    if (eq > 0) rec[field.slice(0, eq)] = field.slice(eq + 1)
    field = ''
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === ':') {
      // '::' is an escaped literal colon; a lone ':' ends the field.
      if (line[i + 1] === ':') {
        field += ':'
        i++
      } else commit()
    } else field += c
  }
  commit()
  return rec
}

const XLOG_TIME = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})[DS]?$/

// "20260620221149D" → ms epoch. The engine writes local wall-clock time, so
// construct in local time; the raw month IS the 0-based index Date wants.
export function xlogTimeMs(v: string | undefined): number | null {
  const m = v ? XLOG_TIME.exec(v) : null
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
  return new Date(y, mo, d, h, mi, s).getTime()
}

// The morgue file the engine wrote for this entry — deterministic, the same
// derivation as morgue_name(name, death_time) (ouch.cc) + the filename strip:
// morgue-<stem>-YYYYMMDD-HHMMSS.txt with a 1-BASED month, from the entry's
// `name` + `end`. Files live under /crawl/morgue/.
export function morgueFileName(name: string, end: string | undefined): string | null {
  const m = end ? XLOG_TIME.exec(end) : null
  if (!m) return null
  const mo = String(Number(m[2]) + 1).padStart(2, '0')
  return `morgue-${slotStem(name)}-${m[1]}${mo}${m[3]}-${m[4]}${m[5]}${m[6]}.txt`
}
