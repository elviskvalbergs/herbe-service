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
  return { tenantId: tenant.id, erpCompanyId: company.id }
}

describe('GET /api/sync/customers', () => {
  beforeEach(() => {
    // Authenticated by default; the 401 test below overrides this per-call.
    authMock.mockReset().mockResolvedValue({ user: { id: 'test-user-id' }, expires: '2099-01-01T00:00:00.000Z' })
  })

  it('rejects an unauthenticated request with 401 before querying', async () => {
    authMock.mockResolvedValue(null)
    const { tenantId } = await makeCompany('unauth-tenant')

    const { GET } = await import('./route')
    const res = await GET(new Request(`http://x/api/sync/customers?tenantId=${tenantId}&after=0`))

    expect(res.status).toBe(401)
  })

  it('returns only rows with changeSeq greater than "after", scoped to the given tenant', async () => {
    const { tenantId, erpCompanyId } = await makeCompany('delta-tenant')
    const other = await makeCompany('other-tenant')

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
    const res = await GET(new Request(`http://x/api/sync/customers?tenantId=${tenantId}&after=${c1.changeSeq}`))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({ id: c2.id, erpRef: 'CUST002', name: 'Second Client' })
    // changeSeq must be JSON-safe (a string), not a raw bigint.
    expect(typeof body.data[0].changeSeq).toBe('string')
    expect(body.cursor).toBe(String(c2.changeSeq))
  })

  it('returns the unchanged cursor and no rows when nothing changed since "after"', async () => {
    const { tenantId, erpCompanyId } = await makeCompany('no-delta-tenant')
    const [c1] = await db
      .insert(schema.customers)
      .values({ tenantId, erpCompanyId, erpRef: 'CUST001', name: 'First Client', changeSeq: BigInt(0) })
      .returning()

    const { GET } = await import('./route')
    const res = await GET(new Request(`http://x/api/sync/customers?tenantId=${tenantId}&after=${c1.changeSeq}`))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toHaveLength(0)
    expect(body.cursor).toBe(String(c1.changeSeq))
  })

  it('defaults "after" to 0 when the query param is omitted, returning every row for the tenant', async () => {
    const { tenantId, erpCompanyId } = await makeCompany('no-after-tenant')
    await db
      .insert(schema.customers)
      .values({ tenantId, erpCompanyId, erpRef: 'CUST001', name: 'First Client', changeSeq: BigInt(0) })
      .returning()

    const { GET } = await import('./route')
    const res = await GET(new Request(`http://x/api/sync/customers?tenantId=${tenantId}`))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toHaveLength(1)
  })
})
