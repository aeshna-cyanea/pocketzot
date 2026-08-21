// Per-server login-cookie persistence. The DCSS WebTiles server issues a
// rotating session token via {msg:"login_cookie", cookie, expires} after a
// successful password login (when the client asks for one with
// {msg:"set_login_cookie"}). The token can later be exchanged for a session
// with {msg:"token_login", cookie}, avoiding a password prompt.
//
// Sessions are keyed by (wsUrl, username) so multiple accounts on the same
// server can be stored side-by-side. The delimiter is a NUL byte, which can
// appear in neither URLs nor DCSS usernames.

const KEY_PREFIX = 'pocketzot:login:'
const SEP = '\x00'

export interface StoredSession {
  wsUrl: string
  username: string
  cookie: string
  expiresAtMs: number
}

export function sessionExpired(session: StoredSession, now = Date.now()): boolean {
  return session.expiresAtMs <= now
}

function storageKey(wsUrl: string, username: string): string {
  return KEY_PREFIX + wsUrl + SEP + username.toLowerCase()
}

export function loadSession(wsUrl: string, username: string): StoredSession | null {
  const k = storageKey(wsUrl, username)
  const raw = localStorage.getItem(k)
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as StoredSession
    // Keep the record so the login screen can retain the server/account
    // identity and ask for a fresh password. The expired token is never used.
    if (sessionExpired(s)) return null
    return s
  } catch {
    localStorage.removeItem(k)
    return null
  }
}

export function saveSession(wsUrl: string, username: string, cookie: string, expiresDays: number): void {
  const s: StoredSession = {
    wsUrl,
    username,
    cookie,
    expiresAtMs: Date.now() + expiresDays * 86400_000,
  }
  localStorage.setItem(storageKey(wsUrl, username), JSON.stringify(s))
}

export function clearSession(wsUrl: string, username: string): void {
  localStorage.removeItem(storageKey(wsUrl, username))
}

export function listSessions(): StoredSession[] {
  const out: StoredSession[] = []
  const corrupt: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (!k || !k.startsWith(KEY_PREFIX)) continue
    const raw = localStorage.getItem(k)
    if (!raw) continue
    try {
      const s = JSON.parse(raw) as StoredSession
      if (typeof s.wsUrl === 'string' && typeof s.username === 'string'
          && typeof s.cookie === 'string' && typeof s.expiresAtMs === 'number') out.push(s)
      else corrupt.push(k)
    } catch { corrupt.push(k) }
  }
  for (const k of corrupt) localStorage.removeItem(k)
  return out
}
