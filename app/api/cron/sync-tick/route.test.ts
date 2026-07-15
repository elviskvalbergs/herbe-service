// app/api/cron/sync-tick/route.test.ts
//
// Uses the local-Postgres test harness (lib/test-support/db.ts), not
// Testcontainers. `@/app/api/cron/sync-tick/route` transitively imports
// `@/lib/db`, which reads DATABASE_URL at module-load time, so DATABASE_URL
// must point at the harness DB *before* the route is first dynamically
// imported.
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { registerAdapter } from '@herbe/erp-core'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

let unsupportedProbeCalls = 0

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  process.env.DATABASE_URL = testDb.url
  process.env.CRON_SECRET = 'test-secret'

  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  // Throws on every pull — proves a per-company failure doesn't abort the tick.
  registerAdapter('failing_adapter', () => ({
    capabilities: () => ({
      supportsIncrementalSync: false,
      supportsDeletesFeed: false,
      supportsDocumentFetch: false,
      supportsInvoiceStatusReadback: false,
      supportsActivityMirror: false,
    }),
    pullChanges: async () => {
      throw new Error('simulated ERP outage')
    },
    pushCreate: async () => ({ erpRef: 'n/a' }),
    probeIncrementalSupport: async () => true,
    pullFullList: async () => [],
    listLiveRefs: async () => [],
  }))

  // Succeeds end-to-end — proves the ok path persists a cursor and ingests.
  registerAdapter('ok_adapter', () => ({
    capabilities: () => ({
      supportsIncrementalSync: true,
      supportsDeletesFeed: false,
      supportsDocumentFetch: false,
      supportsInvoiceStatusReadback: false,
      supportsActivityMirror: false,
    }),
    pullChanges: async (_register: string, sinceCursor: string) => ({
      upserts: [{ Code: 'CUST1', Name: 'Test Customer' }],
      deletedRefs: [],
      cursor: String(Number(sinceCursor) + 1),
    }),
    pushCreate: async () => ({ erpRef: 'n/a' }),
    probeIncrementalSupport: async () => true,
    pullFullList: async () => [],
    listLiveRefs: async () => [],
  }))

  // Probe reports "not supported" — proves the dispatcher records it and
  // skips pullChanges (which would throw if ever called), and that a
  // *second* tick skips via the persisted erp_sync_state row without
  // re-invoking the probe.
  registerAdapter('unsupported_adapter', () => ({
    capabilities: () => ({
      supportsIncrementalSync: false,
      supportsDeletesFeed: false,
      supportsDocumentFetch: false,
      supportsInvoiceStatusReadback: false,
      supportsActivityMirror: false,
    }),
    pullChanges: async () => {
      throw new Error('pullChanges must not be called for an unsupported register')
    },
    pushCreate: async () => ({ erpRef: 'n/a' }),
    probeIncrementalSupport: async () => {
      unsupportedProbeCalls += 1
      return false
    },
    pullFullList: async () => [],
    listLiveRefs: async () => [],
  }))
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

async function makeCompany(adapterType: string, slug: string) {
  const [tenant] = await db.insert(schema.tenants).values({ slug, name: slug }).returning()
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId: tenant.id, displayName: slug, adapterType, adapterConfigJson: {} })
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

  it('reports a per-company failure without throwing, and still returns 200', async () => {
    const company = await makeCompany('failing_adapter', 'failing-co')

    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://x/api/cron/sync-tick', { headers: { authorization: 'Bearer test-secret' } }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    const entry = body.results.find((r: { companyId: string }) => r.companyId === company.id)
    expect(entry.status).toContain('simulated ERP outage')
  })

  it('pulls, ingests, and persists a cursor for a healthy company', async () => {
    const company = await makeCompany('ok_adapter', 'ok-co')

    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://x/api/cron/sync-tick', { headers: { authorization: 'Bearer test-secret' } }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    const entry = body.results.find((r: { companyId: string }) => r.companyId === company.id)
    expect(entry.status).toBe('ok')

    const [state] = await db
      .select()
      .from(schema.erpSyncState)
      .where(and(eq(schema.erpSyncState.erpCompanyId, company.id), eq(schema.erpSyncState.register, 'CUVc')))
    expect(state.syncCursor).toBe('1')

    const [customer] = await db.select().from(schema.customers).where(eq(schema.customers.erpCompanyId, company.id))
    expect(customer.name).toBe('Test Customer')
  })

  it('records an unsupported register on first tick and skips it on the next tick without re-probing', async () => {
    const company = await makeCompany('unsupported_adapter', 'unsupported-co')
    const callsBefore = unsupportedProbeCalls

    const { GET } = await import('./route')

    const res1 = await GET(
      new Request('http://x/api/cron/sync-tick', { headers: { authorization: 'Bearer test-secret' } }),
    )
    const body1 = await res1.json()
    expect(res1.status).toBe(200)
    const entry1 = body1.results.find((r: { companyId: string }) => r.companyId === company.id)
    expect(entry1.status).toContain('not supported')
    expect(unsupportedProbeCalls).toBe(callsBefore + 1)

    const res2 = await GET(
      new Request('http://x/api/cron/sync-tick', { headers: { authorization: 'Bearer test-secret' } }),
    )
    const body2 = await res2.json()
    expect(res2.status).toBe(200)
    const entry2 = body2.results.find((r: { companyId: string }) => r.companyId === company.id)
    expect(entry2.status).toContain('not supported')
    // Still exactly one probe call across both ticks — the second tick read
    // the persisted erp_sync_state row instead of re-discovering it.
    expect(unsupportedProbeCalls).toBe(callsBefore + 1)
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
