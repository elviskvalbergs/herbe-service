// app/api/sync/customers/route.test.ts
//
// Uses the local-Postgres test harness (lib/test-support/db.ts), not
// Testcontainers — same convention as app/api/sync/outbox/route.test.ts.
// `@/app/api/sync/customers/route` transitively imports `@/lib/db`, which
// reads DATABASE_URL at module-load time, so DATABASE_URL must point at the
// harness DB *before* the route is first dynamically imported.
//
// `auth` from '@/lib/auth' is mocked at the module seam (same reasoning as
// the outbox route test): Auth.js v5's server-side `auth()` needs the
// Next.js request-scoped AsyncLocalStorage that only exists inside a real
// Next.js server request, not a bare Vitest call to `GET(request)`.
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

async function makeCompany(slug: string) {
  const [tenant] = await db.insert(schema.tenants).values({ slug, name: slug }).returning()
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId: tenant.id, displayName: slug, adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  // FIX-6: the route now uses getVerifiedSession, which re-checks
  // users.session_version against the JWT claim — so a real user row is
  // required for the mocked session to verify.
  const [user] = await db.insert(schema.users).values({ tenantId: tenant.id, email: `${slug}@sync.test` }).returning()
  return { tenantId: tenant.id, erpCompanyId: company.id, user }
}

function sessionFor(user: { id: string; tenantId: string; sessionVersion: number }) {
  return {
    user: { id: user.id, tenantId: user.tenantId, sessionVersion: user.sessionVersion },
    expires: '2099-01-01T00:00:00.000Z',
  }
}

describe('GET /api/sync/customers', () => {
  beforeEach(() => {
    // Authenticated by default; the 401 test below overrides this per-call.
    authMock.mockReset().mockResolvedValue({ user: { id: 'test-user-id' }, expires: '2099-01-01T00:00:00.000Z' })
  })

  it('rejects an unauthenticated request with 401 before querying', async () => {
    authMock.mockResolvedValue(null)

    const { GET } = await import('./route')
    const res = await GET(new Request(`http://x/api/sync/customers?after=0`))

    expect(res.status).toBe(401)
  })

  it('returns only rows with changeSeq greater than "after", scoped to the given tenant', async () => {
    const { tenantId, erpCompanyId, user } = await makeCompany('delta-tenant')
    const other = await makeCompany('other-tenant')
    authMock.mockResolvedValue(sessionFor(user))

    const [c1] = await db
      .insert(schema.customers)
      .values({ tenantId, erpCompanyId, erpRef: 'CUST001', name: 'First Client', changeSeq: BigInt(0) })
      .returning()
    const [c2] = await db
      .insert(schema.customers)
      .values({ tenantId, erpCompanyId, erpRef: 'CUST002', name: 'Second Client', changeSeq: BigInt(0) })
      .returning()
    // A row belonging to a different tenant must never leak into this tenant's delta.
    await db
      .insert(schema.customers)
      .values({
        tenantId: other.tenantId,
        erpCompanyId: other.erpCompanyId,
        erpRef: 'CUST999',
        name: 'Other Tenant Client',
        changeSeq: BigInt(0),
      })
      .returning()

    const { GET } = await import('./route')
    const res = await GET(new Request(`http://x/api/sync/customers?after=${c1.changeSeq}`))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({ id: c2.id, erpRef: 'CUST002', name: 'Second Client' })
    // changeSeq must be JSON-safe (a string), not a raw bigint.
    expect(typeof body.data[0].changeSeq).toBe('string')
    expect(body.cursor).toBe(String(c2.changeSeq))
  })

  it('returns the unchanged cursor and no rows when nothing changed since "after"', async () => {
    const { tenantId, erpCompanyId, user } = await makeCompany('no-delta-tenant')
    authMock.mockResolvedValue(sessionFor(user))
    const [c1] = await db
      .insert(schema.customers)
      .values({ tenantId, erpCompanyId, erpRef: 'CUST001', name: 'First Client', changeSeq: BigInt(0) })
      .returning()

    const { GET } = await import('./route')
    const res = await GET(new Request(`http://x/api/sync/customers?after=${c1.changeSeq}`))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toHaveLength(0)
    expect(body.cursor).toBe(String(c1.changeSeq))
  })

  it('defaults "after" to 0 when the query param is omitted, returning every row for the tenant', async () => {
    const { tenantId, erpCompanyId, user } = await makeCompany('no-after-tenant')
    authMock.mockResolvedValue(sessionFor(user))
    await db
      .insert(schema.customers)
      .values({ tenantId, erpCompanyId, erpRef: 'CUST001', name: 'First Client', changeSeq: BigInt(0) })
      .returning()

    const { GET } = await import('./route')
    const res = await GET(new Request(`http://x/api/sync/customers`))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toHaveLength(1)
  })

  it('IDOR regression (Task 16b): a session scoped to tenant A never returns tenant B\'s customers, even when the request asks for tenantId=B', async () => {
    const a = await makeCompany('idor-tenant-a')
    const b = await makeCompany('idor-tenant-b')

    await db
      .insert(schema.customers)
      .values({ tenantId: a.tenantId, erpCompanyId: a.erpCompanyId, erpRef: 'CUST-A1', name: 'Tenant A Client', changeSeq: BigInt(0) })
    await db
      .insert(schema.customers)
      .values({ tenantId: b.tenantId, erpCompanyId: b.erpCompanyId, erpRef: 'CUST-B1', name: 'Tenant B Client', changeSeq: BigInt(0) })

    // The logged-in session belongs to tenant A...
    authMock.mockResolvedValue(sessionFor(a.user))

    // ...but the request tries to reach tenant B's data by supplying tenantId=B.
    const { GET } = await import('./route')
    const res = await GET(new Request(`http://x/api/sync/customers?tenantId=${b.tenantId}&after=0`))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.some((row: { name: string }) => row.name === 'Tenant A Client')).toBe(true)
    expect(body.data.some((row: { name: string }) => row.name === 'Tenant B Client')).toBe(false)
  })

  it('rejects with 401 when the session has no tenantId, rather than querying unscoped', async () => {
    const { tenantId, user } = await makeCompany('no-tenant-claim')
    // A verified session (real user id + matching sessionVersion) but with no
    // tenantId claim — the route's tenant guard, not getVerifiedSession, is
    // what must reject it here.
    authMock.mockResolvedValue({ user: { id: user.id, sessionVersion: user.sessionVersion }, expires: '2099-01-01T00:00:00.000Z' })

    const { GET } = await import('./route')
    const res = await GET(new Request(`http://x/api/sync/customers?tenantId=${tenantId}&after=0`))

    expect(res.status).toBe(401)
  })
})
