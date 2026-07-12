import { WsConnection } from '../ws/connection'
import type { ServerMsg } from '../ws/types'
import { listSessions, saveSession, type StoredSession } from '../auth/session'
import { SESSION_EXPIRED_NOTICE, tokenLogin } from '../auth/token-login'
import { findServer, KNOWN_SERVERS, SPECTATE_SERVERS, labelFor } from '../servers'
import { getLastSpectateServer, getPref, setLastSpectateServer, LOGIN_SPRITES_CHANGED_EVENT } from '../prefs'
import { openAboutDoc, openChangelogDoc } from './docs'
import { openSettings } from './settings-view'
import { decorateLogo } from '../logo'
import { listAvatars } from '../avatars'
import { paintAvatars } from './avatar-tiles'
import { openCrypt } from './crypt-view'
import { getOfflineLast, offlineLastSaysResumable } from '../offline/offline-state'
import { abbrevPlace } from '../game/place-abbrev'
import { hasOfflineSave } from '../offline/save-transfer'

export interface LoginResult {
  conn: WsConnection
  username: string
  guest?: boolean
}

export function buildLoginView(
  onLogin: (result: LoginResult) => void,
  // Shown in the error slot on mount — how the app explains an involuntary
  // trip back here (connection lost, auto-resume gave up).
  notice?: string,
  // Boots offline play (the WASM engine) in place. When absent the offline
  // card is not rendered.
  onOffline?: () => void,
): HTMLElement {
  const view = document.createElement('div')
  view.id = 'login-view'

  const sessions = listSessions()
  const hasSessions = sessions.length > 0

  // Reused form contents — wrapped in a `<details>` toggle when the user
  // already has saved sessions, or rendered as a plain Sign-in section when
  // they don't.
  const formInnerHtml = `
    <label class="login-label">
      Server
      <select id="server-select"></select>
    </label>
    <label class="login-label">
      Username
      <input id="login-user" type="text" autocomplete="username"
             spellcheck="false" autocorrect="off" autocapitalize="off" required />
    </label>
    <label class="login-label">
      Password
      <input id="login-pass" type="password" autocomplete="current-password" required />
    </label>
    <button id="login-btn" type="submit" class="login-btn">Connect</button>
  `

  // About / What's new are rendered in-app from the committed ABOUT.md /
  // CHANGELOG.md (see ./docs), so they ship in every build — this footer is the
  // always-present source/attribution surface required by the AGPL.
  const siteFooterHtml = `
    <div class="login-footer">
      <a href="#" id="login-about">About</a>
      <a href="#" id="login-changelog">What's new</a>
      <a href="#" id="login-settings">Settings</a>
    </div>
  `

  const addAccountSection = hasSessions
    ? `
      <details id="add-account" class="login-section login-add-section">
        <summary class="login-add-toggle">Add another account</summary>
        <form id="login-form" autocomplete="on" novalidate class="login-add-form">
          ${formInnerHtml}
        </form>
      </details>
    `
    : `
      <section class="login-section login-signin-section">
        <div class="login-section-label">Sign in</div>
        <form id="login-form" autocomplete="on" novalidate>
          ${formInnerHtml}
        </form>
      </section>
    `

  view.innerHTML = `
    <div class="login-card">
      <h1 class="login-title">PocketZot</h1>
      <div id="login-avatars" class="login-avatars"></div>

      ${hasSessions ? `
      <section id="resume-section" class="login-section">
        <div class="login-section-label">Your accounts</div>
        <div id="resume-list" class="login-account-list"></div>
      </section>
      ` : ''}

      ${onOffline ? `
      <section id="offline-section" class="login-section">
        <div class="login-section-label">On this device</div>
        <button type="button" id="offline-card" class="login-account-card login-offline-card">
          <span class="login-account-tag">⌂</span>
          <span class="login-offline-lines">
            <span class="login-account-username">Play offline</span>
            <span id="offline-sub" class="login-offline-sub"></span>
          </span>
        </button>
      </section>
      ` : ''}

      <div id="login-error" class="login-error" style="display:none" role="alert"></div>

      ${addAccountSection}

      <section class="login-section login-spectate-section">
        <div class="login-section-label">Spectate as guest</div>
        <select id="spectate-select" class="login-spectate-select" aria-label="Server"></select>
        <div id="spectate-error" class="login-error" style="display:none" role="alert"></div>
        <button id="spectate-btn" type="button" class="login-btn login-btn-spectate">Spectate →</button>
      </section>

      ${siteFooterHtml}
    </div>
  `

  const formSelect = view.querySelector<HTMLSelectElement>('#server-select')!
  const spectateSelect = view.querySelector<HTMLSelectElement>('#spectate-select')!
  const userInput = view.querySelector<HTMLInputElement>('#login-user')!
  const passInput = view.querySelector<HTMLInputElement>('#login-pass')!
  const errorEl = view.querySelector<HTMLElement>('#login-error')!
  const spectateErrorEl = view.querySelector<HTMLElement>('#spectate-error')!
  const btn = view.querySelector<HTMLButtonElement>('#login-btn')!

  decorateLogo(view.querySelector<HTMLElement>('.login-title')!)

  // Relocation notice, shown only on the exact public old origin (pocketzot.pages.dev)
  if (location.hostname === 'pocketzot.pages.dev' &&
      sessionStorage.getItem('pocketzot:moved-snooze') !== '1') {
    const banner = document.createElement('div')
    banner.className = 'login-moved'
    banner.innerHTML = `
      <button type="button" class="login-moved-x" aria-label="Dismiss">×</button>
      <p class="login-moved-msg">PocketZot has moved to <strong>pocketzot.app</strong>.</p>
      <a href="https://pocketzot.app/" class="login-moved-link">Open new site →</a>
      <p class="login-moved-sub">If you keep PocketZot on your home screen, re-add it from there.</p>
    `
    banner.querySelector('.login-moved-x')!.addEventListener('click', () => {
      sessionStorage.setItem('pocketzot:moved-snooze', '1')
      banner.remove()
    })
    view.querySelector('.login-card')!.prepend(banner)
  }

  if (notice) {
    errorEl.textContent = notice
    errorEl.style.display = ''
  }

  for (const s of KNOWN_SERVERS) {
    const o1 = document.createElement('option')
    o1.value = s.wsUrl; o1.textContent = s.label
    formSelect.appendChild(o1)
  }
  for (const s of SPECTATE_SERVERS) {
    const o2 = document.createElement('option')
    o2.value = s.wsUrl; o2.textContent = s.label
    spectateSelect.appendChild(o2)
  }

  // Login-form dropdown follows the most-recently-used session's server.
  // Spectate dropdown prefers the saved pref (last explicit guest pick),
  // falling back to the session-derived prior when that server is also
  // anonymously spectatable, otherwise the list top.
  const topSession = sessions[0]
  if (topSession && KNOWN_SERVERS.some(s => s.wsUrl === topSession.wsUrl)) {
    formSelect.value = topSession.wsUrl
  }
  const savedSpectate = getLastSpectateServer()
  if (savedSpectate) {
    spectateSelect.value = savedSpectate
  } else if (topSession && SPECTATE_SERVERS.some(s => s.wsUrl === topSession.wsUrl)) {
    spectateSelect.value = topSession.wsUrl
  }

  view.querySelector('#login-about')!.addEventListener('click', (e) => {
    e.preventDefault()
    openAboutDoc()
  })
  view.querySelector('#login-changelog')!.addEventListener('click', (e) => {
    e.preventDefault()
    openChangelogDoc()
  })
  view.querySelector('#login-settings')!.addEventListener('click', (e) => {
    e.preventDefault()
    openSettings()
  })
  renderResumeButtons()
  renderOfflineCard()
  renderAvatars()

  // Shelf of your recently-played character dolls (see ../avatars + ./avatar-tiles),
  // newest at the left. One newest-first order is shared with the crypt grid (newest
  // top-left), so the visible row reads as the crypt's top row — the head you see
  // here is the same dolls in the same order that lead the full grid. Tapping the
  // row opens the crypt (the full history). The strip stays collapsed (`:empty`)
  // until at least one doll's atlas resolves, so the tap target only exists when
  // there's something to show.
  //
  // The whole shelf is gated on the loginSprites pref: painting is what pulls
  // the tile atlases, so when disabled we must not call paintAvatars at all —
  // the login screen then fetches no gamedata. With the strip :empty the crypt
  // (whose only entry point this is) is unreachable too, by construction.
  // Recipes keep being captured during play regardless, so re-enabling
  // restores a fully populated shelf. Live-apply handles the settings page
  // changing the pref over this still-mounted view.
  function renderAvatars(): void {
    const strip = view.querySelector<HTMLElement>('#login-avatars')
    if (!strip) return
    strip.setAttribute('role', 'button')
    strip.setAttribute('tabindex', '0')
    strip.setAttribute('aria-label', 'View all characters')
    const open = (): void => { if (strip.childElementCount) openCrypt() }
    strip.addEventListener('click', open)
    strip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() }
    })

    // Abort the previous paint before each repaint: paintAvatars resolves
    // atlases over several seconds and appends as they land, so a disable (or a
    // re-enable) mid-load could otherwise drop a superseded call's dolls into
    // the strip after we've cleared it, or duplicate them.
    let painting: AbortController | null = null
    const paint = (): void => {
      painting?.abort()
      if (getPref('loginSprites')) {
        painting = new AbortController()
        void paintAvatars(strip, listAvatars(), 2, 'login-avatar', painting.signal)
      } else {
        painting = null
        strip.innerHTML = ''
      }
    }
    paint()
    // Self-unhooks once this view is gone (same pattern as game-view's pref
    // listeners) — each buildLoginView mounts a fresh view.
    const onSpritesPref = (): void => {
      if (!view.isConnected) {
        window.removeEventListener(LOGIN_SPRITES_CHANGED_EVENT, onSpritesPref)
        return
      }
      paint()
    }
    window.addEventListener(LOGIN_SPRITES_CHANGED_EVENT, onSpritesPref)
  }

  // Offline card: one tap boots the local engine. The subline says what the
  // tap will do — resume the saved character or start fresh. Save presence is
  // guessed synchronously from the offline-state record, then corrected by
  // the IDB probe when the browser supports probing without side effects
  // (covers a wiped IDB under a stale record, and an imported save with no
  // record). The subline is the fallback-varying part; the title row stays
  // fixed so the card never reflows.
  function renderOfflineCard(): void {
    const card = view.querySelector<HTMLButtonElement>('#offline-card')
    const sub = view.querySelector<HTMLElement>('#offline-sub')
    if (!card || !sub || !onOffline) return
    const rec = getOfflineLast()
    const setSub = (resumable: boolean): void => {
      if (resumable && rec?.name) {
        // The wire title carries its own joiner ("the Sneak", ", Vainglorious")
        // — same rule as the HUD titleline (stats-view.ts nameTitle).
        const who = rec.title
          ? (rec.title.startsWith(',') ? rec.name + rec.title : `${rec.name} ${rec.title}`)
          : rec.name
        // Same compact place form as the HUD chip (stats-view.ts).
        const place = rec.place
          ? (rec.depth ? `${abbrevPlace(rec.place)}:${rec.depth}` : abbrevPlace(rec.place))
          : ''
        sub.textContent = `Resume ${who}${place ? ` — ${place}` : ''}`
      } else if (resumable) {
        sub.textContent = 'Resume saved game'
      } else {
        sub.textContent = 'Start a new game'
      }
    }
    setSub(offlineLastSaysResumable(rec))
    void hasOfflineSave().then((has) => {
      if (has !== null && view.isConnected) setSub(has)
    })
    card.addEventListener('click', () => {
      card.disabled = true
      onOffline()
    })
  }

  function renderResumeButtons(): void {
    const section = view.querySelector<HTMLElement>('#resume-section')
    const list = view.querySelector<HTMLElement>('#resume-list')
    if (!section || !list) return
    list.innerHTML = ''
    const ss = listSessions()
    for (const s of ss) {
      const server = findServer(s.wsUrl)
      const tag = server?.tag ?? new URL(s.wsUrl).hostname.split('.')[0].slice(0, 4).toUpperCase()
      const card = document.createElement('button')
      card.type = 'button'
      card.className = 'login-account-card'
      card.innerHTML = `
        <span class="login-account-tag">${escHtml(tag)}</span>
        <span class="login-account-username">${escHtml(s.username)}</span>
      `
      card.addEventListener('click', () => resumeWithToken(s, card))
      list.appendChild(card)
    }
    if (ss.length === 0) section.hidden = true
  }

  async function resumeWithToken(s: StoredSession, card: HTMLButtonElement): Promise<void> {
    clearErrors()
    card.disabled = true

    const conn = new WsConnection(s.wsUrl)
    try {
      await conn.connect()
    } catch {
      showError(`Could not connect to ${labelFor(s.wsUrl)}`)
      card.disabled = false
      return
    }

    tokenLogin(conn, s, {
      onSuccess: (username, flush) => {
        // onLogin swaps in the lobby view, which takes over conn.onMessage;
        // flush() then replays the pre-login lobby snapshot into it.
        onLogin({ conn, username })
        flush()
      },
      onFail: () => {
        conn.close()
        showError(SESSION_EXPIRED_NOTICE)
        renderResumeButtons()
      },
    })
  }

  const form = view.querySelector<HTMLFormElement>('#login-form')!
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    clearErrors()

    const wsUrl = formSelect.value
    const username = userInput.value.trim()
    const password = passInput.value

    if (!username) { showError('Please enter a username.'); return }
    if (!password) { showError('Please enter a password.'); return }

    btn.disabled = true
    btn.textContent = 'Connecting…'

    const conn = new WsConnection(wsUrl)
    try {
      await conn.connect()
    } catch {
      showError(`Could not connect to ${labelFor(wsUrl)}`)
      btn.disabled = false
      btn.textContent = 'Connect'
      return
    }

    conn.send({ msg: 'login', username, password })

    listenOnce(conn, (msg: ServerMsg) => {
      if (msg.msg === 'login_success') {
        conn.onLoginCookie = (cookie, expiresDays) => {
          saveSession(wsUrl, msg.username, cookie, expiresDays)
        }
        conn.send({ msg: 'set_login_cookie' })
        onLogin({ conn, username: msg.username })
      } else if (msg.msg === 'login_fail') {
        showError(msg.message || 'Login failed.')
        conn.close()
        btn.disabled = false
        btn.textContent = 'Connect'
      }
    })
  })

  const spectateBtn = view.querySelector<HTMLButtonElement>('#spectate-btn')!
  spectateBtn.addEventListener('click', async () => {
    clearErrors()
    const wsUrl = spectateSelect.value
    setLastSpectateServer(wsUrl)
    spectateBtn.disabled = true
    spectateBtn.textContent = 'Connecting…'

    const conn = new WsConnection(wsUrl)
    try {
      await conn.connect()
    } catch {
      showSpectateError(`Could not connect to ${labelFor(wsUrl)}`)
      spectateBtn.disabled = false
      spectateBtn.textContent = 'Spectate →'
      return
    }

    onLogin({ conn, username: '', guest: true })
  })

  function showError(msg: string): void {
    spectateErrorEl.style.display = 'none'
    errorEl.textContent = msg
    errorEl.style.display = ''
  }

  function showSpectateError(msg: string): void {
    errorEl.style.display = 'none'
    spectateErrorEl.textContent = msg
    spectateErrorEl.style.display = ''
  }

  function clearErrors(): void {
    errorEl.style.display = 'none'
    spectateErrorEl.style.display = 'none'
  }

  return view
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Install a one-shot handler that fires on the first login_success / login_fail.
// The handler typically swaps the view, which reassigns conn.onMessage to the
// next view's handler — in that case we leave the new handler in place. If the
// handler doesn't reassign (e.g. login_fail), restore the prior onMessage.
//
// The WebTiles server pushes the lobby snapshot (lobby_clear / lobby_entry /
// lobby_complete) immediately on socket open, before login_success arrives.
// Buffer those pre-login messages and replay them to whichever handler owns
// onMessage after the login handler runs, so the lobby view sees them.
function listenOnce(conn: WsConnection, handler: (msg: ServerMsg) => void): void {
  const prev = conn.onMessage
  const buffered: ServerMsg[] = []
  const wrapper = (msg: ServerMsg) => {
    if (msg.msg === 'login_success' || msg.msg === 'login_fail') {
      handler(msg)
      if (conn.onMessage === wrapper) conn.onMessage = prev
      const next = conn.onMessage
      for (const m of buffered) next(m)
      buffered.length = 0
    } else {
      buffered.push(msg)
    }
  }
  conn.onMessage = wrapper
}
