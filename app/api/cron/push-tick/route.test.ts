// app/api/cron/push-tick/route.test.ts
//
// Uses the local-Postgres test harness (lib/test-support/db.ts), not
// Testcontainers. `@/app/api/cron/push-tick/route` transitively imports
// `@/lib/db`, which reads DATABASE_URL at module-load time, so DATABASE_URL
// must point at the harness DB *before* the route is first dynamically
// imported — same constraint as app/api/cron/sync-tick/route.test.ts, whose
// auth/lock/fan-out test shape this file mirrors exactly.
//
// This is a unit test of the ROUTE itself (auth, lock, fan-out, per-company
// error isolation) — buildAdapterForConnection and processPushQueue are both
// mocked out here. The actual saga behavior they drive is covered by
// lib/sync/push/engine.test.ts (fake-ERP + DB).
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import type { ErpAdapter } from '@herbe/erp-core'
import type { PushSummary } from '@/lib/sync/push/engine'

const { buildAdapterForConnectionMock, processPushQueueMock } = vi.hoisted(() => ({
  buildAdapterForConnectionMock: vi.fn(),
  processPushQueueMock: vi.fn(),
}))

vi.mock('@/lib/erp/connection', () => ({
  buildAdapterForConnection: buildAdapterForConnectionMock,
}))

vi.mock('@/lib/sync/push/engine', () => ({
  processPushQueue: processPushQueueMock,
}))

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

const fakeAdapter = {} as ErpAdapter
const okSummary: PushSummary = {
  groupsProcessed: 1,
  groupsSucceeded: 1,
  groupsPending: 0,
  groupsDead: 0,
  stepsSucceeded: 1,
  stepsRetried: 0,
  stepsDead: 0,
}

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  process.env.DATABASE_URL = testDb.url
  process.env.CRON_SECRET = 'test-secret'

  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

afterEach(() => {
  buildAdapterForConnectionMock.mockReset()
  processPushQueueMock.mockReset()
})

async function makeCompany(slug: string) {
  const [tenant] = await db.insert(schema.tenants).values({ slug, name: slug }).returning()
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId: tenant.id, displayName: slug, adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  return company
}

describe('GET /api/cron/push-tick', () => {
  it('rejects a request with no bearer header', async () => {
    const { GET } = await import('./route')
    const res = await GET(new Request('http://x/api/cron/push-tick'))
    expect(res.status).toBe(401)
  })

  it('rejects a request with the wrong bearer token', async () => {
    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://x/api/cron/push-tick', { headers: { authorization: 'Bearer wrong-secret' } }),
    )
    expect(res.status).toBe(401)
  })

  it('fans out over every active company, driving processPushQueue via buildAdapterForConnection', async () => {
    const companyA = await makeCompany('push-fanout-a')
    const companyB = await makeCompany('push-fanout-b')

    buildAdapterForConnectionMock.mockResolvedValue(fakeAdapter)
    processPushQueueMock.mockResolvedValue(okSummary)

    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://x/api/cron/push-tick', { headers: { authorization: 'Bearer test-secret' } }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.status).toBe('ok')

    for (const company of [companyA, companyB]) {
      const entry = body.results.find((r: { erpCompanyId: string }) => r.erpCompanyId === company.id)
      expect(entry.summary).toEqual(okSummary)
      expect(entry.error).toBeUndefined()
      expect(buildAdapterForConnectionMock).toHaveBeenCalledWith(expect.anything(), company.id)
      expect(processPushQueueMock).toHaveBeenCalledWith(expect.anything(), fakeAdapter, company.id)
    }
  })

  it('reports a company whose buildAdapterForConnection throws as an error, without blocking the rest', async () => {
    const goodCompany = await makeCompany('push-creds-good')
    const badCompany = await makeCompany('push-creds-bad')

    buildAdapterForConnectionMock.mockImplementation(async (_db: unknown, erpCompanyId: string) => {
      if (erpCompanyId === badCompany.id) throw new Error('failed to decrypt creds')
      return fakeAdapter
    })
    processPushQueueMock.mockResolvedValue(okSummary)

    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://x/api/cron/push-tick', { headers: { authorization: 'Bearer test-secret' } }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)

    const badEntry = body.results.find((r: { erpCompanyId: string }) => r.erpCompanyId === badCompany.id)
    expect(badEntry.error).toContain('failed to decrypt creds')
    expect(badEntry.summary).toBeUndefined()

    const goodEntry = body.results.find((r: { erpCompanyId: string }) => r.erpCompanyId === goodCompany.id)
    expect(goodEntry.summary).toEqual(okSummary)
    expect(goodEntry.error).toBeUndefined()

    // processPushQueue must never be reached for the company whose adapter build failed.
    expect(processPushQueueMock).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), badCompany.id)
  })

  it('returns {status: "skipped", reason: "lock held"} when the lock is already held', async () => {
    const { acquireCronLock, releaseCronLock } = await import('@/lib/cronLock')
    expect(await acquireCronLock('push-tick', 55)).toBe(true)

    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://x/api/cron/push-tick', { headers: { authorization: 'Bearer test-secret' } }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ status: 'skipped', reason: 'lock held' })

    await releaseCronLock('push-tick')
  })
})
