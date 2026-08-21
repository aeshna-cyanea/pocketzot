// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeStorage } from '../test/fake-storage'

vi.stubGlobal('localStorage', fakeStorage())
vi.stubGlobal('sessionStorage', fakeStorage())

import { KNOWN_SERVERS } from '../servers'
import { loadSession, saveSession } from '../auth/session'
import { buildLoginView } from './login'

class FakeWebSocket {
  static readonly OPEN = 1
  static instances: FakeWebSocket[] = []

  readyState = 0
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  readonly sent: Record<string, unknown>[] = []

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    })
  }

  send(raw: string): void { this.sent.push(JSON.parse(raw) as Record<string, unknown>) }
  close(): void { this.readyState = 3 }
  feed(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

vi.stubGlobal('WebSocket', FakeWebSocket)

describe('login server routes', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    FakeWebSocket.instances = []
    document.body.textContent = ''
  })

  it('announces the selected server before validating or connecting', () => {
    const onServerRoute = vi.fn()
    const initial = KNOWN_SERVERS[1]!.wsUrl
    const view = buildLoginView(vi.fn(), undefined, undefined, initial, onServerRoute)
    const select = view.querySelector<HTMLSelectElement>('#server-select')!
    const form = view.querySelector<HTMLFormElement>('#login-form')!

    expect(select.value).toBe(initial)

    const changed = KNOWN_SERVERS[2]!.wsUrl
    select.value = changed
    select.dispatchEvent(new Event('change'))
    expect(onServerRoute).toHaveBeenLastCalledWith(changed, undefined)

    // A missing password stops submit before a WebSocket is constructed, but
    // route intent must already have reached app.ts/password managers.
    view.querySelector<HTMLInputElement>('#login-user')!.value = 'alice'
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(onServerRoute).toHaveBeenLastCalledWith(changed, 'alice')
    expect(onServerRoute).toHaveBeenCalledTimes(2)
  })

  it('shares one server picker between login and guest spectating', () => {
    const view = buildLoginView(vi.fn())
    const form = view.querySelector<HTMLFormElement>('#login-form')!

    expect(view.querySelector('#spectate-select')).toBeNull()
    expect(form.querySelector<HTMLButtonElement>('#login-btn')).not.toBeNull()
    expect(form.querySelector<HTMLButtonElement>('#spectate-btn')?.textContent)
      .toContain('Spectate as guest')
  })

  it('reveals and routes a normalized custom server URL', () => {
    const onServerRoute = vi.fn()
    const view = buildLoginView(vi.fn(), undefined, undefined, undefined, onServerRoute)
    const select = view.querySelector<HTMLSelectElement>('#server-select')!
    const customLabel = view.querySelector<HTMLLabelElement>('#custom-server-label')!
    const customInput = view.querySelector<HTMLInputElement>('#custom-server-url')!
    const customOption = Array.from(select.options).find(o => o.textContent === 'Custom server…')!

    select.value = customOption.value
    select.dispatchEvent(new Event('change'))
    expect(customLabel.hidden).toBe(false)

    customInput.value = 'wss://custom.example/socket'
    customInput.dispatchEvent(new Event('input'))
    expect(onServerRoute).toHaveBeenLastCalledWith('wss://custom.example/socket', undefined)
  })

  it('lists a saved custom-server session as a normal account and server', () => {
    const wsUrl = 'wss://custom.example/socket'
    saveSession(wsUrl, 'alice', 'token', 1)
    const view = buildLoginView(vi.fn())

    expect(Array.from(view.querySelectorAll<HTMLOptionElement>('#server-select option'))
      .some(option => option.value === wsUrl)).toBe(true)
    expect(view.querySelector('.login-account-username')?.textContent).toBe('alice')
  })

  it('opens password recovery immediately for a locally expired token', () => {
    const wsUrl = KNOWN_SERVERS[0]!.wsUrl
    saveSession(wsUrl, 'alice', 'expired-token', -1)
    const view = buildLoginView(vi.fn())
    const account = view.querySelector<HTMLButtonElement>('.login-account-card.needs-password')!

    account.click()

    expect(view.querySelector<HTMLInputElement>('.login-reauth-password')).not.toBeNull()
    expect(view.querySelector('.login-reauth-copy')?.textContent).toContain('expired')
  })

  it('replaces a server-rejected token card with password recovery', async () => {
    const wsUrl = KNOWN_SERVERS[0]!.wsUrl
    saveSession(wsUrl, 'alice', 'rejected-token', 1)
    const view = buildLoginView(vi.fn())
    view.querySelector<HTMLButtonElement>('.login-account-card')!.click()

    await vi.waitFor(() => expect(FakeWebSocket.instances[0]?.sent[0])
      .toEqual({ msg: 'token_login', cookie: 'rejected-token' }))
    FakeWebSocket.instances[0]!.feed({ msg: 'login_fail', message: 'expired' })

    expect(view.querySelector<HTMLInputElement>('.login-reauth-password')).not.toBeNull()
    expect(view.querySelector('#login-error')?.textContent).toBe('')
    expect(loadSession(wsUrl, 'alice')).toBeNull()
  })

  it('logs in with the replacement password and stores the new token', async () => {
    const wsUrl = KNOWN_SERVERS[0]!.wsUrl
    const onLogin = vi.fn()
    const onServerRoute = vi.fn()
    const view = buildLoginView(
      onLogin, undefined, undefined, wsUrl, onServerRoute, 'alice',
      { wsUrl, username: 'alice' },
    )
    document.body.appendChild(view)
    const form = view.querySelector<HTMLFormElement>('.login-reauth-form')!
    const password = view.querySelector<HTMLInputElement>('.login-reauth-password')!
    password.value = 'replacement-password'
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.instances[0]!
    await vi.waitFor(() => expect(socket.sent[0]).toEqual({
      msg: 'login', username: 'alice', password: 'replacement-password',
    }))
    expect(onServerRoute).toHaveBeenCalledWith(wsUrl, 'alice')

    socket.feed({ msg: 'login_success', username: 'Alice' })
    expect(socket.sent.at(-1)).toEqual({ msg: 'set_login_cookie' })
    expect(onLogin).toHaveBeenCalledWith(expect.objectContaining({ username: 'Alice' }))

    socket.feed({ msg: 'login_cookie', cookie: 'new-token', expires: 7 })
    expect(loadSession(wsUrl, 'Alice')?.cookie).toBe('new-token')
  })
})
