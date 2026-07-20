// app/api/admin/document-templates/route.test.ts
//
// WS12 Task 8 (docs/superpowers/plans/2026-07-20-service-phase1-ws12-documents.md
// decision 9): admin template upload+validate + list routes. Mirrors the
// documents-tick route test harness — `./route` transitively imports
// `@/lib/db`, which reads DATABASE_URL at module-load time, so DATABASE_URL
// must point at the harness DB BEFORE the route is first dynamically imported.
//
// The ADMIN_MIGRATIONS_SECRET is saved in beforeEach and restored in afterEach
// so env mutation (incl. the fail-closed "unset" case) never leaks into other
// suites.
import { and, eq } from 'drizzle-orm'
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

const SECRET = 'test-admin-secret'
let savedSecret: string | undefined

const URL_BASE = 'http://x/api/admin/document-templates'

function bearer(token = SECRET): { authorization: string } {
  return { authorization: `Bearer ${token}` }
}

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  process.env.DATABASE_URL = testDb.url

  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 'tpl', name: 'Tpl OÜ' }).returning()
  tenantId = tenant.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

beforeEach(() => {
  savedSecret = process.env.ADMIN_MIGRATIONS_SECRET
  process.env.ADMIN_MIGRATIONS_SECRET = SECRET
})

afterEach(() => {
  if (savedSecret === undefined) delete process.env.ADMIN_MIGRATIONS_SECRET
  else process.env.ADMIN_MIGRATIONS_SECRET = savedSecret
})

describe('auth (POST + GET)', () => {
  it('POST 401 with no bearer header', async () => {
    const { POST } = await import('./route')
    const res = await POST(new Request(URL_BASE, { method: 'POST', body: '{}' }))
    expect(res.status).toBe(401)
  })

  it('POST 401 with the wrong bearer token', async () => {
    const { POST } = await import('./route')
    const res = await POST(
      new Request(URL_BASE, { method: 'POST', headers: bearer('nope'), body: '{}' }),
    )
    expect(res.status).toBe(401)
  })

  it('POST 401 (fail-closed) when ADMIN_MIGRATIONS_SECRET is unset even with a bearer', async () => {
    delete process.env.ADMIN_MIGRATIONS_SECRET
    const { POST } = await import('./route')
    const res = await POST(new Request(URL_BASE, { method: 'POST', headers: bearer(), body: '{}' }))
    expect(res.status).toBe(401)
  })

  it('GET 401 with no bearer header', async () => {
    const { GET } = await import('./route')
    const res = await GET(new Request(`${URL_BASE}?tenantId=${tenantId}`))
    expect(res.status).toBe(401)
  })

  it('GET 401 with the wrong bearer token', async () => {
    const { GET } = await import('./route')
    const res = await GET(new Request(`${URL_BASE}?tenantId=${tenantId}`, { headers: bearer('nope') }))
    expect(res.status).toBe(401)
  })

  it('GET 401 (fail-closed) when ADMIN_MIGRATIONS_SECRET is unset even with a bearer', async () => {
    delete process.env.ADMIN_MIGRATIONS_SECRET
    const { GET } = await import('./route')
    const res = await GET(new Request(`${URL_BASE}?tenantId=${tenantId}`, { headers: bearer() }))
    expect(res.status).toBe(401)
  })
})

describe('POST /api/admin/document-templates — create', () => {
  it('accepts a valid DOCX: 201, metadata only (no bytes), row persisted WITH bytes', async () => {
    const docx = buildDocxFixture(['{customer.name}', '{order.number}'])
    const { POST } = await import('./route')
    const res = await POST(
      new Request(URL_BASE, {
        method: 'POST',
        headers: bearer(),
        body: JSON.stringify({
          tenantId,
          docType: 'order_report',
          name: 'Happy template',
          docxBase64: docx.toString('base64'),
        }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.status).toBe('ok')
    expect(Object.keys(body.template).sort()).toEqual(
      ['active', 'createdAt', 'docType', 'id', 'name', 'version'].sort(),
    )
    expect(body.template).toMatchObject({
      docType: 'order_report',
      name: 'Happy template',
      version: 1,
      active: true,
    })
    // No byte columns leak into the response.
    expect(body.template).not.toHaveProperty('docx')
    expect(body.template).not.toHaveProperty('docxBytes')

    // The row landed WITH its bytes.
    const [row] = await db
      .select()
      .from(schema.documentTemplates)
      .where(eq(schema.documentTemplates.id, body.template.id))
    expect(row.docx.equals(docx)).toBe(true)
  })

  it('rejects a template with an unknown placeholder: 422 with errors, no row inserted', async () => {
    const docx = buildDocxFixture(['{customer.unknownField}'])
    const { POST } = await import('./route')
    const res = await POST(
      new Request(URL_BASE, {
        method: 'POST',
        headers: bearer(),
        body: JSON.stringify({
          tenantId,
          docType: 'order_report',
          name: 'Bad placeholder',
          docxBase64: docx.toString('base64'),
        }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(422)
    expect(body.status).toBe('invalid')
    expect(Array.isArray(body.errors)).toBe(true)
    expect(body.errors.length).toBeGreaterThan(0)

    const rows = await db
      .select()
      .from(schema.documentTemplates)
      .where(
        and(eq(schema.documentTemplates.tenantId, tenantId), eq(schema.documentTemplates.name, 'Bad placeholder')),
      )
    expect(rows).toHaveLength(0)
  })

  it('rejects an unclosed loop: 422 with errors, no row inserted', async () => {
    const docx = buildDocxFixture(['{#worksheetSections}{workDescription}'])
    const { POST } = await import('./route')
    const res = await POST(
      new Request(URL_BASE, {
        method: 'POST',
        headers: bearer(),
        body: JSON.stringify({
          tenantId,
          docType: 'order_report',
          name: 'Unclosed loop',
          docxBase64: docx.toString('base64'),
        }),
      }),
    )
    expect(res.status).toBe(422)

    const rows = await db
      .select()
      .from(schema.documentTemplates)
      .where(and(eq(schema.documentTemplates.tenantId, tenantId), eq(schema.documentTemplates.name, 'Unclosed loop')))
    expect(rows).toHaveLength(0)
  })

  it('400 on invalid JSON body', async () => {
    const { POST } = await import('./route')
    const res = await POST(new Request(URL_BASE, { method: 'POST', headers: bearer(), body: 'not json' }))
    expect(res.status).toBe(400)
  })

  it('400 on a missing name', async () => {
    const docx = buildDocxFixture(['{customer.name}'])
    const { POST } = await import('./route')
    const res = await POST(
      new Request(URL_BASE, {
        method: 'POST',
        headers: bearer(),
        body: JSON.stringify({ tenantId, docType: 'order_report', docxBase64: docx.toString('base64') }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('400 on a bad tenantId', async () => {
    const docx = buildDocxFixture(['{customer.name}'])
    const { POST } = await import('./route')
    const res = await POST(
      new Request(URL_BASE, {
        method: 'POST',
        headers: bearer(),
        body: JSON.stringify({
          tenantId: 'not-a-uuid',
          docType: 'order_report',
          name: 'X',
          docxBase64: docx.toString('base64'),
        }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('400 on a non-base64 docxBase64', async () => {
    const { POST } = await import('./route')
    const res = await POST(
      new Request(URL_BASE, {
        method: 'POST',
        headers: bearer(),
        body: JSON.stringify({
          tenantId,
          docType: 'order_report',
          name: 'X',
          docxBase64: 'not valid base64 @@@',
        }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('400 on an empty docType', async () => {
    const docx = buildDocxFixture(['{customer.name}'])
    const { POST } = await import('./route')
    const res = await POST(
      new Request(URL_BASE, {
        method: 'POST',
        headers: bearer(),
        body: JSON.stringify({ tenantId, docType: '', name: 'X', docxBase64: docx.toString('base64') }),
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe('GET /api/admin/document-templates — list', () => {
  it('returns seeded templates metadata (no bytes)', async () => {
    const [listTenant] = await db.insert(schema.tenants).values({ slug: 'list', name: 'List OÜ' }).returning()
    await insertTemplate(db, {
      tenantId: listTenant.id,
      docType: 'order_report',
      name: 'A',
      docx: buildDocxFixture(['{customer.name}']),
    })
    await insertTemplate(db, {
      tenantId: listTenant.id,
      docType: 'order_confirmation',
      name: 'B',
      docx: buildDocxFixture(['{order.number}']),
    })

    const { GET } = await import('./route')
    const res = await GET(new Request(`${URL_BASE}?tenantId=${listTenant.id}`, { headers: bearer() }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.templates).toHaveLength(2)
    for (const t of body.templates) {
      expect(t).not.toHaveProperty('docx')
      expect(t).not.toHaveProperty('docxBytes')
      expect(t).toHaveProperty('id')
      expect(t).toHaveProperty('name')
    }
  })

  it('400 on a missing tenantId', async () => {
    const { GET } = await import('./route')
    const res = await GET(new Request(URL_BASE, { headers: bearer() }))
    expect(res.status).toBe(400)
  })

  it('400 on a bad tenantId', async () => {
    const { GET } = await import('./route')
    const res = await GET(new Request(`${URL_BASE}?tenantId=not-a-uuid`, { headers: bearer() }))
    expect(res.status).toBe(400)
  })
})
