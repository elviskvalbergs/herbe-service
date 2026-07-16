// app/api/sync/outbox/route.test.ts
//
// Uses the local-Postgres test harness (lib/test-support/db.ts), not
// Testcontainers — same convention as app/api/cron/sync-tick/route.test.ts.
// `@/app/api/sync/outbox/route` transitively imports `@/lib/db`, which reads
// DATABASE_URL at module-load time, so DATABASE_URL must point at the
// harness DB *before* the route is first dynamically imported.
//
// `auth` from '@/lib/auth' is mocked at the module seam (Task 14 carry-over
// #3): Auth.js v5's server-side `auth()` calls `next/headers`' `headers()`,
// which requires the Next.js request-scoped AsyncLocalStorage that only
// exists inside a real Next.js server request, not a bare Vitest call to
// `POST(request)` — same reasoning as __tests__/api/test/login.test.ts.
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { registerAdapter } from '@herbe/erp-core'

const authMock = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }))

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

let okPushCalls = 0

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  process.env.DATABASE_URL = testDb.url

  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  // Returns a real assigned erpRef — the happy path.
  registerAdapter('ok_push_adapter', () => ({
    capabilities: () => ({
      supportsIncrementalSync: false,
      supportsDeletesFeed: false,
      supportsDocumentFetch: false,
      supportsInvoiceStatusReadback: false,
      supportsActivityMirror: false,
    }),
    pullChanges: async () => {
      throw new Error('pullChanges must not be called by the outbox route')
    },
    pushCreate: async () => {
      okPushCalls += 1
      return { erpRef: 'SVO-000123' }
    },
    pushUpdate: async () => {
      throw new Error('pushUpdate must not be called by the outbox route')
    },
    fetchRecords: async () => {
      throw new Error('fetchRecords must not be called by the outbox route')
    },
    probeIncrementalSupport: async () => false,
    pullFullList: async () => [],
    listLiveRefs: async () => [],
  }))

  // Confirmed real-ERP finding (docs/19-demo-probe-results.md §10): a 200
  // with an echoed, unassigned payload and no erpRef assigned.
  registerAdapter('silent_noop_adapter', () => ({
    capabilities: () => ({
      supportsIncrementalSync: false,
      supportsDeletesFeed: false,
      supportsDocumentFetch: false,
      supportsInvoiceStatusReadback: false,
      supportsActivityMirror: false,
    }),
    pullChanges: async () => {
      throw new Error('pullChanges must not be called by the outbox route')
    },
    pushCreate: async () => ({ erpRef: '' }),
    pushUpdate: async () => {
      throw new Error('pushUpdate must not be called by the outbox route')
    },
    fetchRecords: async () => {
      throw new Error('fetchRecords must not be called by the outbox route')
    },
    probeIncrementalSupport: async () => false,
    pullFullList: async () => [],
    listLiveRefs: async () => [],
  }))

  // Task 16b IDOR regression: a tenant this adapter belongs to must never be
  // reached by another tenant's session — any call proves the route trusted
  // client-supplied tenantId instead of the session's.
  registerAdapter('must_not_be_called_adapter', () => ({
    capabilities: () => ({
      supportsIncrementalSync: false,
      supportsDeletesFeed: false,
      supportsDocumentFetch: false,
      supportsInvoiceStatusReadback: false,
      supportsActivityMirror: false,
    }),
    pullChanges: async () => {
      throw new Error('pullChanges must not be called by the outbox route')
    },
    pushCreate: async () => {
      throw new Error('cross-tenant IDOR: this tenant\'s adapter must never be reached by another tenant\'s session')
    },
    pushUpdate: async () => {
      throw new Error('cross-tenant IDOR: this tenant\'s adapter must never be reached by another tenant\'s session')
    },
    fetchRecords: async () => {
      throw new Error('cross-tenant IDOR: this tenant\'s adapter must never be reached by another tenant\'s session')
    },
    probeIncrementalSupport: async () => false,
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
  await db
    .insert(schema.erpCompanies)
    .values({ tenantId: tenant.id, displayName: slug, adapterType, adapterConfigJson: {} })
    .returning()
  return tenant.id
}

const payload = { custCode: 'CUST001', transDate: '2026-07-08', rows: [{ artCode: 'PART-1', quant: 1 }] }

describe('POST /api/sync/outbox', () => {
  beforeEach(() => {
    // Authenticated by default; the 401 test below overrides this per-call.
    authMock.mockReset().mockResolvedValue({ user: { id: 'test-user-id' }, expires: '2099-01-01T00:00:00.000Z' })
  })

  it('rejects an unauthenticated request with 401 before doing any work (Task 14 carry-over #3)', async () => {
    authMock.mockResolvedValue(null)
    const tenantId = await makeCompany('ok_push_adapter', 'unauth-tenant')
    const opId = '22222222-0000-0000-0000-000000000099'
    const callsBefore = okPushCalls

    const body = { id: opId, tenantId, entity: 'serviceOrder', op: 'create', payload }

    const { POST } = await import('./route')
    const res = await POST(new Request('http://x/api/sync/outbox', { method: 'POST', body: JSON.stringify(body) }))

    expect(res.status).toBe(401)
    // No row written and no ERP push attempted — the guard runs before any work.
    expect(okPushCalls).toBe(callsBefore)
    const rows = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, opId))
    expect(rows.length).toBe(0)
  })

  it('accepts an op once, applies it with the real erpRef, and is a no-op idempotent replay on the same client UUID', async () => {
    const tenantId = await makeCompany('ok_push_adapter', 'ok-tenant')
    authMock.mockResolvedValue({ user: { id: 'test-user-id', tenantId }, expires: '2099-01-01T00:00:00.000Z' })
    const opId = '22222222-0000-0000-0000-000000000001'
    const callsBefore = okPushCalls

    const body = { id: opId, entity: 'serviceOrder', op: 'create', payload }

    const { POST } = await import('./route')

    const first = await POST(new Request('http://x/api/sync/outbox', { method: 'POST', body: JSON.stringify(body) }))
    const firstBody = await first.json()
    expect(first.status).toBe(200)
    expect(firstBody).toEqual({ status: 'applied', erpRef: 'SVO-000123' })
    expect(okPushCalls).toBe(callsBefore + 1)

    const second = await POST(
      new Request('http://x/api/sync/outbox', { method: 'POST', body: JSON.stringify(body) }),
    )
    const secondBody = await second.json()
    expect(second.status).toBe(200)
    expect(secondBody).toEqual({ status: 'already_applied', erpRef: 'SVO-000123' })
    // The replay must not re-push to the ERP.
    expect(okPushCalls).toBe(callsBefore + 1)

    const rows = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, opId))
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('applied')
    expect(rows[0].erpRef).toBe('SVO-000123')
  })

  it('IDOR regression (Task 16b): a session scoped to tenant A writes only under tenant A, even when the request body asks for tenantId=B', async () => {
    const tenantA = await makeCompany('ok_push_adapter', 'idor-tenant-a')
    const tenantB = await makeCompany('must_not_be_called_adapter', 'idor-tenant-b')
    const opId = '22222222-0000-0000-0000-000000000010'
    const callsBefore = okPushCalls

    // Session belongs to tenant A; the request body tries to redirect the
    // write to tenant B (attacker-controlled tenantId).
    authMock.mockResolvedValue({ user: { id: 'attacker', tenantId: tenantA }, expires: '2099-01-01T00:00:00.000Z' })
    const body = { id: opId, tenantId: tenantB, entity: 'serviceOrder', op: 'create', payload }

    const { POST } = await import('./route')
    const res = await POST(new Request('http://x/api/sync/outbox', { method: 'POST', body: JSON.stringify(body) }))
    const resBody = await res.json()

    expect(res.status).toBe(200)
    expect(resBody).toEqual({ status: 'applied', erpRef: 'SVO-000123' })
    // Pushed via tenant A's adapter (the only one registered to push here) —
    // tenant B's adapter, which throws if invoked, was never reached.
    expect(okPushCalls).toBe(callsBefore + 1)

    const rows = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, opId))
    expect(rows).toHaveLength(1)
    expect(rows[0].tenantId).toBe(tenantA)
    expect(rows[0].tenantId).not.toBe(tenantB)
  })

  it('rejects with 401 when the session has no tenantId, rather than writing unscoped', async () => {
    const tenantId = await makeCompany('ok_push_adapter', 'no-tenant-claim')
    const opId = '22222222-0000-0000-0000-000000000011'
    authMock.mockResolvedValue({ user: { id: 'x' }, expires: '2099-01-01T00:00:00.000Z' })

    const body = { id: opId, tenantId, entity: 'serviceOrder', op: 'create', payload }
    const { POST } = await import('./route')
    const res = await POST(new Request('http://x/api/sync/outbox', { method: 'POST', body: JSON.stringify(body) }))

    expect(res.status).toBe(401)
    const rows = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, opId))
    expect(rows).toHaveLength(0)
  })

  it('rejects with 409 when the op id belongs to a different tenant, without leaking that tenant\'s erpRef', async () => {
    const tenantA = await makeCompany('ok_push_adapter', 'cross-tenant-a')
    const tenantB = await makeCompany('ok_push_adapter', 'cross-tenant-b')
    const opId = '22222222-0000-0000-0000-000000000020'
    const callsBefore = okPushCalls

    // Seed an outbox op owned by tenant B, applied with a real erpRef.
    authMock.mockResolvedValue({ user: { id: 'tenant-b-user', tenantId: tenantB }, expires: '2099-01-01T00:00:00.000Z' })
    const seedBody = { id: opId, entity: 'serviceOrder', op: 'create', payload }
    const { POST } = await import('./route')
    const seedRes = await POST(
      new Request('http://x/api/sync/outbox', { method: 'POST', body: JSON.stringify(seedBody) }),
    )
    expect(seedRes.status).toBe(200)
    expect(okPushCalls).toBe(callsBefore + 1)

    // Tenant A's session reuses tenant B's op id — must not confirm existence
    // or leak tenant B's erpRef ('SVO-000123').
    authMock.mockResolvedValue({ user: { id: 'tenant-a-user', tenantId: tenantA }, expires: '2099-01-01T00:00:00.000Z' })
    const reuseBody = { id: opId, entity: 'serviceOrder', op: 'create', payload }
    const res = await POST(
      new Request('http://x/api/sync/outbox', { method: 'POST', body: JSON.stringify(reuseBody) }),
    )
    const text = await res.text()

    expect(res.status).toBe(409)
    expect(text).not.toContain('SVO-000123')
    expect(text).not.toContain('already_applied')
    // No re-push and no second row was written under tenant A.
    expect(okPushCalls).toBe(callsBefore + 1)
    const rows = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, opId))
    expect(rows).toHaveLength(1)
    expect(rows[0].tenantId).toBe(tenantB)
  })

  it('records an empty erpRef as a failed op, not applied — "200 and no error" is not proof of a write', async () => {
    const tenantId = await makeCompany('silent_noop_adapter', 'noop-tenant')
    authMock.mockResolvedValue({ user: { id: 'test-user-id', tenantId }, expires: '2099-01-01T00:00:00.000Z' })
    const opId = '22222222-0000-0000-0000-000000000002'

    const body = { id: opId, entity: 'serviceOrder', op: 'create', payload }

    const { POST } = await import('./route')
    const res = await POST(new Request('http://x/api/sync/outbox', { method: 'POST', body: JSON.stringify(body) }))
    const resBody = await res.json()

    expect(res.status).toBe(502)
    expect(resBody.status).toBe('failed')

    const rows = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, opId))
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('failed')
    expect(rows[0].erpRef).toBeNull()
    expect(rows[0].appliedAt).toBeNull()
    expect(rows[0].errorMessage).toContain('ErpTransientError')
  })
})
