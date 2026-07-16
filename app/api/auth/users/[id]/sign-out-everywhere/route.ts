// app/api/auth/users/[id]/sign-out-everywhere/route.ts
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { getVerifiedSession, bumpSessionVersion } from '@/lib/auth/session-guard'
import { hasCapability, type Role } from '@/lib/auth/roles'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getVerifiedSession(db)
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { id } = await params
  const isSelf = id === session.user.id
  if (!isSelf) {
    if (!hasCapability(session.user.role as Role, 'users:manage')) {
      return new Response('Forbidden', { status: 403 })
    }
    const [target] = await db.select().from(schema.users).where(eq(schema.users.id, id))
    if (!target || target.tenantId !== session.user.tenantId) {
      return new Response('Not found', { status: 404 })
    }
  }

  await bumpSessionVersion(db, id)
  return Response.json({ status: 'ok' })
}
