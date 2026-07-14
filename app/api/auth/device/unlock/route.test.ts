// app/api/auth/device/unlock/route.test.ts
//
// Same DATABASE_URL-at-import-time convention as
// app/api/auth/magic-link/request/route.test.ts: `@/lib/db` reads
// process.env.DATABASE_URL at module load, so it must point at the harness
// DB before `./route` is first dynamically imported.
//
// Each test pairs its own fresh device (makeDevice) instead of sharing one
// across the suite, so a failure in one branch can never leak lockout state
// into another test and mask a real regression (Task 11 review convention).
import argon2 from 'argon2'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string
let userId: string

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  process.env.DATABASE_URL = testDb.url

  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 'device-unlock-t1', name: 'Device Unlock T1' }).returning()
  tenantId = tenant.id
  const [user] = await db
    .insert(schema.users)
    .values({ tenantId, email: 'tech.anna@herbe-service.test', role: 'technician' })
    .returning()
  userId = user.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

async function makeDevice(overrides: Partial<typeof schema.pairedDevices.$inferInsert> = {}) {
  const [device] = await db
    .insert(schema.pairedDevices)
    .values({
      tenantId,
      userId,
      deviceLabel: "Anna's phone",
      pinHash: await argon2.hash('1234'),
      ...overrides,
    })
    .returning()
  return device
}

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/auth/device/unlock', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('POST /api/auth/device/unlock', () => {
  it('returns 404 when the device does not exist', async () => {
    const { POST } = await import('./route')
    const res = await POST(makeRequest({ deviceId: '00000000-0000-0000-0000-000000000000', pin: '1234' }))
    expect(res.status).toBe(404)
  })

  it('returns 404 when the device has been revoked', async () => {
    const device = await makeDevice({ revokedAt: new Date() })

    const { POST } = await import('./route')
    const res = await POST(makeRequest({ deviceId: device.id, pin: '1234' }))
    expect(res.status).toBe(404)
  })

  it('accepts the correct PIN, returns 200, and resets failedAttempts', async () => {
    const device = await makeDevice({ failedAttempts: 3 })

    const { POST } = await import('./route')
    const res = await POST(makeRequest({ deviceId: device.id, pin: '1234' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ status: 'ok' })

    const [updated] = await db.select().from(schema.pairedDevices).where(eq(schema.pairedDevices.id, device.id))
    expect(updated.failedAttempts).toBe(0)
    expect(updated.lastUnlockAt).not.toBeNull()
  })

  it('rejects the wrong PIN with 401 and increments failedAttempts', async () => {
    const device = await makeDevice()

    const { POST } = await import('./route')
    const res = await POST(makeRequest({ deviceId: device.id, pin: 'wrong' }))
    expect(res.status).toBe(401)

    const [updated] = await db.select().from(schema.pairedDevices).where(eq(schema.pairedDevices.id, device.id))
    expect(updated.failedAttempts).toBe(1)
    expect(updated.lockedUntil).toBeNull()
  })

  it('locks the device after 5 consecutive wrong PINs', async () => {
    const device = await makeDevice()

    const { POST } = await import('./route')
    let res: Response | undefined
    for (let i = 0; i < 5; i++) {
      res = await POST(makeRequest({ deviceId: device.id, pin: 'wrong' }))
    }

    expect(res!.status).toBe(423)

    const [updated] = await db.select().from(schema.pairedDevices).where(eq(schema.pairedDevices.id, device.id))
    expect(updated.failedAttempts).toBe(5)
    expect(updated.lockedUntil).not.toBeNull()
    expect(updated.lockedUntil!.getTime()).toBeGreaterThan(Date.now())
  })

  it('locks the device under 20 concurrent wrong PINs (atomic increment survives the race)', async () => {
    // Fires 20 concurrent requests rather than a handful sequentially: a
    // read-then-write increment lets every concurrent request read the same
    // stale failedAttempts before any write commits, so the counter can be
    // kept under MAX_ATTEMPTS indefinitely and lockout never triggers — the
    // exact race this test exists to catch (Task 15 review 2026-07-09,
    // mirrors the 20-caller magic-link concurrency test in
    // lib/auth/magic-link-provider.test.ts, where 2 didn't reliably overlap
    // but 20 does).
    const device = await makeDevice()

    const { POST } = await import('./route')
    await Promise.all(Array.from({ length: 20 }, () => POST(makeRequest({ deviceId: device.id, pin: 'wrong' }))))

    const [updated] = await db.select().from(schema.pairedDevices).where(eq(schema.pairedDevices.id, device.id))
    expect(updated.failedAttempts).toBeGreaterThanOrEqual(5)
    expect(updated.lockedUntil).not.toBeNull()
    expect(updated.lockedUntil!.getTime()).toBeGreaterThan(Date.now())
  })

  it('returns 423 for the CORRECT PIN while locked — lockout takes precedence', async () => {
    const device = await makeDevice()

    const { POST } = await import('./route')
    for (let i = 0; i < 5; i++) {
      await POST(makeRequest({ deviceId: device.id, pin: 'wrong' }))
    }

    const res = await POST(makeRequest({ deviceId: device.id, pin: '1234' }))
    expect(res.status).toBe(423)

    const [updated] = await db.select().from(schema.pairedDevices).where(eq(schema.pairedDevices.id, device.id))
    // Still locked — the correct PIN must not reset attempts or unlock it.
    expect(updated.failedAttempts).toBe(5)
    expect(updated.lastUnlockAt).toBeNull()
  })
})
