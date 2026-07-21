// app/api/auth/magic-link/request/route.ts
//
// Anti-enumeration: this route ALWAYS returns 200, whether or not the email
// is known — the caller can never learn from the response alone whether an
// address exists. Phase 0 has no email transport wired up (the portal's
// TemplateKey engine is a Phase 1 copy, out of scope here); the walking
// skeleton logs the link to the console for manual testing instead — but
// the token is a live bearer credential, so it must never reach production
// logs. Same VERCEL_ENV/NODE_ENV precedence as lib/auth/test-provider.ts's
// isTestAuthEnabled (duplicated rather than shared: this gate has nothing
// to do with TEST_AUTH).
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { issueMagicLinkToken } from '@/lib/auth/magic-link-provider'
import { checkAuthRateLimit, clientIpFrom } from '@/lib/auth/rate-limit'

function isProductionEnvironment(): boolean {
  if (process.env.VERCEL_ENV) return process.env.VERCEL_ENV === 'production'
  return process.env.NODE_ENV === 'production'
}

export async function POST(request: Request) {
  const { tenantId, email } = (await request.json()) as { tenantId: string; email: string }

  // FIX-7: throttle by IP+tenant+email before any DB write — an unauthenticated
  // caller could otherwise flood the token table unbounded.
  const rate = await checkAuthRateLimit(db, `${clientIpFrom(request)}|${tenantId}|${email}`, 'magic-link')
  if (!rate.allowed) {
    return Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(rate.retryAfterSec) } })
  }

  // FIX-2: only issue a token for a user that already exists — a magic link
  // authenticates, it doesn't provision. Anti-enumeration is preserved: the
  // response is an identical 200 whether or not the user exists.
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.email, email)))

  if (user) {
    const { token } = await issueMagicLinkToken(db, { tenantId, email })
    if (!isProductionEnvironment()) {
      console.log(`[magic-link] ${email}: /login/consume?token=${token}`)
    }
  }

  return Response.json({ status: 'ok' })
}
