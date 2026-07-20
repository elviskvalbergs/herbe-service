// lib/documents/context.test.ts
//
// WS12 Task 3: merge-context builder for docType 'order_report'
// (docs/superpowers/plans/2026-07-20-service-phase1-ws12-documents.md
// decision 5, docs/12-documents-templates.md §Merge context). Uses the
// local-Postgres test harness (lib/test-support/db.ts), mirroring
// lib/domain/stores/erp-refs.test.ts. Worksheet ids are supplied explicitly
// so the deterministic by-worksheet-id section ordering is assertable.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { buildOrderReportContext, OrderNotFoundError } from './context'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

let tenantId: string
let otherTenantId: string
let erpCompanyId: string
let customerId: string
let tech1Id: string
let tech2Id: string
let tech3Id: string
let unitItemId: string

const TECH_1_EMAIL = 'tech1@example.test'
const TECH_2_EMAIL = 'tech2@example.test'
const TECH_3_EMAIL = 'tech3@example.test'

// Explicit worksheet ids: lexicographic order is the deterministic section
// order the builder promises (worksheets have no created_at column).
const WS_CREW_A = '00000000-0000-4000-8000-00000000aaa1'
const WS_CREW_B = '00000000-0000-4000-8000-00000000aaa2'
const WS_SOLO_C = '00000000-0000-4000-8000-00000000aaa3'

async function insertOrder(values: Partial<typeof schema.serviceOrders.$inferInsert> = {}) {
  const [order] = await db
    .insert(schema.serviceOrders)
    .values({ tenantId, customerId, changeSeq: BigInt(0), ...values })
    .returning()
  return order
}

async function insertWorksheet(
  orderId: string,
  values: Partial<typeof schema.worksheets.$inferInsert> = {},
) {
  const [ws] = await db
    .insert(schema.worksheets)
    .values({ tenantId, orderId, changeSeq: BigInt(0), ...values })
    .returning()
  return ws
}

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 't1', name: 'T1' }).returning()
  tenantId = tenant.id
  const [otherTenant] = await db
    .insert(schema.tenants)
    .values({ slug: 't2', name: 'T2' })
    .returning()
  otherTenantId = otherTenant.id

  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName: 'C1', adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  erpCompanyId = company.id

  const [customer] = await db
    .insert(schema.customers)
    .values({ tenantId, erpCompanyId, erpRef: 'CUST-1', name: 'Acme OÜ', changeSeq: BigInt(0) })
    .returning()
  customerId = customer.id

  const [tech1] = await db
    .insert(schema.users)
    .values({ tenantId, email: TECH_1_EMAIL })
    .returning()
  tech1Id = tech1.id
  const [tech2] = await db
    .insert(schema.users)
    .values({ tenantId, email: TECH_2_EMAIL })
    .returning()
  tech2Id = tech2.id
  const [tech3] = await db
    .insert(schema.users)
    .values({ tenantId, email: TECH_3_EMAIL })
    .returning()
  tech3Id = tech3.id

  const [unit] = await db
    .insert(schema.serviceItems)
    .values({
      tenantId,
      kind: 'unit',
      name: 'AHU-01',
      serialNr: 'SN-123',
      labelId: 'LBL-1',
      changeSeq: BigInt(0),
    })
    .returning()
  unitItemId = unit.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('buildOrderReportContext — solo order', () => {
  it('projects order, customer, service items, one section with rows/time/distance, and totals', async () => {
    const order = await insertOrder({
      orderNumber: 'SVO-1001',
      status: 'Work done',
      description: 'Annual maintenance',
      priority: 'high',
      siteName: 'Building A',
      contactName: 'Jane Contact',
      requestedAt: new Date('2026-07-01T08:00:00Z'),
      promisedDate: new Date('2026-07-10T00:00:00Z'),
      defaultChargeType: 'contract',
    })
    // Explicit ids: service_order_rows has no seq column either, so the
    // builder's deterministic order is by row id.
    await db.insert(schema.serviceOrderRows).values([
      {
        id: '00000000-0000-4000-8000-00000000ddd1',
        orderId: order.id,
        serviceItemId: unitItemId,
        symptom: 'Rattling noise',
        workType: 'maintenance',
        chargeType: 'warranty',
      },
      // chargeType null on the row → falls back to the order's default.
      { id: '00000000-0000-4000-8000-00000000ddd2', orderId: order.id, serviceItemId: unitItemId },
    ])

    const ws = await insertWorksheet(order.id, {
      technicianUserId: tech1Id,
      status: 'Approved',
      workDescription: 'Replaced filter',
      fault: 'Clogged filter',
      cause: 'Overdue service',
      remedy: 'New filter installed',
      signedOnSite: true,
    })
    // Explicit ids: worksheet_rows has no seq column, so the builder's
    // deterministic row order is by row id.
    await db.insert(schema.worksheetRows).values([
      {
        id: '00000000-0000-4000-8000-00000000bbb1',
        worksheetId: ws.id,
        description: 'Filter F7',
        quantity: '2',
        unit: 'pcs',
        serial: 'FLT-9',
        chargeType: 'invoiceable',
        price: '15.5',
        sum: '31',
      },
      {
        id: '00000000-0000-4000-8000-00000000bbb2',
        worksheetId: ws.id,
        description: 'Labor',
        quantity: '1',
        chargeType: 'contract',
      },
    ])
    await db.insert(schema.timeEntries).values([
      { worksheetId: ws.id, kind: 'work', minutes: 60 },
      { worksheetId: ws.id, kind: 'travel', minutes: 30 },
      // null minutes tolerated, contributes 0
      { worksheetId: ws.id, kind: 'work', minutes: null },
    ])
    await db.insert(schema.distanceEntries).values([
      { worksheetId: ws.id, km: '12.5', billable: true },
      { worksheetId: ws.id, km: '2.5', billable: false },
    ])

    const ctx = await buildOrderReportContext(db, { tenantId, orderId: order.id })

    expect(ctx.order).toEqual({
      id: order.id,
      number: 'SVO-1001',
      status: 'Work done',
      description: 'Annual maintenance',
      priority: 'high',
      siteName: 'Building A',
      contactName: 'Jane Contact',
      requestedAt: '2026-07-01T08:00:00.000Z',
      promisedDate: '2026-07-10T00:00:00.000Z',
    })
    expect(ctx.customer).toEqual({ id: customerId, name: 'Acme OÜ' })
    expect(ctx.serviceItems).toEqual([
      {
        id: unitItemId,
        name: 'AHU-01',
        serial: 'SN-123',
        symptom: 'Rattling noise',
        workType: 'maintenance',
        chargeType: 'warranty',
      },
      { id: unitItemId, name: 'AHU-01', serial: 'SN-123', chargeType: 'contract' },
    ])

    expect(ctx.worksheetSections).toHaveLength(1)
    const section = ctx.worksheetSections[0]
    expect(section.crew).toBe(false)
    expect(section.technicians).toEqual([{ id: tech1Id, name: TECH_1_EMAIL }])
    expect(section.workDescription).toBe('Replaced filter')
    expect(section.fault).toBe('Clogged filter')
    expect(section.cause).toBe('Overdue service')
    expect(section.remedy).toBe('New filter installed')
    expect(section.signedOnSite).toBe(true)
    expect(section.rows).toEqual([
      {
        description: 'Filter F7',
        quantity: 2,
        unit: 'pcs',
        serial: 'FLT-9',
        chargeType: 'invoiceable',
        price: 15.5,
        sum: 31,
      },
      { description: 'Labor', quantity: 1, chargeType: 'contract' },
    ])
    expect(section.timeTotalMinutes).toBe(90)
    expect(section.workMinutes).toBe(60)
    expect(section.travelMinutes).toBe(30)
    expect(section.distanceKm).toBe(15)

    expect(ctx.totals).toEqual({ timeTotalMinutes: 90, distanceKm: 15, rowCount: 2 })
    expect(ctx.computed).toEqual({})
    expect(ctx.meta).toEqual({ worksheetCount: 1, tenantId, orderId: order.id })
    // generatedAt is deliberately NOT part of meta — the renderer stamps it.
    expect('generatedAt' in ctx.meta).toBe(false)
  })
})

describe('buildOrderReportContext — crew order', () => {
  let orderId: string
  const crewGroupId = '00000000-0000-4000-8000-0000000000cc'

  beforeAll(async () => {
    const order = await insertOrder({ orderNumber: 'SVO-2001' })
    orderId = order.id

    // Crew pair: one Approved, one Synced (a pushed worksheet must not drop
    // out of the report). Solo worksheet sorts after by id.
    await insertWorksheet(orderId, {
      id: WS_CREW_A,
      technicianUserId: tech1Id,
      crewGroupId,
      status: 'Approved',
      workDescription: 'Checked compressor',
      fault: 'Low pressure',
      signedOnSite: false,
    })
    await insertWorksheet(orderId, {
      id: WS_CREW_B,
      technicianUserId: tech2Id,
      crewGroupId,
      status: 'Synced',
      workDescription: 'Refilled refrigerant',
      // duplicate fault value across the crew — must appear once
      fault: 'Low pressure',
      signedOnSite: true,
    })
    // tech3, not tech1: worksheets_order_tech_uniq allows one live worksheet
    // per (order x technician).
    await insertWorksheet(orderId, {
      id: WS_SOLO_C,
      technicianUserId: tech3Id,
      status: 'Approved',
      workDescription: 'Final inspection',
    })

    await db.insert(schema.worksheetRows).values([
      { worksheetId: WS_CREW_A, description: 'Gauge check', quantity: '1', chargeType: 'invoiceable' },
      { worksheetId: WS_CREW_B, description: 'R32 refill', quantity: '3', unit: 'kg', chargeType: 'invoiceable' },
      { worksheetId: WS_SOLO_C, description: 'Inspection', quantity: '1', chargeType: 'goodwill' },
    ])
    await db.insert(schema.timeEntries).values([
      { worksheetId: WS_CREW_A, kind: 'work', minutes: 45 },
      { worksheetId: WS_CREW_B, kind: 'work', minutes: 50 },
      { worksheetId: WS_CREW_B, kind: 'travel', minutes: 20 },
      { worksheetId: WS_SOLO_C, kind: 'work', minutes: 15 },
    ])
    await db.insert(schema.distanceEntries).values([
      { worksheetId: WS_CREW_A, km: '10' },
      { worksheetId: WS_CREW_B, km: '4' },
    ])
  })

  it('merges crew worksheets into one section and keeps the solo worksheet separate, in worksheet-id order', async () => {
    const ctx = await buildOrderReportContext(db, { tenantId, orderId })

    expect(ctx.worksheetSections).toHaveLength(2)
    const [crewSection, soloSection] = ctx.worksheetSections

    expect(crewSection.crew).toBe(true)
    expect(crewSection.technicians).toEqual([
      { id: tech1Id, name: TECH_1_EMAIL },
      { id: tech2Id, name: TECH_2_EMAIL },
    ])
    // Concatenated distinct non-empty values, worksheet-id order.
    expect(crewSection.workDescription).toBe('Checked compressor\n\nRefilled refrigerant')
    // duplicate values dedupe
    expect(crewSection.fault).toBe('Low pressure')
    expect(crewSection.cause).toBe('')
    expect(crewSection.signedOnSite).toBe(true) // any in group
    expect(crewSection.rows).toEqual([
      { description: 'Gauge check', quantity: 1, chargeType: 'invoiceable' },
      { description: 'R32 refill', quantity: 3, unit: 'kg', chargeType: 'invoiceable' },
    ])
    expect(crewSection.timeTotalMinutes).toBe(115)
    expect(crewSection.workMinutes).toBe(95)
    expect(crewSection.travelMinutes).toBe(20)
    expect(crewSection.distanceKm).toBe(14)

    expect(soloSection.crew).toBe(false)
    expect(soloSection.technicians).toEqual([{ id: tech3Id, name: TECH_3_EMAIL }])
    expect(soloSection.workDescription).toBe('Final inspection')
    expect(soloSection.timeTotalMinutes).toBe(15)
    expect(soloSection.distanceKm).toBe(0)

    expect(ctx.totals).toEqual({ timeTotalMinutes: 130, distanceKm: 14, rowCount: 3 })
    expect(ctx.meta).toEqual({ worksheetCount: 3, tenantId, orderId })
  })

  it('is stable across repeated builds (deterministic for golden tests)', async () => {
    const a = await buildOrderReportContext(db, { tenantId, orderId })
    const b = await buildOrderReportContext(db, { tenantId, orderId })
    expect(a).toEqual(b)
  })

  it('survives a JSON round-trip unchanged (context_snapshot jsonb)', async () => {
    const ctx = await buildOrderReportContext(db, { tenantId, orderId })
    expect(JSON.parse(JSON.stringify(ctx))).toStrictEqual(ctx)
  })
})

describe('buildOrderReportContext — status filter', () => {
  it('excludes Draft/Assigned/Accepted/In progress/Paused/Done/Rejected and soft-deleted worksheets', async () => {
    const order = await insertOrder({ orderNumber: 'SVO-3001' })
    for (const status of [
      'Draft',
      'Assigned',
      'Accepted',
      'In progress',
      'Paused',
      'Done',
      'Rejected',
    ]) {
      // technicianUserId null: worksheets_order_tech_uniq would reject the
      // same tech twice on one order, and the tech is irrelevant here.
      await insertWorksheet(order.id, { status })
    }
    // Approved but tombstoned — must be excluded too.
    await insertWorksheet(order.id, {
      technicianUserId: tech1Id,
      status: 'Approved',
      deletedAt: new Date(),
    })

    const ctx = await buildOrderReportContext(db, { tenantId, orderId: order.id })
    expect(ctx.worksheetSections).toEqual([])
    expect(ctx.totals).toEqual({ timeTotalMinutes: 0, distanceKm: 0, rowCount: 0 })
    expect(ctx.meta.worksheetCount).toBe(0)
  })
})

describe('buildOrderReportContext — not found', () => {
  it('throws OrderNotFoundError for an unknown order id', async () => {
    await expect(
      buildOrderReportContext(db, { tenantId, orderId: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(OrderNotFoundError)
  })

  it('throws OrderNotFoundError for an order belonging to another tenant', async () => {
    const order = await insertOrder({ orderNumber: 'SVO-4001' })
    await expect(
      buildOrderReportContext(db, { tenantId: otherTenantId, orderId: order.id }),
    ).rejects.toBeInstanceOf(OrderNotFoundError)
  })
})

describe('buildOrderReportContext — null-field tolerance', () => {
  it('renders an order with no optional fields and a bare worksheet without technician/rows/time/distance', async () => {
    const order = await insertOrder() // no number, dates, site, contact, description, priority
    await insertWorksheet(order.id, { status: 'Approved' }) // technicianUserId null, nothing else

    const ctx = await buildOrderReportContext(db, { tenantId, orderId: order.id })

    expect(ctx.order).toEqual({
      id: order.id,
      number: '',
      status: 'New',
      description: '',
      priority: '',
      siteName: '',
      contactName: '',
    })
    expect(ctx.order.requestedAt).toBeUndefined()
    expect(ctx.order.promisedDate).toBeUndefined()
    expect(ctx.serviceItems).toEqual([])

    expect(ctx.worksheetSections).toHaveLength(1)
    const section = ctx.worksheetSections[0]
    expect(section.technicians).toEqual([])
    expect(section.crew).toBe(false)
    expect(section.workDescription).toBe('')
    expect(section.fault).toBe('')
    expect(section.cause).toBe('')
    expect(section.remedy).toBe('')
    expect(section.signedOnSite).toBe(false)
    expect(section.rows).toEqual([])
    expect(section.timeTotalMinutes).toBe(0)
    expect(section.workMinutes).toBe(0)
    expect(section.travelMinutes).toBe(0)
    expect(section.distanceKm).toBe(0)

    expect(JSON.parse(JSON.stringify(ctx))).toStrictEqual(ctx)
  })
})

// FIX-10 / docs/21 WS12 TDD "loop over coverage exceptions": a group/lot row
// resolves its coverage record against the node's members into an explicit
// covered/exception list, not a passed-through jsonb blob.
describe('buildOrderReportContext — group coverage (covered units of a lot)', () => {
  // A lot node with three member units. Explicit ascending ids pin the
  // deterministic member order the builder promises (order by id), so
  // 'n_of_m' coverage of the first n is assertable.
  const LOT_ID = '00000000-0000-4000-8000-0000000c1070'
  const MEMBER_1 = '00000000-0000-4000-8000-0000000ce001'
  const MEMBER_2 = '00000000-0000-4000-8000-0000000ce002'
  const MEMBER_3 = '00000000-0000-4000-8000-0000000ce003'

  beforeAll(async () => {
    await db.insert(schema.serviceItems).values([
      { id: LOT_ID, tenantId, kind: 'lot', name: 'Detector lot', labelId: 'LBL-LOT', changeSeq: BigInt(0) },
      { id: MEMBER_1, tenantId, parentId: LOT_ID, kind: 'unit', name: 'Detector 1', serialNr: 'D-1', labelId: 'LBL-D1', changeSeq: BigInt(0) },
      { id: MEMBER_2, tenantId, parentId: LOT_ID, kind: 'unit', name: 'Detector 2', serialNr: 'D-2', labelId: 'LBL-D2', changeSeq: BigInt(0) },
      { id: MEMBER_3, tenantId, parentId: LOT_ID, kind: 'unit', name: 'Detector 3', serialNr: 'D-3', labelId: 'LBL-D3', changeSeq: BigInt(0) },
    ])
  }, 60_000)

  async function serviceItemForCoverage(coverage: unknown) {
    const order = await insertOrder()
    await db
      .insert(schema.serviceOrderRows)
      .values({ orderId: order.id, serviceItemId: LOT_ID, coverage })
    const ctx = await buildOrderReportContext(db, { tenantId, orderId: order.id })
    return ctx.serviceItems[0]
  }

  it('n_of_m: covers the first n members by id, the rest are exceptions', async () => {
    const item = await serviceItemForCoverage({ mode: 'n_of_m', n: 2 })
    expect(item.coverage).toEqual({ covered: 2, of: 3 })
    expect(item.coveredUnits).toEqual([
      { id: MEMBER_1, name: 'Detector 1', serial: 'D-1', covered: true },
      { id: MEMBER_2, name: 'Detector 2', serial: 'D-2', covered: true },
      { id: MEMBER_3, name: 'Detector 3', serial: 'D-3', covered: false },
    ])
  })

  it('all: every member covered', async () => {
    const item = await serviceItemForCoverage({ mode: 'all' })
    expect(item.coverage).toEqual({ covered: 3, of: 3 })
    expect(item.coveredUnits?.map((u) => u.covered)).toEqual([true, true, true])
  })

  it('list: only the listed members covered', async () => {
    const item = await serviceItemForCoverage({ mode: 'list', ids: [MEMBER_2] })
    expect(item.coverage).toEqual({ covered: 1, of: 3 })
    expect(item.coveredUnits?.filter((u) => u.covered).map((u) => u.id)).toEqual([MEMBER_2])
  })

  it('all_except: everyone but the excepted members covered', async () => {
    const item = await serviceItemForCoverage({ mode: 'all_except', ids: [MEMBER_1, MEMBER_3] })
    expect(item.coverage).toEqual({ covered: 1, of: 3 })
    expect(item.coveredUnits?.filter((u) => !u.covered).map((u) => u.id)).toEqual([MEMBER_1, MEMBER_3])
  })

  it('omits coverage and coveredUnits when the row carries no coverage record', async () => {
    const item = await serviceItemForCoverage(null)
    expect(item).not.toHaveProperty('coverage')
    expect(item).not.toHaveProperty('coveredUnits')
  })

  it('ignores a malformed coverage blob with no recognized mode', async () => {
    const item = await serviceItemForCoverage({ covered: 1, of: 2 })
    expect(item).not.toHaveProperty('coverage')
    expect(item).not.toHaveProperty('coveredUnits')
  })
})
