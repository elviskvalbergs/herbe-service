// app/api/auth/magic-link/request/route.ts
//
// Anti-enumeration: this route ALWAYS returns 200, whether or not the email
// is known — the caller can never learn from the response alone whether an
// address exists. Phase 0 has no email transport wired up (the portal's
// TemplateKey engine is a Phase 1 copy, out of scope here); the walking
// skeleton logs the link to the console for manual testing instead.
import { db } from '@/lib/db'
import { issueMagicLinkToken } from '@/lib/auth/magic-link-provider'

export async function POST(request: Request) {
  const { tenantId, email } = (await request.json()) as { tenantId: string; email: string }

  const { token } = await issueMagicLinkToken(db, { tenantId, email })
  console.log(`[magic-link] ${email}: /login/consume?token=${token}`)

  return Response.json({ status: 'ok' })
}
