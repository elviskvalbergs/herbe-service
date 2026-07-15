// app/api/cron/sync-tick/route.test.ts
//
// Uses the local-Postgres test harness (lib/test-support/db.ts), not
// Testcontainers. `@/app/api/cron/sync-tick/route` transitively imports
// `@/lib/db`, which reads DATABASE_URL at module-load time, so DATABASE_URL
// must point at the harness DB *before* the route is first dynamically
// imported.
//
// This is a unit test of the ROUTE itself (auth, lock, fan-out, per-company
// error isolation) — buildAdapterForConnection and syncConnection are both
// mocked out here. The actual per-register sync behavior they drive is
// covered by lib/sync/sync-connection.test.ts (fake-ERP + DB) and proven
// against the real ERP in tests/live/erp-contract.test.ts.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import type { ErpAdapter } from '@herbe/erp-core'
import type { SyncSummary } from '@/lib/sync/sync-connection'

const { buildAdapterForConnectionMock, syncConnectionMock } = vi.hoisted(() => ({
  buildAdapterForConnectionMock: vi.fn(),
  syncConnectionMock: vi.fn(),
}))

vi.mock('@/lib/erp/connection', () => ({
  buildAdapterForConnection: buildAdapterForConnectionMock,
}))

vi.mock('@/lib/sync/sync-connection', () => ({
  syncConnection: syncConnectionMock,
}))

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

const fakeAdapter = {} as ErpAdapter
const okSummary: SyncSummary = { perRegister: { CUVc: { ingested: 1 } } }

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
  syncConnectionMock.mockReset()
})

async function makeCompany(slug: string) {
  const [tenant] = await db.insert(schema.tenants).values({ slug, name: slug }).returning()
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId: tenant.id, displayName: slug, adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  return company
}

describe('GET /api/cron/sync-tick', () => {
  it('rejects a request with no bearer header', async () => {
    const { GET } = await import('./route')
    const res = await GET(new Request('http://x/api/cron/sync-tick'))
    expect(res.status).toBe(401)
  })

  it('rejects a request with the wrong bearer token', async () => {
    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://x/api/cron/sync-tick', { headers: { authorization: 'Bearer wrong-secret' } }),
    )
    expect(res.status).toBe(401)
  })

  it('fans out over every active company, driving syncConnection via buildAdapterForConnection', async () => {
    const companyA = await makeCompany('fanout-a')
    const companyB = await makeCompany('fanout-b')

    buildAdapterForConnectionMock.mockResolvedValue(fakeAdapter)
    syncConnectionMock.mockResolvedValue(okSummary)

    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://x/api/cron/sync-tick', { headers: { authorization: 'Bearer test-secret' } }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.status).toBe('ok')

    for (const company of [companyA, companyB]) {
      const entry = body.results.find((r: { companyId: string }) => r.companyId === company.id)
      expect(entry.status).toBe('ok')
      expect(entry.summary).toEqual(okSummary)
      expect(buildAdapterForConnectionMock).toHaveBeenCalledWith(expect.anything(), company.id)
      expect(syncConnectionMock).toHaveBeenCalledWith(expect.anything(), fakeAdapter, company.id)
    }
  })

  it('reports a company whose buildAdapterForConnection throws as an error, without blocking the rest', async () => {
    const goodCompany = await makeCompany('creds-good')
    const badCompany = await makeCompany('creds-bad')

    buildAdapterForConnectionMock.mockImplementation(async (_db: unknown, erpCompanyId: string) => {
      if (erpCompanyId === badCompany.id) throw new Error('failed to decrypt creds')
      return fakeAdapter
    })
    syncConnectionMock.mockResolvedValue(okSummary)

    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://x/api/cron/sync-tick', { headers: { authorization: 'Bearer test-secret' } }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)

    const badEntry = body.results.find((r: { companyId: string }) => r.companyId === badCompany.id)
    expect(badEntry.status).toContain('failed to decrypt creds')
    expect(badEntry.summary).toBeUndefined()

    const goodEntry = body.results.find((r: { companyId: string }) => r.companyId === goodCompany.id)
    expect(goodEntry.status).toBe('ok')
    expect(goodEntry.summary).toEqual(okSummary)

    // syncConnection must never be reached for the company whose adapter build failed.
    expect(syncConnectionMock).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), badCompany.id)
  })

  it('returns {status: "skipped", reason: "lock held"} when the lock is already held', async () => {
    const { acquireCronLock, releaseCronLock } = await import('@/lib/cronLock')
    expect(await acquireCronLock('sync-tick', 55)).toBe(true)

    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://x/api/cron/sync-tick', { headers: { authorization: 'Bearer test-secret' } }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ status: 'skipped', reason: 'lock held' })

    await releaseCronLock('sync-tick')
  })
})
