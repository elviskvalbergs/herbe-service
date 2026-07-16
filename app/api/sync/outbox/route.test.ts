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
//
// WS4 outbound slice (docs/superpowers/plans/2026-07-16-service-phase1-erp-outbound.md
// decision 11): the route was refactored to push via the saga engine
// (enqueueOrderCreatePush -> processPushQueue) instead of calling
// pushServiceOrderCreate directly, so `payload` is now `{orderId}` — a real
// service_orders row — rather than a raw ERP-shaped `{custCode, transDate,
// rows}` object. Every test below seeds a real customer + service order per
// tenant/company instead of using a literal ERP payload. Response shapes,
// status codes, and the idempotency/cross-tenant contract itself are
// unchanged — only what `payload` means changed.
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { registerAdapter } from '@herbe/erp-core'
import { insertServiceOrder } from '@/lib/domain/stores/service-orders'

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
      // The saga's natural-key lookup only fires for a payload with at
      // least one serial number (lib/sync/push/engine.ts); every order
      // seeded below has zero order rows, so this must never be reached.
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

// Seeds a tenant + erp_company (given adapterType) + a customer with an
// erpRef (buildSvoCreatePayload requires one) + a real service order with
// zero order rows (so the saga's natural-key lookup never fires — see the
// fetchRecords stubs above). Returns everything a test needs to build an
// `{orderId}` outbox payload for that tenant.
async function makeCompanyWithOrder(adapterType: string, slug: string) {
  const [tenant] = await db.insert(schema.tenants).values({ slug, name: slug }).returning()
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId: tenant.id, displayName: slug, adapterType, adapterConfigJson: {} })
    .returning()
  const [customer] = await db
    .insert(schema.customers)
    .values({ tenantId: tenant.id, erpCompanyId: company.id, erpRef: `CUST-${slug}`, name: slug, changeSeq: BigInt(0) })
    .returning()
  const order = await insertServiceOrder(db, { tenantId: tenant.id, erpCompanyId: company.id, customerId: customer.id })

  return { tenantId: tenant.id, erpCompanyId: company.id, orderId: order.id }
}

describe('POST /api/sync/outbox', () => {
  beforeEach(() => {
    // Authenticated by default; the 401 test below overrides this per-call.
    authMock.mockReset().mockResolvedValue({ user: { id: 'test-user-id' }, expires: '2099-01-01T00:00:00.000Z' })
  })

  it('rejects an unauthenticated request with 401 before doing any work (Task 14 carry-over #3)', async () => {
    authMock.mockResolvedValue(null)
    const { orderId } = await makeCompanyWithOrder('ok_push_adapter', 'unauth-tenant')
    const opId = '22222222-0000-0000-0000-000000000099'
    const callsBefore = okPushCalls

    const body = { id: opId, entity: 'serviceOrder', op: 'create', payload: { orderId } }

    const { POST } = await import('./route')
    const res = await POST(new Request('http://x/api/sync/outbox', { method: 'POST', body: JSON.stringify(body) }))

    expect(res.status).toBe(401)
    // No row written and no ERP push attempted — the guard runs before any work.
    expect(okPushCalls).toBe(callsBefore)
    const rows = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, opId))
    expect(rows.length).toBe(0)
  })

  it('accepts an op once, applies it with the real erpRef, and is a no-op idempotent replay on the same client UUID', async () => {
    const { tenantId, orderId } = await makeCompanyWithOrder('ok_push_adapter', 'ok-tenant')
    authMock.mockResolvedValue({ user: { id: 'test-user-id', tenantId }, expires: '2099-01-01T00:00:00.000Z' })
    const opId = '22222222-0000-0000-0000-000000000001'
    const callsBefore = okPushCalls

    const body = { id: opId, entity: 'serviceOrder', op: 'create', payload: { orderId } }

    const { POST } = await import('./route')

    const first = await POST(new Request('http://x/api/sync/outbox', { method: 'POST', body: JSON.stringify(body) }))
    const firstBody = await first.json()
    expect(first.status).toBe(200)
    expect(firstBody).toEqual({ status: 'applied', erpRef: 'SVO-000123' })
    expect(okPushCalls).toBe(callsBefore + 1)

    // The op row AND the push group/step it drove both exist after the call.
    const opRows = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, opId))
    expect(opRows).toHaveLength(1)
    expect(opRows[0].status).toBe('applied')

    const groups = await db.select().from(schema.erpPushGroups).where(eq(schema.erpPushGroups.lane, `order:${orderId}`))
    expect(groups).toHaveLength(1)
    expect(groups[0].status).toBe('succeeded')
    const steps = await db.select().from(schema.erpPushSteps).where(eq(schema.erpPushSteps.groupId, groups[0].id))
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ status: 'succeeded', entityType: 'serviceOrder', entityId: orderId, erpRef: 'SVO-000123' })

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
    const tenantA = await makeCompanyWithOrder('ok_push_adapter', 'idor-tenant-a')
    const tenantB = await makeCompanyWithOrder('must_not_be_called_adapter', 'idor-tenant-b')
    const opId = '22222222-0000-0000-0000-000000000010'
    const callsBefore = okPushCalls

    // Session belongs to tenant A; the request body tries to redirect the
    // write to tenant B (attacker-controlled tenantId). The orderId is
    // tenant A's own order — the route never looks up tenant B's order or
    // adapter from the request body regardless.
    authMock.mockResolvedValue({ user: { id: 'attacker', tenantId: tenantA.tenantId }, expires: '2099-01-01T00:00:00.000Z' })
    const body = { id: opId, tenantId: tenantB.tenantId, entity: 'serviceOrder', op: 'create', payload: { orderId: tenantA.orderId } }

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
    expect(rows[0].tenantId).toBe(tenantA.tenantId)
    expect(rows[0].tenantId).not.toBe(tenantB.tenantId)
  })

  it('rejects with 401 when the session has no tenantId, rather than writing unscoped', async () => {
    const { orderId } = await makeCompanyWithOrder('ok_push_adapter', 'no-tenant-claim')
    const opId = '22222222-0000-0000-0000-000000000011'
    authMock.mockResolvedValue({ user: { id: 'x' }, expires: '2099-01-01T00:00:00.000Z' })

    const body = { id: opId, entity: 'serviceOrder', op: 'create', payload: { orderId } }
    const { POST } = await import('./route')
    const res = await POST(new Request('http://x/api/sync/outbox', { method: 'POST', body: JSON.stringify(body) }))

    expect(res.status).toBe(401)
    const rows = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, opId))
    expect(rows).toHaveLength(0)
  })

  it('rejects with 409 when the op id belongs to a different tenant, without leaking that tenant\'s erpRef', async () => {
    const tenantA = await makeCompanyWithOrder('ok_push_adapter', 'cross-tenant-a')
    const tenantB = await makeCompanyWithOrder('ok_push_adapter', 'cross-tenant-b')
    const opId = '22222222-0000-0000-0000-000000000020'
    const callsBefore = okPushCalls

    // Seed an outbox op owned by tenant B, applied with a real erpRef.
    authMock.mockResolvedValue({ user: { id: 'tenant-b-user', tenantId: tenantB.tenantId }, expires: '2099-01-01T00:00:00.000Z' })
    const seedBody = { id: opId, entity: 'serviceOrder', op: 'create', payload: { orderId: tenantB.orderId } }
    const { POST } = await import('./route')
    const seedRes = await POST(
      new Request('http://x/api/sync/outbox', { method: 'POST', body: JSON.stringify(seedBody) }),
    )
    expect(seedRes.status).toBe(200)
    expect(okPushCalls).toBe(callsBefore + 1)

    // Tenant A's session reuses tenant B's op id — must not confirm existence
    // or leak tenant B's erpRef ('SVO-000123').
    authMock.mockResolvedValue({ user: { id: 'tenant-a-user', tenantId: tenantA.tenantId }, expires: '2099-01-01T00:00:00.000Z' })
    const reuseBody = { id: opId, entity: 'serviceOrder', op: 'create', payload: { orderId: tenantA.orderId } }
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
    expect(rows[0].tenantId).toBe(tenantB.tenantId)
  })

  it('records an empty erpRef as a failed op, not applied — "200 and no error" is not proof of a write', async () => {
    const { tenantId, orderId } = await makeCompanyWithOrder('silent_noop_adapter', 'noop-tenant')
    authMock.mockResolvedValue({ user: { id: 'test-user-id', tenantId }, expires: '2099-01-01T00:00:00.000Z' })
    const opId = '22222222-0000-0000-0000-000000000002'

    const body = { id: opId, entity: 'serviceOrder', op: 'create', payload: { orderId } }

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
    // The saga engine dead-letters an empty-erpRef create as an
    // ErpPermanentError naming the ERP number-series onboarding issue
    // (lib/sync/push/engine.ts) — no longer the Phase-0 spike's
    // ErpTransientError wrapper, which this route no longer goes through.
    expect(rows[0].errorMessage).toContain('SerNr')

    // The dead-lettered group/step are left in place for push-retry to find.
    const groups = await db.select().from(schema.erpPushGroups).where(eq(schema.erpPushGroups.lane, `order:${orderId}`))
    expect(groups).toHaveLength(1)
    expect(groups[0].status).toBe('dead')
  })
})
