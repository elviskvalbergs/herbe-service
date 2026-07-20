// app/api/settings/route.test.ts
//
// `@/app/api/settings/route` transitively imports `@/lib/db`, which reads
// DATABASE_URL at module-load time, so DATABASE_URL must point at the
// harness DB *before* the route is first dynamically imported (same
// convention as app/api/auth/devices/route.test.ts). The route calls
// `getVerifiedSession` (lib/auth/session-guard), which itself calls
// `auth()` from `@/lib/auth` — that's the seam under mock here.
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

function patchRequest(body: unknown) {
  return new Request('http://localhost/api/settings', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('GET /api/settings', () => {
  beforeEach(() => {
    authMock.mockReset()
  })

  it('rejects an unauthenticated request with 401', async () => {
    authMock.mockResolvedValue(null)

    const { GET } = await import('./route')
    const res = await GET()

    expect(res.status).toBe(401)
  })

  it("returns the caller's own prefs, defaulted", async () => {
    const user = await makeUser('settings-get', 'get@herbe-service.test')
    authMock.mockResolvedValue(sessionFor(user))

    const { GET } = await import('./route')
    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ locale: 'lv', displayScheme: 'standard' })
  })
})

describe('PATCH /api/settings', () => {
  beforeEach(() => {
    authMock.mockReset()
  })

  it('rejects an unauthenticated request with 401', async () => {
    authMock.mockResolvedValue(null)

    const { PATCH } = await import('./route')
    const res = await PATCH(patchRequest({ locale: 'en' }))

    expect(res.status).toBe(401)
  })

  it('persists a valid partial update and returns the full prefs', async () => {
    const user = await makeUser('settings-patch-ok', 'patch-ok@herbe-service.test')
    authMock.mockResolvedValue(sessionFor(user))

    const { PATCH } = await import('./route')
    const res = await PATCH(patchRequest({ displayScheme: 'sunlight' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ locale: 'lv', displayScheme: 'sunlight' })

    const { GET } = await import('./route')
    const getRes = await GET()
    expect(await getRes.json()).toEqual({ locale: 'lv', displayScheme: 'sunlight' })
  })

  it('rejects a malformed JSON body with 400, not a 500, and leaves prefs unchanged', async () => {
    const user = await makeUser('settings-patch-malformed', 'patch-malformed@herbe-service.test')
    authMock.mockResolvedValue(sessionFor(user))

    const { PATCH } = await import('./route')
    const req = new Request('http://localhost/api/settings', {
      method: 'PATCH',
      body: 'not json',
      headers: { 'content-type': 'application/json' },
    })
    const res = await PATCH(req)

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_body' })

    const { GET } = await import('./route')
    const getRes = await GET()
    expect(await getRes.json()).toEqual({ locale: 'lv', displayScheme: 'standard' })
  })

  it('rejects a JSON body that parses to null with 400, not a 500, and leaves prefs unchanged', async () => {
    const user = await makeUser('settings-patch-null-body', 'patch-null-body@herbe-service.test')
    authMock.mockResolvedValue(sessionFor(user))

    const { PATCH } = await import('./route')
    const res = await PATCH(patchRequest(null))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_body' })

    const { GET } = await import('./route')
    const getRes = await GET()
    expect(await getRes.json()).toEqual({ locale: 'lv', displayScheme: 'standard' })
  })

  it('rejects an invalid locale with 400 and leaves prefs unchanged', async () => {
    const user = await makeUser('settings-patch-bad-locale', 'patch-bad-locale@herbe-service.test')
    authMock.mockResolvedValue(sessionFor(user))

    const { PATCH } = await import('./route')
    const res = await PATCH(patchRequest({ locale: 'xx' }))

    expect(res.status).toBe(400)

    const { GET } = await import('./route')
    const getRes = await GET()
    expect(await getRes.json()).toEqual({ locale: 'lv', displayScheme: 'standard' })
  })

  it('rejects an invalid display scheme with 400 and leaves prefs unchanged', async () => {
    const user = await makeUser('settings-patch-bad-scheme', 'patch-bad-scheme@herbe-service.test')
    authMock.mockResolvedValue(sessionFor(user))

    const { PATCH } = await import('./route')
    const res = await PATCH(patchRequest({ displayScheme: 'neon' }))

    expect(res.status).toBe(400)

    const { GET } = await import('./route')
    const getRes = await GET()
    expect(await getRes.json()).toEqual({ locale: 'lv', displayScheme: 'standard' })
  })
})
