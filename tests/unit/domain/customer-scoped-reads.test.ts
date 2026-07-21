// tests/unit/domain/customer-scoped-reads.test.ts
//
// Task 2 of the herbe.service /api/ext/v1 read-API slice
// (docs/superpowers/sdd/task-2-brief.md): resolveCustomerIdsByCodes joins
// ext_tokens.customer_codes (ERP codes) to customers.id, and
// scanServiceItemsForCustomer / scanServiceOrdersForCustomer read those ids
// back with the same gt(changeSeq, after) cursor idiom as
// app/api/sync/customers/route.ts:35-39. Uses the local-Postgres test
// harness (lib/test-support/db.ts), same bootstrap as
// tests/unit/domain/service-items-store.test.ts.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { resolveCustomerIdsByCodes, scanCustomersForCompany } from '@/lib/domain/stores/customers'
import { insertServiceItem, scanServiceItemsForCustomer } from '@/lib/domain/stores/service-items'
import { insertServiceOrder, scanServiceOrdersForCustomer, setOrderStatus } from '@/lib/domain/stores/service-orders'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string
let erpCompanyId: string
let customerA: { id: string }
let customerB: { id: string }

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 'cust-scoped-t1', name: 'Cust Scoped T1' }).returning()
  tenantId = tenant.id

  const [erpCompany] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName: 'Cust Scoped Co', adapterType: 'standard_books' })
    .returning()
  erpCompanyId = erpCompany.id

  const [a] = await db
    .insert(schema.customers)
    .values({ tenantId, erpCompanyId, erpRef: 'CUST-A', name: 'Customer A', changeSeq: BigInt(0) })
    .returning()
  customerA = a

  const [b] = await db
    .insert(schema.customers)
    .values({ tenantId, erpCompanyId, erpRef: 'CUST-B', name: 'Customer B', changeSeq: BigInt(0) })
    .returning()
  customerB = b
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('resolveCustomerIdsByCodes', () => {
  it('maps known erpRef codes to customer ids, excluding unknown codes', async () => {
    const ids = await resolveCustomerIdsByCodes(db, tenantId, erpCompanyId, ['CUST-A', 'CUST-B', 'CUST-UNKNOWN'])
    expect(ids.sort()).toEqual([customerA.id, customerB.id].sort())
  })

  it('returns [] for an empty codes array', async () => {
    const ids = await resolveCustomerIdsByCodes(db, tenantId, erpCompanyId, [])
    expect(ids).toEqual([])
  })

  it('returns [] when no codes match', async () => {
    const ids = await resolveCustomerIdsByCodes(db, tenantId, erpCompanyId, ['NOPE'])
    expect(ids).toEqual([])
  })
})

describe('scanServiceItemsForCustomer', () => {
  it('returns only rows for the given customer ids', async () => {
    const itemA1 = await insertServiceItem(db, { tenantId, kind: 'unit', name: 'A Unit 1', labelId: 'L-csi-a1', customerId: customerA.id })
    const itemA2 = await insertServiceItem(db, { tenantId, kind: 'unit', name: 'A Unit 2', labelId: 'L-csi-a2', customerId: customerA.id })
    await insertServiceItem(db, { tenantId, kind: 'unit', name: 'B Unit 1', labelId: 'L-csi-b1', customerId: customerB.id })

    const rows = await scanServiceItemsForCustomer(db, { tenantId, customerIds: [customerA.id], limit: 10 })
    expect(rows.map((r) => r.id).sort()).toEqual([itemA1.id, itemA2.id].sort())
  })

  it('returns [] when customerIds is empty', async () => {
    const rows = await scanServiceItemsForCustomer(db, { tenantId, customerIds: [], limit: 10 })
    expect(rows).toEqual([])
  })

  it('after-cursor returns only rows with changeSeq > cursor', async () => {
    const [cursorCustomer] = await db
      .insert(schema.customers)
      .values({ tenantId, erpCompanyId, erpRef: 'CUST-CURSOR', name: 'Cursor Customer', changeSeq: BigInt(0) })
      .returning()

    const first = await insertServiceItem(db, { tenantId, kind: 'unit', name: 'Cursor 1', labelId: 'L-csi-cur-1', customerId: cursorCustomer.id })
    const second = await insertServiceItem(db, { tenantId, kind: 'unit', name: 'Cursor 2', labelId: 'L-csi-cur-2', customerId: cursorCustomer.id })
    const third = await insertServiceItem(db, { tenantId, kind: 'unit', name: 'Cursor 3', labelId: 'L-csi-cur-3', customerId: cursorCustomer.id })

    const rows = await scanServiceItemsForCustomer(db, {
      tenantId,
      customerIds: [cursorCustomer.id],
      after: first.changeSeq,
      limit: 10,
    })
    expect(rows.map((r) => r.id)).toEqual([second.id, third.id])
    expect(rows.every((r) => r.changeSeq > first.changeSeq)).toBe(true)
  })

  it('limit caps the returned count and orders by changeSeq ascending', async () => {
    const [limitCustomer] = await db
      .insert(schema.customers)
      .values({ tenantId, erpCompanyId, erpRef: 'CUST-LIMIT', name: 'Limit Customer', changeSeq: BigInt(0) })
      .returning()

    const first = await insertServiceItem(db, { tenantId, kind: 'unit', name: 'Limit 1', labelId: 'L-csi-lim-1', customerId: limitCustomer.id })
    const second = await insertServiceItem(db, { tenantId, kind: 'unit', name: 'Limit 2', labelId: 'L-csi-lim-2', customerId: limitCustomer.id })
    await insertServiceItem(db, { tenantId, kind: 'unit', name: 'Limit 3', labelId: 'L-csi-lim-3', customerId: limitCustomer.id })

    const rows = await scanServiceItemsForCustomer(db, { tenantId, customerIds: [limitCustomer.id], limit: 2 })
    expect(rows.map((r) => r.id)).toEqual([first.id, second.id])
  })
})

describe('scanServiceOrdersForCustomer', () => {
  it('returns only rows for the given customer ids', async () => {
    const orderA1 = await insertServiceOrder(db, { tenantId, customerId: customerA.id, description: 'A Order 1' })
    const orderA2 = await insertServiceOrder(db, { tenantId, customerId: customerA.id, description: 'A Order 2' })
    await insertServiceOrder(db, { tenantId, customerId: customerB.id, description: 'B Order 1' })

    const rows = await scanServiceOrdersForCustomer(db, { tenantId, customerIds: [customerA.id], limit: 10 })
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([orderA1.id, orderA2.id]))
    expect(rows.every((r) => r.customerId === customerA.id)).toBe(true)
  })

  it('returns [] when customerIds is empty', async () => {
    const rows = await scanServiceOrdersForCustomer(db, { tenantId, customerIds: [], limit: 10 })
    expect(rows).toEqual([])
  })

  it('after-cursor returns only rows with changeSeq > cursor', async () => {
    const [cursorCustomer] = await db
      .insert(schema.customers)
      .values({ tenantId, erpCompanyId, erpRef: 'CUST-ORD-CURSOR', name: 'Order Cursor Customer', changeSeq: BigInt(0) })
      .returning()

    const first = await insertServiceOrder(db, { tenantId, customerId: cursorCustomer.id, description: 'Cursor Order 1' })
    const second = await insertServiceOrder(db, { tenantId, customerId: cursorCustomer.id, description: 'Cursor Order 2' })
    const third = await insertServiceOrder(db, { tenantId, customerId: cursorCustomer.id, description: 'Cursor Order 3' })

    const rows = await scanServiceOrdersForCustomer(db, {
      tenantId,
      customerIds: [cursorCustomer.id],
      after: first.changeSeq,
      limit: 10,
    })
    expect(rows.map((r) => r.id)).toEqual([second.id, third.id])
    expect(rows.every((r) => r.changeSeq > first.changeSeq)).toBe(true)
  })

  it('limit caps the returned count and orders by changeSeq ascending', async () => {
    const [limitCustomer] = await db
      .insert(schema.customers)
      .values({ tenantId, erpCompanyId, erpRef: 'CUST-ORD-LIMIT', name: 'Order Limit Customer', changeSeq: BigInt(0) })
      .returning()

    const first = await insertServiceOrder(db, { tenantId, customerId: limitCustomer.id, description: 'Limit Order 1' })
    const second = await insertServiceOrder(db, { tenantId, customerId: limitCustomer.id, description: 'Limit Order 2' })
    await insertServiceOrder(db, { tenantId, customerId: limitCustomer.id, description: 'Limit Order 3' })

    const rows = await scanServiceOrdersForCustomer(db, { tenantId, customerIds: [limitCustomer.id], limit: 2 })
    expect(rows.map((r) => r.id)).toEqual([first.id, second.id])
  })

  it('filters by status when provided', async () => {
    const [statusCustomer] = await db
      .insert(schema.customers)
      .values({ tenantId, erpCompanyId, erpRef: 'CUST-ORD-STATUS', name: 'Order Status Customer', changeSeq: BigInt(0) })
      .returning()

    const newOrder = await insertServiceOrder(db, { tenantId, customerId: statusCustomer.id, description: 'New Order' })
    const acceptedOrder = await insertServiceOrder(db, { tenantId, customerId: statusCustomer.id, description: 'Accepted Order' })
    await setOrderStatus(db, tenantId, acceptedOrder.id, 'Accepted')

    const rows = await scanServiceOrdersForCustomer(db, {
      tenantId,
      customerIds: [statusCustomer.id],
      limit: 10,
      status: 'Accepted',
    })
    expect(rows.map((r) => r.id)).toEqual([acceptedOrder.id])
    expect(rows.some((r) => r.id === newOrder.id)).toBe(false)
  })
})

describe('scanCustomersForCompany', () => {
  it('returns customers for the erp company, tenant-scoped, excluding soft-deleted and other companies', async () => {
    // Own tenant/companies (not the shared tenantId/erpCompanyId) so this
    // assertion isn't affected by customers inserted by earlier tests in
    // this file (cursorCustomer, limitCustomer, statusCustomer, ...).
    const [scanTenant] = await db.insert(schema.tenants).values({ slug: 'scan-cust-t1', name: 'Scan Cust T1' }).returning()
    const [scanCompany] = await db
      .insert(schema.erpCompanies)
      .values({ tenantId: scanTenant.id, displayName: 'Scan Cust Co', adapterType: 'standard_books' })
      .returning()
    const [otherCompany] = await db
      .insert(schema.erpCompanies)
      .values({ tenantId: scanTenant.id, displayName: 'Other Co', adapterType: 'standard_books' })
      .returning()

    const [active] = await db
      .insert(schema.customers)
      .values({ tenantId: scanTenant.id, erpCompanyId: scanCompany.id, erpRef: 'SCAN-CUST-1', name: 'Active Customer', changeSeq: BigInt(0) })
      .returning()
    const [deleted] = await db
      .insert(schema.customers)
      .values({
        tenantId: scanTenant.id,
        erpCompanyId: scanCompany.id,
        erpRef: 'SCAN-CUST-2',
        name: 'Deleted Customer',
        changeSeq: BigInt(0),
        deletedAt: new Date(),
      })
      .returning()
    await db
      .insert(schema.customers)
      .values({ tenantId: scanTenant.id, erpCompanyId: otherCompany.id, erpRef: 'SCAN-CUST-3', name: 'Other Company Customer', changeSeq: BigInt(0) })

    const rows = await scanCustomersForCompany(db, scanTenant.id, scanCompany.id)
    expect(rows.map((r) => r.id)).toEqual([active.id])
    expect(rows.map((r) => r.id)).not.toContain(deleted.id)
  })

  it('returns [] for a tenant that does not own the erp company', async () => {
    const [otherTenant] = await db.insert(schema.tenants).values({ slug: 'scan-cust-t2', name: 'Scan Cust T2' }).returning()
    const rows = await scanCustomersForCompany(db, otherTenant.id, erpCompanyId)
    expect(rows).toEqual([])
  })
})
