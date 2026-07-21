// app/api/auth/devices/[id]/revoke/route.test.ts
//
// Same harness/mock-seam convention as app/api/auth/devices/route.test.ts:
// DATABASE_URL must be set before `./route` is dynamically imported, and
// `@/lib/auth`'s `auth()` is the mocked seam `getVerifiedSession` reaches
// through.
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

async function makeDevice(user: { tenantId: string; id: string }, label: string) {
  const [device] = await db
    .insert(schema.pairedDevices)
    .values({ tenantId: user.tenantId, userId: user.id, deviceLabel: label, pinHash: 'x' })
    .returning()
  return device
}

function sessionFor(user: { id: string; tenantId: string; role: string; sessionVersion: number }) {
  return {
    user: { id: user.id, tenantId: user.tenantId, role: user.role, sessionVersion: user.sessionVersion },
    expires: '2099-01-01T00:00:00.000Z',
  }
}

function revokeRequest(id: string) {
  return new Request(`http://localhost/api/auth/devices/${id}/revoke`, { method: 'POST' })
}

describe('POST /api/auth/devices/[id]/revoke', () => {
  beforeEach(() => {
    authMock.mockReset()
  })

  it('rejects an unauthenticated request with 401', async () => {
    authMock.mockResolvedValue(null)

    const { POST } = await import('./route')
    const res = await POST(revokeRequest('00000000-0000-0000-0000-000000000000'), {
      params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }),
    })

    expect(res.status).toBe(401)
  })

  it('returns 404 for an unknown device id', async () => {
    const user = await makeUser('revoke-unknown', 'unknown@herbe-service.test')
    authMock.mockResolvedValue(sessionFor(user))

    const unknownId = '00000000-0000-0000-0000-000000000000'
    const { POST } = await import('./route')
    const res = await POST(revokeRequest(unknownId), { params: Promise.resolve({ id: unknownId }) })

    expect(res.status).toBe(404)
  })

  it('lets a user revoke their own device', async () => {
    const user = await makeUser('revoke-self', 'self@herbe-service.test')
    const device = await makeDevice(user, "Self's phone")
    authMock.mockResolvedValue(sessionFor(user))

    const { POST } = await import('./route')
    const res = await POST(revokeRequest(device.id), { params: Promise.resolve({ id: device.id }) })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.status).toBe('ok')

    const [updated] = await db.select().from(schema.pairedDevices).where(eq(schema.pairedDevices.id, device.id))
    expect(updated.revokedAt).not.toBeNull()
  })

  // FIX-8: revoking a device must invalidate the owner's live session, not
  // just stamp revokedAt — nothing reads revokedAt on the session path and
  // sessions aren't device-bound, so bumping session_version is the only
  // lever that makes getVerifiedSession reject the owner's JWT.
  it("bumps the owner's session_version so the wipe invalidates their session (FIX-8)", async () => {
    const user = await makeUser('revoke-bump', 'bump@herbe-service.test')
    const device = await makeDevice(user, "Bump's phone")
    authMock.mockResolvedValue(sessionFor(user))

    const [beforeRow] = await db
      .select({ sessionVersion: schema.users.sessionVersion })
      .from(schema.users)
      .where(eq(schema.users.id, user.id))

    const { POST } = await import('./route')
    const res = await POST(revokeRequest(device.id), { params: Promise.resolve({ id: device.id }) })
    expect(res.status).toBe(200)

    const [afterRow] = await db
      .select({ sessionVersion: schema.users.sessionVersion })
      .from(schema.users)
      .where(eq(schema.users.id, user.id))
    expect(afterRow.sessionVersion).toBe(beforeRow.sessionVersion + 1)
  })

  it("forbids a technician from revoking another user's device", async () => {
    const owner = await makeUser('revoke-tech-owner', 'owner@herbe-service.test')
    const device = await makeDevice(owner, "Owner's phone")
    const technician = await makeUser('revoke-tech-actor', 'tech@herbe-service.test', 'technician')
    authMock.mockResolvedValue(sessionFor(technician))

    const { POST } = await import('./route')
    const res = await POST(revokeRequest(device.id), { params: Promise.resolve({ id: device.id }) })

    expect(res.status).toBe(403)

    const [unchanged] = await db.select().from(schema.pairedDevices).where(eq(schema.pairedDevices.id, device.id))
    expect(unchanged.revokedAt).toBeNull()
  })

  it("lets a same-tenant admin revoke another user's device", async () => {
    const tenantSlug = 'revoke-admin-same-tenant'
    const owner = await makeUser(tenantSlug, 'owner2@herbe-service.test')
    const device = await makeDevice(owner, "Owner2's phone")
    const [admin] = await db
      .insert(schema.users)
      .values({ tenantId: owner.tenantId, email: 'admin@herbe-service.test', role: 'admin' })
      .returning()
    authMock.mockResolvedValue(sessionFor(admin))

    const { POST } = await import('./route')
    const res = await POST(revokeRequest(device.id), { params: Promise.resolve({ id: device.id }) })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.status).toBe('ok')

    const [updated] = await db.select().from(schema.pairedDevices).where(eq(schema.pairedDevices.id, device.id))
    expect(updated.revokedAt).not.toBeNull()
  })

  it("forbids a cross-tenant admin from revoking another tenant's device", async () => {
    const owner = await makeUser('revoke-cross-tenant-owner', 'owner3@herbe-service.test')
    const device = await makeDevice(owner, "Owner3's phone")
    const otherAdmin = await makeUser('revoke-cross-tenant-admin', 'otheradmin@herbe-service.test', 'admin')
    authMock.mockResolvedValue(sessionFor(otherAdmin))

    const { POST } = await import('./route')
    const res = await POST(revokeRequest(device.id), { params: Promise.resolve({ id: device.id }) })

    expect(res.status).toBe(403)

    const [unchanged] = await db.select().from(schema.pairedDevices).where(eq(schema.pairedDevices.id, device.id))
    expect(unchanged.revokedAt).toBeNull()
  })
})
