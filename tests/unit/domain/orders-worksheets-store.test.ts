// tests/unit/domain/orders-worksheets-store.test.ts
//
// Uses the local-Postgres test harness (lib/test-support/db.ts), same
// bootstrap as tests/unit/domain/service-items-store.test.ts /
// __tests__/db/tenancy.test.ts / lib/sync/ingest/customers.test.ts.
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import {
  getServiceOrderById,
  insertServiceOrder,
  scanServiceOrdersForTenant,
  setOrderStatus,
} from '@/lib/domain/stores/service-orders'
import {
  getWorksheetById,
  getWorksheetsForOrder,
  getWorksheetsForTechnician,
  insertWorksheet,
  scanWorksheetsForCompanyByStatus,
  setWorksheetStatus,
  updateWorksheetWorkDescription,
} from '@/lib/domain/stores/worksheets'
import { getErpRefs, putErpRef } from '@/lib/domain/stores/erp-refs'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string
let otherTenantId: string
let erpCompanyId: string
let customerId: string
let technicianUserId: string

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 't1', name: 'T1' }).returning()
  tenantId = tenant.id
  const [other] = await db.insert(schema.tenants).values({ slug: 't2', name: 'T2' }).returning()
  otherTenantId = other.id

  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName: 'C1', adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  erpCompanyId = company.id
  const [customer] = await db
    .insert(schema.customers)
    .values({ tenantId, erpCompanyId: company.id, erpRef: 'CUST001', name: 'Test Client OÜ', changeSeq: BigInt(0) })
    .returning()
  customerId = customer.id

  const [user] = await db.insert(schema.users).values({ tenantId, email: 'tech@example.com' }).returning()
  technicianUserId = user.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('service-orders store', () => {
  it('inserts an order defaulting to status New and reads it back scoped by tenant', async () => {
    const order = await insertServiceOrder(db, { tenantId, customerId })
    expect(order.status).toBe('New')

    const got = await getServiceOrderById(db, tenantId, order.id)
    expect(got?.id).toBe(order.id)

    // cross-tenant read returns null
    expect(await getServiceOrderById(db, otherTenantId, order.id)).toBeNull()
  })

  it('scans orders for a tenant and setOrderStatus writes the column without validating a transition', async () => {
    const order = await insertServiceOrder(db, { tenantId, customerId })
    await setOrderStatus(db, tenantId, order.id, 'Cancelled')

    const got = await getServiceOrderById(db, tenantId, order.id)
    expect(got?.status).toBe('Cancelled')

    const scanned = await scanServiceOrdersForTenant(db, tenantId)
    expect(scanned.map((o) => o.id)).toContain(order.id)
  })
})

describe('worksheets store', () => {
  it('inserts a worksheet, rejects a second one for the same (order, technician), and reads cross-tenant as null', async () => {
    const order = await insertServiceOrder(db, { tenantId, customerId })
    const worksheet = await insertWorksheet(db, { tenantId, orderId: order.id, technicianUserId })
    expect(worksheet.status).toBe('Draft')

    await expect(insertWorksheet(db, { tenantId, orderId: order.id, technicianUserId })).rejects.toThrow()

    const got = await getWorksheetById(db, tenantId, worksheet.id)
    expect(got?.id).toBe(worksheet.id)

    // cross-tenant read returns null
    expect(await getWorksheetById(db, otherTenantId, worksheet.id)).toBeNull()

    const forOrder = await getWorksheetsForOrder(db, tenantId, order.id)
    expect(forOrder.map((w) => w.id)).toContain(worksheet.id)
  })

  it('setWorksheetStatus writes the column without validating a transition', async () => {
    const order = await insertServiceOrder(db, { tenantId, customerId })
    const worksheet = await insertWorksheet(db, { tenantId, orderId: order.id })
    await setWorksheetStatus(db, tenantId, worksheet.id, 'Rejected')

    const got = await getWorksheetById(db, tenantId, worksheet.id)
    expect(got?.status).toBe('Rejected')
  })

  it('getWorksheetsForTechnician returns only that technician\'s worksheets, tenant-scoped, excluding soft-deleted', async () => {
    const order = await insertServiceOrder(db, { tenantId, customerId })
    const [otherTech] = await db.insert(schema.users).values({ tenantId, email: 'other-tech@example.com' }).returning()

    const mine = await insertWorksheet(db, { tenantId, orderId: order.id, technicianUserId })
    const notMine = await insertWorksheet(db, { tenantId, orderId: order.id, technicianUserId: otherTech.id })

    const order2 = await insertServiceOrder(db, { tenantId, customerId })
    const deletedMine = await insertWorksheet(db, { tenantId, orderId: order2.id, technicianUserId })
    await db.update(schema.worksheets).set({ deletedAt: new Date() }).where(eq(schema.worksheets.id, deletedMine.id))

    const rows = await getWorksheetsForTechnician(db, tenantId, technicianUserId)
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(mine.id)
    expect(ids).not.toContain(notMine.id)
    expect(ids).not.toContain(deletedMine.id)

    // cross-tenant read returns none of this technician's worksheets
    expect(await getWorksheetsForTechnician(db, otherTenantId, technicianUserId)).toEqual([])
  })

  it('updateWorksheetWorkDescription writes the column, tenant-scoped', async () => {
    const order = await insertServiceOrder(db, { tenantId, customerId })
    const worksheet = await insertWorksheet(db, { tenantId, orderId: order.id })

    await updateWorksheetWorkDescription(db, tenantId, worksheet.id, 'Replaced compressor')
    const got = await getWorksheetById(db, tenantId, worksheet.id)
    expect(got?.workDescription).toBe('Replaced compressor')

    // cross-tenant write is a no-op
    await updateWorksheetWorkDescription(db, otherTenantId, worksheet.id, 'Should not apply')
    const stillMine = await getWorksheetById(db, tenantId, worksheet.id)
    expect(stillMine?.workDescription).toBe('Replaced compressor')
  })

  it('scanWorksheetsForCompanyByStatus returns only matching-status worksheets for the erp company, tenant-scoped, excluding soft-deleted', async () => {
    const order = await insertServiceOrder(db, { tenantId, customerId, erpCompanyId })
    const [scanTech] = await db.insert(schema.users).values({ tenantId, email: 'scan-status-tech@example.com' }).returning()

    const draftWs = await insertWorksheet(db, { tenantId, orderId: order.id, erpCompanyId, technicianUserId })
    const assignedWs = await insertWorksheet(db, { tenantId, orderId: order.id, erpCompanyId, technicianUserId: scanTech.id })
    await setWorksheetStatus(db, tenantId, assignedWs.id, 'Assigned')

    const order2 = await insertServiceOrder(db, { tenantId, customerId, erpCompanyId })
    const deletedDraftWs = await insertWorksheet(db, { tenantId, orderId: order2.id, erpCompanyId, technicianUserId })
    await db.update(schema.worksheets).set({ deletedAt: new Date() }).where(eq(schema.worksheets.id, deletedDraftWs.id))

    const rows = await scanWorksheetsForCompanyByStatus(db, tenantId, erpCompanyId, 'Draft')
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(draftWs.id)
    expect(ids).not.toContain(assignedWs.id)
    expect(ids).not.toContain(deletedDraftWs.id)

    // cross-tenant read returns none
    expect(await scanWorksheetsForCompanyByStatus(db, otherTenantId, erpCompanyId, 'Draft')).toEqual([])
  })
})

describe('erp-refs store', () => {
  it('round-trips two purposes (primary + worksheetShadow) for one worksheet', async () => {
    const order = await insertServiceOrder(db, { tenantId, customerId })
    const worksheet = await insertWorksheet(db, { tenantId, orderId: order.id })

    await putErpRef(db, {
      tenantId,
      entityType: 'worksheet',
      entityId: worksheet.id,
      purpose: 'primary',
      register: 'WSVc',
      recordRef: 'WS-1',
    })
    await putErpRef(db, {
      tenantId,
      entityType: 'worksheet',
      entityId: worksheet.id,
      purpose: 'worksheetShadow',
      register: 'ActVc',
      recordRef: 'ACT-1',
    })

    const refs = await getErpRefs(db, tenantId, 'worksheet', worksheet.id)
    expect(refs).toHaveLength(2)
    const byPurpose = Object.fromEntries(refs.map((r) => [r.purpose, r]))
    expect(byPurpose.primary.recordRef).toBe('WS-1')
    expect(byPurpose.worksheetShadow.recordRef).toBe('ACT-1')
  })

  it('putErpRef upserts in place on (entityType, entityId, purpose) instead of duplicating', async () => {
    const order = await insertServiceOrder(db, { tenantId, customerId })
    const worksheet = await insertWorksheet(db, { tenantId, orderId: order.id })

    await putErpRef(db, {
      tenantId,
      entityType: 'worksheet',
      entityId: worksheet.id,
      purpose: 'primary',
      register: 'WSVc',
      recordRef: 'WS-2',
    })
    await putErpRef(db, {
      tenantId,
      entityType: 'worksheet',
      entityId: worksheet.id,
      purpose: 'primary',
      register: 'WSVc',
      recordRef: 'WS-2-updated',
    })

    const refs = await getErpRefs(db, tenantId, 'worksheet', worksheet.id)
    expect(refs).toHaveLength(1)
    expect(refs[0].recordRef).toBe('WS-2-updated')
  })
})
