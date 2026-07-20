// lib/documents/store.test.ts
//
// WS12 Task 6 — document + template store (docs/superpowers/plans/
// 2026-07-20-service-phase1-ws12-documents.md decisions 3/4). Uses the
// local-Postgres test harness (lib/test-support/db.ts), mirroring
// lib/domain/stores/erp-refs.test.ts. The invariant under test everywhere:
// a document number is assigned ONCE at version 1 and copied verbatim to
// every later version — the series counter must never advance for a
// re-render.
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { buildDocxFixture } from './docx/fixture'
import {
  getActiveTemplate,
  getDocumentPdf,
  getLatestDocument,
  getTemplateById,
  insertRenderedDocument,
  insertTemplate,
  listDocumentsForOrder,
  listTemplates,
  orderHasRenderedReport,
} from './store'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

let tenantId: string
let otherTenantId: string
let erpCompanyId: string
let customerId: string

const NOW = new Date('2026-07-20T10:00:00Z')
const PDF = Buffer.from('%PDF-1.7 test pdf bytes')

async function newOrder(): Promise<string> {
  const [order] = await db
    .insert(schema.serviceOrders)
    .values({ tenantId, customerId, changeSeq: BigInt(0) })
    .returning()
  return order.id
}

async function seriesRow(forTenantId: string, docType: string) {
  const [row] = await db
    .select()
    .from(schema.documentNumberSeries)
    .where(
      and(
        eq(schema.documentNumberSeries.tenantId, forTenantId),
        eq(schema.documentNumberSeries.docType, docType),
      ),
    )
  return row
}

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
    .values({ tenantId, erpCompanyId, erpRef: 'CUST-1', name: 'Acme OÜ', changeSeq: BigInt(0) })
    .returning()
  customerId = customer.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('insertRenderedDocument', () => {
  it('first render assigns SR-2026-00001 and version 1', async () => {
    const orderId = await newOrder()
    const doc = await insertRenderedDocument(db, {
      tenantId,
      docType: 'order_report',
      orderId,
      contextSnapshot: { meta: { orderId } },
      pdfBytes: PDF,
      now: NOW,
    })

    expect(doc.number).toBe('SR-2026-00001')
    expect(doc.version).toBe(1)
    expect(doc.templateId).toBeNull()
    expect(doc.templateVersion).toBeNull()
    expect(doc.docxBytes).toBeNull()
    expect(doc.pdfBytes?.equals(PDF)).toBe(true)
    expect(doc.contextSnapshot).toEqual({ meta: { orderId } })
    expect(doc.renderedAt.getTime()).toBe(NOW.getTime())

    const series = await seriesRow(tenantId, 'order_report')
    expect(series.nextCounter).toBe(2)
    expect(doc.seriesId).toBe(series.id)
  })

  it('re-render of the same order: version 2, SAME number, counter NOT advanced', async () => {
    const orderId = await newOrder()
    const v1 = await insertRenderedDocument(db, {
      tenantId,
      docType: 'order_report',
      orderId,
      contextSnapshot: {},
      pdfBytes: PDF,
      now: NOW,
    })
    const counterAfterV1 = (await seriesRow(tenantId, 'order_report')).nextCounter

    const v2 = await insertRenderedDocument(db, {
      tenantId,
      docType: 'order_report',
      orderId,
      contextSnapshot: {},
      pdfBytes: PDF,
      now: new Date('2027-01-05T00:00:00Z'), // even across a year boundary
    })

    expect(v2.version).toBe(2)
    expect(v2.number).toBe(v1.number) // number immutability — THE invariant
    expect(v2.seriesId).toBe(v1.seriesId)
    const series = await seriesRow(tenantId, 'order_report')
    expect(series.nextCounter).toBe(counterAfterV1) // not advanced

    const v3 = await insertRenderedDocument(db, {
      tenantId,
      docType: 'order_report',
      orderId,
      contextSnapshot: {},
      pdfBytes: PDF,
      now: NOW,
    })
    expect(v3.version).toBe(3)
    expect(v3.number).toBe(v1.number)
  })

  it('a different order draws the next counter value', async () => {
    const t = (await db.insert(schema.tenants).values({ slug: 't-next', name: 'T' }).returning())[0].id
    const [c] = await db
      .insert(schema.customers)
      .values({ tenantId: t, erpCompanyId, erpRef: 'CUST-N', name: 'N', changeSeq: BigInt(0) })
      .returning()
    const mkOrder = async () =>
      (await db.insert(schema.serviceOrders).values({ tenantId: t, customerId: c.id, changeSeq: BigInt(0) }).returning())[0].id

    const first = await insertRenderedDocument(db, {
      tenantId: t,
      docType: 'order_report',
      orderId: await mkOrder(),
      contextSnapshot: {},
      pdfBytes: PDF,
      now: NOW,
    })
    const second = await insertRenderedDocument(db, {
      tenantId: t,
      docType: 'order_report',
      orderId: await mkOrder(),
      contextSnapshot: {},
      pdfBytes: PDF,
      now: NOW,
    })
    expect(first.number).toBe('SR-2026-00001')
    expect(second.number).toBe('SR-2026-00002')
  })

  it('stores template id/version when a template was used', async () => {
    const template = await insertTemplate(db, {
      tenantId,
      docType: 'order_report',
      name: 'used-by-doc',
      docx: buildDocxFixture(['x']),
    })
    const orderId = await newOrder()
    const doc = await insertRenderedDocument(db, {
      tenantId,
      docType: 'order_report',
      orderId,
      contextSnapshot: {},
      templateId: template.id,
      templateVersion: template.version,
      docxBytes: Buffer.from('docx bytes'),
      pdfBytes: PDF,
      now: NOW,
    })
    expect(doc.templateId).toBe(template.id)
    expect(doc.templateVersion).toBe(template.version)
    expect(doc.docxBytes?.equals(Buffer.from('docx bytes'))).toBe(true)
  })

  it('the (tenant, docType, order, version) unique constraint rejects duplicates', async () => {
    const orderId = await newOrder()
    const doc = await insertRenderedDocument(db, {
      tenantId,
      docType: 'order_report',
      orderId,
      contextSnapshot: {},
      pdfBytes: PDF,
      now: NOW,
    })
    // drizzle wraps the driver error; the Postgres error (SQLSTATE 23505 for a
    // unique violation) is the `cause`, not the message — assert on that, same
    // idiom as __tests__/db/documents-migration.test.ts.
    const err = await db
      .insert(schema.documents)
      .values({
        tenantId,
        docType: 'order_report',
        orderId,
        number: doc.number,
        seriesId: doc.seriesId,
        version: 1,
        contextSnapshot: {},
      })
      .then(() => null)
      .catch((e) => e as Error)
    const cause = (err as Error | null)?.cause as { code?: string } | undefined
    expect(cause?.code).toBe('23505')
  })

  it('composes inside an outer transaction (savepoint, not a second top-level tx)', async () => {
    const orderId = await newOrder()
    const doc = await db.transaction(async (tx) =>
      insertRenderedDocument(tx, {
        tenantId,
        docType: 'order_report',
        orderId,
        contextSnapshot: {},
        pdfBytes: PDF,
        now: NOW,
      }),
    )
    expect(doc.version).toBe(1)
  })
})

describe('getLatestDocument / listDocumentsForOrder / getDocumentPdf', () => {
  let orderId: string
  let v1Number: string

  beforeAll(async () => {
    orderId = await newOrder()
    const v1 = await insertRenderedDocument(db, {
      tenantId,
      docType: 'order_report',
      orderId,
      contextSnapshot: { v: 1 },
      pdfBytes: PDF,
      now: NOW,
    })
    v1Number = v1.number
    await insertRenderedDocument(db, {
      tenantId,
      docType: 'order_report',
      orderId,
      contextSnapshot: { v: 2 },
      pdfBytes: Buffer.from('%PDF-1.7 v2'),
      now: NOW,
    })
  })

  it('getLatestDocument returns the highest version', async () => {
    const latest = await getLatestDocument(db, { tenantId, docType: 'order_report', orderId })
    expect(latest?.version).toBe(2)
    expect(latest?.number).toBe(v1Number)
    expect(latest?.contextSnapshot).toEqual({ v: 2 })
  })

  it('getLatestDocument is tenant-scoped and null for unknown orders', async () => {
    expect(await getLatestDocument(db, { tenantId: otherTenantId, docType: 'order_report', orderId })).toBeNull()
    expect(
      await getLatestDocument(db, { tenantId, docType: 'order_report', orderId: crypto.randomUUID() }),
    ).toBeNull()
  })

  it('listDocumentsForOrder returns metadata only — no byte columns', async () => {
    const list = await listDocumentsForOrder(db, { tenantId, orderId })
    expect(list).toHaveLength(2)
    expect(list.map((d) => d.version)).toEqual([1, 2])
    for (const doc of list) {
      expect(doc.number).toBe(v1Number)
      expect('docxBytes' in doc).toBe(false)
      expect('pdfBytes' in doc).toBe(false)
    }
    expect(await listDocumentsForOrder(db, { tenantId: otherTenantId, orderId })).toEqual([])
  })

  it('getDocumentPdf returns number/version/bytes for a rendered document', async () => {
    const latest = await getLatestDocument(db, { tenantId, docType: 'order_report', orderId })
    const pdf = await getDocumentPdf(db, { tenantId, documentId: latest!.id })
    expect(pdf).not.toBeNull()
    expect(pdf!.number).toBe(v1Number)
    expect(pdf!.version).toBe(2)
    expect(pdf!.pdfBytes.equals(Buffer.from('%PDF-1.7 v2'))).toBe(true)
  })

  it('getDocumentPdf is tenant-scoped and null for unknown ids', async () => {
    const latest = await getLatestDocument(db, { tenantId, docType: 'order_report', orderId })
    expect(await getDocumentPdf(db, { tenantId: otherTenantId, documentId: latest!.id })).toBeNull()
    expect(await getDocumentPdf(db, { tenantId, documentId: crypto.randomUUID() })).toBeNull()
  })

  it('getDocumentPdf returns null when the row has no pdf bytes', async () => {
    const bare = await insertRenderedDocument(db, {
      tenantId,
      docType: 'order_report',
      orderId: await newOrder(),
      contextSnapshot: {},
      now: NOW,
    })
    expect(await getDocumentPdf(db, { tenantId, documentId: bare.id })).toBeNull()
  })
})

describe('templates', () => {
  // Separate tenant so version/activity assertions are isolated from the
  // template rows other suites insert.
  let tId: string

  beforeAll(async () => {
    const [t] = await db.insert(schema.tenants).values({ slug: 't-tpl', name: 'T-TPL' }).returning()
    tId = t.id
  })

  it('getActiveTemplate returns null when none exist', async () => {
    expect(await getActiveTemplate(db, { tenantId: tId, docType: 'order_report' })).toBeNull()
  })

  it('insertTemplate auto-bumps version per (tenant, docType, name)', async () => {
    const v1 = await insertTemplate(db, {
      tenantId: tId,
      docType: 'order_report',
      name: 'standard',
      docx: buildDocxFixture(['v1']),
    })
    const v2 = await insertTemplate(db, {
      tenantId: tId,
      docType: 'order_report',
      name: 'standard',
      docx: buildDocxFixture(['v2']),
    })
    const otherName = await insertTemplate(db, {
      tenantId: tId,
      docType: 'order_report',
      name: 'winter-edition',
      docx: buildDocxFixture(['w1']),
    })
    expect(v1.version).toBe(1)
    expect(v2.version).toBe(2)
    expect(otherName.version).toBe(1) // versions are per name
  })

  it('getActiveTemplate picks the newest active (version desc, created_at desc)', async () => {
    const active = await getActiveTemplate(db, { tenantId: tId, docType: 'order_report' })
    expect(active?.name).toBe('standard')
    expect(active?.version).toBe(2)
    expect(Buffer.isBuffer(active?.docx)).toBe(true)
  })

  it('inactive templates are excluded', async () => {
    await db
      .update(schema.documentTemplates)
      .set({ active: false })
      .where(
        and(
          eq(schema.documentTemplates.tenantId, tId),
          eq(schema.documentTemplates.name, 'standard'),
          eq(schema.documentTemplates.version, 2),
        ),
      )
    const active = await getActiveTemplate(db, { tenantId: tId, docType: 'order_report' })
    // v2 deactivated → highest remaining active version wins (standard v1
    // and winter-edition v1 tie on version; created_at desc breaks the tie
    // toward the newest upload).
    expect(active?.version).toBe(1)
    expect(active?.name).toBe('winter-edition')
  })

  it('getActiveTemplate is docType-scoped', async () => {
    expect(await getActiveTemplate(db, { tenantId: tId, docType: 'order_confirmation' })).toBeNull()
  })

  it('insertTemplate honors active: false', async () => {
    const inactive = await insertTemplate(db, {
      tenantId: tId,
      docType: 'order_confirmation',
      name: 'oc',
      docx: buildDocxFixture(['oc']),
      active: false,
    })
    expect(inactive.active).toBe(false)
    expect(await getActiveTemplate(db, { tenantId: tId, docType: 'order_confirmation' })).toBeNull()
  })

  it('listTemplates returns metadata only, tenant-scoped', async () => {
    const list = await listTemplates(db, { tenantId: tId })
    expect(list.length).toBeGreaterThanOrEqual(4)
    for (const template of list) {
      expect(template.tenantId).toBe(tId)
      expect('docx' in template).toBe(false)
    }
  })

  it('getTemplateById returns the bytes, tenant-scoped', async () => {
    const [row] = await db
      .select({ id: schema.documentTemplates.id })
      .from(schema.documentTemplates)
      .where(and(eq(schema.documentTemplates.tenantId, tId), eq(schema.documentTemplates.name, 'winter-edition')))
    const template = await getTemplateById(db, { tenantId: tId, id: row.id })
    expect(template?.name).toBe('winter-edition')
    expect(Buffer.isBuffer(template?.docx)).toBe(true)
    expect(await getTemplateById(db, { tenantId: otherTenantId, id: row.id })).toBeNull()
    expect(await getTemplateById(db, { tenantId: tId, id: crypto.randomUUID() })).toBeNull()
  })
})

describe('orderHasRenderedReport', () => {
  it('false with no documents, true once an order_report with pdf bytes exists', async () => {
    const orderId = await newOrder()
    expect(await orderHasRenderedReport(db, { tenantId, orderId })).toBe(false)

    await insertRenderedDocument(db, {
      tenantId,
      docType: 'order_report',
      orderId,
      contextSnapshot: {},
      pdfBytes: PDF,
      now: NOW,
    })
    expect(await orderHasRenderedReport(db, { tenantId, orderId })).toBe(true)
    expect(await orderHasRenderedReport(db, { tenantId: otherTenantId, orderId })).toBe(false)
  })

  it('false when the only document has null pdf_bytes', async () => {
    const orderId = await newOrder()
    await insertRenderedDocument(db, {
      tenantId,
      docType: 'order_report',
      orderId,
      contextSnapshot: {},
      now: NOW, // no pdfBytes
    })
    expect(await orderHasRenderedReport(db, { tenantId, orderId })).toBe(false)
  })

  it('ignores non-order_report documents', async () => {
    const orderId = await newOrder()
    await insertRenderedDocument(db, {
      tenantId,
      docType: 'order_confirmation',
      orderId,
      contextSnapshot: {},
      pdfBytes: PDF,
      now: NOW,
    })
    expect(await orderHasRenderedReport(db, { tenantId, orderId })).toBe(false)
  })
})
