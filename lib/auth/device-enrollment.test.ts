// lib/auth/device-enrollment.test.ts
//
// Thin, mechanical follow-on test suite (Task 15 scope note: "don't over-
// build enrollment") — mirrors magic-link-provider.test.ts's harness
// convention and single-use assertions, kept to the branches that matter:
// happy path, single-use, and an unresolvable token.
import argon2 from 'argon2'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { consumeDeviceEnrollment, issueDeviceEnrollment } from './device-enrollment'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string
let userId: string

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })
  const [tenant] = await db.insert(schema.tenants).values({ slug: 'enroll-t1', name: 'Enroll T1' }).returning()
  tenantId = tenant.id
  const [user] = await db
    .insert(schema.users)
    .values({ tenantId, email: 'tech.bo@herbe-service.test', role: 'technician' })
    .returning()
  userId = user.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('device enrollment', () => {
  it('consumes a valid enrollment token and creates a paired device with an argon2-hashed PIN', async () => {
    const { token } = await issueDeviceEnrollment(db, { tenantId, userId })

    const result = await consumeDeviceEnrollment(db, { token, deviceLabel: "Bo's phone", pin: '4321' })
    expect(result?.deviceId).toEqual(expect.any(String))

    const [device] = await db.select().from(schema.pairedDevices).where(eq(schema.pairedDevices.id, result!.deviceId))
    expect(device.tenantId).toBe(tenantId)
    expect(device.userId).toBe(userId)
    expect(device.deviceLabel).toBe("Bo's phone")
    // Never plaintext — argon2 hash, verifiable, and not equal to the raw PIN.
    expect(device.pinHash).not.toBe('4321')
    expect(device.pinHash.startsWith('$argon2')).toBe(true)
    await expect(argon2.verify(device.pinHash, '4321')).resolves.toBe(true)
  })

  it('rejects reuse of an already-consumed enrollment token (single-use)', async () => {
    const { token } = await issueDeviceEnrollment(db, { tenantId, userId })

    const first = await consumeDeviceEnrollment(db, { token, deviceLabel: 'Device A', pin: '1111' })
    expect(first).not.toBeNull()

    const second = await consumeDeviceEnrollment(db, { token, deviceLabel: 'Device B', pin: '2222' })
    expect(second).toBeNull()
  })

  it('rejects a token that was never issued', async () => {
    const result = await consumeDeviceEnrollment(db, { token: 'never-issued', deviceLabel: 'Ghost', pin: '0000' })
    expect(result).toBeNull()
  })
})
