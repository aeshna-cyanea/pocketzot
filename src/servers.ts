// The production CSP permits HTTP(S) tile assets by scheme because custom
// servers cannot be enumerated at build time. See the trust warning beside
// the custom-server field and in ABOUT.md.
//
// `tag` is the official server acronym from the DCSS howto
// (https://crawl.develz.org/wordpress/howto), used as a compact label in
// places like the lobby header.
export interface KnownServer {
  label: string
  tag: string
  wsUrl: string
}

export const KNOWN_SERVERS: KnownServer[] = [
  { label: 'crawl.dcss.io', tag: 'CDI', wsUrl: 'wss://crawl.dcss.io/socket' },
  { label: 'crawl.akrasiac.org', tag: 'CAO', wsUrl: 'wss://crawl.akrasiac.org:8443/socket' },
  { label: 'cbro.berotato.org', tag: 'CBR2', wsUrl: 'wss://cbro.berotato.org:8443/socket' },
  { label: 'crawl.roguelikes.gg', tag: 'CRG', wsUrl: 'wss://crawl.roguelikes.gg/socket' },
  { label: 'crawl-br.roguelikes.gg', tag: 'CBRG', wsUrl: 'wss://crawl-br.roguelikes.gg/socket' },
  { label: 'crawl.xtahua.com', tag: 'CXC', wsUrl: 'wss://crawl.xtahua.com/socket' },
  { label: 'underhound.eu', tag: 'CUE', wsUrl: 'wss://underhound.eu:8080/socket' },
  { label: 'crawl.nemelex.cards', tag: 'CNC', wsUrl: 'wss://crawl.nemelex.cards/socket' },
  { label: 'crawl.project357.org', tag: 'CPO', wsUrl: 'wss://crawl.project357.org/socket' },
]

// CAO requires authentication for spectating, so it's excluded from the
// anonymous spectate dropdown.
export const SPECTATE_SERVERS: KnownServer[] = KNOWN_SERVERS.filter(
  s => s.tag !== 'CAO',
)

export function findServer(wsUrl: string): KnownServer | undefined {
  return KNOWN_SERVERS.find(s => s.wsUrl === wsUrl)
}

export function tagFor(wsUrl: string): string {
  return findServer(wsUrl)?.tag ?? new URL(wsUrl).hostname
}

export function labelFor(wsUrl: string): string {
  return findServer(wsUrl)?.label ?? wsUrl
}

// Canonicalize a WebTiles host (or complete secure socket URL) before it
// becomes route, session, or connection identity. PocketZot deliberately
// assumes the standard WebTiles endpoint: wss://<host>/socket. That keeps a
// route's `server` value to host[:port] without an alias table or encoded URL.
export function normalizeServerUrl(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  try {
    const url = new URL(value.includes('://') ? value : `wss://${value}`)
    if (url.protocol !== 'wss:') return null
    if (!url.hostname || url.username || url.password || url.hash || url.search) return null
    if (url.pathname !== '/' && url.pathname !== '/socket' && url.pathname !== '/socket/') return null
    url.pathname = '/socket'
    return url.href
  } catch {
    return null
  }
}
