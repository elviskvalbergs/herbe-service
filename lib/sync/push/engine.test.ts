// lib/sync/push/engine.test.ts
//
// DB + fake-ERP integration tests for the push-queue saga engine (WS4
// outbound slice, docs/superpowers/plans/2026-07-16-service-phase1-erp-outbound.md
// decision 3), mirroring the local-Postgres + fake-ERP harness idiom from
// lib/erp/standard-books/adapter.test.ts (fresh startFakeErpServer per test,
// closed in afterEach) and lib/sync/push/store.test.ts (DB harness).
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterEach, afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFakeErpServer } from '@herbe/fake-erp'
import type { ErpAdapter } from '@herbe/erp-core'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { createStandardBooksAdapter } from '@/lib/erp/standard-books/adapter'
import { insertServiceOrder, getServiceOrderById, type InsertServiceOrderInput } from '@/lib/domain/stores/service-orders'
import { insertServiceItem } from '@/lib/domain/stores/service-items'
import {
  insertWorksheet,
  setWorksheetStatus,
  getWorksheetById,
  getWorksheetsForOrder,
} from '@/lib/domain/stores/worksheets'
import { putErpRef, getErpRefs } from '@/lib/domain/stores/erp-refs'
import { ingestWorksheets } from '@/lib/sync/ingest/worksheets'
import { createPushGroup, getStepsForGroup, markStep } from './store'
import { enqueueOrderCreatePush, approveWorksheet } from './enqueue'
import { processPushQueue } from './engine'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string
let erpCompanyId: string // no push config — for order_create-only tests
let customerId: string
let wsErpCompanyId: string // push.mainServiceLocation configured — for worksheet_push tests
let wsCustomerId: string

function adapterFor(url: string) {
  return createStandardBooksAdapter({
    baseUrl: url,
    companyNumber: '1',
    auth: { kind: 'basic', username: 'test', password: 'test' },
  })
}

// Test-only wrapper (concurrency regression below): makes pushCreate('SVOVc')
// block until `arrivals` concurrent calls have started, or `timeoutMs`
// elapses — whichever first. This forces two racing processPushQueue calls
// to genuinely overlap inside the create step, instead of leaving the
// overlap to unpredictable I/O timing (which let the old, unclaimed code
// sometimes "get lucky" and only create once). Under the single-flight fix
// only one of the two calls ever reaches pushCreate at all, so the timeout
// is what lets that lone call proceed without hanging.
function withCreateBarrier(base: ErpAdapter, arrivals: number, timeoutMs = 150): ErpAdapter {
  let count = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
    setTimeout(resolve, timeoutMs)
  })

  return {
    ...base,
    async pushCreate(register: string, payload: Record<string, unknown>) {
      if (register === 'SVOVc') {
        count++
        if (count >= arrivals) release?.()
        await gate
      }
      return base.pushCreate(register, payload)
    },
  }
}

async function makeOrder(
  companyId: string,
  custId: string,
  overrides: Partial<InsertServiceOrderInput> = {},
): Promise<string> {
  const order = await insertServiceOrder(db, { tenantId, erpCompanyId: companyId, customerId: custId, ...overrides })
  return order.id
}

async function makeTechnician(companyId: string, emCode: string): Promise<string> {
  const [user] = await db
    .insert(schema.users)
    .values({ tenantId, email: `tech-${randomUUID()}@example.com` })
    .returning()

  await db.insert(schema.identityLinks).values({
    tenantId,
    userId: user.id,
    provider: 'erp',
    erpCompanyId: companyId,
    externalId: emCode,
    linkedBy: 'test',
  })

  return user.id
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

  const [wsCompany] = await db
    .insert(schema.erpCompanies)
    .values({
      tenantId,
      displayName: 'C2 (worksheet push)',
      adapterType: 'standard_books',
      adapterConfigJson: { push: { mainServiceLocation: 'VAN-1' } },
    })
    .returning()
  wsErpCompanyId = wsCompany.id
  const [wsCustomer] = await db
    .insert(schema.customers)
    .values({ tenantId, erpCompanyId: wsErpCompanyId, erpRef: 'CUST-WS', name: 'WS Test Client', changeSeq: BigInt(0) })
    .returning()
  wsCustomerId = wsCustomer.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('processPushQueue — order_create happy path', () => {
  let server: Awaited<ReturnType<typeof startFakeErpServer>> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('creates the SVOVc, writes the primary erp_ref, sets order_number, marks the group succeeded', async () => {
    server = await startFakeErpServer({ port: 0 })
    const adapter = adapterFor(server.url)

    const orderId = await makeOrder(erpCompanyId, customerId)
    const { groupId } = await enqueueOrderCreatePush(db, { tenantId, erpCompanyId, orderId })

    const summary = await processPushQueue(db, adapter, erpCompanyId)

    expect(summary).toMatchObject({
      groupsProcessed: 1,
      groupsSucceeded: 1,
      groupsPending: 0,
      groupsDead: 0,
      stepsSucceeded: 1,
      stepsRetried: 0,
      stepsDead: 0,
    })

    const [group] = await db.select().from(schema.erpPushGroups).where(eq(schema.erpPushGroups.id, groupId))
    expect(group.status).toBe('succeeded')

    const refs = await getErpRefs(db, tenantId, 'service_order', orderId)
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ purpose: 'primary', register: 'SVOVc' })

    const order = await getServiceOrderById(db, tenantId, orderId)
    expect(order!.orderNumber).toBe(refs[0].recordRef)

    const rows = await adapter.fetchRecords('SVOVc', { 'filter.SerNr': refs[0].recordRef })
    expect(rows).toHaveLength(1)
  })
})

describe('processPushQueue — concurrent single-flight claim (final review)', () => {
  let server: Awaited<ReturnType<typeof startFakeErpServer>> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('two concurrent processPushQueue calls racing the same pending group create the SVOVc exactly once', async () => {
    server = await startFakeErpServer({ port: 0 })
    const baseAdapter = adapterFor(server.url)
    // Forces both calls to genuinely overlap inside pushCreate if they both
    // get that far (old, unclaimed code) — see withCreateBarrier comment.
    const adapter = withCreateBarrier(baseAdapter, 2)

    const orderId = await makeOrder(erpCompanyId, customerId)
    const { groupId } = await enqueueOrderCreatePush(db, { tenantId, erpCompanyId, orderId })

    const before = await baseAdapter.fetchRecords('SVOVc', {})

    // Two entry points (an outbox POST's inline drain and the push-tick
    // cron, or two concurrent outbox POSTs) can both call processPushQueue
    // for the same erpCompanyId at once. Without a single-flight claim on
    // the group, both would find no erp_ref yet and both POST a create —
    // this must never double-create the ERP record.
    const [summaryA, summaryB] = await Promise.all([
      processPushQueue(db, adapter, erpCompanyId),
      processPushQueue(db, adapter, erpCompanyId),
    ])

    const after = await baseAdapter.fetchRecords('SVOVc', {})
    expect(after).toHaveLength(before.length + 1) // exactly one SVOVc created, not two

    const refs = await getErpRefs(db, tenantId, 'service_order', orderId)
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ purpose: 'primary', register: 'SVOVc' })

    const [group] = await db.select().from(schema.erpPushGroups).where(eq(schema.erpPushGroups.id, groupId))
    expect(group.status).toBe('succeeded')

    // Exactly one of the two racing calls actually claimed and ran the
    // group; the other's claim failed and it skipped the group silently.
    expect(summaryA.groupsProcessed + summaryB.groupsProcessed).toBe(1)
  })
})

describe('processPushQueue — worksheet_push full group', () => {
  let server: Awaited<ReturnType<typeof startFakeErpServer>> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('runs the order step then the worksheet step, writes both erp_refs, sets order_number, flips the worksheet to Synced, and WSVc.SVONr matches the SVOVc SerNr', async () => {
    server = await startFakeErpServer({ port: 0 })
    const adapter = adapterFor(server.url)

    const orderId = await makeOrder(wsErpCompanyId, wsCustomerId)
    const technicianUserId = await makeTechnician(wsErpCompanyId, 'TECH1')
    const worksheet = await insertWorksheet(db, { tenantId, erpCompanyId: wsErpCompanyId, orderId, technicianUserId })
    await setWorksheetStatus(db, tenantId, worksheet.id, 'Done')

    await approveWorksheet(db, { tenantId, erpCompanyId: wsErpCompanyId, worksheetId: worksheet.id })

    const summary = await processPushQueue(db, adapter, wsErpCompanyId)
    expect(summary).toMatchObject({
      groupsProcessed: 1,
      groupsSucceeded: 1,
      stepsSucceeded: 2,
      stepsRetried: 0,
      stepsDead: 0,
    })

    const orderRefs = await getErpRefs(db, tenantId, 'service_order', orderId)
    expect(orderRefs).toHaveLength(1)
    const wsRefs = await getErpRefs(db, tenantId, 'worksheet', worksheet.id)
    expect(wsRefs).toHaveLength(1)

    const order = await getServiceOrderById(db, tenantId, orderId)
    expect(order!.orderNumber).toBe(orderRefs[0].recordRef)

    const after = await getWorksheetById(db, tenantId, worksheet.id)
    expect(after!.status).toBe('Synced')

    const svoRows = await adapter.fetchRecords('SVOVc', { 'filter.SerNr': orderRefs[0].recordRef })
    const wsRows = await adapter.fetchRecords('WSVc', { 'filter.SerNr': wsRefs[0].recordRef })
    expect(svoRows).toHaveLength(1)
    expect(wsRows).toHaveLength(1)
    expect(String(wsRows[0].SVONr)).toBe(String(svoRows[0].SerNr))

    // Idempotent re-run: the group is already 'succeeded' (a terminal state
    // getRunnableGroups excludes), so nothing executes and no duplicate is
    // created — this is the "resume-from-failed never re-posts" property in
    // its simplest honest form (task-5 brief).
    const rerun = await processPushQueue(db, adapter, wsErpCompanyId)
    expect(rerun.groupsProcessed).toBe(0)

    const svoAll = await adapter.fetchRecords('SVOVc', {})
    const wsAll = await adapter.fetchRecords('WSVc', {})
    expect(svoAll).toHaveLength(5) // 4 fixture rows + 1 created
    expect(wsAll).toHaveLength(4) // 3 fixture rows + 1 created

    // Decision 12: a subsequent ingest of the pushed WSVc matches the SAME
    // worksheet via its erp_ref — no duplicate row — and applies the
    // flag-derived status.
    const ingestResult = await ingestWorksheets(db, wsErpCompanyId, {
      upserts: [
        {
          SerNr: Number(wsRefs[0].recordRef),
          SVONr: Number(orderRefs[0].recordRef),
          EMCode: 'TECH1',
          OKFlag: '1',
          PrelOK: '1',
          Invalid: '0',
          Comment1: 'Re-ingested after push',
        },
      ],
      deletedRefs: [],
      cursor: '0',
    })
    expect(ingestResult).toEqual({ ingested: 1, skipped: 0 })

    const worksheetsForOrder = await getWorksheetsForOrder(db, tenantId, orderId)
    expect(worksheetsForOrder).toHaveLength(1)
    expect(worksheetsForOrder[0].id).toBe(worksheet.id)
    expect(worksheetsForOrder[0].status).toBe('Synced')
  })
})

describe('processPushQueue — noop-create (number-series trap)', () => {
  let server: Awaited<ReturnType<typeof startFakeErpServer>> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('dead-letters the step with an actionable number-series message, dead-letters the group, and blocks the lane', async () => {
    server = await startFakeErpServer({ port: 0, mode: 'noop-create' })
    const adapter = adapterFor(server.url)

    const orderId = await makeOrder(erpCompanyId, customerId)
    const { groupId } = await enqueueOrderCreatePush(db, { tenantId, erpCompanyId, orderId })

    const summary = await processPushQueue(db, adapter, erpCompanyId)
    expect(summary).toMatchObject({ groupsProcessed: 1, groupsDead: 1, stepsDead: 1 })

    const [step] = await getStepsForGroup(db, groupId)
    expect(step.status).toBe('dead')
    expect(step.errorMessage).toMatch(/number series|number-series/i)
    expect(step.errorMessage).toMatch(/SVOVc/)

    const [group] = await db.select().from(schema.erpPushGroups).where(eq(schema.erpPushGroups.id, groupId))
    expect(group.status).toBe('dead')

    // A second group enqueued on the same lane is never even attempted.
    const second = await enqueueOrderCreatePush(db, { tenantId, erpCompanyId, orderId })
    const rerun = await processPushQueue(db, adapter, erpCompanyId)
    expect(rerun.groupsProcessed).toBe(0)

    const [secondStep] = await getStepsForGroup(db, second.groupId)
    expect(secondStep.status).toBe('pending')
  })

  it('also dead-letters a WSVc create with the number-series message', async () => {
    server = await startFakeErpServer({ port: 0, mode: 'noop-create' })
    const adapter = adapterFor(server.url)

    const orderId = await makeOrder(wsErpCompanyId, wsCustomerId)
    // '5002' is a live SVOVc fixture row with DoneMark "0" (GET is
    // mode-independent), so the gather step's order-ref/liveSvo/DoneMark
    // preconditions all pass and the group actually reaches the WSVc
    // pushCreate call under noop-create mode.
    await putErpRef(db, {
      tenantId,
      entityType: 'service_order',
      entityId: orderId,
      purpose: 'primary',
      register: 'SVOVc',
      recordRef: '5002',
      erpCompanyId: wsErpCompanyId,
    })
    const technicianUserId = await makeTechnician(wsErpCompanyId, 'TECH-NOOP')
    const worksheet = await insertWorksheet(db, { tenantId, erpCompanyId: wsErpCompanyId, orderId, technicianUserId })
    await setWorksheetStatus(db, tenantId, worksheet.id, 'Approved')

    const { groupId } = await createPushGroup(db, {
      tenantId,
      erpCompanyId: wsErpCompanyId,
      lane: `order:${orderId}`,
      kind: 'worksheet_push',
      steps: [{ seq: 1, entityType: 'worksheet', entityId: worksheet.id, register: 'WSVc', op: 'create' }],
    })

    const summary = await processPushQueue(db, adapter, wsErpCompanyId)
    expect(summary).toMatchObject({ groupsDead: 1, stepsDead: 1 })

    const [step] = await getStepsForGroup(db, groupId)
    expect(step.errorMessage).toMatch(/number series|number-series/i)
    expect(step.errorMessage).toMatch(/WSVc/)
  })
})

describe('processPushQueue — serviceOrder stored-ref adoption at execution time', () => {
  let server: Awaited<ReturnType<typeof startFakeErpServer>> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('a step whose order already has a primary erp_ref succeeds by adoption without calling the ERP, and keeps order_number in sync', async () => {
    server = await startFakeErpServer({ port: 0 })
    const adapter = adapterFor(server.url)

    const orderId = await makeOrder(erpCompanyId, customerId)
    await putErpRef(db, {
      tenantId,
      entityType: 'service_order',
      entityId: orderId,
      purpose: 'primary',
      register: 'SVOVc',
      recordRef: '5001',
      erpCompanyId,
    })

    const { groupId } = await enqueueOrderCreatePush(db, { tenantId, erpCompanyId, orderId })

    const svoBefore = await adapter.fetchRecords('SVOVc', {})
    const summary = await processPushQueue(db, adapter, erpCompanyId)
    const svoAfter = await adapter.fetchRecords('SVOVc', {})

    expect(summary).toMatchObject({ groupsSucceeded: 1, stepsSucceeded: 1 })
    expect(svoAfter).toHaveLength(svoBefore.length) // adoption only — no create call

    const [step] = await getStepsForGroup(db, groupId)
    expect(step.erpRef).toBe('5001')

    const order = await getServiceOrderById(db, tenantId, orderId)
    expect(order!.orderNumber).toBe('5001')
  })
})

describe('processPushQueue — transient failure then retry', () => {
  let badServer: Awaited<ReturnType<typeof startFakeErpServer>> | undefined
  let goodServer: Awaited<ReturnType<typeof startFakeErpServer>> | undefined
  afterEach(async () => {
    await badServer?.close()
    await goodServer?.close()
    badServer = undefined
    goodServer = undefined
  })

  it('fails with a 2^attempts-minute backoff on a 500, stays gated until then, and succeeds once retried against a working server', async () => {
    badServer = await startFakeErpServer({ port: 0, mode: 'http-500' })
    const badAdapter = adapterFor(badServer.url)

    const orderId = await makeOrder(erpCompanyId, customerId)
    const { groupId } = await enqueueOrderCreatePush(db, { tenantId, erpCompanyId, orderId })

    const t0 = new Date('2026-07-16T12:00:00Z')
    const summary1 = await processPushQueue(db, badAdapter, erpCompanyId, { now: t0 })
    expect(summary1).toMatchObject({ groupsProcessed: 1, groupsPending: 1, stepsRetried: 1 })

    const [step] = await getStepsForGroup(db, groupId)
    expect(step.status).toBe('failed')
    expect(step.attempts).toBe(1)
    expect(step.nextAttemptAt!.getTime()).toBe(t0.getTime() + 2 * 60_000)

    const [group] = await db.select().from(schema.erpPushGroups).where(eq(schema.erpPushGroups.id, groupId))
    expect(group.status).toBe('pending')

    // Still gated before nextAttemptAt — the lane yields nothing this tick.
    const gated = await processPushQueue(db, badAdapter, erpCompanyId, { now: new Date(t0.getTime() + 30_000) })
    expect(gated.groupsProcessed).toBe(0)

    goodServer = await startFakeErpServer({ port: 0 })
    const goodAdapter = adapterFor(goodServer.url)

    const summary2 = await processPushQueue(db, goodAdapter, erpCompanyId, {
      now: new Date(step.nextAttemptAt!.getTime() + 1000),
    })
    expect(summary2).toMatchObject({ groupsProcessed: 1, groupsSucceeded: 1, stepsSucceeded: 1 })

    const refs = await getErpRefs(db, tenantId, 'service_order', orderId)
    expect(refs).toHaveLength(1)
  })

  it('dead-letters the step after 5 failed attempts (max retries exhausted)', async () => {
    badServer = await startFakeErpServer({ port: 0, mode: 'http-500' })
    const adapter = adapterFor(badServer.url)

    const orderId = await makeOrder(erpCompanyId, customerId)
    const { groupId } = await enqueueOrderCreatePush(db, { tenantId, erpCompanyId, orderId })

    let now = new Date('2026-07-16T00:00:00Z')
    for (let i = 0; i < 4; i++) {
      const summary = await processPushQueue(db, adapter, erpCompanyId, { now })
      expect(summary.stepsRetried).toBe(1)
      const [step] = await getStepsForGroup(db, groupId)
      expect(step.status).toBe('failed')
      now = new Date(step.nextAttemptAt!.getTime() + 1000)
    }

    const summary5 = await processPushQueue(db, adapter, erpCompanyId, { now })
    expect(summary5).toMatchObject({ groupsDead: 1, stepsDead: 1 })

    const [step] = await getStepsForGroup(db, groupId)
    expect(step.status).toBe('dead')
    expect(step.attempts).toBe(5)

    const [group] = await db.select().from(schema.erpPushGroups).where(eq(schema.erpPushGroups.id, groupId))
    expect(group.status).toBe('dead')
  })
})

describe('processPushQueue — resume-from-failed never re-posts a succeeded step', () => {
  let server: Awaited<ReturnType<typeof startFakeErpServer>> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('a group whose order step is already marked succeeded only executes the pending worksheet step', async () => {
    server = await startFakeErpServer({ port: 0 })
    const adapter = adapterFor(server.url)

    const orderId = await makeOrder(wsErpCompanyId, wsCustomerId)
    const technicianUserId = await makeTechnician(wsErpCompanyId, 'TECH2')
    const worksheet = await insertWorksheet(db, { tenantId, erpCompanyId: wsErpCompanyId, orderId, technicianUserId })
    await setWorksheetStatus(db, tenantId, worksheet.id, 'Done')
    await setWorksheetStatus(db, tenantId, worksheet.id, 'Approved')

    // Simulate a prior successful order-create step directly against the
    // fake ERP (bypassing the saga), then record it the way the engine
    // would have.
    const { erpRef: preErpRef } = await adapter.pushCreate('SVOVc', { CustCode: 'CUST-WS', TransDate: '2026-07-01' })
    await putErpRef(db, {
      tenantId,
      entityType: 'service_order',
      entityId: orderId,
      purpose: 'primary',
      register: 'SVOVc',
      recordRef: preErpRef,
      erpCompanyId: wsErpCompanyId,
    })

    const { groupId } = await createPushGroup(db, {
      tenantId,
      erpCompanyId: wsErpCompanyId,
      lane: `order:${orderId}`,
      kind: 'worksheet_push',
      steps: [
        { seq: 1, entityType: 'serviceOrder', entityId: orderId, register: 'SVOVc', op: 'create' },
        { seq: 2, entityType: 'worksheet', entityId: worksheet.id, register: 'WSVc', op: 'create' },
      ],
    })
    const [orderStep] = await getStepsForGroup(db, groupId)
    await markStep(db, orderStep.id, { status: 'succeeded', erpRef: preErpRef })

    const svoBefore = await adapter.fetchRecords('SVOVc', {})

    const summary = await processPushQueue(db, adapter, wsErpCompanyId)

    expect(summary).toMatchObject({ groupsProcessed: 1, groupsSucceeded: 1, stepsSucceeded: 1 })

    const svoAfter = await adapter.fetchRecords('SVOVc', {})
    expect(svoAfter).toHaveLength(svoBefore.length) // no new SVOVc created — the order step never re-ran

    const wsRefs = await getErpRefs(db, tenantId, 'worksheet', worksheet.id)
    expect(wsRefs).toHaveLength(1)
  })
})

describe('processPushQueue — natural-key adoption', () => {
  let server: Awaited<ReturnType<typeof startFakeErpServer>> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('SVOVc: adopts a pre-existing record matching CustCode+TransDate+serial set instead of creating a duplicate', async () => {
    server = await startFakeErpServer({ port: 0 })
    const adapter = adapterFor(server.url)

    const item = await insertServiceItem(db, {
      tenantId,
      erpCompanyId,
      kind: 'unit',
      name: 'NK Unit',
      labelId: `lbl-${randomUUID()}`,
      serialNr: 'NK-SN-1',
    })
    const orderId = await makeOrder(erpCompanyId, customerId, { requestedAt: new Date('2026-07-01T10:00:00Z') })
    await db.insert(schema.serviceOrderRows).values({ orderId, serviceItemId: item.id, chargeType: 'invoiceable' })

    // Pre-create a matching SVOVc directly against the fake ERP.
    const preCreated = await adapter.pushCreate('SVOVc', {
      CustCode: 'CUST001',
      TransDate: '2026-07-01',
      rows: [{ SerialNr: 'NK-SN-1', ItemType: 1 }],
    })
    const before = await adapter.fetchRecords('SVOVc', {})

    const { groupId } = await enqueueOrderCreatePush(db, { tenantId, erpCompanyId, orderId })
    const summary = await processPushQueue(db, adapter, erpCompanyId)

    expect(summary).toMatchObject({ groupsSucceeded: 1, stepsSucceeded: 1 })

    const after = await adapter.fetchRecords('SVOVc', {})
    expect(after).toHaveLength(before.length) // adopted, not duplicated

    const refs = await getErpRefs(db, tenantId, 'service_order', orderId)
    expect(refs).toHaveLength(1)
    expect(refs[0].recordRef).toBe(preCreated.erpRef) // adopted the pre-created record's SerNr

    const [step] = await getStepsForGroup(db, groupId)
    expect(step.status).toBe('succeeded')
  })

  it('WSVc: adopts a pre-existing record matching SVONr+EMCode instead of creating a duplicate', async () => {
    server = await startFakeErpServer({ port: 0 })
    const adapter = adapterFor(server.url)

    const orderId = await makeOrder(wsErpCompanyId, wsCustomerId)
    const technicianUserId = await makeTechnician(wsErpCompanyId, 'TECH3')
    const worksheet = await insertWorksheet(db, { tenantId, erpCompanyId: wsErpCompanyId, orderId, technicianUserId })
    await setWorksheetStatus(db, tenantId, worksheet.id, 'Approved')

    const { erpRef: orderErpRef } = await adapter.pushCreate('SVOVc', { CustCode: 'CUST-WS', TransDate: '2026-07-01' })
    await putErpRef(db, {
      tenantId,
      entityType: 'service_order',
      entityId: orderId,
      purpose: 'primary',
      register: 'SVOVc',
      recordRef: orderErpRef,
      erpCompanyId: wsErpCompanyId,
    })

    // Pre-create a matching WSVc directly against the fake ERP.
    await adapter.pushCreate('WSVc', { SVONr: orderErpRef, EMCode: 'TECH3' })
    const before = await adapter.fetchRecords('WSVc', {})

    await createPushGroup(db, {
      tenantId,
      erpCompanyId: wsErpCompanyId,
      lane: `order:${orderId}`,
      kind: 'worksheet_push',
      steps: [{ seq: 1, entityType: 'worksheet', entityId: worksheet.id, register: 'WSVc', op: 'create' }],
    })

    const summary = await processPushQueue(db, adapter, wsErpCompanyId)
    expect(summary).toMatchObject({ groupsSucceeded: 1, stepsSucceeded: 1 })

    const after = await adapter.fetchRecords('WSVc', {})
    expect(after).toHaveLength(before.length) // adopted, not duplicated

    const wsRefs = await getErpRefs(db, tenantId, 'worksheet', worksheet.id)
    expect(wsRefs).toHaveLength(1)

    const afterWorksheet = await getWorksheetById(db, tenantId, worksheet.id)
    expect(afterWorksheet!.status).toBe('Synced')
  })
})

describe('processPushQueue — empty-serial natural-key guard', () => {
  let server: Awaited<ReturnType<typeof startFakeErpServer>> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('two same-customer, same-day orders with only non-serialized rows both create distinct SVOVc records (no false adoption)', async () => {
    server = await startFakeErpServer({ port: 0 })
    const adapter = adapterFor(server.url)

    const item = await insertServiceItem(db, {
      tenantId,
      erpCompanyId,
      kind: 'unit',
      name: 'Non-serialized part',
      labelId: `lbl-${randomUUID()}`,
      attributes: { itemCode: 'PART-X' }, // lowercase — matches ingestServiceItems' actual attribute key
      // no serialNr — this order's row has an itemCode but no serial.
    })

    const sameDay = new Date('2026-07-02T10:00:00Z')
    const orderAId = await makeOrder(erpCompanyId, customerId, { requestedAt: sameDay })
    await db.insert(schema.serviceOrderRows).values({ orderId: orderAId, serviceItemId: item.id, chargeType: 'invoiceable' })
    const orderBId = await makeOrder(erpCompanyId, customerId, { requestedAt: sameDay })
    await db.insert(schema.serviceOrderRows).values({ orderId: orderBId, serviceItemId: item.id, chargeType: 'invoiceable' })

    await enqueueOrderCreatePush(db, { tenantId, erpCompanyId, orderId: orderAId })
    await enqueueOrderCreatePush(db, { tenantId, erpCompanyId, orderId: orderBId })

    const summary = await processPushQueue(db, adapter, erpCompanyId)
    expect(summary).toMatchObject({ groupsProcessed: 2, groupsSucceeded: 2, stepsSucceeded: 2 })

    const refsA = await getErpRefs(db, tenantId, 'service_order', orderAId)
    const refsB = await getErpRefs(db, tenantId, 'service_order', orderBId)
    expect(refsA).toHaveLength(1)
    expect(refsB).toHaveLength(1)
    expect(refsA[0].recordRef).not.toBe(refsB[0].recordRef) // two distinct SVOVc records, not a false adoption

    const orderA = await getServiceOrderById(db, tenantId, orderAId)
    const orderB = await getServiceOrderById(db, tenantId, orderBId)
    expect(orderA!.orderNumber).toBe(refsA[0].recordRef)
    expect(orderB!.orderNumber).toBe(refsB[0].recordRef)
  })
})

describe('processPushQueue — worksheet stored-ref adoption', () => {
  let server: Awaited<ReturnType<typeof startFakeErpServer>> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('a worksheet with an existing primary WSVc erp_ref succeeds by adoption (no ERP write) and flips Approved -> Synced', async () => {
    server = await startFakeErpServer({ port: 0 })
    const adapter = adapterFor(server.url)

    const orderId = await makeOrder(wsErpCompanyId, wsCustomerId)
    const worksheet = await insertWorksheet(db, { tenantId, erpCompanyId: wsErpCompanyId, orderId })
    await setWorksheetStatus(db, tenantId, worksheet.id, 'Approved')
    await putErpRef(db, {
      tenantId,
      entityType: 'worksheet',
      entityId: worksheet.id,
      purpose: 'primary',
      register: 'WSVc',
      recordRef: '9999',
      erpCompanyId: wsErpCompanyId,
    })

    await createPushGroup(db, {
      tenantId,
      erpCompanyId: wsErpCompanyId,
      lane: `order:${orderId}`,
      kind: 'worksheet_push',
      steps: [{ seq: 1, entityType: 'worksheet', entityId: worksheet.id, register: 'WSVc', op: 'create' }],
    })

    const wsBefore = await adapter.fetchRecords('WSVc', {})
    const summary = await processPushQueue(db, adapter, wsErpCompanyId)
    const wsAfter = await adapter.fetchRecords('WSVc', {})

    expect(summary).toMatchObject({ groupsSucceeded: 1, stepsSucceeded: 1 })
    expect(wsAfter).toHaveLength(wsBefore.length) // adoption only — no ERP write happened

    const after = await getWorksheetById(db, tenantId, worksheet.id)
    expect(after!.status).toBe('Synced')
  })
})

describe('processPushQueue — update op (dispatch skeleton only)', () => {
  let server: Awaited<ReturnType<typeof startFakeErpServer>> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('dead-letters an update-op step immediately with "not yet supported"', async () => {
    server = await startFakeErpServer({ port: 0 })
    const adapter = adapterFor(server.url)

    const orderId = await makeOrder(erpCompanyId, customerId)
    const { groupId } = await createPushGroup(db, {
      tenantId,
      erpCompanyId,
      lane: `order:${orderId}`,
      kind: 'order_create',
      steps: [{ seq: 1, entityType: 'serviceOrder', entityId: orderId, register: 'SVOVc', op: 'update' }],
    })

    const summary = await processPushQueue(db, adapter, erpCompanyId)
    expect(summary).toMatchObject({ groupsDead: 1, stepsDead: 1 })

    const [step] = await getStepsForGroup(db, groupId)
    expect(step.status).toBe('dead')
    expect(step.errorMessage).toMatch(/not yet supported/)
  })
})

describe('processPushQueue — unrecognized step shape', () => {
  let server: Awaited<ReturnType<typeof startFakeErpServer>> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('dead-letters a step with an unrecognized entityType', async () => {
    server = await startFakeErpServer({ port: 0 })
    const adapter = adapterFor(server.url)

    const orderId = await makeOrder(erpCompanyId, customerId)
    const { groupId } = await createPushGroup(db, {
      tenantId,
      erpCompanyId,
      lane: `order:${orderId}`,
      kind: 'order_create',
      steps: [{ seq: 1, entityType: 'bogus', entityId: orderId, register: 'SVOVc', op: 'create' }],
    })

    const summary = await processPushQueue(db, adapter, erpCompanyId)
    expect(summary).toMatchObject({ groupsDead: 1, stepsDead: 1 })

    const [step] = await getStepsForGroup(db, groupId)
    expect(step.errorMessage).toMatch(/unknown push step entityType/)
  })
})
