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
import { db } from '@/lib/db'
import { issueMagicLinkToken } from '@/lib/auth/magic-link-provider'

function isProductionEnvironment(): boolean {
  if (process.env.VERCEL_ENV) return process.env.VERCEL_ENV === 'production'
  return process.env.NODE_ENV === 'production'
}

export async function POST(request: Request) {
  const { tenantId, email } = (await request.json()) as { tenantId: string; email: string }

  const { token } = await issueMagicLinkToken(db, { tenantId, email })
  if (!isProductionEnvironment()) {
    console.log(`[magic-link] ${email}: /login/consume?token=${token}`)
  }

  return Response.json({ status: 'ok' })
}
