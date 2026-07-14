import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
// @ts-expect-error plain-JS module (inlined into the classic-script SW at build)
import { classify, PRECACHE_EXTRAS } from './classify.js'

const ORIGIN = 'https://pocketzot.app'

function run(
  url: string,
  { method = 'GET', mode = 'no-cors', origin = ORIGIN } = {},
) {
  const u = new URL(url, origin)
  return classify(u, {
    method,
    mode,
    sameOrigin: u.origin === ORIGIN,
  })
}

describe('classify — the design doc routing table', () => {
  it('passes through non-GET and cross-origin requests', () => {
    expect(run('/', { method: 'POST', mode: 'navigate' })).toBe('passthrough')
    expect(run('https://crawl.dcss.io/gamedata/x/player.png', { origin: 'https://crawl.dcss.io' })).toBe('passthrough')
    // cross-origin /assets-lookalike must not be claimed
    expect(run('https://evil.example/assets/index-abc.js', { origin: 'https://evil.example' })).toBe('passthrough')
  })

  it('never touches the engine-artifact or gamedata paths', () => {
    expect(run('/offline/version.json')).toBe('passthrough')
    expect(run('/offline/crawl.wasm.gz')).toBe('passthrough')
    expect(run('/gamedata/local/tileinfo-player.js')).toBe('passthrough')
    expect(run('/gamedata/local/player.png')).toBe('passthrough')
  })

  it('routes shell navigations network-first, query string irrelevant', () => {
    expect(run('/', { mode: 'navigate' })).toBe('network-first')
    expect(run('/index.html', { mode: 'navigate' })).toBe('network-first')
    expect(run('/?offline=1', { mode: 'navigate' })).toBe('network-first')
    expect(run('/?engine=fake&fixture=x', { mode: 'navigate' })).toBe('network-first')
  })

  it('passes through non-shell navigations (SEO mirrors, morgues)', () => {
    expect(run('/about.html', { mode: 'navigate' })).toBe('passthrough')
    expect(run('/changelog.html', { mode: 'navigate' })).toBe('passthrough')
    expect(run('/404.html', { mode: 'navigate' })).toBe('passthrough')
  })

  it('serves hashed assets and install files cache-first', () => {
    expect(run('/assets/index-Ab12Cd3.js')).toBe('cache-first')
    expect(run('/assets/boot-XyZ.css')).toBe('cache-first')
    for (const path of PRECACHE_EXTRAS) {
      expect(run(path)).toBe('cache-first')
    }
  })

  it('passes through every other same-origin GET', () => {
    expect(run('/shot-login.png')).toBe('passthrough')
    expect(run('/hero.png')).toBe('passthrough')
    expect(run('/robots.txt')).toBe('passthrough')
    expect(run('/sw.js')).toBe('passthrough')
  })
})

describe('sw.js template contract', () => {
  const dir = resolve(__dirname)
  const template = readFileSync(resolve(dir, 'sw.js'), 'utf8')
  const classifySrc = readFileSync(resolve(dir, 'classify.js'), 'utf8')

  it('holds both build-plugin tokens exactly once', () => {
    expect(template.split('__PRECACHE_MANIFEST__')).toHaveLength(2)
    expect(template.split('__CLASSIFY__')).toHaveLength(2)
  })

  it('classify.js stays classic-script-safe after export stripping', () => {
    // The plugin only strips leading `export ` keywords; any import (or
    // other module syntax) would throw inside the classic worker script.
    expect(classifySrc).not.toMatch(/^import /m)
    expect(classifySrc.replace(/^export /gm, '')).not.toMatch(/^export /m)
  })

  it('kill switch sweeps the same cache prefix sw.js creates', () => {
    // sw-kill.js must stay standalone (deployed by cp, no build step), so
    // the prefix can't be a shared import — this pins the duplication.
    const kill = readFileSync(resolve(dir, 'sw-kill.js'), 'utf8')
    expect(template).toContain("'pz-shell-'")
    expect(kill).toContain("'pz-shell-'")
  })

  it('the SW never self-promotes; only the kill switch does', () => {
    expect(template).not.toMatch(/\.skipWaiting\(/)
    expect(template).not.toMatch(/\.claim\(/)
    const kill = readFileSync(resolve(dir, 'sw-kill.js'), 'utf8')
    expect(kill).toMatch(/\.skipWaiting\(/)
    expect(kill).toContain('unregister')
  })
})
