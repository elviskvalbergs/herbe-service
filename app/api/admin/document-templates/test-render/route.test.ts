// app/api/admin/document-templates/test-render/route.test.ts
//
// WS12 Task 8 (decision 9): the admin test-render route drives the full
// merge+validate+render(+convert) pipeline against a REAL order and returns
// the validation report plus byte SIZES only — never the file bytes. Mirrors
// documents-tick's harness: `./route` transitively imports `@/lib/db`, so
// DATABASE_URL must point at the harness DB before the first dynamic import.
// GOTENBERG_URL is deleted by default (converterConfigured=false, pdfBytes
// null) and only set — to a local %PDF- stub — inside the configured-path
// test, save/restored so it can't leak.
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { buildDocxFixture } from '@/lib/documents/docx/fixture'
import { insertTemplate } from '@/lib/documents/store'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

let tenantId: string
let orderId: string

const SECRET = 'test-admin-secret'
let savedSecret: string | undefined
let savedGotenberg: string | undefined

const URL_BASE = 'http://x/api/admin/document-templates/test-render'
const FAKE_PDF = '%PDF-1.7\nfake pdf bytes for tests'

function bearer(token = SECRET): { authorization: string } {
  return { authorization: `Bearer ${token}` }
}

// ——— Gotenberg %PDF- stub (documents-tick technique) ————————————————————
const servers: Server[] = []

async function startPdfStub(): Promise<string> {
  const server = createServer((req, res: ServerResponse) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/pdf' })
      res.end(FAKE_PDF)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

async function seedTemplate(paragraphs: string[], docType = 'order_report'): Promise<string> {
  const tpl = await insertTemplate(db, {
    tenantId,
    docType,
    name: `tpl-${crypto.randomUUID()}`,
    docx: buildDocxFixture(paragraphs),
  })
  return tpl.id
}

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  process.env.DATABASE_URL = testDb.url

  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 'tr', name: 'TestRender OÜ' }).returning()
  tenantId = tenant.id
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName: 'C1', adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  const [customer] = await db
    .insert(schema.customers)
    .values({ tenantId, erpCompanyId: company.id, erpRef: 'CUST-1', name: 'Acme OÜ', changeSeq: BigInt(0) })
    .returning()
  const [order] = await db
    .insert(schema.serviceOrders)
    .values({ tenantId, customerId: customer.id, orderNumber: 'SVO-TR-1', description: 'Test render', changeSeq: BigInt(0) })
    .returning()
  orderId = order.id
  await db
    .insert(schema.worksheets)
    .values({ tenantId, orderId, status: 'Approved', workDescription: 'Did the work', changeSeq: BigInt(0) })
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

beforeEach(() => {
  savedSecret = process.env.ADMIN_MIGRATIONS_SECRET
  savedGotenberg = process.env.GOTENBERG_URL
  process.env.ADMIN_MIGRATIONS_SECRET = SECRET
  delete process.env.GOTENBERG_URL
})

afterEach(async () => {
  if (savedSecret === undefined) delete process.env.ADMIN_MIGRATIONS_SECRET
  else process.env.ADMIN_MIGRATIONS_SECRET = savedSecret
  if (savedGotenberg === undefined) delete process.env.GOTENBERG_URL
  else process.env.GOTENBERG_URL = savedGotenberg

  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

function post(body: unknown, headers = bearer()): Promise<Response> {
  return import('./route').then(({ POST }) =>
    POST(new Request(URL_BASE, { method: 'POST', headers, body: JSON.stringify(body) })),
  )
}

describe('auth', () => {
  it('401 with no bearer header', async () => {
    const res = await post({ tenantId, templateId: crypto.randomUUID(), orderId }, {} as never)
    expect(res.status).toBe(401)
  })

  it('401 with the wrong bearer token', async () => {
    const res = await post({ tenantId, templateId: crypto.randomUUID(), orderId }, bearer('nope'))
    expect(res.status).toBe(401)
  })

  it('401 (fail-closed) when ADMIN_MIGRATIONS_SECRET is unset even with a bearer', async () => {
    delete process.env.ADMIN_MIGRATIONS_SECRET
    const res = await post({ tenantId, templateId: crypto.randomUUID(), orderId })
    expect(res.status).toBe(401)
  })
})

describe('POST /api/admin/document-templates/test-render', () => {
  it('happy path: 200, validation.ok, docxBytes>0, converter unconfigured → pdfBytes null', async () => {
    const templateId = await seedTemplate([
      '{customer.name}',
      '{#worksheetSections}{workDescription}{/worksheetSections}',
    ])
    const res = await post({ tenantId, templateId, orderId })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.validation.ok).toBe(true)
    expect(body.validation.errors).toEqual([])
    expect(body.docxBytes).toBeGreaterThan(0)
    expect(body.converterConfigured).toBe(false)
    expect(body.pdfBytes).toBeNull()
    // Sizes only — no file bytes anywhere in the payload.
    expect(Object.keys(body).sort()).toEqual(
      ['converterConfigured', 'docxBytes', 'pdfBytes', 'status', 'validation'].sort(),
    )
    expect(body).not.toHaveProperty('docx')
  })

  it('converts when GOTENBERG_URL is set: converterConfigured true, pdfBytes>0', async () => {
    process.env.GOTENBERG_URL = await startPdfStub()
    const templateId = await seedTemplate(['{customer.name}'])
    const res = await post({ tenantId, templateId, orderId })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.converterConfigured).toBe(true)
    expect(body.pdfBytes).toBe(Buffer.byteLength(FAKE_PDF))
    expect(body).not.toHaveProperty('pdf')
  })

  it('surfaces validation errors for a bad placeholder against the real context (200, ok:false)', async () => {
    const templateId = await seedTemplate(['{customer.unknownField}'])
    const res = await post({ tenantId, templateId, orderId })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.validation.ok).toBe(false)
    expect(body.validation.errors.length).toBeGreaterThan(0)
    // Missing leaves render as '' (nullGetter) — the docx still built.
    expect(body.docxBytes).toBeGreaterThan(0)
  })

  it('422 when the template is structurally broken (unclosed loop)', async () => {
    const templateId = await seedTemplate(['{#worksheetSections}{workDescription}'])
    const res = await post({ tenantId, templateId, orderId })
    const body = await res.json()

    expect(res.status).toBe(422)
    expect(body.status).toBe('invalid')
    expect(body.errors.length).toBeGreaterThan(0)
  })

  it('404 for an unknown templateId', async () => {
    const res = await post({ tenantId, templateId: crypto.randomUUID(), orderId })
    expect(res.status).toBe(404)
  })

  it('404 for an unknown orderId', async () => {
    const templateId = await seedTemplate(['{customer.name}'])
    const res = await post({ tenantId, templateId, orderId: crypto.randomUUID() })
    expect(res.status).toBe(404)
  })

  it('400 on a bad templateId', async () => {
    const res = await post({ tenantId, templateId: 'nope', orderId })
    expect(res.status).toBe(400)
  })

  it('400 on invalid JSON body', async () => {
    const { POST } = await import('./route')
    const res = await POST(new Request(URL_BASE, { method: 'POST', headers: bearer(), body: 'not json' }))
    expect(res.status).toBe(400)
  })
})
