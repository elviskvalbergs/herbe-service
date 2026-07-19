// lib/sync/push/enqueue.test.ts
//
// DB-backed tests for the push-queue enqueue entry points (WS4 outbound
// slice, docs/superpowers/plans/2026-07-16-service-phase1-erp-outbound.md
// decision 4), mirroring the local-Postgres harness idiom from
// lib/sync/push/store.test.ts. No ERP/adapter here — that's the engine's
// job (engine.test.ts); this file only proves what gets enqueued and the
// approval guards.
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { insertServiceOrder } from '@/lib/domain/stores/service-orders'
import { insertWorksheet, setWorksheetStatus, getWorksheetById } from '@/lib/domain/stores/worksheets'
import { putErpRef } from '@/lib/domain/stores/erp-refs'
import { DomainTransitionError } from '@/lib/domain/worksheet-status'
import { getStepsForGroup } from './store'
import { enqueueOrderCreatePush, approveWorksheet } from './enqueue'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string
let erpCompanyId: string
let customerId: string

async function makeOrder() {
  const order = await insertServiceOrder(db, { tenantId, erpCompanyId, customerId })
  return order.id
}

async function makeTechnician(withIdentityLink: boolean) {
  const [user] = await db
    .insert(schema.users)
    .values({ tenantId, email: `tech-${Math.random()}@example.com` })
    .returning()

  if (withIdentityLink) {
    await db.insert(schema.identityLinks).values({
      tenantId,
      userId: user.id,
      provider: 'erp',
      erpCompanyId,
      externalId: 'TECH1',
      linkedBy: 'test',
    })
  }

  return user.id
}

async function makeDoneWorksheet(orderId: string, technicianUserId?: string) {
  const worksheet = await insertWorksheet(db, { tenantId, erpCompanyId, orderId, technicianUserId })
  await setWorksheetStatus(db, tenantId, worksheet.id, 'Done')
  return worksheet.id
}

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 't1', name: 'T1' }).returning()
  tenantId = tenant.id
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName: 'C1', adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  erpCompanyId = company.id
  const [customer] = await db
    .insert(schema.customers)
    .values({ tenantId, erpCompanyId, erpRef: 'CUST001', name: 'Test Client', changeSeq: BigInt(0) })
    .returning()
  customerId = customer.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('enqueueOrderCreatePush', () => {
  it('creates an order_create group on lane order:<orderId> with one serviceOrder/SVOVc/create step', async () => {
    const orderId = await makeOrder()

    const { groupId } = await enqueueOrderCreatePush(db, { tenantId, erpCompanyId, orderId })

    const [group] = await db.select().from(schema.erpPushGroups).where(eq(schema.erpPushGroups.id, groupId))
    expect(group).toMatchObject({ tenantId, erpCompanyId, lane: `order:${orderId}`, kind: 'order_create', status: 'pending' })

    const steps = await getStepsForGroup(db, groupId)
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({
      seq: 1,
      entityType: 'serviceOrder',
      entityId: orderId,
      register: 'SVOVc',
      op: 'create',
      status: 'pending',
    })
  })
})

describe('approveWorksheet', () => {
  it('blocks approval and creates no group when the worksheet has no technician assigned at all', async () => {
    const orderId = await makeOrder()
    const worksheetId = await makeDoneWorksheet(orderId, undefined)

    await expect(approveWorksheet(db, { tenantId, erpCompanyId, worksheetId })).rejects.toThrow(/technician/i)

    const worksheet = await getWorksheetById(db, tenantId, worksheetId)
    expect(worksheet!.status).toBe('Done')

    const groups = await db.select().from(schema.erpPushGroups).where(eq(schema.erpPushGroups.lane, `order:${orderId}`))
    expect(groups).toHaveLength(0)
  })

  it('blocks approval and creates no group when the technician has no identity_links (erp) entry', async () => {
    const orderId = await makeOrder()
    const technicianUserId = await makeTechnician(false)
    const worksheetId = await makeDoneWorksheet(orderId, technicianUserId)

    await expect(approveWorksheet(db, { tenantId, erpCompanyId, worksheetId })).rejects.toThrow(/identity_links/)

    const worksheet = await getWorksheetById(db, tenantId, worksheetId)
    expect(worksheet!.status).toBe('Done')

    const groups = await db.select().from(schema.erpPushGroups).where(eq(schema.erpPushGroups.lane, `order:${orderId}`))
    expect(groups).toHaveLength(0)
  })

  it('rejects approval from a non-Done status (e.g. Draft) with DomainTransitionError, no group created', async () => {
    const orderId = await makeOrder()
    const technicianUserId = await makeTechnician(true)
    const worksheet = await insertWorksheet(db, { tenantId, erpCompanyId, orderId, technicianUserId })
    // status defaults to 'Draft'

    await expect(approveWorksheet(db, { tenantId, erpCompanyId, worksheetId: worksheet.id })).rejects.toThrow(
      DomainTransitionError,
    )

    const after = await getWorksheetById(db, tenantId, worksheet.id)
    expect(after!.status).toBe('Draft')

    const groups = await db.select().from(schema.erpPushGroups).where(eq(schema.erpPushGroups.lane, `order:${orderId}`))
    expect(groups).toHaveLength(0)
  })

  it('sets status Approved and enqueues order-create + worksheet-create steps when the order has no primary erp_ref yet', async () => {
    const orderId = await makeOrder()
    const technicianUserId = await makeTechnician(true)
    const worksheetId = await makeDoneWorksheet(orderId, technicianUserId)

    const { groupId } = await approveWorksheet(db, { tenantId, erpCompanyId, worksheetId })

    const worksheet = await getWorksheetById(db, tenantId, worksheetId)
    expect(worksheet!.status).toBe('Approved')

    const [group] = await db.select().from(schema.erpPushGroups).where(eq(schema.erpPushGroups.id, groupId))
    expect(group).toMatchObject({ lane: `order:${orderId}`, kind: 'worksheet_push' })

    const steps = await getStepsForGroup(db, groupId)
    expect(steps).toHaveLength(2)
    expect(steps[0]).toMatchObject({ seq: 1, entityType: 'serviceOrder', entityId: orderId, register: 'SVOVc', op: 'create' })
    expect(steps[1]).toMatchObject({ seq: 2, entityType: 'worksheet', entityId: worksheetId, register: 'WSVc', op: 'create' })
  })

  it('omits the order-create step when the order already has a primary SVOVc erp_ref', async () => {
    const orderId = await makeOrder()
    await putErpRef(db, {
      tenantId,
      entityType: 'service_order',
      entityId: orderId,
      purpose: 'primary',
      register: 'SVOVc',
      recordRef: '5001',
      erpCompanyId,
    })
    const technicianUserId = await makeTechnician(true)
    const worksheetId = await makeDoneWorksheet(orderId, technicianUserId)

    const { groupId } = await approveWorksheet(db, { tenantId, erpCompanyId, worksheetId })

    const steps = await getStepsForGroup(db, groupId)
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ seq: 1, entityType: 'worksheet', entityId: worksheetId, register: 'WSVc', op: 'create' })
  })

  it('throws for an unknown worksheetId', async () => {
    await expect(
      approveWorksheet(db, { tenantId, erpCompanyId, worksheetId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toThrow(/not found/)
  })

  it('leaves the worksheet status unchanged when createPushGroup fails inside the same transaction', async () => {
    const orderId = await makeOrder()
    const technicianUserId = await makeTechnician(true)
    const worksheetId = await makeDoneWorksheet(orderId, technicianUserId)

    // An erpCompanyId that doesn't exist trips the erp_push_groups.erp_company_id
    // foreign key inside createPushGroup's insert — a genuine DB failure, not a
    // mock. Before the fix (setWorksheetStatus and createPushGroup as separate
    // writes), this would leave the worksheet stranded at Approved with no
    // group. With both in one db.transaction, the whole thing rolls back.
    const bogusErpCompanyId = '00000000-0000-0000-0000-000000000000'

    await expect(
      approveWorksheet(db, { tenantId, erpCompanyId: bogusErpCompanyId, worksheetId }),
    ).rejects.toThrow()

    const worksheet = await getWorksheetById(db, tenantId, worksheetId)
    expect(worksheet!.status).toBe('Done')

    const groups = await db.select().from(schema.erpPushGroups).where(eq(schema.erpPushGroups.lane, `order:${orderId}`))
    expect(groups).toHaveLength(0)
  })
})
