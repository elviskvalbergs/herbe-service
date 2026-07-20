// app/api/push/unsubscribe/route.test.ts
//
// `@/app/api/push/unsubscribe/route` transitively imports `@/lib/db`, which
// reads DATABASE_URL at module-load time, so DATABASE_URL must point at the
// harness DB *before* the route is first dynamically imported (same
// convention as app/api/auth/devices/route.test.ts).
import { eq } from 'drizzle-orm'
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

async function makeUser(tenantSlug: string) {
  const [tenant] = await db.insert(schema.tenants).values({ slug: tenantSlug, name: tenantSlug }).returning()
  const [user] = await db
    .insert(schema.users)
    .values({ tenantId: tenant.id, email: `${tenantSlug}@herbe-service.test`, role: 'technician' })
    .returning()
  return user
}

function sessionFor(user: { id: string; tenantId: string; role: string; sessionVersion: number }) {
  return {
    user: { id: user.id, tenantId: user.tenantId, role: user.role, sessionVersion: user.sessionVersion },
    expires: '2099-01-01T00:00:00.000Z',
  }
}

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/push/unsubscribe', () => {
  beforeEach(() => {
    authMock.mockReset()
  })

  it('rejects an unauthenticated request with 401', async () => {
    authMock.mockResolvedValue(null)

    const { POST } = await import('./route')
    const res = await POST(makeRequest({ endpoint: 'https://push.example/x' }))

    expect(res.status).toBe(401)
  })

  it('returns 400 when endpoint is missing', async () => {
    const user = await makeUser('push-unsub-400')
    authMock.mockResolvedValue(sessionFor(user))

    const { POST } = await import('./route')
    const res = await POST(makeRequest({}))

    expect(res.status).toBe(400)
  })

  it("deletes the caller's own subscription by endpoint", async () => {
    const user = await makeUser('push-unsub-own')
    await db.insert(schema.pushSubscriptions).values({
      userId: user.id,
      endpoint: 'https://push.example/unsub-own',
      p256dh: 'p',
      auth: 'a',
    })
    authMock.mockResolvedValue(sessionFor(user))

    const { POST } = await import('./route')
    const res = await POST(makeRequest({ endpoint: 'https://push.example/unsub-own' }))

    expect(res.status).toBe(200)
    const rows = await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, 'https://push.example/unsub-own'))
    expect(rows).toHaveLength(0)
  })

  it("does not delete another user's subscription for the same endpoint value", async () => {
    const userA = await makeUser('push-unsub-cross-a')
    const userB = await makeUser('push-unsub-cross-b')
    await db.insert(schema.pushSubscriptions).values({
      userId: userB.id,
      endpoint: 'https://push.example/unsub-cross',
      p256dh: 'p',
      auth: 'a',
    })
    authMock.mockResolvedValue(sessionFor(userA))

    const { POST } = await import('./route')
    const res = await POST(makeRequest({ endpoint: 'https://push.example/unsub-cross' }))

    expect(res.status).toBe(200)
    const rows = await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, 'https://push.example/unsub-cross'))
    expect(rows).toHaveLength(1)
    expect(rows[0].userId).toBe(userB.id)
  })
})
