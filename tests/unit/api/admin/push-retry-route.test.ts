// tests/unit/api/admin/push-retry-route.test.ts
//
// DB-backed tests for POST /api/admin/push-retry (WS4 outbound slice, docs/
// superpowers/plans/2026-07-16-service-phase1-erp-outbound.md decision 11),
// against a real local Postgres — same bootstrap and vi.stubEnv convention
// as tests/unit/api/admin/ext-tokens-route.test.ts. `@/app/api/admin/
// push-retry/route` transitively imports `@/lib/db`, which reads
// DATABASE_URL at module-load time, so DATABASE_URL must point at the
// harness DB *before* the route module is first dynamically imported.
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { startFakeErpServer } from '@herbe/fake-erp'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { createStandardBooksAdapter } from '@/lib/erp/standard-books/adapter'
import { insertServiceOrder } from '@/lib/domain/stores/service-orders'
import { enqueueOrderCreatePush } from '@/lib/sync/push/enqueue'
import { getStepsForGroup, markStep, markGroup } from '@/lib/sync/push/store'
import { processPushQueue } from '@/lib/sync/push/engine'
import { getErpRefs } from '@/lib/domain/stores/erp-refs'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string
let erpCompanyId: string
let customerId: string

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/admin/push-retry', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

// Drives a fresh order create group to a 'dead' step/group WITHOUT any real
// ERP failure — a direct status write, same shorthand idiom as lib/sync/
// push/store.test.ts's setGroupStatus/setGroupCreatedAt helpers. This
// isolates the route test from the engine's own failure-classification
// behavior (already covered by lib/sync/push/engine.test.ts) while still
// producing a realistic "operator needs to retry a stuck order" fixture.
//
// Takes its own erpCompanyId (rather than the shared module-level one) so
// the later processPushQueue integration assertion only ever sees THIS
// group — other tests in this file enqueue-but-never-drain groups on the
// shared company, and processPushQueue(db, adapter, erpCompanyId) sweeps
// every runnable group for that company, not just one lane.
async function makeDeadOrderCreateGroup(companyId: string, custId: string) {
  const order = await insertServiceOrder(db, { tenantId, erpCompanyId: companyId, customerId: custId })
  const { groupId } = await enqueueOrderCreatePush(db, { tenantId, erpCompanyId: companyId, orderId: order.id })
  const [step] = await getStepsForGroup(db, groupId)

  await markStep(db, step.id, {
    status: 'dead',
    attempts: 5,
    errorMessage: 'create returned 200 without a SerNr — ERP number series for SVOVc likely behind/exhausted',
  })
  await markGroup(db, groupId, 'dead')

  return { groupId, stepId: step.id, orderId: order.id }
}

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  process.env.DATABASE_URL = testDb.url

  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 'push-retry-t1', name: 'Push Retry T1' }).returning()
  tenantId = tenant.id

  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName: 'Push Retry Co', adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  erpCompanyId = company.id

  const [customer] = await db
    .insert(schema.customers)
    .values({ tenantId, erpCompanyId, erpRef: 'CUST-RETRY', name: 'Retry Test Client', changeSeq: BigInt(0) })
    .returning()
  customerId = customer.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('POST /api/admin/push-retry', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns 401 (plain text) when the bearer header is missing', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')
    const { POST } = await import('@/app/api/admin/push-retry/route')

    const res = await POST(makeRequest({ stepId: randomUUID() }))

    expect(res.status).toBe(401)
    expect(await res.text()).toBe('Unauthorized')
  })

  it('returns 401 when the bearer is wrong', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')
    const { POST } = await import('@/app/api/admin/push-retry/route')

    const res = await POST(makeRequest({ stepId: randomUUID() }, { authorization: 'Bearer wrong-secret' }))

    expect(res.status).toBe(401)
  })

  it('returns 401 when ADMIN_MIGRATIONS_SECRET is unset (fail-closed)', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', '')
    const { POST } = await import('@/app/api/admin/push-retry/route')

    const res = await POST(makeRequest({ stepId: randomUUID() }, { authorization: 'Bearer anything' }))

    expect(res.status).toBe(401)
  })

  it('returns 400 when stepId is missing', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')
    const { POST } = await import('@/app/api/admin/push-retry/route')

    const res = await POST(makeRequest({}, { authorization: 'Bearer the-secret' }))

    expect(res.status).toBe(400)
  })

  it('returns 400 when stepId is not a uuid', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')
    const { POST } = await import('@/app/api/admin/push-retry/route')

    const res = await POST(makeRequest({ stepId: 'not-a-uuid' }, { authorization: 'Bearer the-secret' }))

    expect(res.status).toBe(400)
  })

  it('returns 404 for a well-formed but nonexistent stepId', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')
    const { POST } = await import('@/app/api/admin/push-retry/route')

    const res = await POST(makeRequest({ stepId: randomUUID() }, { authorization: 'Bearer the-secret' }))

    expect(res.status).toBe(404)
  })

  it('returns 409 when the step exists but is not dead', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')
    const order = await insertServiceOrder(db, { tenantId, erpCompanyId, customerId })
    const { groupId } = await enqueueOrderCreatePush(db, { tenantId, erpCompanyId, orderId: order.id })
    const [step] = await getStepsForGroup(db, groupId)
    expect(step.status).toBe('pending') // never touched — not dead

    const { POST } = await import('@/app/api/admin/push-retry/route')
    const res = await POST(makeRequest({ stepId: step.id }, { authorization: 'Bearer the-secret' }))

    expect(res.status).toBe(409)
  })

  it('resets a dead step (+ its group) to pending, and a subsequent processPushQueue tick completes the group', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')

    // Dedicated company + customer (see makeDeadOrderCreateGroup's comment):
    // isolates the processPushQueue sweep below from other tests' leftover
    // pending groups on the shared module-level erpCompanyId.
    const [company] = await db
      .insert(schema.erpCompanies)
      .values({ tenantId, displayName: 'Push Retry Integration Co', adapterType: 'standard_books', adapterConfigJson: {} })
      .returning()
    const [customer] = await db
      .insert(schema.customers)
      .values({ tenantId, erpCompanyId: company.id, erpRef: 'CUST-RETRY-INTEGRATION', name: 'Retry Integration Client', changeSeq: BigInt(0) })
      .returning()

    const { groupId, stepId, orderId } = await makeDeadOrderCreateGroup(company.id, customer.id)

    const { POST } = await import('@/app/api/admin/push-retry/route')
    const res = await POST(makeRequest({ stepId }, { authorization: 'Bearer the-secret' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ status: 'reset', stepId })

    const [resetStep] = await getStepsForGroup(db, groupId)
    expect(resetStep.status).toBe('pending')
    expect(resetStep.attempts).toBe(0)
    expect(resetStep.errorMessage).toBeNull()

    const [group] = await db.select().from(schema.erpPushGroups).where(eq(schema.erpPushGroups.id, groupId))
    expect(group.status).toBe('pending')

    // Integration assertion (Task 6 brief): the next engine tick against a
    // real (non-noop) fake ERP actually completes the group the retry
    // unblocked — retrying isn't just a DB status flip.
    const server = await startFakeErpServer({ port: 0 })
    try {
      const adapter = createStandardBooksAdapter({
        baseUrl: server.url,
        companyNumber: '1',
        auth: { kind: 'basic', username: 'test', password: 'test' },
      })

      const summary = await processPushQueue(db, adapter, company.id)
      expect(summary).toMatchObject({ groupsProcessed: 1, groupsSucceeded: 1, stepsSucceeded: 1, stepsDead: 0 })

      const [finalGroup] = await db.select().from(schema.erpPushGroups).where(eq(schema.erpPushGroups.id, groupId))
      expect(finalGroup.status).toBe('succeeded')

      const refs = await getErpRefs(db, tenantId, 'service_order', orderId)
      expect(refs).toHaveLength(1)
      expect(refs[0]).toMatchObject({ purpose: 'primary', register: 'SVOVc' })
    } finally {
      await server.close()
    }
  })
})
