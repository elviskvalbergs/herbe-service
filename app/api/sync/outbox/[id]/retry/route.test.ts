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
//
// WS4 outbound slice (docs/superpowers/plans/2026-07-16-service-phase1-erp-outbound.md
// decision 11): the route no longer re-drives the Phase-0
// `attemptOutboxPush` -> `pushServiceOrderCreate` path — it re-enqueues the
// op's order onto the push-queue saga (enqueueOrderCreatePush ->
// processPushQueue), same as the main outbox route. `payload` is now
// `{orderId}` — a real service_orders row — rather than an ERP-shaped
// `{custCode, transDate, rows}` object, so every seeded failed op below
// carries `payloadJson: {orderId}` pointing at a real order (see
// `makeCompanyWithOrder`, mirrored from the main route's test file).
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { registerAdapter } from '@herbe/erp-core'
import { insertServiceOrder } from '@/lib/domain/stores/service-orders'
import { encryptErpCredentials } from '@/lib/erp/credentials'
import { createPushGroup } from '@/lib/sync/push/store'

const authMock = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }))

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

let retryOkPushCalls = 0
let retryFailPushCalls = 0

beforeAll(async () => {
  // FIX-3: the route builds the adapter via buildAdapterForConnection, which
  // decrypts api_creds_encrypted — set a throwaway envelope key before any
  // company is seeded (matches lib/erp/connection.test.ts).
  process.env.MASTER_ENCRYPTION_KEY = 'test-only-throwaway-key-not-a-real-secret-value'
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
    pushUpdate: async () => {
      throw new Error('pushUpdate must not be called by the retry route')
    },
    fetchRecords: async () => {
      // The saga's natural-key lookup only fires for a payload with at
      // least one serial number; every order seeded below has zero order
      // rows, so this must never be reached.
      throw new Error('fetchRecords must not be called by the retry route')
    },
    probeIncrementalSupport: async () => false,
    pullFullList: async () => [],
    listLiveRefs: async () => [],
    getRecordLinks: async () => {
      throw new Error('getRecordLinks must not be called by the retry route')
    },
  }))

  // Always fails — proves a retry against a permanently-broken push still
  // re-attempts (pushCreate is actually called again) even though the
  // outcome is failed once more. An empty erpRef is classified by the saga
  // engine as an ErpPermanentError naming the ERP number-series onboarding
  // issue (lib/sync/push/engine.ts) — same wording asserted in the main
  // outbox route's silent_noop_adapter test.
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
      return { erpRef: '' }
    },
    pushUpdate: async () => {
      throw new Error('pushUpdate must not be called by the retry route')
    },
    fetchRecords: async () => {
      throw new Error('fetchRecords must not be called by the retry route')
    },
    probeIncrementalSupport: async () => false,
    pullFullList: async () => [],
    listLiveRefs: async () => [],
    getRecordLinks: async () => {
      throw new Error('getRecordLinks must not be called by the retry route')
    },
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
    pushUpdate: async () => {
      throw new Error('must not be reached: this op should have been rejected before any push was attempted')
    },
    fetchRecords: async () => {
      throw new Error('must not be reached: this op should have been rejected before any push was attempted')
    },
    probeIncrementalSupport: async () => false,
    pullFullList: async () => [],
    listLiveRefs: async () => [],
    getRecordLinks: async () => {
      throw new Error('must not be reached: this op should have been rejected before any push was attempted')
    },
  }))
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

// Mirrors makeCompanyWithOrder from app/api/sync/outbox/route.test.ts: seeds
// a tenant + erp_company (given adapterType) + a customer with an erpRef
// (buildSvoCreatePayload requires one) + a real service order with zero
// order rows (so the saga's natural-key lookup never fires — see the
// fetchRecords stubs above).
async function makeCompanyWithOrder(adapterType: string, slug: string) {
  const [tenant] = await db.insert(schema.tenants).values({ slug, name: slug }).returning()
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({
      tenantId: tenant.id,
      displayName: slug,
      adapterType,
      // FIX-3: seeded like a real connection — buildAdapterForConnection reads
      // adapterConfigJson + decrypts api_creds_encrypted; the fake adapters
      // ignore the config, so adapterType still selects the fake.
      adapterConfigJson: { baseUrl: 'http://x', companyNumber: '1' },
      apiCredsEncrypted: encryptErpCredentials({ username: 'u', password: 'p' }).toString('base64'),
    })
    .returning()
  const [customer] = await db
    .insert(schema.customers)
    .values({ tenantId: tenant.id, erpCompanyId: company.id, erpRef: `CUST-${slug}`, name: slug, changeSeq: BigInt(0) })
    .returning()
  const order = await insertServiceOrder(db, { tenantId: tenant.id, erpCompanyId: company.id, customerId: customer.id })

  return { tenantId: tenant.id, erpCompanyId: company.id, orderId: order.id }
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

// Seeds a failed outbox op directly (bypassing the saga entirely, same as
// the Phase-0 version of this helper) so each test starts from a clean lane
// with no pre-existing push group — the retry route's own
// enqueueOrderCreatePush call is the first group ever created for that
// order, and runs immediately rather than being gated behind an earlier one.
async function seedFailedOp(tenantId: string, opId: string, orderId: string, errorMessage = 'original failure') {
  await db.insert(schema.outboxOps).values({
    id: opId,
    tenantId,
    entity: 'serviceOrder',
    op: 'create',
    payloadJson: { orderId },
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
    const { tenantId, orderId } = await makeCompanyWithOrder('retry_ok_adapter', 'retry-unauth')
    const opId = '33333333-0000-0000-0000-000000000001'
    await seedFailedOp(tenantId, opId, orderId)
    const callsBefore = retryOkPushCalls

    const res = await call(opId)

    expect(res.status).toBe(401)
    expect(retryOkPushCalls).toBe(callsBefore)
    const [row] = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, opId))
    expect(row.status).toBe('failed')
  })

  it('resets a failed op to pending, re-attempts the push, and applies it with a real erpRef', async () => {
    const { tenantId, orderId } = await makeCompanyWithOrder('retry_ok_adapter', 'retry-success')
    const user = await makeUser(tenantId, 'retry-success-user@herbe-service.test')
    authMock.mockResolvedValue(sessionFor(user))
    const opId = '33333333-0000-0000-0000-000000000002'
    await seedFailedOp(tenantId, opId, orderId, 'ERP was down')
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
    const { tenantId, orderId } = await makeCompanyWithOrder('retry_fail_adapter', 'retry-still-failing')
    const user = await makeUser(tenantId, 'retry-still-failing-user@herbe-service.test')
    authMock.mockResolvedValue(sessionFor(user))
    const opId = '33333333-0000-0000-0000-000000000003'
    await seedFailedOp(tenantId, opId, orderId, 'original failure')
    const callsBefore = retryFailPushCalls

    const res = await call(opId)
    const body = await res.json()

    expect(res.status).toBe(502)
    expect(body.status).toBe('failed')
    // Proves a real second attempt happened (not a no-op).
    expect(retryFailPushCalls).toBe(callsBefore + 1)

    const [row] = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, opId))
    expect(row.status).toBe('failed')
    expect(row.errorMessage).toContain('SerNr')
  })

  it('returns 404 for an op id that does not exist', async () => {
    const { tenantId } = await makeCompanyWithOrder('retry_ok_adapter', 'retry-404-tenant')
    const user = await makeUser(tenantId, 'retry-404-user@herbe-service.test')
    authMock.mockResolvedValue(sessionFor(user))

    const res = await call('33333333-0000-0000-0000-000000000404')

    expect(res.status).toBe(404)
  })

  it('returns 404 (not a leak) for an op id belonging to a different tenant', async () => {
    const tenantA = await makeCompanyWithOrder('retry_ok_adapter', 'retry-idor-a')
    const tenantB = await makeCompanyWithOrder('retry_must_not_be_called_adapter', 'retry-idor-b')
    const opId = '33333333-0000-0000-0000-000000000005'
    await seedFailedOp(tenantB.tenantId, opId, tenantB.orderId)

    const attacker = await makeUser(tenantA.tenantId, 'retry-idor-attacker@herbe-service.test')
    authMock.mockResolvedValue(sessionFor(attacker))
    const res = await call(opId)

    expect(res.status).toBe(404)
    const [row] = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, opId))
    expect(row.status).toBe('failed') // untouched — tenant A's request never reached tenant B's row
  })

  it('rejects retrying an op that is not "failed" (e.g. already applied), without re-pushing', async () => {
    const { tenantId, orderId } = await makeCompanyWithOrder('retry_must_not_be_called_adapter', 'retry-not-failed')
    const user = await makeUser(tenantId, 'retry-not-failed-user@herbe-service.test')
    authMock.mockResolvedValue(sessionFor(user))
    const opId = '33333333-0000-0000-0000-000000000006'
    await db.insert(schema.outboxOps).values({
      id: opId,
      tenantId,
      entity: 'serviceOrder',
      op: 'create',
      payloadJson: { orderId },
      status: 'applied',
      erpRef: 'SVO-ALREADY',
    })

    const res = await call(opId)

    expect(res.status).toBe(409)
    const [row] = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, opId))
    expect(row.status).toBe('applied')
    expect(row.erpRef).toBe('SVO-ALREADY')
  })

  it('FIX-4: heals a lane whose order-create group already dead-lettered, instead of stacking a new group behind the FIFO gate', async () => {
    const { tenantId, erpCompanyId, orderId } = await makeCompanyWithOrder('retry_ok_adapter', 'retry-heal-dead-lane')
    const user = await makeUser(tenantId, 'retry-heal-user@herbe-service.test')
    authMock.mockResolvedValue(sessionFor(user))
    const opId = '33333333-0000-0000-0000-000000000007'

    // Reproduce the real production state (which seedFailedOp deliberately
    // does NOT): the ORIGINAL push already left a DEAD order-create group on
    // the lane, and the outbox op is 'failed'. Before FIX-4, retry enqueued a
    // SECOND group here — but the FIFO gate is the older dead group, so the
    // new group never ran and the op stayed 'failed' forever.
    const lane = `order:${orderId}`
    const { groupId: deadGroupId } = await createPushGroup(db, {
      tenantId,
      erpCompanyId,
      lane,
      kind: 'order_create',
      steps: [{ seq: 1, entityType: 'serviceOrder', entityId: orderId, register: 'SVOVc', op: 'create' }],
    })
    await db.update(schema.erpPushGroups).set({ status: 'dead' }).where(eq(schema.erpPushGroups.id, deadGroupId))
    await db
      .update(schema.erpPushSteps)
      .set({ status: 'dead', attempts: 5, errorMessage: 'ERP number series exhausted' })
      .where(eq(schema.erpPushSteps.groupId, deadGroupId))

    await seedFailedOp(tenantId, opId, orderId, 'ERP number series exhausted')
    const callsBefore = retryOkPushCalls

    const res = await call(opId)
    const body = await res.json()

    // The reset dead group re-drove to success — the op is now applied.
    expect(res.status).toBe(200)
    expect(body).toEqual({ status: 'applied', erpRef: 'SVO-RETRY-OK' })
    expect(retryOkPushCalls).toBe(callsBefore + 1)

    const [row] = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, opId))
    expect(row.status).toBe('applied')
    expect(row.erpRef).toBe('SVO-RETRY-OK')

    // Crucially: no SECOND group was stacked — the SAME group healed in place.
    const groups = await db.select().from(schema.erpPushGroups).where(eq(schema.erpPushGroups.lane, lane))
    expect(groups).toHaveLength(1)
    expect(groups[0].id).toBe(deadGroupId)
    expect(groups[0].status).toBe('succeeded')
  })
})
