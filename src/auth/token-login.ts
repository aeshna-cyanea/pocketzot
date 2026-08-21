// Shared token-login handshake: exchange a stored rotating cookie for a
// server session. Three consumers — the login view's account cards, the
// lobby's silent reconnect (app.ts), and the game auto-resume state machine
// (reconnect.ts). The sequence (rotation hook → token_login →
// set_login_cookie on success / clearSession on failure) used to be
// duplicated per consumer and the user-facing copy had already drifted.
//
// Callbacks, not promises, on purpose: the WebTiles server batches messages
// ({msgs:[…]}) that dispatch synchronously, and consumers rely on installing
// their follow-up handler *within* the login_success dispatch so same-batch
// messages land in it — a promise would defer that to a microtask and drop
// them into the void.
import type { ClientMsg, ServerMsg } from '../ws/types'
import { clearSession, saveSession, type StoredSession } from './session'

// Shared fatal reason. app.ts recognizes this exact value and opens inline
// password recovery for the affected account instead of displaying it as a
// generic sign-in notice.
export const SESSION_EXPIRED_NOTICE = 'Saved session expired.'

// Structural subset of WsConnection we need; reconnect.ts hands in its
// test-substitutable ResumeConn.
export interface TokenLoginConn {
  send(msg: ClientMsg): void
  onMessage: (msg: ServerMsg) => void
  onLoginCookie: (cookie: string, expiresDays: number) => void
}

export interface TokenLoginCallbacks {
  // Called synchronously when login_success dispatches, after
  // set_login_cookie has been requested. Point conn.onMessage at the
  // destination handler (mount the view / install the state machine), then
  // call flush() to replay messages that arrived during the handshake — the
  // server pushes the lobby snapshot before login_success — into it.
  onSuccess: (username: string, flush: () => void) => void
  // Called on login_fail, after the stored session has been cleared.
  onFail: () => void
}

export function tokenLogin(conn: TokenLoginConn, session: StoredSession, cb: TokenLoginCallbacks): void {
  // Keep the rotating cookie fresh on every successful (re)login.
  conn.onLoginCookie = (cookie, days) => saveSession(session.wsUrl, session.username, cookie, days)

  const buffered: ServerMsg[] = []
  const pump = (msg: ServerMsg): void => {
    if (msg.msg === 'login_success') {
      conn.send({ msg: 'set_login_cookie' })
      cb.onSuccess(msg.username, () => {
        // If no destination took over onMessage, replaying would feed the
        // buffer straight back into itself.
        if (conn.onMessage === pump) return
        for (let i = 0; i < buffered.length; i++) conn.onMessage(buffered[i]!)
        buffered.length = 0
      })
    } else if (msg.msg === 'login_fail') {
      clearSession(session.wsUrl, session.username)
      cb.onFail()
    } else {
      buffered.push(msg)
    }
  }
  conn.onMessage = pump
  conn.send({ msg: 'token_login', cookie: session.cookie })
}
