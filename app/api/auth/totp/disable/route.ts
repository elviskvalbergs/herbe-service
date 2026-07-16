// app/api/auth/totp/disable/route.ts
import { db } from '@/lib/db'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { disableTotp } from '@/lib/auth/totp'

export async function POST(request: Request) {
  const session = await getVerifiedSession(db)
  if (!session?.user?.id) return new Response('Unauthorized', { status: 401 })

  const { code } = (await request.json()) as { code?: string }
  if (typeof code !== 'string') return new Response('Bad Request', { status: 400 })

  const ok = await disableTotp(db, session.user.id, code)
  if (!ok) return Response.json({ error: 'invalid_code' }, { status: 400 })

  return Response.json({ status: 'ok' })
}
