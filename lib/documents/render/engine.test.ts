// lib/documents/render/engine.test.ts
//
// WS12 Task 6 — render engine: claim → context → template-else-builtin →
// Gotenberg → insertRenderedDocument → done, with the WS4 backoff taxonomy
// on failure. DB-backed via the local-Postgres harness; Gotenberg is a local
// node:http stub returning %PDF- bytes (the gotenberg.test.ts technique),
// injected via the engine's `env` parameter — process.env is never touched.
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import PizZip from 'pizzip'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { buildDocxFixture } from '../docx/fixture'
import { insertTemplate, listDocumentsForOrder } from '../store'
import { enqueueRenderJob } from './store'
import { processRenderJobs } from './engine'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

let tenantId: string
let erpCompanyId: string
let customerId: string
let techId: string

const NOW = new Date('2026-07-20T10:00:00Z')
const MINUTE = 60_000
const FAKE_PDF = '%PDF-1.7\nfake pdf bytes for tests'

// ——— Gotenberg stub (gotenberg.test.ts technique) ————————————————————————

const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

async function startStub(
  respond: (res: ServerResponse) => void,
): Promise<{ url: string; requests: { url: string }[] }> {
  const requests: { url: string }[] = []
  const server = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      requests.push({ url: req.url ?? '' })
      respond(res)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, requests }
}

function servePdf(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/pdf' })
  res.end(FAKE_PDF)
}

// ——— fixture ——————————————————————————————————————————————————————————————

/** Seed an order with one approved worksheet (rows + time), lib/documents/
 *  context.test.ts style. Returns the order id. */
async function seedOrder({ withWorksheet = true }: { withWorksheet?: boolean } = {}): Promise<string> {
  const [order] = await db
    .insert(schema.serviceOrders)
    .values({
      tenantId,
      customerId,
      orderNumber: 'SVO-9001',
      description: 'Annual maintenance',
      changeSeq: BigInt(0),
    })
    .returning()

  if (withWorksheet) {
    const [ws] = await db
      .insert(schema.worksheets)
      .values({
        tenantId,
        orderId: order.id,
        technicianUserId: techId,
        status: 'Approved',
        workDescription: 'Replaced filter',
        changeSeq: BigInt(0),
      })
      .returning()
    await db.insert(schema.worksheetRows).values({
      worksheetId: ws.id,
      description: 'Filter F7',
      quantity: '2',
      chargeType: 'invoiceable',
    })
    await db.insert(schema.timeEntries).values({ worksheetId: ws.id, kind: 'work', minutes: 60 })
  }

  return order.id
}

async function jobById(id: string) {
  const [row] = await db
    .select()
    .from(schema.documentRenderJobs)
    .where(eq(schema.documentRenderJobs.id, id))
  return row
}

async function docsForOrder(orderId: string) {
  return db
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.orderId, orderId))
    .orderBy(schema.documents.version)
}

/** Enqueue a job and force it due at the fixed NOW. The table default
 *  next_attempt_at = now() is real wall-clock time, which can land AFTER the
 *  test's fixed NOW and make claimDueJobs({ now: NOW }) skip the row — a
 *  time-of-day flake (green before 10:00 UTC, red after). Backdating to NOW
 *  makes claiming deterministic while keeping NOW fixed for the renderedAt /
 *  backoff assertions. */
async function enqueueDue(
  input: Parameters<typeof enqueueRenderJob>[1],
): Promise<schema.DocumentRenderJobRow> {
  const job = await enqueueRenderJob(db, input)
  const [row] = await db
    .update(schema.documentRenderJobs)
    .set({ nextAttemptAt: NOW })
    .where(eq(schema.documentRenderJobs.id, job.id))
    .returning()
  return row
}

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db
    .insert(schema.tenants)
    .values({
      slug: 't1',
      name: 'Herbe Test OÜ',
      branding: { locale: 'en', accentColor: '#ff6600', footerText: 'Test footer' },
    })
    .returning()
  tenantId = tenant.id
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
  const [tech] = await db
    .insert(schema.users)
    .values({ tenantId, email: 'tech@example.test' })
    .returning()
  techId = tech.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('processRenderJobs — built-in report path', () => {
  it('renders the order to a PDF document, marks the job done, and reports the summary', async () => {
    const { url, requests } = await startStub(servePdf)
    const orderId = await seedOrder()
    const job = await enqueueDue({ tenantId, docType: 'order_report', orderId, trigger: 'approval' })

    const summary = await processRenderJobs(db, { now: NOW, env: { GOTENBERG_URL: url } })

    expect(summary.claimed).toBe(1)
    expect(summary.rendered).toBe(1)
    expect(summary.failed).toBe(0)
    expect(summary.dead).toBe(0)
    expect(summary.results).toHaveLength(1)
    expect(summary.results[0].jobId).toBe(job.id)
    expect(summary.results[0].orderId).toBe(orderId)
    expect(summary.results[0].status).toBe('rendered')
    expect(summary.results[0].number).toBe('SR-2026-00001')
    expect(summary.results[0].error).toBeUndefined()

    // Built-in path goes through the Chromium HTML route.
    expect(requests.map((r) => r.url)).toEqual(['/forms/chromium/convert/html'])

    const [doc] = await docsForOrder(orderId)
    expect(doc.id).toBe(summary.results[0].documentId)
    expect(doc.number).toBe('SR-2026-00001')
    expect(doc.version).toBe(1)
    expect(doc.templateId).toBeNull()
    expect(doc.docxBytes).toBeNull()
    expect(doc.pdfBytes?.subarray(0, 5).toString()).toBe('%PDF-')
    expect(doc.renderedAt.getTime()).toBe(NOW.getTime())
    // Context snapshot is the built merge context.
    const snapshot = doc.contextSnapshot as { customer: { name: string }; meta: { orderId: string } }
    expect(snapshot.customer.name).toBe('Acme OÜ')
    expect(snapshot.meta.orderId).toBe(orderId)

    expect((await jobById(job.id)).status).toBe('done')
  })

  it('re-render after a new enqueue creates version 2 with the SAME number', async () => {
    const { url } = await startStub(servePdf)
    const orderId = await seedOrder()

    await enqueueDue({ tenantId, docType: 'order_report', orderId, trigger: 'approval' })
    await processRenderJobs(db, { now: NOW, env: { GOTENBERG_URL: url } })
    await enqueueDue({ tenantId, docType: 'order_report', orderId, trigger: 'manual' })
    const summary = await processRenderJobs(db, { now: NOW, env: { GOTENBERG_URL: url } })

    expect(summary.rendered).toBe(1)
    const docs = await docsForOrder(orderId)
    expect(docs).toHaveLength(2)
    expect(docs[1].version).toBe(2)
    expect(docs[1].number).toBe(docs[0].number)
  })

  it('an order with zero approved worksheets still renders (decision: emptiness is transient — the report states "no worksheets")', async () => {
    const { url } = await startStub(servePdf)
    const orderId = await seedOrder({ withWorksheet: false })
    await enqueueDue({ tenantId, docType: 'order_report', orderId, trigger: 'manual' })

    const summary = await processRenderJobs(db, { now: NOW, env: { GOTENBERG_URL: url } })

    expect(summary.rendered).toBe(1)
    const [doc] = await docsForOrder(orderId)
    expect(doc.pdfBytes?.subarray(0, 5).toString()).toBe('%PDF-')
    expect((doc.contextSnapshot as { worksheetSections: unknown[] }).worksheetSections).toEqual([])
  })

  it('claims nothing when no jobs are due', async () => {
    const summary = await processRenderJobs(db, { now: NOW, env: {} })
    expect(summary).toEqual({ claimed: 0, rendered: 0, failed: 0, dead: 0, results: [] })
  })
})

describe('processRenderJobs — template path', () => {
  it('merges the active DOCX template, converts via LibreOffice, stores BOTH docx and pdf bytes', async () => {
    const { url, requests } = await startStub(servePdf)
    const template = await insertTemplate(db, {
      tenantId,
      docType: 'order_report',
      name: 'standard',
      docx: buildDocxFixture(['Customer: {customer.name}', 'Order: {order.number}']),
    })
    const orderId = await seedOrder()
    await enqueueDue({ tenantId, docType: 'order_report', orderId, trigger: 'approval' })

    const summary = await processRenderJobs(db, { now: NOW, env: { GOTENBERG_URL: url } })

    expect(summary.rendered).toBe(1)
    expect(requests.map((r) => r.url)).toEqual(['/forms/libreoffice/convert'])

    const [doc] = await docsForOrder(orderId)
    expect(doc.templateId).toBe(template.id)
    expect(doc.templateVersion).toBe(template.version)
    expect(doc.pdfBytes?.subarray(0, 5).toString()).toBe('%PDF-')
    // The stored docx is the MERGED result: unzip and assert the customer
    // name replaced the placeholder.
    expect(doc.docxBytes).not.toBeNull()
    const documentXml = new PizZip(doc.docxBytes!).file('word/document.xml')!.asText()
    expect(documentXml).toContain('Customer: Acme OÜ')
    expect(documentXml).toContain('Order: SVO-9001')
    expect(documentXml).not.toContain('{customer.name}')
  })

  afterAll(async () => {
    // Deactivate the template so later suites exercise the built-in path.
    await db
      .update(schema.documentTemplates)
      .set({ active: false })
      .where(eq(schema.documentTemplates.tenantId, tenantId))
  })
})

describe('processRenderJobs — failure paths', () => {
  it('converter unconfigured: job stays queued with attempts=1 and backoff, no document inserted', async () => {
    const orderId = await seedOrder()
    const job = await enqueueDue({ tenantId, docType: 'order_report', orderId, trigger: 'approval' })

    const summary = await processRenderJobs(db, { now: NOW, env: {} })

    expect(summary.claimed).toBe(1)
    expect(summary.rendered).toBe(0)
    expect(summary.failed).toBe(1)
    expect(summary.dead).toBe(0)
    expect(summary.results[0].status).toBe('failed')
    expect(summary.results[0].error).toContain('GOTENBERG_URL')

    const row = await jobById(job.id)
    expect(row.status).toBe('queued')
    expect(row.attempts).toBe(1)
    expect(row.lastError).toContain('GOTENBERG_URL')
    expect(row.nextAttemptAt.getTime()).toBe(NOW.getTime() + 2 * MINUTE)

    expect(await docsForOrder(orderId)).toEqual([])
  })

  it('converter 500: same retry path', async () => {
    const { url } = await startStub((res) => {
      res.writeHead(500)
      res.end('conversion blew up')
    })
    const orderId = await seedOrder()
    const job = await enqueueDue({ tenantId, docType: 'order_report', orderId, trigger: 'approval' })

    const summary = await processRenderJobs(db, { now: NOW, env: { GOTENBERG_URL: url } })

    expect(summary.failed).toBe(1)
    const row = await jobById(job.id)
    expect(row.status).toBe('queued')
    expect(row.attempts).toBe(1)
    expect(row.lastError).toContain('500')
    expect(await docsForOrder(orderId)).toEqual([])
  })

  it('order soft-deleted after enqueue: failed path', async () => {
    const { url } = await startStub(servePdf)
    const orderId = await seedOrder()
    const job = await enqueueDue({ tenantId, docType: 'order_report', orderId, trigger: 'approval' })
    await db
      .update(schema.serviceOrders)
      .set({ deletedAt: new Date() })
      .where(eq(schema.serviceOrders.id, orderId))

    const summary = await processRenderJobs(db, { now: NOW, env: { GOTENBERG_URL: url } })

    expect(summary.failed).toBe(1)
    expect(summary.results[0].error).toContain('not found')
    expect((await jobById(job.id)).status).toBe('queued')
    expect(await docsForOrder(orderId)).toEqual([])
  })

  it('a job on its 8th attempt goes dead', async () => {
    const orderId = await seedOrder()
    const job = await enqueueDue({ tenantId, docType: 'order_report', orderId, trigger: 'manual' })
    await db
      .update(schema.documentRenderJobs)
      .set({ attempts: 7 })
      .where(eq(schema.documentRenderJobs.id, job.id))

    const summary = await processRenderJobs(db, { now: NOW, env: {} })

    expect(summary.failed).toBe(0)
    expect(summary.dead).toBe(1)
    expect(summary.results[0].status).toBe('dead')
    expect((await jobById(job.id)).status).toBe('dead')
  })

  it('PER-JOB ISOLATION: a failing job does not stop the next one from rendering', async () => {
    const { url } = await startStub(servePdf)
    const brokenOrderId = await seedOrder()
    const goodOrderId = await seedOrder()
    const brokenJob = await enqueueDue({ tenantId, docType: 'order_report', orderId: brokenOrderId, trigger: 'manual' })
    const goodJob = await enqueueDue({ tenantId, docType: 'order_report', orderId: goodOrderId, trigger: 'manual' })
    // Make the broken job claim first (oldest created_at).
    await db.update(schema.documentRenderJobs).set({ createdAt: new Date('2026-07-20T08:00:00Z') }).where(eq(schema.documentRenderJobs.id, brokenJob.id))
    await db
      .update(schema.serviceOrders)
      .set({ deletedAt: new Date() })
      .where(eq(schema.serviceOrders.id, brokenOrderId))

    const summary = await processRenderJobs(db, { now: NOW, env: { GOTENBERG_URL: url } })

    expect(summary.claimed).toBe(2)
    expect(summary.failed).toBe(1)
    expect(summary.rendered).toBe(1)
    const byJob = new Map(summary.results.map((r) => [r.jobId, r]))
    expect(byJob.get(brokenJob.id)?.status).toBe('failed')
    expect(byJob.get(goodJob.id)?.status).toBe('rendered')
    expect(await docsForOrder(goodOrderId)).toHaveLength(1)
    expect((await jobById(goodJob.id)).status).toBe('done')
  })

  it('respects the claim limit', async () => {
    const { url } = await startStub(servePdf)
    await enqueueDue({ tenantId, docType: 'order_report', orderId: await seedOrder(), trigger: 'manual' })
    await enqueueDue({ tenantId, docType: 'order_report', orderId: await seedOrder(), trigger: 'manual' })

    const summary = await processRenderJobs(db, { now: NOW, limit: 1, env: { GOTENBERG_URL: url } })
    expect(summary.claimed).toBe(1)

    const rest = await processRenderJobs(db, { now: NOW, limit: 10, env: { GOTENBERG_URL: url } })
    expect(rest.claimed).toBe(1)
  })
})
