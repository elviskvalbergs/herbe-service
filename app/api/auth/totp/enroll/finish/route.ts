// app/api/auth/totp/enroll/finish/route.ts
import { db } from '@/lib/db'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { confirmTotpEnrollment } from '@/lib/auth/totp'

export async function POST(request: Request) {
  const session = await getVerifiedSession(db)
  if (!session?.user?.id) return new Response('Unauthorized', { status: 401 })
  if (session.user.role !== 'admin') return new Response('Forbidden', { status: 403 })

  const { code } = (await request.json()) as { code?: string }
  if (typeof code !== 'string') return new Response('Bad Request', { status: 400 })

  const ok = await confirmTotpEnrollment(db, session.user.id, code)
  if (!ok) return Response.json({ error: 'invalid_code' }, { status: 400 })

  return Response.json({ status: 'ok' })
}
