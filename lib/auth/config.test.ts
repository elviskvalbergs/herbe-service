// lib/auth/config.test.ts
//
// Auth.js v5's own JWT `iat` claim is reset to "now" on every re-encode
// (@auth/core's jwt.ts calls jose's `.setIssuedAt()` with no argument every
// time, and the jwt-strategy session action re-encodes on every session
// read — see node_modules/.../@auth/core/src/jwt.ts and
// lib/actions/session.ts). Anchoring a 30-day absolute cap on that claim
// would never trip: it gets bumped to "now" on every request, not just at
// sign-in. These tests pin down the custom `authTime` claim jwtCallback uses
// instead, which Auth.js's encoder never touches.
import { beforeAll, describe, expect, it } from 'vitest'
import type { JWT } from 'next-auth/jwt'

// `./config` transitively imports `@/lib/db`, which reads DATABASE_URL at
// module-load time (throws if unset) — same convention as
// __tests__/lib/db.test.ts. A dummy, unreachable URL is fine here: these
// tests only exercise the pure jwtCallback/sessionCallback functions, which
// never touch the database.
let jwtCallback: typeof import('./config').jwtCallback
let sessionCallback: typeof import('./config').sessionCallback

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/unused'
  ;({ jwtCallback, sessionCallback } = await import('./config'))
})

describe('jwtCallback', () => {
  it('sets userId, sessionVersion, and authTime on trigger "signIn"', () => {
    const nowSecs = Math.floor(Date.now() / 1000)
    const token = jwtCallback({ token: {}, user: { id: 'user-1' }, trigger: 'signIn' })

    expect(token?.userId).toBe('user-1')
    expect(token?.sessionVersion).toBe(1)
    expect(token?.authTime).toBeGreaterThanOrEqual(nowSecs - 1)
    expect(token?.authTime).toBeLessThanOrEqual(nowSecs + 1)
  })

  it('preserves the original authTime across a later call with no trigger (rolling refresh)', () => {
    const originalAuthTime = Math.floor(Date.now() / 1000) - 60 * 60 // signed in 1h ago
    const existingToken: JWT = { userId: 'user-1', sessionVersion: 1, authTime: originalAuthTime }

    const refreshed = jwtCallback({ token: existingToken, trigger: undefined })

    // Must NOT be bumped to "now" — that would defeat the absolute cap.
    expect(refreshed?.authTime).toBe(originalAuthTime)
  })

  it('drops the session (returns null) once authTime is older than the 30-day absolute cap', () => {
    const THIRTY_ONE_DAYS_AGO = Math.floor(Date.now() / 1000) - 31 * 24 * 60 * 60
    const staleToken: JWT = { userId: 'user-1', sessionVersion: 1, authTime: THIRTY_ONE_DAYS_AGO }

    const result = jwtCallback({ token: staleToken })

    expect(result).toBeNull()
  })

  it('keeps the session alive just under the 30-day absolute cap', () => {
    const TWENTY_NINE_DAYS_AGO = Math.floor(Date.now() / 1000) - 29 * 24 * 60 * 60
    const token: JWT = { userId: 'user-1', sessionVersion: 1, authTime: TWENTY_NINE_DAYS_AGO }

    const result = jwtCallback({ token })

    expect(result?.authTime).toBe(TWENTY_NINE_DAYS_AGO)
  })

  it('does not set userId/authTime on a non-signIn call with no prior token state', () => {
    // Defensive case: no trigger and no user (e.g. a malformed/expired
    // decode) — authTime falls back to "now" rather than throwing.
    const nowSecs = Math.floor(Date.now() / 1000)
    const token = jwtCallback({ token: {} })

    expect(token?.userId).toBeUndefined()
    expect(token?.authTime).toBeGreaterThanOrEqual(nowSecs - 1)
  })
})

describe('sessionCallback', () => {
  it('copies token.userId onto session.user.id', () => {
    const session = sessionCallback({
      session: { user: { id: '' }, expires: '2099-01-01T00:00:00.000Z' },
      token: { userId: 'user-1' },
    })

    expect(session.user.id).toBe('user-1')
  })

  it('leaves session.user.id untouched when the token has no userId', () => {
    const session = sessionCallback({
      session: { user: { id: 'unchanged' }, expires: '2099-01-01T00:00:00.000Z' },
      token: {},
    })

    expect(session.user.id).toBe('unchanged')
  })
})
