// app/api/settings/route.ts
import { db } from '@/lib/db'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { getUserPrefs, setUserPrefs } from '@/lib/settings/user-prefs'

export async function GET() {
  const session = await getVerifiedSession(db)
  if (!session?.user?.id) return new Response('Unauthorized', { status: 401 })

  const prefs = await getUserPrefs(db, session.user.id)
  return Response.json(prefs)
}

export async function PATCH(request: Request) {
  const session = await getVerifiedSession(db)
  if (!session?.user?.id) return new Response('Unauthorized', { status: 401 })

  let body: { locale?: unknown; displayScheme?: unknown }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 })
  }
  if (body === null || typeof body !== 'object') {
    return Response.json({ error: 'invalid_body' }, { status: 400 })
  }
  const { locale, displayScheme } = body

  if (locale !== undefined && typeof locale !== 'string') {
    return Response.json({ error: 'invalid_body' }, { status: 400 })
  }
  if (displayScheme !== undefined && typeof displayScheme !== 'string') {
    return Response.json({ error: 'invalid_body' }, { status: 400 })
  }

  try {
    const prefs = await setUserPrefs(db, session.user.id, { locale, displayScheme })
    return Response.json(prefs)
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 })
  }
}
