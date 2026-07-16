// app/api/auth/password/set/route.ts
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { hashPassword } from '@/lib/auth/password'

const MIN_PASSWORD_LENGTH = 12

export async function POST(request: Request) {
  const session = await getVerifiedSession(db)
  if (!session?.user?.id) return new Response('Unauthorized', { status: 401 })
  if (session.user.role !== 'admin') return new Response('Forbidden', { status: 403 })

  const { password } = (await request.json()) as { password?: string }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return Response.json({ error: 'password_too_short' }, { status: 400 })
  }

  const passwordHash = await hashPassword(password)
  await db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, session.user.id))

  return Response.json({ status: 'ok' })
}
