// app/api/cron/identity-rematch/route.test.ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import type { ErpAdapter } from '@herbe/erp-core'
import type { MatchSummary } from '@/lib/auth/identity-link'

const { buildAdapterForConnectionMock, matchUsersByEmailMock } = vi.hoisted(() => ({
  buildAdapterForConnectionMock: vi.fn(),
  matchUsersByEmailMock: vi.fn(),
}))

vi.mock('@/lib/erp/connection', () => ({
  buildAdapterForConnection: buildAdapterForConnectionMock,
}))

vi.mock('@/lib/auth/identity-link', () => ({
  matchUsersByEmail: matchUsersByEmailMock,
}))

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

const fakeAdapter = {} as ErpAdapter
const okSummary: MatchSummary = { linked: 1, alreadyLinked: 0, noMatch: 0 }

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
  matchUsersByEmailMock.mockReset()
})

async function makeCompany(slug: string) {
  const [tenant] = await db.insert(schema.tenants).values({ slug, name: slug }).returning()
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId: tenant.id, displayName: slug, adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  return company
}

describe('GET /api/cron/identity-rematch', () => {
  it('rejects a request with no bearer header', async () => {
    const { GET } = await import('./route')
    const res = await GET(new Request('http://x/api/cron/identity-rematch'))
    expect(res.status).toBe(401)
  })

  it('rejects a request with the wrong bearer token', async () => {
    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://x/api/cron/identity-rematch', { headers: { authorization: 'Bearer wrong-secret' } }),
    )
    expect(res.status).toBe(401)
  })

  it('fans out over every active company, driving matchUsersByEmail via buildAdapterForConnection', async () => {
    const companyA = await makeCompany('rematch-a')
    const companyB = await makeCompany('rematch-b')

    buildAdapterForConnectionMock.mockResolvedValue(fakeAdapter)
    matchUsersByEmailMock.mockResolvedValue(okSummary)

    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://x/api/cron/identity-rematch', { headers: { authorization: 'Bearer test-secret' } }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.status).toBe('ok')

    for (const company of [companyA, companyB]) {
      const entry = body.results.find((r: { companyId: string }) => r.companyId === company.id)
      expect(entry.status).toBe('ok')
      expect(entry.summary).toEqual(okSummary)
      expect(buildAdapterForConnectionMock).toHaveBeenCalledWith(expect.anything(), company.id)
      expect(matchUsersByEmailMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ erpCompanyId: company.id, tenantId: company.tenantId, adapter: fakeAdapter }),
      )
    }
  })

  it('reports a company whose buildAdapterForConnection throws as an error, without blocking the rest', async () => {
    const goodCompany = await makeCompany('rematch-good')
    const badCompany = await makeCompany('rematch-bad')

    buildAdapterForConnectionMock.mockImplementation(async (_db: unknown, erpCompanyId: string) => {
      if (erpCompanyId === badCompany.id) throw new Error('failed to decrypt creds')
      return fakeAdapter
    })
    matchUsersByEmailMock.mockResolvedValue(okSummary)

    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://x/api/cron/identity-rematch', { headers: { authorization: 'Bearer test-secret' } }),
    )
    const body = await res.json()

    const badEntry = body.results.find((r: { companyId: string }) => r.companyId === badCompany.id)
    expect(badEntry.status).toContain('failed to decrypt creds')
    expect(badEntry.summary).toBeUndefined()

    const goodEntry = body.results.find((r: { companyId: string }) => r.companyId === goodCompany.id)
    expect(goodEntry.status).toBe('ok')
    expect(matchUsersByEmailMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ erpCompanyId: badCompany.id }),
    )
  })

  it('returns {status: "skipped", reason: "lock held"} when the lock is already held', async () => {
    const { acquireCronLock, releaseCronLock } = await import('@/lib/cronLock')
    expect(await acquireCronLock('identity-rematch', 55)).toBe(true)

    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://x/api/cron/identity-rematch', { headers: { authorization: 'Bearer test-secret' } }),
    )
    const body = await res.json()

    expect(body).toEqual({ status: 'skipped', reason: 'lock held' })
    await releaseCronLock('identity-rematch')
  })
})
