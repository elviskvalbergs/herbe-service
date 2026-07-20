// lib/sync/ingest/worksheets.test.ts
//
// DB-backed ingest test for the WSVc register, mirroring
// service-orders.test.ts (local-Postgres harness, hand-built ChangeSet).
// worksheets has no scalar erpRef column, so every "does this match an
// existing worksheet" assertion here exercises the erp_refs reverse lookup
// (findEntityIdByErpRef) that ingestWorksheets relies on to stay idempotent
// across re-ingests. orderId is resolved the same way, against the seeded
// service_order's own primary/SVOVc erp_ref.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { insertServiceOrder } from '@/lib/domain/stores/service-orders'
import { insertServiceItem } from '@/lib/domain/stores/service-items'
import { putErpRef, getErpRefs } from '@/lib/domain/stores/erp-refs'
import { createPushGroup } from '@/lib/sync/push/store'
import { ingestWorksheets, deriveWorksheetStatusFromErp } from './worksheets'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string
let erpCompanyId: string
let orderId: string
const ORDER_SERNR = '5001'

// A single-row WSVc header, overridable per test. SVONr resolves to the
// seeded order (ORDER_SERNR) by default; SVONr: '9999' deliberately does
// not resolve, to exercise the unresolved-order path.
function row(overrides: Record<string, unknown>) {
  return {
    SerNr: 0,
    SVONr: ORDER_SERNR,
    EMCode: 'TECH1',
    OKFlag: '0',
    PrelOK: '0',
    Invalid: '0',
    Location: 'VAN-1',
    Comment1: 'Checked unit',
    Comment2: '',
    Comment3: '',
    Comment4: '',
    ...overrides,
  }
}

function changeSetOf(rows: Record<string, unknown>[]) {
  return { upserts: rows, deletedRefs: [], cursor: '0' }
}

async function findWorksheet(erpRef: string) {
  const [ref] = await db
    .select()
    .from(schema.erpRefs)
    .where(
      and(
        eq(schema.erpRefs.entityType, 'worksheet'),
        eq(schema.erpRefs.purpose, 'primary'),
        eq(schema.erpRefs.recordRef, erpRef),
      ),
    )
  if (!ref) return undefined
  const [ws] = await db.select().from(schema.worksheets).where(eq(schema.worksheets.id, ref.entityId))
  return ws
}

async function rowsForWorksheet(worksheetId: string) {
  return db.select().from(schema.worksheetRows).where(eq(schema.worksheetRows.worksheetId, worksheetId))
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
    .values({ tenantId, erpCompanyId, erpRef: 'CUST001', name: 'Test Client OÜ', changeSeq: BigInt(0) })
    .returning()

  // Seed a service_order with a primary/SVOVc erp_ref so SVONr resolution
  // (the FK worksheets.orderId depends on) has something to find.
  const order = await insertServiceOrder(db, {
    tenantId,
    erpCompanyId,
    customerId: customer.id,
    orderNumber: ORDER_SERNR,
  })
  orderId = order.id
  await putErpRef(db, {
    tenantId,
    entityType: 'service_order',
    entityId: orderId,
    purpose: 'primary',
    register: 'SVOVc',
    recordRef: ORDER_SERNR,
    erpCompanyId,
  })

  // Seeded so a line's SerialNr can resolve to a real service_items row.
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

describe('ingestWorksheets', () => {
  it('inserts a new worksheet keyed by SerNr, resolves orderId via SVONr, and records a primary/WSVc erp_ref', async () => {
    const result = await ingestWorksheets(db, erpCompanyId, changeSetOf([row({ SerNr: 8001 })]))
    expect(result).toEqual({ ingested: 1, skipped: 0 })

    const ws = await findWorksheet('8001')
    expect(ws).toBeTruthy()
    expect(ws!.orderId).toBe(orderId)
    expect(ws!.workDescription).toBe('Checked unit')
    expect(ws!.status).toBe('Draft')

    const refs = await getErpRefs(db, tenantId, 'worksheet', ws!.id)
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ purpose: 'primary', register: 'WSVc', recordRef: '8001' })
  })

  it('an unresolved SVONr is skipped — counted, not inserted, no throw', async () => {
    const result = await ingestWorksheets(db, erpCompanyId, changeSetOf([row({ SerNr: 8002, SVONr: '9999' })]))
    expect(result).toEqual({ ingested: 0, skipped: 1 })
    expect(await findWorksheet('8002')).toBeUndefined()
  })

  it('skips a row with an empty or entirely missing SerNr, counting neither ingested nor skipped', async () => {
    const result = await ingestWorksheets(
      db,
      erpCompanyId,
      changeSetOf([row({ SerNr: '' }), row({ SerNr: undefined })]),
    )
    expect(result).toEqual({ ingested: 0, skipped: 0 })
  })

  it('an entirely missing SVONr is also treated as unresolved', async () => {
    const result = await ingestWorksheets(db, erpCompanyId, changeSetOf([row({ SerNr: 8003, SVONr: undefined })]))
    expect(result).toEqual({ ingested: 0, skipped: 1 })
    expect(await findWorksheet('8003')).toBeUndefined()
  })

  it('re-ingesting the same SerNr updates the same worksheet via the erp_refs reverse lookup — no duplicate row', async () => {
    const before = await findWorksheet('8001')

    const result = await ingestWorksheets(
      db,
      erpCompanyId,
      changeSetOf([row({ SerNr: 8001, Comment1: 'Checked unit', Comment2: 'Replaced belt' })]),
    )
    expect(result).toEqual({ ingested: 1, skipped: 0 })

    const after = await findWorksheet('8001')
    expect(after!.id).toBe(before!.id) // no duplicate
    expect(after!.workDescription).toBe('Checked unit\nReplaced belt')

    const refs = await getErpRefs(db, tenantId, 'worksheet', after!.id)
    expect(refs).toHaveLength(1) // erp_refs row not duplicated either
  })

  it('throws for an unknown erpCompanyId', async () => {
    await expect(
      ingestWorksheets(db, '00000000-0000-0000-0000-000000000000', changeSetOf([row({ SerNr: 8099 })])),
    ).rejects.toThrow(/unknown erpCompanyId/)
  })

  describe('status mapping (deriveWorksheetStatusFromErp via ingest)', () => {
    it('OKFlag=1 -> Synced', async () => {
      await ingestWorksheets(db, erpCompanyId, changeSetOf([row({ SerNr: 8010, OKFlag: '1' })]))
      expect((await findWorksheet('8010'))!.status).toBe('Synced')
    })

    it('all flags 0 -> Draft', async () => {
      await ingestWorksheets(db, erpCompanyId, changeSetOf([row({ SerNr: 8011 })]))
      expect((await findWorksheet('8011'))!.status).toBe('Draft')
    })

    it('Invalid=1 -> Rejected (highest precedence)', async () => {
      await ingestWorksheets(
        db,
        erpCompanyId,
        changeSetOf([row({ SerNr: 8012, Invalid: '1', OKFlag: '1', PrelOK: '1' })]),
      )
      expect((await findWorksheet('8012'))!.status).toBe('Rejected')
    })

    it('PrelOK=1 (and OKFlag/Invalid 0) -> Done', async () => {
      await ingestWorksheets(db, erpCompanyId, changeSetOf([row({ SerNr: 8013, PrelOK: '1' })]))
      expect((await findWorksheet('8013'))!.status).toBe('Done')
    })
  })

  describe('echo-suppression for self-pushed worksheets (FIX-1)', () => {
    // Seeds a worksheet, advances it to a locally-authored + pushed state
    // (status Synced, a full local workDescription, one local part row), and
    // records a worksheet_push step for it — exactly the state a worksheet is
    // in right after approveWorksheet + a successful WSVc create, when the
    // next sync tick full-pulls WSVc and re-ingests the un-OK'd echo.
    async function seedPushedWorksheet(sernr: number, localDescription: string) {
      await ingestWorksheets(db, erpCompanyId, changeSetOf([row({ SerNr: sernr })]))
      const ws = await findWorksheet(String(sernr))
      await db
        .update(schema.worksheets)
        .set({ status: 'Synced', workDescription: localDescription })
        .where(eq(schema.worksheets.id, ws!.id))
      await db.insert(schema.worksheetRows).values({ worksheetId: ws!.id, description: 'local part row' })
      await createPushGroup(db, {
        tenantId,
        erpCompanyId,
        lane: `order:${orderId}`,
        kind: 'worksheet_push',
        steps: [{ seq: 1, entityType: 'worksheet', entityId: ws!.id, register: 'WSVc', op: 'create' }],
      })
      return ws!
    }

    it('an un-OK\'d echo (OKFlag=0) does NOT regress status to Draft or wipe the local description/rows', async () => {
      const ws = await seedPushedWorksheet(8600, 'Full local work notes, well over what the ERP echo carries')

      // The exact regression: sync-tick re-ingests WSVc with OKFlag=0, blank
      // Comments, and synthetic labor/distance rows.
      const result = await ingestWorksheets(
        db,
        erpCompanyId,
        changeSetOf([
          row({
            SerNr: 8600,
            OKFlag: '0',
            PrelOK: '0',
            Invalid: '0',
            Comment1: '',
            Comment2: '',
            Comment3: '',
            Comment4: '',
            rows: [{ ArtCode: 'LABOR-ECHO', SerialNr: '', ItemType: 'Invoiceable' }],
          }),
        ]),
      )
      expect(result).toEqual({ ingested: 1, skipped: 0 })

      const after = await findWorksheet('8600')
      expect(after!.status).toBe('Synced') // not Draft
      expect(after!.workDescription).toBe('Full local work notes, well over what the ERP echo carries')

      const rows = await rowsForWorksheet(ws.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].description).toBe('local part row') // not the synthetic LABOR-ECHO row
    })

    it('applies the OKFlag=1 upgrade on a self-pushed worksheet (the flattering echo) — stays Synced', async () => {
      await seedPushedWorksheet(8601, 'local notes')
      await ingestWorksheets(db, erpCompanyId, changeSetOf([row({ SerNr: 8601, OKFlag: '1' })]))
      expect((await findWorksheet('8601'))!.status).toBe('Synced')
    })

    it('applies the Invalid=1 upgrade on a self-pushed worksheet — Synced -> Rejected', async () => {
      await seedPushedWorksheet(8602, 'local notes')
      await ingestWorksheets(db, erpCompanyId, changeSetOf([row({ SerNr: 8602, Invalid: '1' })]))
      expect((await findWorksheet('8602'))!.status).toBe('Rejected')
    })
  })

  describe('worksheet_rows (lines)', () => {
    it('inserts one worksheet_rows row per line, resolving serviceItemId by SerialNr and chargeType from ItemType', async () => {
      await ingestWorksheets(
        db,
        erpCompanyId,
        changeSetOf([
          row({
            SerNr: 8020,
            rows: [
              {
                ArtCode: 'ART-1',
                SerialNr: 'FAKE-SN-LINE-1',
                ItemType: 'Warranty',
                Spec: 'Replace filter',
                Quant: 2,
                UsageUnit: 'pcs',
                PosCode: 'A1',
                Price: 10.5,
                Sum: 21,
              },
            ],
          }),
        ]),
      )

      const ws = await findWorksheet('8020')
      const rows = await rowsForWorksheet(ws!.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].chargeType).toBe('warranty')
      expect(rows[0].serviceItemId).toBeTruthy() // resolved to the seeded FAKE-SN-LINE-1 service_item
      expect(rows[0].description).toBe('Replace filter')
      expect(rows[0].quantity).toBe('2')
      expect(rows[0].unit).toBe('pcs')
      expect(rows[0].serial).toBe('FAKE-SN-LINE-1')
      expect(rows[0].stockLocation).toBe('A1')
      expect(rows[0].price).toBe('10.5')
      expect(rows[0].sum).toBe('21')
    })

    it('coerces empty-string numeric fields (Books unset numerics) to null, not a crash on the numeric column', async () => {
      // Standard Books returns an unset numeric as '' (verified live) — a
      // Postgres numeric column rejects that (22P02). booksNumeric() must
      // null it out rather than bind ''.
      await ingestWorksheets(
        db,
        erpCompanyId,
        changeSetOf([
          row({
            SerNr: 8023,
            rows: [{ ArtCode: 'ART-5', SerialNr: '', ItemType: 'Invoiceable', Quant: '', Price: '', Sum: '' }],
          }),
        ]),
      )
      const ws = await findWorksheet('8023')
      const rows = await rowsForWorksheet(ws!.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].quantity).toBeNull()
      expect(rows[0].price).toBeNull()
      expect(rows[0].sum).toBeNull()
    })

    it('falls back to the header Location when a line has no PosCode', async () => {
      await ingestWorksheets(
        db,
        erpCompanyId,
        changeSetOf([
          row({
            SerNr: 8021,
            Location: 'VAN-9',
            rows: [{ ArtCode: 'ART-2', SerialNr: '', ItemType: 'Invoiceable' }],
          }),
        ]),
      )
      const ws = await findWorksheet('8021')
      const rows = await rowsForWorksheet(ws!.id)
      expect(rows[0].stockLocation).toBe('VAN-9')
    })

    it('a blank or dangling SerialNr resolves serviceItemId to null, tolerated (never throws)', async () => {
      await ingestWorksheets(
        db,
        erpCompanyId,
        changeSetOf([
          row({
            SerNr: 8022,
            rows: [
              { ArtCode: 'ART-3', SerialNr: '', ItemType: 'Warranty' },
              { ArtCode: 'ART-4', SerialNr: 'FAKE-SN-DOES-NOT-EXIST', ItemType: 'Warranty' },
            ],
          }),
        ]),
      )
      const ws = await findWorksheet('8022')
      const rows = await rowsForWorksheet(ws!.id)
      expect(rows).toHaveLength(2)
      expect(rows.every((r) => r.serviceItemId === null)).toBe(true)
    })

    it('re-ingesting the same worksheet replaces its rows — no accumulation or duplication', async () => {
      await ingestWorksheets(
        db,
        erpCompanyId,
        changeSetOf([
          row({
            SerNr: 8023,
            rows: [
              { ArtCode: 'ART-5A', SerialNr: '', ItemType: 'Warranty' },
              { ArtCode: 'ART-5B', SerialNr: '', ItemType: 'Goodwill' },
            ],
          }),
        ]),
      )
      const ws = await findWorksheet('8023')
      expect(await rowsForWorksheet(ws!.id)).toHaveLength(2)

      await ingestWorksheets(
        db,
        erpCompanyId,
        changeSetOf([row({ SerNr: 8023, rows: [{ ArtCode: 'ART-5C', SerialNr: '', ItemType: 'Contract' }] })]),
      )
      const rowsAfter = await rowsForWorksheet(ws!.id)
      expect(rowsAfter).toHaveLength(1)
      expect(rowsAfter[0].chargeType).toBe('contract')
    })

    it('a header with no rows[] leaves the worksheet with zero line rows', async () => {
      await ingestWorksheets(db, erpCompanyId, changeSetOf([row({ SerNr: 8024 })]))
      const ws = await findWorksheet('8024')
      expect(await rowsForWorksheet(ws!.id)).toHaveLength(0)
    })
  })
})

describe('deriveWorksheetStatusFromErp', () => {
  it('all flags falsy -> Draft', () => {
    expect(deriveWorksheetStatusFromErp({ OKFlag: '0', PrelOK: '0', Invalid: '0' })).toBe('Draft')
  })

  it('PrelOK=1 -> Done', () => {
    expect(deriveWorksheetStatusFromErp({ OKFlag: '0', PrelOK: '1', Invalid: '0' })).toBe('Done')
  })

  it('OKFlag=1 -> Synced (takes precedence over PrelOK)', () => {
    expect(deriveWorksheetStatusFromErp({ OKFlag: '1', PrelOK: '1', Invalid: '0' })).toBe('Synced')
  })

  it('Invalid=1 -> Rejected (highest precedence, overrides OKFlag/PrelOK)', () => {
    expect(deriveWorksheetStatusFromErp({ OKFlag: '1', PrelOK: '1', Invalid: '1' })).toBe('Rejected')
  })
})
