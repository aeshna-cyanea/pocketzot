// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeStorage } from '../test/fake-storage'

vi.stubGlobal('localStorage', fakeStorage())

import { isChangelogUnread, openChangelogDoc } from './docs'
import { getPref } from '../prefs'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('changelog unread state', () => {
  // A fresh install (no stored pref) is unread on purpose: the first launch
  // after install surfaces the release notes. This also guards the date
  // parsing itself — if CHANGELOG.md's `## YYYY-MM-DD` heading format ever
  // drifts, newestChangelogDate comes back null and this fails.
  it('is unread with no stored pref', () => {
    expect(isChangelogUnread()).toBe(true)
  })

  it('opening the doc marks the newest entry seen', () => {
    openChangelogDoc()
    expect(isChangelogUnread()).toBe(false)
    expect(getPref('changelogSeen')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('goes unread again when a newer entry ships', () => {
    openChangelogDoc()
    document.body.innerHTML = ''
    // Simulate a stale pref from a previous deploy's changelog.
    localStorage.setItem(
      'pocketzot:prefs',
      JSON.stringify({ changelogSeen: '2001-01-01' }),
    )
    expect(isChangelogUnread()).toBe(true)
  })
})
