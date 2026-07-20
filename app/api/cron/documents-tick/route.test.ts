// app/api/cron/documents-tick/route.test.ts
//
// Uses the local-Postgres test harness (lib/test-support/db.ts), not
// Testcontainers. `@/app/api/cron/documents-tick/route` transitively imports
// `@/lib/db`, which reads DATABASE_URL at module-load time, so DATABASE_URL
// must point at the harness DB *before* the route is first dynamically
// imported — same constraint as app/api/cron/push-tick/route.test.ts, whose
// auth/lock test shape this file mirrors.
//
// This is a unit test of the ROUTE itself (auth, lock, and that it drives the
// real render engine). Unlike push-tick, nothing is mocked: the route calls
// processRenderJobs directly, so the happy path seeds a real order, enqueues a
// job, and points GOTENBERG_URL at a local node:http stub returning %PDF-
// bytes (the lib/documents/render/engine.test.ts technique). The engine's own
// failure/backoff taxonomy is covered by that engine test.
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { enqueueRenderJob } from '@/lib/documents/render/store'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

let tenantId: string
let customerId: string

const FAKE_PDF = '%PDF-1.7\nfake pdf bytes for tests'

// ——— Gotenberg stub (engine.test.ts technique) ———————————————————————————
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  delete process.env.GOTENBERG_URL
})

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

async function seedOrder(): Promise<string> {
  const [order] = await db
    .insert(schema.serviceOrders)
    .values({ tenantId, customerId, orderNumber: 'SVO-CRON-1', description: 'Cron render', changeSeq: BigInt(0) })
    .returning()
  return order.id
}

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  process.env.DATABASE_URL = testDb.url
  process.env.CRON_SECRET = 'test-secret'

  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 'docs-tick', name: 'Docs Tick OÜ' }).returning()
  tenantId = tenant.id
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName: 'C1', adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  const [customer] = await db
    .insert(schema.customers)
    .values({ tenantId, erpCompanyId: company.id, erpRef: 'CUST-1', name: 'Acme OÜ', changeSeq: BigInt(0) })
    .returning()
  customerId = customer.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('GET /api/cron/documents-tick', () => {
  it('rejects a request with no bearer header', async () => {
    const { GET } = await import('./route')
    const res = await GET(new Request('http://x/api/cron/documents-tick'))
    expect(res.status).toBe(401)
  })

  it('rejects a request with the wrong bearer token', async () => {
    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://x/api/cron/documents-tick', { headers: { authorization: 'Bearer wrong-secret' } }),
    )
    expect(res.status).toBe(401)
  })

  it('returns {status: "skipped", reason: "lock held"} when the lock is already held', async () => {
    const { acquireCronLock, releaseCronLock } = await import('@/lib/cronLock')
    expect(await acquireCronLock('documents-tick', 55)).toBe(true)

    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://x/api/cron/documents-tick', { headers: { authorization: 'Bearer test-secret' } }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ status: 'skipped', reason: 'lock held' })

    await releaseCronLock('documents-tick')
  })

  it('claims and renders a due job, returning {status: "ok", summary}', async () => {
    process.env.GOTENBERG_URL = await startPdfStub()
    const orderId = await seedOrder()
    const job = await enqueueRenderJob(db, { tenantId, docType: 'order_report', orderId, trigger: 'manual' })

    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://x/api/cron/documents-tick', { headers: { authorization: 'Bearer test-secret' } }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.summary.claimed).toBe(1)
    expect(body.summary.rendered).toBe(1)
    expect(body.summary.failed).toBe(0)
    expect(body.summary.results[0]).toMatchObject({ jobId: job.id, orderId, status: 'rendered' })

    // The job flipped to done and a documents row now exists for the order.
    const [after] = await db
      .select()
      .from(schema.documentRenderJobs)
      .where(eq(schema.documentRenderJobs.id, job.id))
    expect(after.status).toBe('done')
    const docs = await db.select().from(schema.documents).where(eq(schema.documents.orderId, orderId))
    expect(docs).toHaveLength(1)
    expect(docs[0].pdfBytes?.subarray(0, 5).toString()).toBe('%PDF-')
  })
})
