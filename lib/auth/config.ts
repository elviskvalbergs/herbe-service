// lib/auth/config.ts
import type { DefaultSession, NextAuthConfig, Session } from 'next-auth'
import type { JWT } from 'next-auth/jwt'
import Credentials from 'next-auth/providers/credentials'
import { db } from '@/lib/db'
import { authorizeMagicLink } from './magic-link-provider'

// The default Session["user"] shape has no `id` — augment it so
// sessionCallback below (and any server-side `auth()` caller) can rely on
// `session.user.id` being typed.
declare module 'next-auth' {
  interface Session {
    user: {
      id: string
    } & DefaultSession['user']
  }
}

const THIRTY_DAYS_SECS = 30 * 24 * 60 * 60

// Auth.js's own JWT `iat` claim is NOT a stable "time of original sign-in":
// @auth/core's jwt.encode() unconditionally calls jose's `.setIssuedAt()`
// (no argument) on every re-encode, which happens on every session read for
// the jwt strategy — so the real `iat` gets reset to "now" on every request,
// not just at sign-in. Anchoring the 30-day absolute cap on that claim would
// never trip in practice. `authTime` is a custom claim we set once at
// trigger === 'signIn' and copy forward unchanged on every later call — Auth.js
// only manages iat/exp/jti at encode time, so custom claims pass through as-is.
export function jwtCallback(params: {
  token: JWT
  user?: { id?: string } | null
  trigger?: 'signIn' | 'signUp' | 'update'
}): JWT | null {
  const { token, user, trigger } = params
  const nowSecs = Math.floor(Date.now() / 1000)

  if (trigger === 'signIn' && user?.id) {
    token.userId = user.id
    // Placeholder for Phase 1: bump a per-user counter in the `users` table
    // to force-invalidate all of that user's live sessions (role change /
    // offboarding). Not enforced against anything yet in Phase 0.
    token.sessionVersion = 1
    token.authTime = nowSecs
  }

  const authTime = typeof token.authTime === 'number' ? token.authTime : nowSecs
  if (nowSecs - authTime > THIRTY_DAYS_SECS) {
    return null // past the absolute cap: drop the session, forcing re-authentication
  }

  token.authTime = authTime
  return token
}

export function sessionCallback(params: { session: Session; token: JWT }): Session {
  const { session, token } = params
  if (typeof token.userId === 'string') {
    session.user.id = token.userId
  }
  return session
}

export const authConfig: NextAuthConfig = {
  session: { strategy: 'jwt', maxAge: 24 * 60 * 60, updateAge: 60 * 60 },
  cookies: {
    sessionToken: {
      name: '__Host-herbe-service.session-token',
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: true },
    },
  },
  trustHost: true,
  pages: { signIn: '/login' },
  providers: [
    Credentials({
      id: 'magic_link',
      credentials: { token: { type: 'text' } },
      authorize: async (credentials) => {
        const user = await authorizeMagicLink(db, { token: credentials.token as string })
        return user ? { id: user.id, email: user.email } : null
      },
    }),
  ],
  callbacks: {
    jwt: (params) => jwtCallback(params),
    session: (params) => sessionCallback(params),
  },
}
