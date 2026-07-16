// app/api/auth/devices/route.test.ts
//
// `@/app/api/auth/devices/route` transitively imports `@/lib/db`, which reads
// DATABASE_URL at module-load time, so DATABASE_URL must point at the harness
// DB *before* the route is first dynamically imported (same convention as
// app/api/sync/customers/route.test.ts). The route calls `getVerifiedSession`
// (lib/auth/session-guard), which itself calls `auth()` from `@/lib/auth` —
// that's the seam under mock here, not session-guard itself.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'

const authMock = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }))

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  process.env.DATABASE_URL = testDb.url

  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

async function makeUser(tenantSlug: string, email: string) {
  const [tenant] = await db.insert(schema.tenants).values({ slug: tenantSlug, name: tenantSlug }).returning()
  const [user] = await db.insert(schema.users).values({ tenantId: tenant.id, email, role: 'technician' }).returning()
  return user
}

function sessionFor(user: { id: string; tenantId: string; role: string; sessionVersion: number }) {
  return {
    user: { id: user.id, tenantId: user.tenantId, role: user.role, sessionVersion: user.sessionVersion },
    expires: '2099-01-01T00:00:00.000Z',
  }
}

describe('GET /api/auth/devices', () => {
  beforeEach(() => {
    authMock.mockReset()
  })

  it('rejects an unauthenticated request with 401', async () => {
    authMock.mockResolvedValue(null)

    const { GET } = await import('./route')
    const res = await GET()

    expect(res.status).toBe(401)
  })

  it("returns only the caller's own devices, isolated from another user's", async () => {
    const userA = await makeUser('devices-list-a', 'a@herbe-service.test')
    const userB = await makeUser('devices-list-b', 'b@herbe-service.test')

    await db.insert(schema.pairedDevices).values([
      { tenantId: userA.tenantId, userId: userA.id, deviceLabel: 'A Phone', pinHash: 'x' },
      { tenantId: userA.tenantId, userId: userA.id, deviceLabel: 'A Tablet', pinHash: 'x' },
      { tenantId: userB.tenantId, userId: userB.id, deviceLabel: 'B Phone', pinHash: 'x' },
      { tenantId: userB.tenantId, userId: userB.id, deviceLabel: 'B Tablet', pinHash: 'x' },
    ])

    authMock.mockResolvedValue(sessionFor(userA))

    const { GET } = await import('./route')
    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.devices).toHaveLength(2)
    expect(body.devices.map((d: { deviceLabel: string }) => d.deviceLabel).sort()).toEqual(['A Phone', 'A Tablet'])
  })
})
