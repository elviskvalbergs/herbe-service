// app/api/auth/devices/route.ts
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { getVerifiedSession } from '@/lib/auth/session-guard'

export async function GET() {
  const session = await getVerifiedSession(db)
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 })
  }

  const devices = await db
    .select({
      id: schema.pairedDevices.id,
      deviceLabel: schema.pairedDevices.deviceLabel,
      createdAt: schema.pairedDevices.createdAt,
      lastUnlockAt: schema.pairedDevices.lastUnlockAt,
      revokedAt: schema.pairedDevices.revokedAt,
      lockedUntil: schema.pairedDevices.lockedUntil,
    })
    .from(schema.pairedDevices)
    .where(eq(schema.pairedDevices.userId, session.user.id))

  return Response.json({ devices })
}
