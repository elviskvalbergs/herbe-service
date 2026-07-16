// app/api/auth/password/set/route.test.ts
//
// Same DATABASE_URL-at-import-time convention as
// app/api/auth/devices/route.test.ts: `@/lib/db` reads DATABASE_URL at
// module load, so it must point at the harness DB before `./route` is first
// dynamically imported. `auth()` (from `@/lib/auth`) is the seam under mock,
// since `getVerifiedSession` calls it internally.
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { verifyPassword } from '@/lib/auth/password'

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

async function makeUser(tenantSlug: string, email: string, role: string) {
  const [tenant] = await db.insert(schema.tenants).values({ slug: tenantSlug, name: tenantSlug }).returning()
  const [user] = await db.insert(schema.users).values({ tenantId: tenant.id, email, role }).returning()
  return user
}

function sessionFor(user: { id: string; tenantId: string; role: string; sessionVersion: number }) {
  return {
    user: { id: user.id, tenantId: user.tenantId, role: user.role, sessionVersion: user.sessionVersion },
    expires: '2099-01-01T00:00:00.000Z',
  }
}

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/auth/password/set', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('POST /api/auth/password/set', () => {
  beforeEach(() => {
    authMock.mockReset()
  })

  it('rejects an unauthenticated request with 401', async () => {
    authMock.mockResolvedValue(null)

    const { POST } = await import('./route')
    const res = await POST(makeRequest({ password: 'x'.repeat(20) }))

    expect(res.status).toBe(401)
  })

  it('rejects a non-admin caller with 403', async () => {
    const user = await makeUser('pw-set-non-admin', 'tech@herbe-service.test', 'technician')
    authMock.mockResolvedValue(sessionFor(user))

    const { POST } = await import('./route')
    const res = await POST(makeRequest({ password: 'x'.repeat(20) }))

    expect(res.status).toBe(403)
  })

  it('rejects a password under 12 characters with 400', async () => {
    const user = await makeUser('pw-set-short', 'admin-short@herbe-service.test', 'admin')
    authMock.mockResolvedValue(sessionFor(user))

    const { POST } = await import('./route')
    const res = await POST(makeRequest({ password: 'short-pass' }))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('password_too_short')
  })

  it('sets a verifiable password hash for a valid password', async () => {
    const user = await makeUser('pw-set-ok', 'admin-ok@herbe-service.test', 'admin')
    authMock.mockResolvedValue(sessionFor(user))

    const { POST } = await import('./route')
    const res = await POST(makeRequest({ password: 'correct horse battery' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ status: 'ok' })

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id))
    expect(row.passwordHash).toBeTruthy()
    expect(await verifyPassword(row.passwordHash!, 'correct horse battery')).toBe(true)
  })
})
