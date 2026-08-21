// @vitest-environment happy-dom

import { describe, it, expect, vi, afterEach } from 'vitest'
import { fakeStorage } from '../test/fake-storage'
import { tokenLogin, SESSION_EXPIRED_NOTICE, type TokenLoginConn } from './token-login'
import { listSessions, loadSession, saveSession } from './session'
import type { ClientMsg, ServerMsg } from '../ws/types'

vi.stubGlobal('localStorage', fakeStorage())
vi.stubGlobal('sessionStorage', fakeStorage())

const WS_URL = 'wss://test.example/socket'
const USER = 'tester'

function fakeConn(): { conn: TokenLoginConn; sent: ClientMsg[]; feed: (m: ServerMsg) => void } {
  const sent: ClientMsg[] = []
  const conn: TokenLoginConn = {
    send: (m) => { sent.push(m) },
    onMessage: () => {},
    onLoginCookie: () => {},
  }
  return { conn, sent, feed: (m) => conn.onMessage(m) }
}

function storedSession() {
  saveSession(WS_URL, USER, 'cookie-1', 7)
  return loadSession(WS_URL, USER)!
}

afterEach(() => {
  localStorage.clear()
})

describe('tokenLogin', () => {
  it('keeps an expired account available for password recovery without loading its token', () => {
    saveSession(WS_URL, USER, 'expired-cookie', -1)
    expect(loadSession(WS_URL, USER)).toBeNull()
    expect(listSessions()).toEqual([
      expect.objectContaining({ wsUrl: WS_URL, username: USER, cookie: 'expired-cookie' }),
    ])
  })

  it('exchanges the cookie and requests a fresh one on success', () => {
    const { conn, sent, feed } = fakeConn()
    const successes: string[] = []
    tokenLogin(conn, storedSession(), {
      onSuccess: (username) => successes.push(username),
      onFail: () => { throw new Error('unexpected') },
    })
    expect(sent).toEqual([{ msg: 'token_login', cookie: 'cookie-1' }])
    feed({ msg: 'login_success', username: USER })
    expect(sent.at(-1)).toEqual({ msg: 'set_login_cookie' })
    expect(successes).toEqual([USER])
  })

  it('buffers the pre-login lobby snapshot and flushes it into the destination handler', () => {
    const { conn, feed } = fakeConn()
    let flushFn: (() => void) | null = null
    tokenLogin(conn, storedSession(), {
      onSuccess: (_u, flush) => { flushFn = flush },
      onFail: () => { throw new Error('unexpected') },
    })
    // The server pushes the lobby snapshot before login_success arrives.
    feed({ msg: 'lobby_complete' })
    feed({ msg: 'login_success', username: USER })
    // No destination yet — flush must not feed the buffer into itself.
    flushFn!()
    const seen: ServerMsg[] = []
    conn.onMessage = (m) => seen.push(m)
    flushFn!()
    expect(seen.map(m => m.msg)).toEqual(['lobby_complete'])
  })

  it('persists the rotated cookie', () => {
    const { conn, feed } = fakeConn()
    tokenLogin(conn, storedSession(), {
      onSuccess: () => {},
      onFail: () => { throw new Error('unexpected') },
    })
    conn.onLoginCookie('cookie-2', 7)
    expect(loadSession(WS_URL, USER)?.cookie).toBe('cookie-2')
    feed({ msg: 'login_success', username: USER })
  })

  it('clears the stored session and reports failure on login_fail', () => {
    const { conn, feed } = fakeConn()
    let failed = false
    tokenLogin(conn, storedSession(), {
      onSuccess: () => { throw new Error('unexpected') },
      onFail: () => { failed = true },
    })
    feed({ msg: 'login_fail', message: 'nope' })
    expect(failed).toBe(true)
    expect(loadSession(WS_URL, USER)).toBeNull()
    expect(SESSION_EXPIRED_NOTICE).toMatch(/expired/)
  })
})
