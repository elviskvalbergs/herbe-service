// app/api/push/subscribe/route.test.ts
//
// `@/app/api/push/subscribe/route` transitively imports `@/lib/db`, which
// reads DATABASE_URL at module-load time, so DATABASE_URL must point at the
// harness DB *before* the route is first dynamically imported (same
// convention as app/api/auth/devices/route.test.ts).
import { and, eq } from 'drizzle-orm'
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
  return new Request('http://localhost/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/push/subscribe', () => {
  beforeEach(() => {
    authMock.mockReset()
  })

  it('rejects an unauthenticated request with 401', async () => {
    authMock.mockResolvedValue(null)

    const { POST } = await import('./route')
    const res = await POST(makeRequest({ endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } }))

    expect(res.status).toBe(401)
  })

  it('returns 400 when endpoint or keys are missing', async () => {
    const user = await makeUser('push-sub-400')
    authMock.mockResolvedValue(sessionFor(user))

    const { POST } = await import('./route')
    const res = await POST(makeRequest({ endpoint: 'https://push.example/x' }))

    expect(res.status).toBe(400)
  })

  it('creates a new subscription row for the current user', async () => {
    const user = await makeUser('push-sub-create')
    authMock.mockResolvedValue(sessionFor(user))

    const { POST } = await import('./route')
    const res = await POST(
      makeRequest({ endpoint: 'https://push.example/sub-create', keys: { p256dh: 'p1', auth: 'a1' } }),
    )

    expect(res.status).toBe(200)

    const [row] = await db
      .select()
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.endpoint, 'https://push.example/sub-create'))
    expect(row.userId).toBe(user.id)
    expect(row.p256dh).toBe('p1')
    expect(row.auth).toBe('a1')
  })

  it('upserts by endpoint instead of creating a duplicate row', async () => {
    const user = await makeUser('push-sub-upsert')
    authMock.mockResolvedValue(sessionFor(user))

    const { POST } = await import('./route')
    await POST(makeRequest({ endpoint: 'https://push.example/sub-upsert', keys: { p256dh: 'old', auth: 'old' } }))
    const res = await POST(makeRequest({ endpoint: 'https://push.example/sub-upsert', keys: { p256dh: 'new', auth: 'new' } }))

    expect(res.status).toBe(200)

    const rows = await db
      .select()
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.endpoint, 'https://push.example/sub-upsert'))
    expect(rows).toHaveLength(1)
    expect(rows[0].p256dh).toBe('new')
    expect(rows[0].auth).toBe('new')
  })

  it('re-subscribing the same endpoint under a different user reassigns ownership', async () => {
    const userA = await makeUser('push-sub-reassign-a')
    const userB = await makeUser('push-sub-reassign-b')

    authMock.mockResolvedValue(sessionFor(userA))
    const { POST } = await import('./route')
    await POST(makeRequest({ endpoint: 'https://push.example/sub-reassign', keys: { p256dh: 'p', auth: 'a' } }))

    authMock.mockResolvedValue(sessionFor(userB))
    const res = await POST(makeRequest({ endpoint: 'https://push.example/sub-reassign', keys: { p256dh: 'p', auth: 'a' } }))
    expect(res.status).toBe(200)

    const [row] = await db
      .select()
      .from(schema.pushSubscriptions)
      .where(
        and(eq(schema.pushSubscriptions.endpoint, 'https://push.example/sub-reassign'), eq(schema.pushSubscriptions.userId, userB.id)),
      )
    expect(row).toBeDefined()
  })
})
