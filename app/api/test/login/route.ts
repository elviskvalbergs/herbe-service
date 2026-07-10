import { isTestAuthEnabled } from '@/lib/auth/test-provider'
import { PERSONAS } from '@/lib/seed/personas'

export async function POST(request: Request) {
  if (!isTestAuthEnabled()) {
    return new Response('Not found', { status: 404 })
  }

  const { personaKey } = (await request.json()) as { personaKey: keyof typeof PERSONAS }
  const persona = PERSONAS[personaKey]
  if (!persona) {
    return Response.json({ error: 'unknown persona' }, { status: 400 })
  }

  // TODO(Task 14): replace with a real Auth.js session mint once the auth config exists.
  throw new Error('Not implemented until Task 14 (Auth.js magic-link config) lands')
}
