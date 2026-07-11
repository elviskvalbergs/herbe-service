// lib/auth/device-enrollment.ts
//
// Mechanical follow-on of Task 14's magic-link issuance, same single-use-
// token shape: `issueDeviceEnrollment` mints a raw token and stores only its
// SHA-256 hash (device_enrollments.token_hash); `consumeDeviceEnrollment`
// atomically consumes it (one UPDATE ... RETURNING, per the atomic-consume
// fix applied to magic-link-provider.ts after Task 14's review — a SELECT-
// then-UPDATE split would let two concurrent requests both pass the SELECT
// before either UPDATE commits, pairing two devices off one enrolment link)
// and creates the first paired_devices row for that user, hashing the PIN
// with argon2 (never stored plaintext).
//
// Out of scope here (Task 15 brief: "don't over-build enrollment"): minting
// a full Auth.js session. `signIn()` needs live Next.js request context
// (next/headers), the same gap Task 14's carry-overs documented for
// app/api/test/login — deferred to whichever task exercises this route
// inside a real Next.js server.
import crypto from 'node:crypto'
import argon2 from 'argon2'
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'

const ENROLLMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days — admin-issued, may sit unopened longer than a login magic link

type Db = PostgresJsDatabase<typeof schema>

export async function issueDeviceEnrollment(
  db: Db,
  opts: { tenantId: string; userId: string },
): Promise<{ token: string }> {
  const token = crypto.randomBytes(32).toString('hex')
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

  await db.insert(schema.deviceEnrollments).values({
    tokenHash,
    tenantId: opts.tenantId,
    userId: opts.userId,
    expiresAt: new Date(Date.now() + ENROLLMENT_TTL_MS),
  })

  return { token }
}

export async function consumeDeviceEnrollment(
  db: Db,
  opts: { token: string; deviceLabel: string; pin: string },
): Promise<{ deviceId: string } | null> {
  const tokenHash = crypto.createHash('sha256').update(opts.token).digest('hex')

  const [record] = await db
    .update(schema.deviceEnrollments)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(schema.deviceEnrollments.tokenHash, tokenHash),
        isNull(schema.deviceEnrollments.consumedAt),
        gt(schema.deviceEnrollments.expiresAt, new Date()),
      ),
    )
    .returning()

  if (!record) return null

  const pinHash = await argon2.hash(opts.pin)
  const [device] = await db
    .insert(schema.pairedDevices)
    .values({
      tenantId: record.tenantId,
      userId: record.userId,
      deviceLabel: opts.deviceLabel,
      pinHash,
    })
    .returning()

  return { deviceId: device.id }
}
