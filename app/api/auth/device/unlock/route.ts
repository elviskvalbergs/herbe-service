// app/api/auth/device/unlock/route.ts
//
// Local PIN re-verification for a device paired via /api/auth/device/enroll
// (docs/05-users-auth.md "Sessions & devices"): this is NOT a full re-auth —
// it's the daily field-device gate that (per the doc) extends the existing
// device-bound Auth.js session's rolling window rather than forcing a fresh
// sign-in. Phase 0 keeps this route to the local re-verification itself:
// { status: 'ok' } on success is the deliverable the walking-skeleton demo
// exercises; wiring the actual session-refresh touch needs live Next.js
// request context (next/headers), the same gap Task 14's carry-overs
// documented for signIn()/auth() outside a real server request.
import argon2 from 'argon2'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'

const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 24 * 60 * 60 * 1000 // 24h tenant-policy default (Task 15 brief)

export async function POST(request: Request) {
  const { deviceId, pin } = (await request.json()) as { deviceId: string; pin: string }

  const [device] = await db.select().from(schema.pairedDevices).where(eq(schema.pairedDevices.id, deviceId))
  if (!device || device.revokedAt) {
    return new Response('Not found', { status: 404 })
  }

  // Lockout takes precedence over even a correct PIN — a locked device stays
  // locked until lockedUntil passes, regardless of what's typed.
  if (device.lockedUntil && device.lockedUntil > new Date()) {
    return new Response('Device locked', { status: 423 })
  }

  const valid = await argon2.verify(device.pinHash, pin)

  if (!valid) {
    const failedAttempts = device.failedAttempts + 1
    const locked = failedAttempts >= MAX_ATTEMPTS
    await db
      .update(schema.pairedDevices)
      .set({
        failedAttempts,
        lockedUntil: locked ? new Date(Date.now() + LOCKOUT_MS) : null,
      })
      .where(eq(schema.pairedDevices.id, deviceId))

    return new Response(locked ? 'Device locked' : 'Wrong PIN', { status: locked ? 423 : 401 })
  }

  await db
    .update(schema.pairedDevices)
    .set({ failedAttempts: 0, lastUnlockAt: new Date() })
    .where(eq(schema.pairedDevices.id, deviceId))

  return Response.json({ status: 'ok' })
}
