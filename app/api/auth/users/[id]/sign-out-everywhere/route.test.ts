// app/api/auth/users/[id]/sign-out-everywhere/route.test.ts
//
// Same harness/mock-seam convention as the devices route tests: DATABASE_URL
// must be set before `./route` is dynamically imported, and `@/lib/auth`'s
// `auth()` is the mocked seam `getVerifiedSession` reaches through.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { eq } from 'drizzle-orm'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import type { Role } from '@/lib/auth/roles'

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

async function makeUser(tenantSlug: string, email: string, role: Role = 'technician') {
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

function signOutRequest(id: string) {
  return new Request(`http://localhost/api/auth/users/${id}/sign-out-everywhere`, { method: 'POST' })
}

async function sessionVersionOf(userId: string) {
  const [row] = await db.select({ sessionVersion: schema.users.sessionVersion }).from(schema.users).where(eq(schema.users.id, userId))
  return row.sessionVersion
}

describe('POST /api/auth/users/[id]/sign-out-everywhere', () => {
  beforeEach(() => {
    authMock.mockReset()
  })

  it('rejects an unauthenticated request with 401', async () => {
    authMock.mockResolvedValue(null)

    const id = '00000000-0000-0000-0000-000000000000'
    const { POST } = await import('./route')
    const res = await POST(signOutRequest(id), { params: Promise.resolve({ id }) })

    expect(res.status).toBe(401)
  })

  it('lets a user bump their own session version', async () => {
    const user = await makeUser('signout-self', 'self@herbe-service.test')
    authMock.mockResolvedValue(sessionFor(user))
    const before = await sessionVersionOf(user.id)

    const { POST } = await import('./route')
    const res = await POST(signOutRequest(user.id), { params: Promise.resolve({ id: user.id }) })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(await sessionVersionOf(user.id)).toBe(before + 1)
  })

  it("forbids a technician from bumping another user's session version", async () => {
    const target = await makeUser('signout-tech-target', 'target@herbe-service.test')
    const technician = await makeUser('signout-tech-actor', 'tech@herbe-service.test', 'technician')
    authMock.mockResolvedValue(sessionFor(technician))
    const before = await sessionVersionOf(target.id)

    const { POST } = await import('./route')
    const res = await POST(signOutRequest(target.id), { params: Promise.resolve({ id: target.id }) })

    expect(res.status).toBe(403)
    expect(await sessionVersionOf(target.id)).toBe(before)
  })

  it("lets a same-tenant admin bump another user's session version", async () => {
    const tenantSlug = 'signout-admin-same-tenant'
    const target = await makeUser(tenantSlug, 'target2@herbe-service.test')
    const [admin] = await db
      .insert(schema.users)
      .values({ tenantId: target.tenantId, email: 'admin@herbe-service.test', role: 'admin' })
      .returning()
    authMock.mockResolvedValue(sessionFor(admin))
    const before = await sessionVersionOf(target.id)

    const { POST } = await import('./route')
    const res = await POST(signOutRequest(target.id), { params: Promise.resolve({ id: target.id }) })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(await sessionVersionOf(target.id)).toBe(before + 1)
  })

  it("returns 404 when a cross-tenant admin targets a user in a different tenant", async () => {
    const target = await makeUser('signout-cross-tenant-target', 'target3@herbe-service.test')
    const otherAdmin = await makeUser('signout-cross-tenant-admin', 'otheradmin@herbe-service.test', 'admin')
    authMock.mockResolvedValue(sessionFor(otherAdmin))
    const before = await sessionVersionOf(target.id)

    const { POST } = await import('./route')
    const res = await POST(signOutRequest(target.id), { params: Promise.resolve({ id: target.id }) })

    expect(res.status).toBe(404)
    expect(await sessionVersionOf(target.id)).toBe(before)
  })

  it('returns 404 when a same-tenant-check admin targets an unknown user id', async () => {
    const admin = await makeUser('signout-unknown-admin', 'admin4@herbe-service.test', 'admin')
    authMock.mockResolvedValue(sessionFor(admin))

    const unknownId = '00000000-0000-0000-0000-000000000000'
    const { POST } = await import('./route')
    const res = await POST(signOutRequest(unknownId), { params: Promise.resolve({ id: unknownId }) })

    expect(res.status).toBe(404)
  })
})
