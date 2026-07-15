// tests/unit/api/ext/service-items-routes.test.ts
//
// Task 8: DB-backed route tests for GET /api/ext/v1/service-items (+ {id},
// {id}/history), against a real local Postgres (same bootstrap as
// app/api/sync/customers/route.test.ts). `@/app/api/ext/v1/service-items/*`
// transitively imports `@/lib/db`, which reads DATABASE_URL at module-load
// time, so DATABASE_URL must point at the harness DB *before* any route
// module is first dynamically imported.
//
// Seeds via `seedBaseline` (`@/lib/seed`), which seeds two tenants, each with
// one erpCompany and one customer (`SEED-CUST-1`) plus a service-item tree
// (system -> unit/lot, unit+lot get the seeded customerId). A second
// customer + item is inserted directly in this file's beforeAll, in the
// SAME tenant/company as tenant 1's token, specifically to prove the scope
// check narrows by *customer*, not just by tenant — seedBaseline alone only
// gives one customer per tenant, which would let a tenant-only check pass
// this test by accident.
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { seedBaseline } from '@/lib/seed'
import { mintExtToken } from '@/lib/api/ext/tokens-store'
import { serviceItemListSchema, serviceItemDetailSchema, historyEventSchema } from '@/lib/api/ext/dto'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

// Fixed ids from lib/seed/scenarios/baseline.ts's TENANTS array.
const TENANT_1 = '11111111-0000-0000-0000-000000000001'
const COMPANY_1 = '22222222-0000-0000-0000-000000000001'
const SEED_CUSTOMER_CODE = 'SEED-CUST-1'
const OTHER_CUSTOMER_CODE = 'OTHER-CUST'

let rawToken: string
let unitItemId: string
let unitItemLabelId: string
let otherCustomerItemId: string

function authed(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` }
}

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  process.env.DATABASE_URL = testDb.url

  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  await seedBaseline(db)

  const { raw } = await mintExtToken(db, {
    tenantId: TENANT_1,
    erpCompanyId: COMPANY_1,
    name: 'Test Token',
    customerCodes: [SEED_CUSTOMER_CODE],
  })
  rawToken = raw

  const tenant1Items = await db.select().from(schema.serviceItems).where(eq(schema.serviceItems.tenantId, TENANT_1))
  const unit = tenant1Items.find((i) => i.kind === 'unit')
  if (!unit) throw new Error('seedBaseline did not seed a unit-kind service item for tenant 1')
  unitItemId = unit.id
  unitItemLabelId = unit.labelId

  // Manually inserted history event so the history route test asserts real
  // mapped content, not just an empty-array shape (seedDomain doesn't write
  // history_events itself).
  await db.insert(schema.historyEvents).values({
    tenantId: TENANT_1,
    serviceItemId: unitItemId,
    key: 'test:history:1',
    at: new Date('2026-01-02T00:00:00.000Z'),
    kind: 'work_done',
    summary: 'Test service performed',
  })

  // Second customer + item, same tenant/company as the token, but NOT in
  // its customerCodes scope.
  const [otherCustomer] = await db
    .insert(schema.customers)
    .values({
      tenantId: TENANT_1,
      erpCompanyId: COMPANY_1,
      erpRef: OTHER_CUSTOMER_CODE,
      name: 'Other Customer OÜ',
      changeSeq: BigInt(0),
    })
    .returning()
  const [otherItem] = await db
    .insert(schema.serviceItems)
    .values({
      tenantId: TENANT_1,
      erpCompanyId: COMPANY_1,
      customerId: otherCustomer.id,
      kind: 'unit',
      name: 'Other Customer Unit',
      labelId: 'test:other-customer-unit',
      path: '',
      changeSeq: BigInt(0),
    })
    .returning()
  otherCustomerItemId = otherItem.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('GET /api/ext/v1/service-items', () => {
  it('rejects a request with no token with 401', async () => {
    const { GET } = await import('@/app/api/ext/v1/service-items/route')
    const res = await GET(new Request(`http://x/api/ext/v1/service-items?customerCodes=${SEED_CUSTOMER_CODE}`))
    expect(res.status).toBe(401)
  })

  it('returns the scoped customer\'s items and omits another customer\'s', async () => {
    const { GET } = await import('@/app/api/ext/v1/service-items/route')
    const res = await GET(
      new Request(`http://x/api/ext/v1/service-items?customerCodes=${SEED_CUSTOMER_CODE}`, { headers: authed(rawToken) }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(() => serviceItemListSchema.parse(body)).not.toThrow()
    expect(body.data.some((i: { id: string }) => i.id === unitItemId)).toBe(true)
    expect(body.data.some((i: { id: string }) => i.id === otherCustomerItemId)).toBe(false)
  })

  it('narrows a customerCodes request outside the token scope to nothing', async () => {
    const { GET } = await import('@/app/api/ext/v1/service-items/route')
    const res = await GET(
      new Request(`http://x/api/ext/v1/service-items?customerCodes=${OTHER_CUSTOMER_CODE}`, { headers: authed(rawToken) }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toEqual([])
    expect(body.nextCursor).toBeUndefined()
  })

  it('resolves a single item by labelId, scope-checked to the caller\'s customer', async () => {
    const { GET } = await import('@/app/api/ext/v1/service-items/route')
    const res = await GET(
      new Request(
        `http://x/api/ext/v1/service-items?labelId=${encodeURIComponent(unitItemLabelId)}&customerCodes=${SEED_CUSTOMER_CODE}`,
        { headers: authed(rawToken) },
      ),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].id).toBe(unitItemId)
  })

  it('returns [] for a labelId belonging to an out-of-scope customer', async () => {
    const { GET } = await import('@/app/api/ext/v1/service-items/route')
    const res = await GET(
      new Request(
        `http://x/api/ext/v1/service-items?labelId=test:other-customer-unit&customerCodes=${SEED_CUSTOMER_CODE}`,
        { headers: authed(rawToken) },
      ),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toEqual([])
  })

  it('returns 400 for a malformed after cursor', async () => {
    const { GET } = await import('@/app/api/ext/v1/service-items/route')
    const res = await GET(
      new Request(`http://x/api/ext/v1/service-items?customerCodes=${SEED_CUSTOMER_CODE}&after=abc`, { headers: authed(rawToken) }),
    )
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.code).toBe('invalid_cursor')
  })
})

describe('GET /api/ext/v1/service-items/[id]', () => {
  it('rejects a request with no token with 401', async () => {
    const { GET } = await import('@/app/api/ext/v1/service-items/[id]/route')
    const res = await GET(new Request(`http://x/api/ext/v1/service-items/${unitItemId}`), {
      params: Promise.resolve({ id: unitItemId }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 200 with a parseable detail DTO for the token\'s own item', async () => {
    const { GET } = await import('@/app/api/ext/v1/service-items/[id]/route')
    const res = await GET(new Request(`http://x/api/ext/v1/service-items/${unitItemId}`, { headers: authed(rawToken) }), {
      params: Promise.resolve({ id: unitItemId }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(() => serviceItemDetailSchema.parse(body)).not.toThrow()
    expect(body.id).toBe(unitItemId)
  })

  it('returns 404 (not 403) for another customer\'s item, same tenant', async () => {
    const { GET } = await import('@/app/api/ext/v1/service-items/[id]/route')
    const res = await GET(
      new Request(`http://x/api/ext/v1/service-items/${otherCustomerItemId}`, { headers: authed(rawToken) }),
      { params: Promise.resolve({ id: otherCustomerItemId }) },
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('not_found')
  })

  it('returns 404 for a nonexistent id', async () => {
    const { GET } = await import('@/app/api/ext/v1/service-items/[id]/route')
    const missingId = '00000000-0000-0000-0000-000000000000'
    const res = await GET(new Request(`http://x/api/ext/v1/service-items/${missingId}`, { headers: authed(rawToken) }), {
      params: Promise.resolve({ id: missingId }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 404 (not 500) for a malformed, non-UUID id', async () => {
    const { GET } = await import('@/app/api/ext/v1/service-items/[id]/route')
    const res = await GET(new Request('http://x/api/ext/v1/service-items/not-a-uuid', { headers: authed(rawToken) }), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('not_found')
  })
})

describe('GET /api/ext/v1/service-items/[id]/history', () => {
  it('rejects a request with no token with 401', async () => {
    const { GET } = await import('@/app/api/ext/v1/service-items/[id]/history/route')
    const res = await GET(new Request(`http://x/api/ext/v1/service-items/${unitItemId}/history`), {
      params: Promise.resolve({ id: unitItemId }),
    })
    expect(res.status).toBe(401)
  })

  it('returns a bare array (not {data}-wrapped) with the mapped event', async () => {
    const { GET } = await import('@/app/api/ext/v1/service-items/[id]/history/route')
    const res = await GET(
      new Request(`http://x/api/ext/v1/service-items/${unitItemId}/history`, { headers: authed(rawToken) }),
      { params: Promise.resolve({ id: unitItemId }) },
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect(() => historyEventSchema.array().parse(body)).not.toThrow()
    expect(body).toHaveLength(1)
    expect(body[0].summary).toBe('Test service performed')
    expect(body[0].kind).toBe('work_done')
  })

  it('returns 404 for another customer\'s item', async () => {
    const { GET } = await import('@/app/api/ext/v1/service-items/[id]/history/route')
    const res = await GET(
      new Request(`http://x/api/ext/v1/service-items/${otherCustomerItemId}/history`, { headers: authed(rawToken) }),
      { params: Promise.resolve({ id: otherCustomerItemId }) },
    )
    expect(res.status).toBe(404)
  })
})
