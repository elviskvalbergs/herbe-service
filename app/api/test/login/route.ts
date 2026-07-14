import { signIn } from '@/lib/auth'
import { isTestAuthEnabled } from '@/lib/auth/test-provider'
import { issueMagicLinkToken } from '@/lib/auth/magic-link-provider'
import { db } from '@/lib/db'
import { PERSONAS } from '@/lib/seed/personas'

export async function POST(request: Request) {
  if (!isTestAuthEnabled()) {
    return new Response('Not found', { status: 404 })
  }

  const { personaKey, tenantId } = (await request.json()) as { personaKey: string; tenantId: string }

  // Guard against prototype pollution: a bare `PERSONAS[personaKey]` lookup
  // resolves keys like '__proto__' or 'constructor' to a truthy prototype
  // object even though they were never defined on PERSONAS, which would let
  // an unknown key mint a real session below. Only an own enumerable key
  // qualifies as a known persona.
  if (!Object.prototype.hasOwnProperty.call(PERSONAS, personaKey)) {
    return Response.json({ error: 'unknown persona' }, { status: 400 })
  }
  const persona = PERSONAS[personaKey as keyof typeof PERSONAS]

  const { token } = await issueMagicLinkToken(db, { tenantId, email: persona.email })
  await signIn('magic_link', { token, redirect: false })

  return Response.json({ status: 'ok' })
}
