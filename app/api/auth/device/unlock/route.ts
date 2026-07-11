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
import { eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'

const MAX_ATTEMPTS = 5

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
    // Atomic increment: one UPDATE bumps failed_attempts AND sets locked_until
    // in the same statement, so concurrent wrong-PIN attempts on the same
    // device can't each read a stale counter and keep it below the threshold
    // forever. failed_attempts/locked_until is the ONLY brute-force defense on
    // a short numeric PIN, so a read-then-write race here defeats lockout
    // entirely (Task 15 review 2026-07-09). Response derives from the RETURNED
    // post-increment row, not the pre-read value.
    const [updated] = await db
      .update(schema.pairedDevices)
      .set({
        failedAttempts: sql`${schema.pairedDevices.failedAttempts} + 1`,
        lockedUntil: sql`CASE WHEN ${schema.pairedDevices.failedAttempts} + 1 >= ${MAX_ATTEMPTS}
                              THEN now() + interval '24 hours'
                              ELSE ${schema.pairedDevices.lockedUntil} END`,
      })
      .where(eq(schema.pairedDevices.id, deviceId))
      .returning()

    const locked = updated.failedAttempts >= MAX_ATTEMPTS
    return new Response(locked ? 'Device locked' : 'Wrong PIN', { status: locked ? 423 : 401 })
  }

  // Successful unlock: reset the counter, stamp last_unlock_at, and clear any
  // stale (already-expired) locked_until so the row carries no leftover state.
  await db
    .update(schema.pairedDevices)
    .set({ failedAttempts: 0, lastUnlockAt: new Date(), lockedUntil: null })
    .where(eq(schema.pairedDevices.id, deviceId))

  return Response.json({ status: 'ok' })
}
