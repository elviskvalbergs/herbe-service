// app/api/auth/devices/[id]/revoke/route.ts
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { hasCapability, type Role } from '@/lib/auth/roles'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getVerifiedSession(db)
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { id } = await params
  const [device] = await db.select().from(schema.pairedDevices).where(eq(schema.pairedDevices.id, id))
  if (!device) {
    return new Response('Not found', { status: 404 })
  }

  const isSelf = device.userId === session.user.id
  const isAdmin = hasCapability(session.user.role as Role, 'users:manage') && device.tenantId === session.user.tenantId
  if (!isSelf && !isAdmin) {
    return new Response('Forbidden', { status: 403 })
  }

  await db
    .update(schema.pairedDevices)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.pairedDevices.id, id)))

  return Response.json({ status: 'ok' })
}
