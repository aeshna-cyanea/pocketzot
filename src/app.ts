import type { GameConnection } from './ws/connection'
import type { GameExit } from './ws/types'
import { buildLoginView } from './views/login'
import { buildLobbyView } from './views/lobby'
import { buildGameView, type SpectateTarget } from './views/game-view'
import type { TileLoader } from './game/tiles/tile-loader'
import { attemptResume, clearGameStart, loadPersistedResume, markProactiveClose } from './reconnect'
import { loadSession } from './auth/session'

type AppState = 'login' | 'lobby' | 'game'

let state: AppState = 'login'
let conn: GameConnection | null = null
let root: HTMLElement
let currentUsername = ''
let currentIsGuest = false
let resumeActive = false

export function initApp(appEl: HTMLElement): void {
  root = appEl
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Mobile suspension kills the socket *without* a close frame, leaving a
      // zombie process holding the game's lockfile server-side — a later
      // resume then eats the server's hardcoded ~10s stale-purge wait. Close
      // cleanly while we still can: the server saves the game at swap-away
      // time and the resume replays `play` against a free slot in ~2s.
      if (state === 'game' && conn?.connected && !resumeActive
          && platformSuspendsSockets() && canResumeAfterClose()) {
        markProactiveClose()
        conn.close()
      }
      return
    }
    // Belt-and-braces companion to onClose: iOS delivers the socket's close
    // event promptly on foregrounding, but if the socket died while we were
    // suspended and the event is slow to land, kick the recovery ourselves.
    if ((state === 'game' || state === 'lobby') && conn && !conn.connected && !resumeActive) {
      connLost()
    }
  })
  // Offline play: ?offline=1 mounts the game view against the local WASM
  // engine (or ?engine=fake, a golden-fixture replay) with no server, login,
  // or lobby. Checked before the resume path so a stale online-resume record
  // can't hijack the boot. The URL flag is a dev/debug convenience — the real
  // entry point is the login view's offline card (onOffline below).
  if (new URLSearchParams(location.search).has('offline')) {
    void showOfflineGame()
    return
  }
  // A context in sessionStorage means iOS evicted the page mid-game (swap
  // back after memory pressure reloads the app from scratch) — resume the
  // game instead of booting to the login screen.
  const persisted = loadPersistedResume()
  if (persisted) {
    currentUsername = persisted.username
    currentIsGuest = persisted.guest
    startResume(persisted.wsUrl)
  } else {
    showLogin()
  }
}

// Offline (WASM engine) game. Bypasses login/lobby entirely: the engine has
// no account and no game list. Deliberate parameter choices: gameId '' keeps
// avatar/crypt writes disabled (both gate on a truthy id); guest=false keeps
// canResumeAfterClose() false, so the visibilitychange handler never
// proactively closes the "socket" (LocalConnection never reconnects — see
// its header). Exit lands on the login view, the app's home, where the
// offline card shows the ending state (from the offline-state record) — a
// normal exit is not an error, so nothing goes to the login error slot.
async function showOfflineGame(): Promise<void> {
  const { bootOffline } = await import('./offline/boot')
  const boot = bootOffline(new URLSearchParams(location.search))
  state = 'game'
  conn = boot.conn
  currentUsername = 'local'
  currentIsGuest = false
  setView(buildGameView(
    boot.conn,
    () => {
      boot.dispose()
      conn = null
      // Drop the ?offline flag with the session: a later reload (e.g. the
      // iOS eviction path mid-online-game) must not boot back into offline.
      history.replaceState(null, '', location.pathname)
      showLogin()
    },
    undefined,
    undefined,
    currentUsername,
    '',
    currentIsGuest,
  ))
  boot.start()
}

function showLogin(notice?: string): void {
  conn?.close()
  conn = null
  state = 'login'
  clearGameStart()
  setView(buildLoginView((result) => {
    adoptConn(result.conn)
    currentUsername = result.username
    currentIsGuest = result.guest ?? false
    showLobby(currentUsername, currentIsGuest)
  }, notice, () => { void showOfflineGame() }))
}

function showLobby(username: string, guest: boolean, exit?: GameExit): void {
  state = 'lobby'
  clearGameStart()
  setView(buildLobbyView(
    conn!,
    username,
    guest,
    (spectating, loader, gameId) => showGame(spectating, loader, gameId),
    () => showLogin(),
    exit,
  ))
}

function showGame(spectating?: SpectateTarget, loader?: TileLoader, gameId?: string): void {
  state = 'game'
  setView(buildGameView(
    conn!,
    (exit) => showLobby(currentUsername, currentIsGuest, exit),
    spectating,
    loader,
    currentUsername,
    gameId,
    currentIsGuest,
  ))
}

function adoptConn(c: GameConnection): void {
  conn = c
  c.onClose = connLost
}

// Unexpected socket loss (onClose never fires for intentional close()). Mid-
// game — the iOS app-swap case — run the full auto-resume. A lobby drop is
// equally routine (iOS kills the socket on every backgrounding) but there's
// nothing worth protecting in a lobby, and the login screen doubles as the
// app's home — server picker, account cards, guest spectate — so land there
// with no notice: an error message would frame a normal event as a failure.
// (A silent lobby *reconnect* was tried and deliberately shelved — see
// dev-material/sticky-lobby-shelved.md.)
function connLost(): void {
  if (resumeActive) return
  if (state === 'game') {
    startResume(conn!.wsUrl)
    return
  }
  showLogin(state === 'lobby' ? undefined : 'Connection lost.')
}

function startResume(wsUrl: string): void {
  resumeActive = true
  attemptResume({
    wsUrl,
    username: currentUsername,
    guest: currentIsGuest,
    onGame: (newConn, spectating, loader, gameId) => {
      resumeActive = false
      adoptConn(newConn)
      // iOS grants a brief JS window after backgrounding, so an in-flight
      // resume can complete while hidden — past the hidden edge that closes
      // sockets proactively. Left open, this one just zombifies and costs the
      // next resume the ~10s stale wait; close it cleanly now and let the
      // foreground edge resume it again.
      if (document.hidden && platformSuspendsSockets() && canResumeAfterClose()) {
        markProactiveClose()
        newConn.close()
      }
      showGame(spectating, loader, gameId)
    },
    onLobby: (newConn, exit) => {
      resumeActive = false
      adoptConn(newConn)
      showLobby(currentUsername, currentIsGuest, exit)
    },
    onGiveUp: (notice) => {
      resumeActive = false
      showLogin(notice)
    },
  })
}

// A proactive close is only an improvement if the resume that follows it can
// actually sign back in. Guests resume without a credential (watch only);
// everyone else needs a stored session cookie — a server configured with
// login_token_lifetime <= 0 hands out already-expired ones, and killing a
// healthy socket we can't resume would kick the user to the login screen on
// every app swap.
function canResumeAfterClose(): boolean {
  return currentIsGuest || (conn != null && !!loadSession(conn.wsUrl, currentUsername))
}

// Whether backgrounding is likely to kill our socket without a close frame.
// True on iOS/iPadOS (including PWA standalone) and Android; desktop browsers
// keep background-tab sockets alive, and closing on every tab switch there
// would be pure regression. The iPadOS check catches its desktop-Mac UA
// masquerade (MacIntel platform + real touch points). Read at event time so
// tests can override the UA.
function platformSuspendsSockets(): boolean {
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

function setView(el: HTMLElement): void {
  root.textContent = ''
  root.appendChild(el)
}

export { state }
