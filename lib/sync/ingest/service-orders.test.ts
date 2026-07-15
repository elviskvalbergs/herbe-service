// lib/sync/ingest/service-orders.test.ts
//
// DB-backed ingest test for the SVOVc register, mirroring
// service-items.test.ts (local-Postgres harness, hand-built ChangeSet).
// service_orders has no scalar erpRef column, so every "does this match an
// existing order" assertion here exercises the erp_refs reverse lookup
// (findEntityIdByErpRef) that ingestServiceOrders relies on to stay
// idempotent across re-ingests.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { setOrderStatus } from '@/lib/domain/stores/service-orders'
import { insertServiceItem } from '@/lib/domain/stores/service-items'
import { getErpRefs } from '@/lib/domain/stores/erp-refs'
import { ingestServiceOrders } from './service-orders'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string
let erpCompanyId: string

// A single-row SVOVc header, overridable per test. CUST001 is seeded below;
// CUST999 deliberately is not, to exercise the unresolved-customer path.
function row(overrides: Record<string, unknown>) {
  return {
    SerNr: 0,
    CustCode: 'CUST001',
    CustComplaint1: 'Unit not cooling',
    CustComplaint2: '',
    CustComplaint3: '',
    CustComplaint4: '',
    CustContact: 'Demo Contact',
    OurContact: 'Demo Tech',
    RegDate: '2026-06-01',
    TransDate: '2026-06-01',
    PlanShipDate: '2026-06-10',
    DoneMark: '0',
    ...overrides,
  }
}

function changeSetOf(rows: Record<string, unknown>[]) {
  return { upserts: rows, deletedRefs: [], cursor: '0' }
}

async function orderByNumber(orderNumber: string) {
  const [found] = await db
    .select()
    .from(schema.serviceOrders)
    .where(and(eq(schema.serviceOrders.tenantId, tenantId), eq(schema.serviceOrders.orderNumber, orderNumber)))
  return found
}

async function rowsForOrder(orderId: string) {
  return db.select().from(schema.serviceOrderRows).where(eq(schema.serviceOrderRows.orderId, orderId))
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

  // Only CUST001 exists — CUST999 is deliberately absent so customerId
  // resolution can be asserted to skip, not throw.
  await db
    .insert(schema.customers)
    .values({ tenantId, erpCompanyId, erpRef: 'CUST001', name: 'Test Client OÜ', changeSeq: BigInt(0) })

  // Seeded so a line's SerialNr can resolve to a real service_items row
  // (Task B — serviceItemId resolution).
  await insertServiceItem(db, {
    tenantId,
    erpCompanyId,
    kind: 'unit',
    name: 'Demo Air Handler',
    labelId: 'test-label-fake-sn-line-1',
    serialNr: 'FAKE-SN-LINE-1',
  })
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('ingestServiceOrders', () => {
  it('inserts a new order keyed by SerNr, sets orderNumber, and records a primary/SVOVc erp_ref', async () => {
    const result = await ingestServiceOrders(db, erpCompanyId, changeSetOf([row({ SerNr: 5001 })]))
    expect(result).toEqual({ ingested: 1, skipped: 0 })

    const order = await orderByNumber('5001')
    expect(order).toBeTruthy()
    expect(order.status).toBe('New')
    expect(order.description).toBe('Unit not cooling')
    expect(order.contactName).toBe('Demo Contact')
    expect(order.requestedAt).toBeInstanceOf(Date)
    expect(order.promisedDate).toBeInstanceOf(Date)

    const refs = await getErpRefs(db, tenantId, 'service_order', order.id)
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ purpose: 'primary', register: 'SVOVc', recordRef: '5001' })
  })

  it('DoneMark=1 on insert sets status Closed', async () => {
    await ingestServiceOrders(db, erpCompanyId, changeSetOf([row({ SerNr: 5002, DoneMark: '1' })]))
    const order = await orderByNumber('5002')
    expect(order.status).toBe('Closed')
  })

  it('re-ingesting the same SerNr updates the same order via the erp_refs reverse lookup — no duplicate row', async () => {
    const before = await orderByNumber('5001')

    const result = await ingestServiceOrders(
      db,
      erpCompanyId,
      changeSetOf([row({ SerNr: 5001, CustComplaint1: 'Still not cooling', CustComplaint2: 'Worse now' })]),
    )
    expect(result).toEqual({ ingested: 1, skipped: 0 })

    const rows = await db
      .select()
      .from(schema.serviceOrders)
      .where(and(eq(schema.serviceOrders.tenantId, tenantId), eq(schema.serviceOrders.orderNumber, '5001')))
    expect(rows).toHaveLength(1) // still one row, no duplicate
    expect(rows[0].id).toBe(before.id)
    expect(rows[0].description).toBe('Still not cooling\nWorse now')

    const refs = await getErpRefs(db, tenantId, 'service_order', rows[0].id)
    expect(refs).toHaveLength(1) // erp_refs row not duplicated either
  })

  it('DoneMark=1 on update forces Closed, even for an existing non-Closed order', async () => {
    await ingestServiceOrders(db, erpCompanyId, changeSetOf([row({ SerNr: 5003, DoneMark: '0' })]))
    expect((await orderByNumber('5003')).status).toBe('New')

    await ingestServiceOrders(db, erpCompanyId, changeSetOf([row({ SerNr: 5003, DoneMark: '1' })]))
    expect((await orderByNumber('5003')).status).toBe('Closed')
  })

  it('DoneMark != 1 on update leaves an already-advanced status untouched', async () => {
    await ingestServiceOrders(db, erpCompanyId, changeSetOf([row({ SerNr: 5004, DoneMark: '0' })]))
    const inserted = await orderByNumber('5004')

    // Simulate a locally-advanced status (technician marked work done) —
    // something this ingest itself never sets.
    await setOrderStatus(db, tenantId, inserted.id, 'Work done')

    await ingestServiceOrders(db, erpCompanyId, changeSetOf([row({ SerNr: 5004, DoneMark: '0' })]))
    expect((await orderByNumber('5004')).status).toBe('Work done') // never downgraded
  })

  it('an unresolved CustCode is skipped — counted, not inserted, no throw', async () => {
    const result = await ingestServiceOrders(
      db,
      erpCompanyId,
      changeSetOf([row({ SerNr: 5005, CustCode: 'CUST999' })]),
    )
    expect(result).toEqual({ ingested: 0, skipped: 1 })
    expect(await orderByNumber('5005')).toBeUndefined()
  })

  it('skips a row with an empty or entirely missing SerNr, counting neither ingested nor skipped', async () => {
    const result = await ingestServiceOrders(
      db,
      erpCompanyId,
      changeSetOf([row({ SerNr: '' }), row({ SerNr: undefined })]),
    )
    expect(result).toEqual({ ingested: 0, skipped: 0 })
  })

  it('an entirely missing CustCode is also treated as unresolved', async () => {
    const result = await ingestServiceOrders(db, erpCompanyId, changeSetOf([row({ SerNr: 6003, CustCode: undefined })]))
    expect(result).toEqual({ ingested: 0, skipped: 1 })
    expect(await orderByNumber('6003')).toBeUndefined()
  })

  it('contactName falls back from CustContact to OurContact; requestedAt falls back from RegDate to TransDate; an unparseable PlanShipDate maps to no promisedDate', async () => {
    await ingestServiceOrders(
      db,
      erpCompanyId,
      changeSetOf([
        row({
          SerNr: 6001,
          CustContact: '',
          OurContact: 'Fallback Tech',
          RegDate: '',
          TransDate: '2026-07-01',
          PlanShipDate: 'not-a-date',
        }),
      ]),
    )

    const order = await orderByNumber('6001')
    expect(order.contactName).toBe('Fallback Tech')
    expect(order.requestedAt).toBeInstanceOf(Date)
    expect(order.promisedDate).toBeNull()
  })

  it('blank contact fields and missing/blank date fields resolve to no contact and no dates on insert', async () => {
    await ingestServiceOrders(
      db,
      erpCompanyId,
      changeSetOf([
        row({
          SerNr: 6002,
          CustContact: '',
          OurContact: '',
          RegDate: undefined,
          TransDate: undefined,
          PlanShipDate: '',
        }),
      ]),
    )

    const order = await orderByNumber('6002')
    expect(order.contactName).toBeNull()
    expect(order.requestedAt).toBeNull()
    expect(order.promisedDate).toBeNull()
  })

  it('throws for an unknown erpCompanyId', async () => {
    await expect(
      ingestServiceOrders(db, '00000000-0000-0000-0000-000000000000', changeSetOf([row({ SerNr: 5006 })])),
    ).rejects.toThrow(/unknown erpCompanyId/)
  })
})

describe('ingestServiceOrders — line rows (Task B: service_order_rows + ItemType charge-type parsing)', () => {
  it('inserts one service_order_rows row per line, resolving serviceItemId by SerialNr and chargeType from ItemType', async () => {
    await ingestServiceOrders(
      db,
      erpCompanyId,
      changeSetOf([
        row({
          SerNr: 7001,
          rows: [
            {
              ArtCode: 'ART-1',
              SerialNr: 'FAKE-SN-LINE-1',
              ItemType: 'Warranty',
              StandProblem: 'NOCOOL',
              Spec: 'Replace filter',
              ContractNr: 'CN-1',
              DiagnosticCode: 'D1',
            },
          ],
        }),
      ]),
    )

    const order = await orderByNumber('7001')
    const rows = await rowsForOrder(order.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].chargeType).toBe('warranty')
    expect(rows[0].serviceItemId).toBeTruthy() // resolved to the seeded FAKE-SN-LINE-1 service_item
    expect(rows[0].symptom).toBe('NOCOOL') // StandProblem takes priority over Spec
    expect(rows[0].workType).toBe('ART-1')
    expect(rows[0].coverage).toEqual({ contractNr: 'CN-1', diagnosticCode: 'D1' }) // no reviewNeeded — mapped label
  })

  it('falls back to Spec for symptom when StandProblem is blank', async () => {
    await ingestServiceOrders(
      db,
      erpCompanyId,
      changeSetOf([
        row({
          SerNr: 7002,
          rows: [{ ArtCode: 'ART-2', SerialNr: '', ItemType: 'Invoiceable', StandProblem: '', Spec: 'Inspect unit' }],
        }),
      ]),
    )

    const order = await orderByNumber('7002')
    const rows = await rowsForOrder(order.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].symptom).toBe('Inspect unit')
  })

  it('a blank SerialNr resolves serviceItemId to null, tolerated (never throws)', async () => {
    const order = await orderByNumber('7002')
    const rows = await rowsForOrder(order.id)
    expect(rows[0].serviceItemId).toBeNull()
  })

  it('a non-empty SerialNr that matches no service_items row (dangling) also resolves to null', async () => {
    await ingestServiceOrders(
      db,
      erpCompanyId,
      changeSetOf([
        row({ SerNr: 7007, rows: [{ ArtCode: 'ART-7', SerialNr: 'FAKE-SN-DOES-NOT-EXIST', ItemType: 'Warranty' }] }),
      ]),
    )
    const order = await orderByNumber('7007')
    const rows = await rowsForOrder(order.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].serviceItemId).toBeNull()
  })

  it('an unmapped/"-" ItemType flags coverage.chargeTypeReviewNeeded and defaults to invoiceable', async () => {
    await ingestServiceOrders(
      db,
      erpCompanyId,
      changeSetOf([row({ SerNr: 7003, rows: [{ ArtCode: 'ART-3', SerialNr: '', ItemType: '-' }] })]),
    )

    const order = await orderByNumber('7003')
    const rows = await rowsForOrder(order.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].chargeType).toBe('invoiceable')
    expect(rows[0].coverage).toEqual({ chargeTypeReviewNeeded: true })
  })

  it('re-ingesting the same order replaces its rows — no accumulation or duplication', async () => {
    await ingestServiceOrders(
      db,
      erpCompanyId,
      changeSetOf([
        row({
          SerNr: 7004,
          rows: [
            { ArtCode: 'ART-4A', SerialNr: '', ItemType: 'Warranty' },
            { ArtCode: 'ART-4B', SerialNr: '', ItemType: 'Goodwill' },
          ],
        }),
      ]),
    )
    const order = await orderByNumber('7004')
    expect(await rowsForOrder(order.id)).toHaveLength(2)

    // Re-ingest with a single, different line — the old two must be gone,
    // not accumulated alongside the new one.
    await ingestServiceOrders(
      db,
      erpCompanyId,
      changeSetOf([row({ SerNr: 7004, rows: [{ ArtCode: 'ART-4C', SerialNr: '', ItemType: 'Contract' }] })]),
    )
    const rowsAfter = await rowsForOrder(order.id)
    expect(rowsAfter).toHaveLength(1)
    expect(rowsAfter[0].workType).toBe('ART-4C')
    expect(rowsAfter[0].chargeType).toBe('contract')
  })

  it('blank StandProblem/Spec/ArtCode on a line resolve to no symptom and no workType', async () => {
    await ingestServiceOrders(
      db,
      erpCompanyId,
      changeSetOf([
        row({ SerNr: 7006, rows: [{ ArtCode: '', SerialNr: '', ItemType: 'Warranty', StandProblem: '', Spec: '' }] }),
      ]),
    )

    const order = await orderByNumber('7006')
    const rows = await rowsForOrder(order.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].symptom).toBeNull()
    expect(rows[0].workType).toBeNull()
  })

  it('a header with no rows[] leaves the order with zero line rows', async () => {
    await ingestServiceOrders(db, erpCompanyId, changeSetOf([row({ SerNr: 7005 })]))
    const order = await orderByNumber('7005')
    expect(await rowsForOrder(order.id)).toHaveLength(0)
  })
})
