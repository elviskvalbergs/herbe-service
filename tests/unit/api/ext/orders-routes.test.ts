// tests/unit/api/ext/orders-routes.test.ts
//
// Task 9: DB-backed route tests for GET /api/ext/v1/orders (+ {id}), against
// a real local Postgres (same bootstrap as
// tests/unit/api/ext/service-items-routes.test.ts, Task 8).
// `@/app/api/ext/v1/orders/*` transitively imports `@/lib/db`, which reads
// DATABASE_URL at module-load time, so DATABASE_URL must point at the
// harness DB *before* any route module is first dynamically imported.
//
// Seeds via `seedBaseline` (`@/lib/seed`), which seeds two tenants, each with
// one erpCompany, one customer (`SEED-CUST-1`), and (via seedDomain) one
// service order per internal OrderStatus. A second customer + order is
// inserted directly in this file's beforeAll, in the SAME tenant/company as
// tenant 1's token, to prove the scope check narrows by *customer*, not just
// tenant — same reasoning as the service-items test's `otherCustomerItemId`.
// A service_order_rows link is also inserted directly (seedDomain doesn't
// write any) so the serviceItems[] batch-join has something real to assert
// against, not just an empty array.
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { seedBaseline } from '@/lib/seed'
import { insertServiceOrder } from '@/lib/domain/stores/service-orders'
import { mintExtToken } from '@/lib/api/ext/tokens-store'
import { orderListSchema, orderDetailSchema } from '@/lib/api/ext/dto'

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
let unitItemName: string
let confirmedOrderId: string
let workDoneOrderId: string
let otherCustomerOrderId: string

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

  const tenant1Orders = await db.select().from(schema.serviceOrders).where(eq(schema.serviceOrders.tenantId, TENANT_1))
  const confirmedOrder = tenant1Orders.find((o) => o.orderNumber === 'SVO-CONFIRMED')
  const workDoneOrder = tenant1Orders.find((o) => o.orderNumber === 'SVO-WORK-DONE')
  if (!confirmedOrder) throw new Error('seedDomain did not seed a SVO-CONFIRMED order for tenant 1')
  if (!workDoneOrder) throw new Error('seedDomain did not seed a SVO-WORK-DONE order for tenant 1')
  confirmedOrderId = confirmedOrder.id
  workDoneOrderId = workDoneOrder.id

  const tenant1Items = await db.select().from(schema.serviceItems).where(eq(schema.serviceItems.tenantId, TENANT_1))
  const unit = tenant1Items.find((i) => i.kind === 'unit')
  if (!unit) throw new Error('seedBaseline did not seed a unit-kind service item for tenant 1')
  unitItemId = unit.id
  unitItemName = unit.name

  // Link the confirmed order to the unit item, so the serviceItems[] batch
  // join has a real row to resolve (seedDomain never writes
  // service_order_rows itself).
  await db.insert(schema.serviceOrderRows).values({
    orderId: confirmedOrderId,
    serviceItemId: unitItemId,
    chargeType: 'invoiceable',
  })

  // Second customer + order, same tenant/company as the token, but NOT in
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
  const otherOrder = await insertServiceOrder(db, {
    tenantId: TENANT_1,
    customerId: otherCustomer.id,
    erpCompanyId: COMPANY_1,
    orderNumber: 'OTHER-ORDER',
  })
  otherCustomerOrderId = otherOrder.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('GET /api/ext/v1/orders', () => {
  it('rejects a request with no token with 401', async () => {
    const { GET } = await import('@/app/api/ext/v1/orders/route')
    const res = await GET(new Request(`http://x/api/ext/v1/orders?customerCodes=${SEED_CUSTOMER_CODE}`))
    expect(res.status).toBe(401)
  })

  it('returns the scoped customer\'s orders with projected status and the serviceItems join, omitting another customer\'s', async () => {
    const { GET } = await import('@/app/api/ext/v1/orders/route')
    const res = await GET(
      new Request(`http://x/api/ext/v1/orders?customerCodes=${SEED_CUSTOMER_CODE}`, { headers: authed(rawToken) }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(() => orderListSchema.parse(body)).not.toThrow()
    expect(body.data.some((o: { id: string }) => o.id === otherCustomerOrderId)).toBe(false)

    // Internal 'Confirmed' -> customer-visible 'work_done' (docs/02-data-model.md:64-72).
    const confirmed = body.data.find((o: { id: string }) => o.id === confirmedOrderId)
    expect(confirmed).toBeDefined()
    expect(confirmed.status).toBe('work_done')
    expect(confirmed.serviceItems).toEqual([{ id: unitItemId, name: unitItemName }])
  })

  it('narrows a customerCodes request outside the token scope to nothing', async () => {
    const { GET } = await import('@/app/api/ext/v1/orders/route')
    const res = await GET(
      new Request(`http://x/api/ext/v1/orders?customerCodes=${OTHER_CUSTOMER_CODE}`, { headers: authed(rawToken) }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toEqual([])
    expect(body.nextCursor).toBeUndefined()
  })

  it('?status=work_done filters to orders whose PROJECTED status matches, across multiple internal states', async () => {
    const { GET } = await import('@/app/api/ext/v1/orders/route')
    const res = await GET(
      new Request(`http://x/api/ext/v1/orders?customerCodes=${SEED_CUSTOMER_CODE}&status=work_done`, {
        headers: authed(rawToken),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.length).toBeGreaterThanOrEqual(2)
    expect(body.data.every((o: { status: string }) => o.status === 'work_done')).toBe(true)
    // Both 'Work done' and 'Confirmed' internal states collapse to 'work_done'.
    expect(body.data.some((o: { id: string }) => o.id === workDoneOrderId)).toBe(true)
    expect(body.data.some((o: { id: string }) => o.id === confirmedOrderId)).toBe(true)
  })

  it('returns 400 for a malformed after cursor', async () => {
    const { GET } = await import('@/app/api/ext/v1/orders/route')
    const res = await GET(
      new Request(`http://x/api/ext/v1/orders?customerCodes=${SEED_CUSTOMER_CODE}&after=abc`, { headers: authed(rawToken) }),
    )
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.code).toBe('invalid_cursor')
  })
})

describe('GET /api/ext/v1/orders/[id]', () => {
  it('rejects a request with no token with 401', async () => {
    const { GET } = await import('@/app/api/ext/v1/orders/[id]/route')
    const res = await GET(new Request(`http://x/api/ext/v1/orders/${confirmedOrderId}`), {
      params: Promise.resolve({ id: confirmedOrderId }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 200 with a parseable detail DTO, worksheets present, timeline/invoices empty', async () => {
    const { GET } = await import('@/app/api/ext/v1/orders/[id]/route')
    const res = await GET(new Request(`http://x/api/ext/v1/orders/${confirmedOrderId}`, { headers: authed(rawToken) }), {
      params: Promise.resolve({ id: confirmedOrderId }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(() => orderDetailSchema.parse(body)).not.toThrow()
    expect(body.id).toBe(confirmedOrderId)
    expect(body.status).toBe('work_done')
    expect(body.worksheets).toHaveLength(1)
    expect(body.worksheets[0].signedOnSite).toBe(true)
    expect(body.timeline).toEqual([])
    expect(body.invoices).toEqual([])
    expect(body.serviceItems).toEqual([{ id: unitItemId, name: unitItemName }])
  })

  it('returns 404 (not 403) for another customer\'s order, same tenant', async () => {
    const { GET } = await import('@/app/api/ext/v1/orders/[id]/route')
    const res = await GET(
      new Request(`http://x/api/ext/v1/orders/${otherCustomerOrderId}`, { headers: authed(rawToken) }),
      { params: Promise.resolve({ id: otherCustomerOrderId }) },
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('not_found')
  })

  it('returns 404 for a nonexistent id', async () => {
    const { GET } = await import('@/app/api/ext/v1/orders/[id]/route')
    const missingId = '00000000-0000-0000-0000-000000000000'
    const res = await GET(new Request(`http://x/api/ext/v1/orders/${missingId}`, { headers: authed(rawToken) }), {
      params: Promise.resolve({ id: missingId }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 404 (not 500) for a malformed, non-UUID id', async () => {
    const { GET } = await import('@/app/api/ext/v1/orders/[id]/route')
    const res = await GET(new Request('http://x/api/ext/v1/orders/not-a-uuid', { headers: authed(rawToken) }), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('not_found')
  })
})
