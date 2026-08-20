import { describe, expect, it } from 'vitest'
import { parseAppRoute, routeHref, serverFromRouteKey, serverRouteKey } from './routes'
import { normalizeServerUrl } from './servers'

const CDI = 'wss://crawl.dcss.io/socket'

function source(search = '', hash = '', path = '/pocketzot/') {
  return { href: `https://example.test${path}${search}${hash}`, search, hash }
}

describe('app routes', () => {
  it('uses WebTiles hashes beneath a compact server selector', () => {
    expect(routeHref({ kind: 'online-login', wsUrl: CDI, loginUsername: 'Foo Bar' }, source('?src=pwa')))
      .toBe('/pocketzot/?src=pwa&server=cdi&username=Foo+Bar')
    expect(routeHref({ kind: 'online-lobby', wsUrl: CDI, loginUsername: 'Foo Bar' }, source('?src=pwa')))
      .toBe('/pocketzot/?src=pwa&server=cdi&username=Foo+Bar#lobby')
    expect(routeHref({
      kind: 'online-play', wsUrl: CDI, gameId: 'dcss-0.35', loginUsername: 'alice',
    }, source()))
      .toBe('/pocketzot/?server=cdi&username=alice#play-dcss-0.35')
    expect(routeHref({ kind: 'online-watch', wsUrl: CDI, username: 'Foo Bar' }, source()))
      .toBe('/pocketzot/?server=cdi#watch-Foo%20Bar')
    expect(routeHref({ kind: 'online-login', wsUrl: 'wss://custom.example/socket' }, source()))
      .toBe('/pocketzot/?server=wss%3A%2F%2Fcustom.example%2Fsocket')
  })

  it('integrates the existing offline query with lobby and save-slot routes', () => {
    expect(routeHref({ kind: 'offline-lobby' }, source('?engine=fake')))
      .toBe('/pocketzot/?engine=fake&offline=1#lobby')
    expect(routeHref({ kind: 'offline-play', name: 'My Guy' }, source()))
      .toBe('/pocketzot/?offline=1#play-My%20Guy')
  })

  it('parses online, offline, and malformed routes safely', () => {
    expect(parseAppRoute(source('?server=CDI&username=alice')))
      .toEqual({ kind: 'online-login', wsUrl: CDI, loginUsername: 'alice' })
    expect(parseAppRoute(source('?server=CDI&username=alice', '#lobby')))
      .toEqual({ kind: 'online-lobby', wsUrl: CDI, loginUsername: 'alice' })
    expect(parseAppRoute(source('?server=CDI&username=alice', '#watch-Foo%20Bar')))
      .toEqual({ kind: 'online-watch', wsUrl: CDI, username: 'Foo Bar', loginUsername: 'alice' })
    expect(parseAppRoute(source('?offline=1', '#play-My%20Guy')))
      .toEqual({ kind: 'offline-play', name: 'My Guy' })
    expect(parseAppRoute(source('?server=unknown', '#play-x'))).toEqual({ kind: 'home' })
    expect(parseAppRoute(source('', '#play-x'))).toEqual({ kind: 'home' })
  })

  it('accepts tags, hostnames, and explicit custom websocket URLs', () => {
    expect(serverRouteKey(CDI)).toBe('cdi')
    expect(serverFromRouteKey('CDI')).toBe(CDI)
    expect(serverFromRouteKey('crawl.dcss.io')).toBe(CDI)
    expect(serverFromRouteKey('wss://example.test/socket')).toBe('wss://example.test/socket')
    expect(normalizeServerUrl(' wss://example.test/socket ')).toBe('wss://example.test/socket')
    expect(normalizeServerUrl('https://example.test/socket')).toBeNull()
    expect(normalizeServerUrl('wss://user:secret@example.test/socket')).toBeNull()
  })

  it('clears only route-owned parameters when returning home', () => {
    expect(routeHref({ kind: 'home' }, source('?offline=1&username=alice&engine=fake&fixture=x', '#lobby')))
      .toBe('/pocketzot/?engine=fake&fixture=x')
  })
})
