import { WsConnection, type GameConnection } from './ws/connection'
import type { GameExit } from './ws/types'
import { buildLoginView, type ReauthAccount } from './views/login'
import { buildLobbyView } from './views/lobby'
import { buildOfflineLobbyView } from './views/offline-lobby'
import { buildGameView, type SpectateTarget } from './views/game-view'
import type { TileLoader } from './game/tiles/tile-loader'
import { OFFLINE_GAME_ID, validateOfflineName } from './offline/offline-state'
import {
  attemptResume, clearGameStart, loadPersistedResume, markProactiveClose, rememberGameStart,
} from './reconnect'
import { count } from './counter'
import { getPref } from './prefs'
import { listSessions, loadSession, sessionExpired } from './auth/session'
import { SESSION_EXPIRED_NOTICE, tokenLogin } from './auth/token-login'
import { parseAppRoute, replaceRoute, type OnlineRoute } from './routes'

type AppState = 'login' | 'lobby' | 'game'

let state: AppState = 'login'
let conn: GameConnection | null = null
let root: HTMLElement
let currentUsername = ''
let currentIsGuest = false
let resumeActive = false
let pendingOnlineRoute: OnlineRoute | null = null

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
  // Offline routes open either the save-slot lobby or one named game with no
  // server or login. Checked before the resume path so a stale online-resume
  // record can't hijack the boot. ?engine=fake (a golden-fixture replay)
  // skips the lobby and mounts the game view directly: fixtures have no save
  // slot, and the replay flows drive rendering, not slot management.
  const params = new URLSearchParams(location.search)
  const initialRoute = parseAppRoute(location)
  // Perf harness: ?replay=<recording> replays a __dcssRec capture through the
  // real game view with instrumentation (src/perf/replay.ts) — a lab bench,
  // not a session: no login, no resume, no server. Checked first so a stale
  // resume record can't hijack a profiling run. DEV-only (recordings are
  // only served by the dev server); the DEV gate also keeps the lazy replay
  // chunk out of prod builds entirely.
  if (import.meta.env.DEV && params.get('replay')) {
    void (async () => {
      const { buildReplayView } = await import('./perf/replay')
      setView(await buildReplayView(params))
    })().catch((e: unknown) => showFatal(`Replay failed: ${e instanceof Error ? e.message : String(e)}`))
    return
  }
  if (initialRoute.kind === 'offline-lobby' || initialRoute.kind === 'offline-play') {
    if (params.get('engine') === 'fake') void showOfflineGame('local')
    else if (initialRoute.kind === 'offline-play' && !validateOfflineName(initialRoute.name)) {
      void showOfflineGame(initialRoute.name)
    }
    else showOfflineLobby()
    return
  }
  if (initialRoute.kind.startsWith('online-')) {
    openOnlineRoute(initialRoute as OnlineRoute)
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

// A routed server can resume automatically only when it identifies one saved
// account unambiguously. The stored value is WebTiles' rotating login token,
// never the password. With zero or multiple accounts, leave the routed login
// home visible and let the user choose an identity (or guest spectate).
function openOnlineRoute(route: OnlineRoute): void {
  // #lobby describes an authenticated screen. Strip it while login is still
  // pending; unlike lobby, #play/#watch carry a destination that must survive
  // authentication and therefore remain visible.
  const pending: OnlineRoute = route.kind === 'online-lobby'
    ? { kind: 'online-login', wsUrl: route.wsUrl, loginUsername: route.loginUsername }
    : route
  pendingOnlineRoute = pending
  showLogin(undefined, pending)
  const sessions = listSessions().filter(session =>
    session.wsUrl === pending.wsUrl
    && (!pending.loginUsername
      || session.username.toLowerCase() === pending.loginUsername.toLowerCase()),
  )
  if (sessions.length !== 1) return

  const session = sessions[0]!
  if (sessionExpired(session)) {
    showLogin(undefined, pending, session)
    return
  }
  const next = new WsConnection(pending.wsUrl)
  void next.connect().then(() => {
    // The user may have navigated elsewhere while the socket opened.
    if (pendingOnlineRoute !== pending || state !== 'login') {
      next.close()
      return
    }
    tokenLogin(next, session, {
      onSuccess: (username, flush) => {
        if (pendingOnlineRoute !== pending || state !== 'login') {
          next.close()
          return
        }
        enterLobby(next, username, false)
        flush()
      },
      onFail: () => {
        next.close()
        if (pendingOnlineRoute === pending && state === 'login') {
          showLogin(undefined, pending, session)
        }
      },
    })
  }).catch(() => {
    if (pendingOnlineRoute === pending && state === 'login') {
      showLogin('Could not connect to the selected server.', pending)
    }
  })
}

// The offline "server" lobby: the on-device analog of showLobby — save-slot
// list, new-character flow, backup export/import (views/offline-lobby.ts).
// No connection exists here; back returns to the login home.
function showOfflineLobby(exit?: GameExit, syncRoute = true): void {
  conn?.close()
  conn = null
  state = 'lobby'
  clearGameStart()
  if (syncRoute) replaceRoute({ kind: 'offline-lobby' })
  setView(buildOfflineLobbyView(
    (name) => { void showOfflineGame(name) },
    () => showLogin(),
    exit,
  ))
}

// Offline (WASM engine) game for one save slot — `name` is the character
// name, which the engine also uses as the save file identity (-name argv).
// Deliberate parameter choices: gameId 'offline' enables avatar/crypt writes
// (both gate on a truthy id), so offline characters join the login doll shelf
// and crypt — wsUrl 'local://offline' + username=name keep their slot keys
// disjoint from every server's, and captures eager-bake PNG thumbnails off
// the same-origin pack (game-view maybeSaveAvatar). guest=false keeps
// canResumeAfterClose() false, so the visibilitychange handler never
// proactively closes the "socket" (LocalConnection never reconnects — see its
// header). Exit returns to the offline lobby, which shows the same
// end-of-game dialog as the online one.
async function showOfflineGame(name: string): Promise<void> {
  let bootMod: typeof import('./offline/boot')
  try {
    bootMod = await import('./offline/boot')
  } catch (e) {
    showFatal(`Offline engine failed to load: ${String(e)}`)
    return
  }
  const { bootOffline } = bootMod
  const params = new URLSearchParams(location.search)
  const boot = bootOffline(params, name)
  // Fixture replays get no gameId, keeping avatar/crypt writes disabled —
  // same reason boot.ts excludes them from the slot-record tracker: a golden
  // capture's character isn't yours and must not mint a phantom shelf entry.
  const gameId = params.get('engine') === 'fake' ? '' : OFFLINE_GAME_ID
  if (gameId) count('play-offline', { ascii: getPref('mapRenderMode') === 'ascii' })
  state = 'game'
  conn = boot.conn
  currentUsername = name
  currentIsGuest = false
  replaceRoute({ kind: 'offline-play', name })
  setView(buildGameView(
    boot.conn,
    (exit) => {
      boot.dispose()
      conn = null
      // Fixture replays are a lab surface, not a persistent offline route:
      // preserve their dev params but drop ?offline after the run as before.
      if (params.get('engine') === 'fake') {
        replaceRoute({ kind: 'home' })
        showOfflineLobby(exit, false)
      } else {
        showOfflineLobby(exit)
      }
    },
    undefined,
    undefined,
    currentUsername,
    gameId,
    currentIsGuest,
  ))
  boot.start()
}

function showLogin(notice?: string, routed?: OnlineRoute, reauthAccount?: ReauthAccount): void {
  conn?.close()
  conn = null
  state = 'login'
  clearGameStart()
  if (routed) {
    pendingOnlineRoute = routed
    replaceRoute(routed)
  }
  else {
    pendingOnlineRoute = null
    replaceRoute({ kind: 'home' })
  }
  setView(buildLoginView(
    (result) => { enterLobby(result.conn, result.username, result.guest ?? false) },
    notice,
    () => showOfflineLobby(),
    routed?.wsUrl,
    selectOnlineServer,
    routed?.loginUsername,
    reauthAccount,
  ))
}

// Server selection is navigation even before a socket opens: expose it in the
// URL as soon as the user changes a picker or chooses an account, so password
// managers and copied links see the intended WebTiles origin discriminator.
function selectOnlineServer(wsUrl: string, loginUsername?: string): void {
  // A login action for the same deep-linked server must not erase its pending
  // #play/#watch target. A deliberate picker change to another server does.
  const route: OnlineRoute = pendingOnlineRoute?.wsUrl === wsUrl
    ? { ...pendingOnlineRoute, loginUsername: loginUsername || pendingOnlineRoute.loginUsername }
    : { kind: 'online-login', wsUrl, loginUsername }
  pendingOnlineRoute = route
  replaceRoute(route)
}

// Every route onto a server ends the same way: take the connection, record who
// we are on it, show that server's lobby. The identity pair and the mounted
// view have to move together — showGame and connLost both read it back.
function enterLobby(c: GameConnection, username: string, guest: boolean, exit?: GameExit): void {
  adoptConn(c)
  currentUsername = username
  currentIsGuest = guest
  const pending = pendingOnlineRoute?.wsUrl === c.wsUrl ? pendingOnlineRoute : null
  const destination = pending && !guest ? { ...pending, loginUsername: username } : pending
  pendingOnlineRoute = null
  const routedGameId = destination?.kind === 'online-play' && !guest ? destination.gameId : ''
  showLobby(username, guest, exit, routedGameId)
  if (destination?.kind === 'online-watch') {
    rememberGameStart(
      { kind: 'watch', username: destination.username },
      { wsUrl: c.wsUrl, username, guest },
    )
    replaceRoute(destination)
    c.send({ msg: 'watch', username: destination.username })
  } else if (destination?.kind === 'online-play' && !guest) {
    rememberGameStart(
      { kind: 'play', gameId: destination.gameId },
      { wsUrl: c.wsUrl, username, guest },
    )
    replaceRoute(destination)
    c.send({ msg: 'play', game_id: destination.gameId })
  }
}

function showLobby(username: string, guest: boolean, exit?: GameExit, routedGameId = ''): void {
  state = 'lobby'
  clearGameStart()
  replaceRoute({
    kind: 'online-lobby',
    wsUrl: conn!.wsUrl,
    loginUsername: guest ? undefined : username,
  })
  setView(buildLobbyView(
    conn!,
    username,
    guest,
    (spectating, loader, gameId) => showGame(spectating, loader, gameId || routedGameId),
    () => showLogin(),
    exit,
    guest ? switchSpectateServer : undefined,
  ))
}

// Guest-only server hop, from the lobby's header chip. The new socket is
// opened before the old one is dropped, so a server that won't answer leaves
// the user on the lobby they were already watching rather than stranded on
// the login screen. A guest connection needs no login handshake — the server
// pushes its lobby snapshot on open (see login.ts's spectate path).
async function switchSpectateServer(wsUrl: string): Promise<void> {
  const prev = conn
  const next = new WsConnection(wsUrl)
  await next.connect()
  // The lobby stays live while we connect, so the user may have moved on — into
  // a game they tapped (still this connection, so `state` is what catches it),
  // or onto some other connection entirely: back to login, into the offline
  // lobby, signed in. Whatever is on screen now wins; drop the unasked-for
  // socket rather than closing one that something is already reading.
  if (state !== 'lobby' || conn !== prev) {
    next.close()
    return
  }
  conn?.close()
  enterLobby(next, '', true)
}

function showGame(spectating?: SpectateTarget, loader?: TileLoader, gameId?: string): void {
  const resolvedGameId = spectating ? '' : gameId || ''
  count(spectating ? 'spectate' : 'play', { ascii: getPref('mapRenderMode') === 'ascii' })
  state = 'game'
  if (spectating) {
    replaceRoute({
      kind: 'online-watch',
      wsUrl: conn!.wsUrl,
      username: spectating.username,
      loginUsername: currentIsGuest ? undefined : currentUsername,
    })
  } else if (resolvedGameId) {
    replaceRoute({
      kind: 'online-play',
      wsUrl: conn!.wsUrl,
      gameId: resolvedGameId,
      loginUsername: currentUsername,
    })
  }
  setView(buildGameView(
    conn!,
    (exit) => showLobby(currentUsername, currentIsGuest, exit),
    spectating,
    loader,
    currentUsername,
    resolvedGameId,
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
      enterLobby(newConn, currentUsername, currentIsGuest, exit)
    },
    onGiveUp: (notice) => {
      resumeActive = false
      if (notice === SESSION_EXPIRED_NOTICE && !currentIsGuest) {
        const parsed = parseAppRoute(location)
        const parsedOnline = parsed.kind.startsWith('online-') ? parsed as OnlineRoute : null
        const routed: OnlineRoute = parsedOnline?.wsUrl === wsUrl
          ? { ...parsedOnline, loginUsername: currentUsername }
          : { kind: 'online-login', wsUrl, loginUsername: currentUsername }
        showLogin(undefined, routed, { wsUrl, username: currentUsername })
      } else {
        showLogin(notice)
      }
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

// Dynamic-import failure surface: a stale SW start doc serving rotated chunk
// hashes after a deploy makes lazy chunks 404 — that must render something,
// not leave a blank #app with a silent unhandled rejection.
function showFatal(text: string): void {
  const el = document.createElement('pre')
  el.style.cssText = 'padding:16px;color:#eeeeec;white-space:pre-wrap'
  el.textContent = text
  setView(el)
}

export { state }
