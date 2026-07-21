// app/api/auth/devices/[id]/revoke/route.ts
import { and, eq } from 'drizzle-orm'
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

  // FIX-8: stamping revokedAt alone is a no-op against a live JWT — nothing
  // reads paired_devices.revokedAt on the session path, and sessions aren't
  // device-bound (no deviceId claim). Bump the owner's session_version so
  // getVerifiedSession rejects their token immediately. Scope caveat: because
  // sessions are user- not device-scoped today, this signs the owner out on
  // ALL their devices — the safe conservative behavior for a lost/stolen
  // device. A true per-device wipe (and wipe-on-N-failed-PIN, currently only a
  // 24h lockout in device/unlock) needs device-bound sessions first — not built.
  await bumpSessionVersion(db, device.userId)

  return Response.json({ status: 'ok' })
}
