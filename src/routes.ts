// URL routes for the static app. The selected WebTiles host and optional
// public account name live in the query (`?server=underhound.eu:8080` /
// `?offline=1`), while the screen uses Crawl WebTiles' established hash
// vocabulary (`#lobby`, `#play-…`, `#watch-…`). WebTiles' standard
// wss://<host>/socket endpoint is implicit. Hash routes keep deep links
// compatible with GitHub project Pages: every reload still requests the real
// app entry path rather than a server-side route.

import { normalizeServerUrl } from './servers'

export type AppRoute =
  | { kind: 'home' }
  | { kind: 'offline-lobby' }
  | { kind: 'offline-play'; name: string }
  | OnlineRoute

export type OnlineRoute =
  | { kind: 'online-login'; wsUrl: string; loginUsername?: string }
  | { kind: 'online-lobby'; wsUrl: string; loginUsername?: string }
  | { kind: 'online-play'; wsUrl: string; gameId: string; loginUsername?: string }
  | { kind: 'online-watch'; wsUrl: string; username: string; loginUsername?: string }

type UrlSource = Pick<Location, 'href' | 'search' | 'hash'>

export function serverRouteHost(wsUrl: string): string {
  const normalized = normalizeServerUrl(wsUrl)
  if (!normalized) throw new Error(`Invalid standard WebTiles URL: ${wsUrl}`)
  return new URL(normalized).host
}

export function serverFromRouteHost(host: string | null): string | null {
  if (!host || host.includes('/') || host.includes('@')) return null
  return normalizeServerUrl(host)
}

function hashTarget(hash: string):
  | { kind: 'login' }
  | { kind: 'lobby' }
  | { kind: 'play'; value: string }
  | { kind: 'watch'; value: string } {
  const raw = hash.replace(/^#/, '')
  if (!raw) return { kind: 'login' }
  if (raw.toLowerCase() === 'lobby') return { kind: 'lobby' }
  const match = /^(play|watch)-(.+)$/i.exec(raw)
  if (!match) return { kind: 'login' }
  let value: string
  try { value = decodeURIComponent(match[2]!) } catch { return { kind: 'lobby' } }
  if (!value) return { kind: 'lobby' }
  return match[1]!.toLowerCase() === 'play'
    ? { kind: 'play', value }
    : { kind: 'watch', value }
}

export function parseAppRoute(source: Pick<UrlSource, 'search' | 'hash'>): AppRoute {
  const params = new URLSearchParams(source.search)
  const target = hashTarget(source.hash)
  if (params.has('offline')) {
    return target.kind === 'play'
      ? { kind: 'offline-play', name: target.value }
      : { kind: 'offline-lobby' }
  }

  const wsUrl = serverFromRouteHost(params.get('server'))
  if (!wsUrl) return { kind: 'home' }
  const loginUsername = params.get('username')?.trim() || undefined
  if (target.kind === 'play') return { kind: 'online-play', wsUrl, gameId: target.value, loginUsername }
  if (target.kind === 'watch') {
    return { kind: 'online-watch', wsUrl, username: target.value, loginUsername }
  }
  return target.kind === 'lobby'
    ? { kind: 'online-lobby', wsUrl, loginUsername }
    : { kind: 'online-login', wsUrl, loginUsername }
}

export function routeHref(route: AppRoute, source: UrlSource = location): string {
  const url = new URL(source.href)
  url.searchParams.delete('offline')
  url.searchParams.delete('server')
  url.searchParams.delete('username')

  switch (route.kind) {
    case 'home':
      url.hash = ''
      break
    case 'offline-lobby':
      url.searchParams.set('offline', '1')
      url.hash = 'lobby'
      break
    case 'offline-play':
      url.searchParams.set('offline', '1')
      url.hash = `play-${encodeURIComponent(route.name)}`
      break
    case 'online-login':
      url.searchParams.set('server', serverRouteHost(route.wsUrl))
      if (route.loginUsername) url.searchParams.set('username', route.loginUsername)
      url.hash = ''
      break
    case 'online-lobby':
      url.searchParams.set('server', serverRouteHost(route.wsUrl))
      if (route.loginUsername) url.searchParams.set('username', route.loginUsername)
      url.hash = 'lobby'
      break
    case 'online-play':
      url.searchParams.set('server', serverRouteHost(route.wsUrl))
      if (route.loginUsername) url.searchParams.set('username', route.loginUsername)
      url.hash = `play-${encodeURIComponent(route.gameId)}`
      break
    case 'online-watch':
      url.searchParams.set('server', serverRouteHost(route.wsUrl))
      if (route.loginUsername) url.searchParams.set('username', route.loginUsername)
      url.hash = `watch-${encodeURIComponent(route.username)}`
      break
  }
  return url.pathname + url.search + url.hash
}

export function replaceRoute(route: AppRoute): void {
  history.replaceState(null, '', routeHref(route))
}
