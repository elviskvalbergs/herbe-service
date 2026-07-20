// __tests__/db/documents-migration.test.ts
//
// WS12 Task 1 (docs/superpowers/plans/2026-07-20-service-phase1-ws12-documents.md
// decision 4): migration 0021 shape tests. Same two-layer convention as the
// 0002-0007 suites in migrate.test.ts — (a) the runner path is a clean no-op
// on a second run, (b) the raw SQL is independently re-runnable, bypassing
// herbe_migrations.applied entirely. On top of that, inserts through the
// drizzle mirror prove drizzle/schema.ts matches the SQL (column names,
// nullability, defaults, FK chain tenant -> series -> document), and the
// (tenant_id, doc_type, order_id, version) unique constraint is exercised.
import fs from 'node:fs'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations, splitSqlStatements } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'

// Drizzle wraps driver errors in a DrizzleQueryError whose message is the
// failed query text; the Postgres error (with .code) is the `cause`. Unique
// violations are SQLSTATE 23505.
async function expectUniqueViolation(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(Error)
  const cause = (err as Error).cause as { code?: string } | undefined
  expect(cause?.code).toBe('23505')
}

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string
let erpCompanyId: string
let orderId: string

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
    .values({ tenantId, erpCompanyId, erpRef: 'CU-1', name: 'Customer 1', changeSeq: BigInt(0) })
    .returning()
  const [order] = await db
    .insert(schema.serviceOrders)
    .values({ tenantId, customerId: customer.id, changeSeq: BigInt(0) })
    .returning()
  orderId = order.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('0021 documents migration', () => {
  it('is a clean no-op on a second runMigrations against the same database', async () => {
    await expect(runMigrations(testDb.url)).resolves.toBeUndefined()
  })

  it('re-executes 0021_documents.sql twice more, bypassing herbe_migrations.applied, with no thrown error', async () => {
    // Same raw-re-execution convention as the 0002-0007 suites: the SQL text
    // itself — not the runner's filename tracking — is what's proven idempotent.
    const content = fs.readFileSync(path.resolve('scripts/migrations/0021_documents.sql'), 'utf8')
    const statements = splitSqlStatements(content)

    for (let pass = 0; pass < 2; pass++) {
      for (const stmt of statements) {
        await sql.unsafe(stmt)
      }
    }

    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('document_templates', 'document_number_series', 'documents', 'document_render_jobs')
    `
    expect(rows.map((r) => r.table_name).sort()).toEqual([
      'document_number_series',
      'document_render_jobs',
      'document_templates',
      'documents',
    ])
  })

  it('accepts a drizzle insert into each new table through the full FK chain (tenant -> series/template -> document; render job)', async () => {
    const [template] = await db
      .insert(schema.documentTemplates)
      .values({ tenantId, docType: 'order_report', name: 'Custom report', docx: Buffer.from('PK-docx') })
      .returning()
    expect(template.version).toBe(1)
    expect(template.active).toBe(true)

    const [series] = await db
      .insert(schema.documentNumberSeries)
      .values({ tenantId, docType: 'order_report', prefix: 'SR' })
      .returning()
    expect(series.nextCounter).toBe(1)

    const [doc] = await db
      .insert(schema.documents)
      .values({
        tenantId,
        docType: 'order_report',
        orderId,
        number: 'SR-2026-00001',
        seriesId: series.id,
        templateId: template.id,
        templateVersion: template.version,
        contextSnapshot: { order: { id: orderId } },
        pdfBytes: Buffer.from('%PDF-fake'),
      })
      .returning()
    expect(doc.version).toBe(1)
    expect(doc.number).toBe('SR-2026-00001')
    expect(doc.templateId).toBe(template.id)
    expect(doc.docxBytes).toBeNull() // nullable — built-in path may skip DOCX
    expect(doc.renderedAt).toBeInstanceOf(Date)

    const [job] = await db
      .insert(schema.documentRenderJobs)
      .values({ tenantId, erpCompanyId, docType: 'order_report', orderId, trigger: 'approval' })
      .returning()
    expect(job.status).toBe('queued')
    expect(job.attempts).toBe(0)
    expect(job.nextAttemptAt).toBeInstanceOf(Date)
    expect(job.lastError).toBeNull()
  })

  it('rejects a duplicate (tenant_id, doc_type, order_id, version) document', async () => {
    const [series] = await db
      .insert(schema.documentNumberSeries)
      .values({ tenantId, docType: 'order_confirmation', prefix: 'OC' })
      .returning()

    const values = {
      tenantId,
      docType: 'order_confirmation',
      orderId,
      number: 'OC-2026-00001',
      seriesId: series.id,
      version: 1,
      contextSnapshot: {},
    }
    await db.insert(schema.documents).values(values)
    await expectUniqueViolation(db.insert(schema.documents).values(values))
  })

  it('enforces UNIQUE (tenant_id, doc_type) on document_number_series', async () => {
    await expectUniqueViolation(
      db.insert(schema.documentNumberSeries).values({ tenantId, docType: 'order_report', prefix: 'XX' }),
    )
  })

  it('adds a nullable tenants.branding jsonb column that round-trips through the drizzle mirror', async () => {
    const [bare] = await db.insert(schema.tenants).values({ slug: 't-bare', name: 'Bare' }).returning()
    expect(bare.branding).toBeNull()

    const branding = { locale: 'lv', accentColor: '#004466' }
    const [themed] = await db
      .insert(schema.tenants)
      .values({ slug: 't-themed', name: 'Themed', branding })
      .returning()
    expect(themed.branding).toEqual(branding)
  })
})
