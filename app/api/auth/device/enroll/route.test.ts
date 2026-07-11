// app/api/auth/device/enroll/route.test.ts
//
// `@/app/api/auth/device/enroll/route` transitively imports `@/lib/db`,
// which reads DATABASE_URL at module-load time, so DATABASE_URL must point
// at the harness DB *before* the route is first dynamically imported (same
// convention as app/api/auth/magic-link/request/route.test.ts).
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { issueDeviceEnrollment } from '@/lib/auth/device-enrollment'

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
  const [tenant] = await db.insert(schema.tenants).values({ slug: 'enroll-route-t1', name: 'Enroll Route T1' }).returning()
  tenantId = tenant.id
  const [user] = await db
    .insert(schema.users)
    .values({ tenantId, email: 'tech.cai@herbe-service.test', role: 'technician' })
    .returning()
  userId = user.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/auth/device/enroll', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('POST /api/auth/device/enroll', () => {
  it('pairs a device and returns 200 + deviceId for a valid enrollment token', async () => {
    const { token } = await issueDeviceEnrollment(db, { tenantId, userId })

    const { POST } = await import('./route')
    const res = await POST(makeRequest({ enrollmentToken: token, deviceLabel: "Cai's tablet", pin: '5678' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.deviceId).toEqual(expect.any(String))
  })

  it('returns 400 for an invalid or expired enrollment token', async () => {
    const { POST } = await import('./route')
    const res = await POST(makeRequest({ enrollmentToken: 'bogus-token', deviceLabel: 'Ghost', pin: '0000' }))

    expect(res.status).toBe(400)
  })
})
