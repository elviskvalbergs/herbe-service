// app/api/sync/outbox/[id]/retry/route.test.ts
//
// Same harness convention as app/api/sync/outbox/route.test.ts (local
// Postgres, not Testcontainers; `@/lib/auth`'s `auth()` mocked at the module
// seam for the same next/headers-outside-a-real-request reason documented
// there).
//
// The route calls `getVerifiedSession` (lib/auth/session-guard), which
// wraps `auth()` with a DB round-trip comparing `session.user.sessionVersion`
// against the live `users.session_version` row — so an authenticated test
// session must correspond to a real users row with a matching
// `sessionVersion` (see `makeUser`/`sessionFor` below).
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

let retryOkPushCalls = 0
let retryFailPushCalls = 0

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  process.env.DATABASE_URL = testDb.url

  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  registerAdapter('retry_ok_adapter', () => ({
    capabilities: () => ({
      supportsIncrementalSync: false,
      supportsDeletesFeed: false,
      supportsDocumentFetch: false,
      supportsInvoiceStatusReadback: false,
      supportsActivityMirror: false,
    }),
    pullChanges: async () => {
      throw new Error('pullChanges must not be called by the retry route')
    },
    pushCreate: async () => {
      retryOkPushCalls += 1
      return { erpRef: 'SVO-RETRY-OK' }
    },
    probeIncrementalSupport: async () => false,
    pullFullList: async () => [],
    listLiveRefs: async () => [],
  }))

  // Always fails — proves a retry against a permanently-broken push still
  // re-attempts (pushCreate is actually called again) even though the
  // outcome is failed once more.
  registerAdapter('retry_fail_adapter', () => ({
    capabilities: () => ({
      supportsIncrementalSync: false,
      supportsDeletesFeed: false,
      supportsDocumentFetch: false,
      supportsInvoiceStatusReadback: false,
      supportsActivityMirror: false,
    }),
    pullChanges: async () => {
      throw new Error('pullChanges must not be called by the retry route')
    },
    pushCreate: async () => {
      retryFailPushCalls += 1
      return { erpRef: '' } // classified as ErpTransientError by pushServiceOrderCreate
    },
    probeIncrementalSupport: async () => false,
    pullFullList: async () => [],
    listLiveRefs: async () => [],
  }))

  registerAdapter('retry_must_not_be_called_adapter', () => ({
    capabilities: () => ({
      supportsIncrementalSync: false,
      supportsDeletesFeed: false,
      supportsDocumentFetch: false,
      supportsInvoiceStatusReadback: false,
      supportsActivityMirror: false,
    }),
    pullChanges: async () => {
      throw new Error('pullChanges must not be called by the retry route')
    },
    pushCreate: async () => {
      throw new Error('must not be reached: this op should have been rejected before any push was attempted')
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

async function makeUser(tenantId: string, email: string) {
  const [user] = await db.insert(schema.users).values({ tenantId, email, role: 'technician' }).returning()
  return user
}

function sessionFor(user: { id: string; tenantId: string; sessionVersion: number }) {
  return {
    user: { id: user.id, tenantId: user.tenantId, sessionVersion: user.sessionVersion },
    expires: '2099-01-01T00:00:00.000Z',
  }
}

const payload = { custCode: 'CUST001', transDate: '2026-07-08', rows: [{ artCode: 'PART-1', quant: 1 }] }

async function seedFailedOp(tenantId: string, opId: string, errorMessage = 'original failure') {
  await db.insert(schema.outboxOps).values({
    id: opId,
    tenantId,
    entity: 'serviceOrder',
    op: 'create',
    payloadJson: payload,
    status: 'failed',
    errorMessage,
  })
}

function call(id: string) {
  return import('./route').then(({ POST }) =>
    POST(new Request(`http://x/api/sync/outbox/${id}/retry`, { method: 'POST' }), { params: Promise.resolve({ id }) }),
  )
}

describe('POST /api/sync/outbox/[id]/retry', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'test-user-id' }, expires: '2099-01-01T00:00:00.000Z' })
  })

  it('rejects an unauthenticated request with 401 before touching the row', async () => {
    authMock.mockResolvedValue(null)
    const tenantId = await makeCompany('retry_ok_adapter', 'retry-unauth')
    const opId = '33333333-0000-0000-0000-000000000001'
    await seedFailedOp(tenantId, opId)
    const callsBefore = retryOkPushCalls

    const res = await call(opId)

    expect(res.status).toBe(401)
    expect(retryOkPushCalls).toBe(callsBefore)
    const [row] = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, opId))
    expect(row.status).toBe('failed')
  })

  it('resets a failed op to pending, re-attempts the push, and applies it with a real erpRef', async () => {
    const tenantId = await makeCompany('retry_ok_adapter', 'retry-success')
    const user = await makeUser(tenantId, 'retry-success-user@herbe-service.test')
    authMock.mockResolvedValue(sessionFor(user))
    const opId = '33333333-0000-0000-0000-000000000002'
    await seedFailedOp(tenantId, opId, 'ERP was down')
    const callsBefore = retryOkPushCalls

    const res = await call(opId)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ status: 'applied', erpRef: 'SVO-RETRY-OK' })
    // The push was genuinely re-attempted, not just a status flip.
    expect(retryOkPushCalls).toBe(callsBefore + 1)

    const [row] = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, opId))
    expect(row.status).toBe('applied')
    expect(row.erpRef).toBe('SVO-RETRY-OK')
    expect(row.appliedAt).not.toBeNull()
  })

  it('re-attempts the push even when it fails again, recording the new error rather than a stale one', async () => {
    const tenantId = await makeCompany('retry_fail_adapter', 'retry-still-failing')
    const user = await makeUser(tenantId, 'retry-still-failing-user@herbe-service.test')
    authMock.mockResolvedValue(sessionFor(user))
    const opId = '33333333-0000-0000-0000-000000000003'
    await seedFailedOp(tenantId, opId, 'original failure')
    const callsBefore = retryFailPushCalls

    const res = await call(opId)
    const body = await res.json()

    expect(res.status).toBe(502)
    expect(body.status).toBe('failed')
    // Proves a real second attempt happened (not a no-op).
    expect(retryFailPushCalls).toBe(callsBefore + 1)

    const [row] = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, opId))
    expect(row.status).toBe('failed')
    expect(row.errorMessage).toContain('ErpTransientError')
  })

  it('returns 404 for an op id that does not exist', async () => {
    const tenantId = await makeCompany('retry_ok_adapter', 'retry-404-tenant')
    const user = await makeUser(tenantId, 'retry-404-user@herbe-service.test')
    authMock.mockResolvedValue(sessionFor(user))

    const res = await call('33333333-0000-0000-0000-000000000404')

    expect(res.status).toBe(404)
  })

  it('returns 404 (not a leak) for an op id belonging to a different tenant', async () => {
    const tenantA = await makeCompany('retry_ok_adapter', 'retry-idor-a')
    const tenantB = await makeCompany('retry_must_not_be_called_adapter', 'retry-idor-b')
    const opId = '33333333-0000-0000-0000-000000000005'
    await seedFailedOp(tenantB, opId)

    const attacker = await makeUser(tenantA, 'retry-idor-attacker@herbe-service.test')
    authMock.mockResolvedValue(sessionFor(attacker))
    const res = await call(opId)

    expect(res.status).toBe(404)
    const [row] = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, opId))
    expect(row.status).toBe('failed') // untouched — tenant A's request never reached tenant B's row
  })

  it('rejects retrying an op that is not "failed" (e.g. already applied), without re-pushing', async () => {
    const tenantId = await makeCompany('retry_must_not_be_called_adapter', 'retry-not-failed')
    const user = await makeUser(tenantId, 'retry-not-failed-user@herbe-service.test')
    authMock.mockResolvedValue(sessionFor(user))
    const opId = '33333333-0000-0000-0000-000000000006'
    await db.insert(schema.outboxOps).values({
      id: opId,
      tenantId,
      entity: 'serviceOrder',
      op: 'create',
      payloadJson: payload,
      status: 'applied',
      erpRef: 'SVO-ALREADY',
    })

    const res = await call(opId)

    expect(res.status).toBe(409)
    const [row] = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, opId))
    expect(row.status).toBe('applied')
    expect(row.erpRef).toBe('SVO-ALREADY')
  })
})
