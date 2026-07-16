// app/api/auth/totp/enroll/start/route.ts
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { enrollTotp, verifyTotp } from '@/lib/auth/totp'

export async function POST(request: Request) {
  const session = await getVerifiedSession(db)
  if (!session?.user?.id) return new Response('Unauthorized', { status: 401 })
  if (session.user.role !== 'admin') return new Response('Forbidden', { status: 403 })

  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, session.user.id))
  if (!user) return new Response('Unauthorized', { status: 401 })

  if (user.mfaEnabled) {
    const { currentCode } = (await request.json().catch(() => ({}))) as { currentCode?: string }
    if (!currentCode || !(await verifyTotp(db, user.id, currentCode, { bumpSession: false }))) {
      return new Response('Forbidden', { status: 403 })
    }
  }

  const result = await enrollTotp(db, user.id, user.email)
  return Response.json(result)
}
