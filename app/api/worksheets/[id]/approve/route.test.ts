// app/api/worksheets/[id]/approve/route.test.ts
//
// Task 6 (O4 approval UI, docs/superpowers/sdd/task-6-brief.md): same
// DB-backed harness/mock-seam convention as
// app/api/worksheets/[id]/transition/route.test.ts (dynamic [id] param
// arrives as a Promise). The success case seeds a real ERP-company
// connection and a `registerAdapter` fake (same idiom as
// app/api/sync/outbox/[id]/retry/route.test.ts's makeCompanyWithOrder) so
// the route's inline buildAdapterForConnection + processPushQueue call is
// genuinely exercised, not mocked away — but the fake's pushCreate for
// SVOVc deliberately returns an empty erpRef (permanent failure,
// same convention as retry_fail_adapter), so the worksheet_push group's
// FIRST step dies and the second (WSVc) step never runs this tick. That
// keeps the worksheet's end state deterministically 'Approved' (never
// 'Synced') without depending on the fake correctly emulating a full
// two-step SVOVc+WSVc round trip — the full push + ERP read-back proof is
// Task 7's job (this route's brief explicitly says not to duplicate it
// here), and it also exercises this route's OWN contract: a push failure
// must never roll back the already-committed approval.
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import type { Role } from '@/lib/auth/roles'
import { registerAdapter } from '@herbe/erp-core'
import { encryptErpCredentials } from '@/lib/erp/credentials'
import { insertServiceOrder } from '@/lib/domain/stores/service-orders'
import { insertWorksheet, setWorksheetStatus } from '@/lib/domain/stores/worksheets'
import { getStepsForGroup } from '@/lib/sync/push/store'

const authMock = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }))

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

let approveDeadAdapterPushCalls = 0

beforeAll(async () => {
  // Same reason as retry route's own test file: buildAdapterForConnection
  // decrypts api_creds_encrypted, which needs an envelope key before any
  // company is seeded.
  process.env.MASTER_ENCRYPTION_KEY = 'test-only-throwaway-key-not-a-real-secret-value'
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  process.env.DATABASE_URL = testDb.url

  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  // Always fails the SVOVc create step (empty erpRef -> ErpPermanentError,
  // same classification as retry_fail_adapter) so the worksheet_push
  // group's first step dies and the WSVc step is never attempted this
  // tick — see this file's header comment for why that's the deterministic
  // choice for the success test below.
  registerAdapter('approve_dead_adapter', () => ({
    capabilities: () => ({
      supportsIncrementalSync: false,
      supportsDeletesFeed: false,
      supportsDocumentFetch: false,
      supportsInvoiceStatusReadback: false,
      supportsActivityMirror: false,
    }),
    pullChanges: async () => {
      throw new Error('pullChanges must not be called by the approve route')
    },
    pushCreate: async (register: string) => {
      if (register === 'SVOVc') {
        approveDeadAdapterPushCalls += 1
        return { erpRef: '' }
      }
      throw new Error('must not be reached: the SVOVc step dies before the WSVc step ever runs')
    },
    pushUpdate: async () => {
      throw new Error('pushUpdate must not be called by the approve route')
    },
    fetchRecords: async () => [],
    probeIncrementalSupport: async () => false,
    pullFullList: async () => [],
    listLiveRefs: async () => [],
    getRecordLinks: async () => {
      throw new Error('getRecordLinks must not be called by the approve route')
    },
  }))
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

async function makeTenant(slug: string) {
  const [tenant] = await db.insert(schema.tenants).values({ slug, name: slug }).returning()
  return tenant
}

async function makeUser(tenantId: string, email: string, role: Role) {
  const [user] = await db.insert(schema.users).values({ tenantId, email, role }).returning()
  return user
}

// Seeded like a real connection (mirrors makeCompanyWithOrder from the
// retry route's test file) — the fake adapter ignores adapterConfigJson,
// but buildAdapterForConnection still needs a decodable apiCredsEncrypted
// blob and a baseUrl/companyNumber shape to build its config.
async function makeCompany(tenantId: string, slug: string) {
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({
      tenantId,
      displayName: slug,
      adapterType: 'approve_dead_adapter',
      adapterConfigJson: { baseUrl: 'http://x', companyNumber: '1' },
      apiCredsEncrypted: encryptErpCredentials({ username: 'u', password: 'p' }).toString('base64'),
    })
    .returning()
  return company
}

async function makeCustomer(tenantId: string, erpCompanyId: string, slug: string) {
  const [customer] = await db
    .insert(schema.customers)
    .values({ tenantId, erpCompanyId, erpRef: `CUST-${slug}`, name: slug, changeSeq: BigInt(0) })
    .returning()
  return customer
}

async function makeDoneWorksheet(tenantId: string, erpCompanyId: string, orderId: string, technicianUserId?: string) {
  const worksheet = await insertWorksheet(db, { tenantId, erpCompanyId, orderId, technicianUserId })
  await setWorksheetStatus(db, tenantId, worksheet.id, 'Done')
  return worksheet
}

async function linkTechnicianToErp(tenantId: string, userId: string, erpCompanyId: string, externalId: string) {
  await db.insert(schema.identityLinks).values({ tenantId, userId, provider: 'erp', erpCompanyId, externalId, linkedBy: 'test' })
}

function sessionFor(user: { id: string; tenantId: string; role: string; sessionVersion: number }) {
  return {
    user: { id: user.id, tenantId: user.tenantId, role: user.role, sessionVersion: user.sessionVersion },
    expires: '2099-01-01T00:00:00.000Z',
  }
}

function call(id: string) {
  return import('./route').then(({ POST }) =>
    POST(new Request(`http://x/api/worksheets/${id}/approve`, { method: 'POST' }), { params: Promise.resolve({ id }) }),
  )
}

describe('POST /api/worksheets/[id]/approve', () => {
  beforeEach(() => {
    authMock.mockReset()
  })

  it('rejects an unauthenticated request with 401', async () => {
    authMock.mockResolvedValue(null)

    const res = await call('00000000-0000-0000-0000-000000000000')

    expect(res.status).toBe(401)
  })

  it("returns 403 for a technician (proves FIX-13: worksheet:approve is checked at the route, not just approveWorksheet's own guards)", async () => {
    const tenant = await makeTenant('approve-403-tenant')
    const company = await makeCompany(tenant.id, 'approve-403-company')
    const customer = await makeCustomer(tenant.id, company.id, 'approve-403-customer')
    const order = await insertServiceOrder(db, { tenantId: tenant.id, erpCompanyId: company.id, customerId: customer.id })
    const technicianUser = await makeUser(tenant.id, 'tech-403@herbe-service.test', 'technician')
    await linkTechnicianToErp(tenant.id, technicianUser.id, company.id, 'EM-403')
    const worksheet = await makeDoneWorksheet(tenant.id, company.id, order.id, technicianUser.id)

    authMock.mockResolvedValue(sessionFor(technicianUser))
    const res = await call(worksheet.id)

    expect(res.status).toBe(403)
    const [row] = await db.select().from(schema.worksheets).where(eq(schema.worksheets.id, worksheet.id))
    expect(row.status).toBe('Done')
  })

  it('returns 404 for a worksheet id belonging to a different tenant, without leaking existence', async () => {
    const tenantA = await makeTenant('approve-404-tenant-a')
    const tenantB = await makeTenant('approve-404-tenant-b')
    const companyB = await makeCompany(tenantB.id, 'approve-404-company-b')
    const customerB = await makeCustomer(tenantB.id, companyB.id, 'approve-404-customer-b')
    const orderB = await insertServiceOrder(db, { tenantId: tenantB.id, erpCompanyId: companyB.id, customerId: customerB.id })
    const technicianB = await makeUser(tenantB.id, 'tech-b@herbe-service.test', 'technician')
    await linkTechnicianToErp(tenantB.id, technicianB.id, companyB.id, 'EM-B')
    const worksheetB = await makeDoneWorksheet(tenantB.id, companyB.id, orderB.id, technicianB.id)

    const dispatcherA = await makeUser(tenantA.id, 'dispatcher-a@herbe-service.test', 'dispatcher')
    authMock.mockResolvedValue(sessionFor(dispatcherA))
    const res = await call(worksheetB.id)

    expect(res.status).toBe(404)
  })

  it('approves a Done worksheet, enqueues the worksheet_push group, and runs the inline push without rolling back the approval when the push fails', async () => {
    const tenant = await makeTenant('approve-ok-tenant')
    const company = await makeCompany(tenant.id, 'approve-ok-company')
    const customer = await makeCustomer(tenant.id, company.id, 'approve-ok-customer')
    const order = await insertServiceOrder(db, { tenantId: tenant.id, erpCompanyId: company.id, customerId: customer.id })
    const technicianUser = await makeUser(tenant.id, 'tech-ok@herbe-service.test', 'technician')
    await linkTechnicianToErp(tenant.id, technicianUser.id, company.id, 'EM-OK')
    const worksheet = await makeDoneWorksheet(tenant.id, company.id, order.id, technicianUser.id)

    const dispatcher = await makeUser(tenant.id, 'dispatcher-ok@herbe-service.test', 'dispatcher')
    authMock.mockResolvedValue(sessionFor(dispatcher))
    const callsBefore = approveDeadAdapterPushCalls

    const res = await call(worksheet.id)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.status).toBe('approved')
    expect(typeof body.groupId).toBe('string')
    // The inline push genuinely ran (not skipped) — its SVOVc step was
    // actually attempted, then classified as a permanent failure.
    expect(approveDeadAdapterPushCalls).toBe(callsBefore + 1)
    expect(body.pushSummary).toMatchObject({ groupsProcessed: 1, groupsDead: 1, stepsDead: 1 })

    // The approval itself committed and was NOT rolled back by the push
    // failure — this is the constraint this route's brief calls out
    // explicitly (cron retries a dead/pending group on its own schedule).
    const [row] = await db.select().from(schema.worksheets).where(eq(schema.worksheets.id, worksheet.id))
    expect(row.status).toBe('Approved')

    const steps = await getStepsForGroup(db, body.groupId)
    expect(steps).toHaveLength(2)
    expect(steps[0]).toMatchObject({ seq: 1, entityType: 'serviceOrder', entityId: order.id, register: 'SVOVc', op: 'create', status: 'dead' })
    expect(steps[1]).toMatchObject({ seq: 2, entityType: 'worksheet', entityId: worksheet.id, register: 'WSVc', op: 'create', status: 'pending' })
  })

  it('returns 409 for a worksheet not in Done status (Assigned), leaving its status unchanged', async () => {
    const tenant = await makeTenant('approve-409-tenant')
    const company = await makeCompany(tenant.id, 'approve-409-company')
    const customer = await makeCustomer(tenant.id, company.id, 'approve-409-customer')
    const order = await insertServiceOrder(db, { tenantId: tenant.id, erpCompanyId: company.id, customerId: customer.id })
    const technicianUser = await makeUser(tenant.id, 'tech-409@herbe-service.test', 'technician')
    await linkTechnicianToErp(tenant.id, technicianUser.id, company.id, 'EM-409')
    const worksheet = await insertWorksheet(db, {
      tenantId: tenant.id,
      erpCompanyId: company.id,
      orderId: order.id,
      technicianUserId: technicianUser.id,
    })
    await setWorksheetStatus(db, tenant.id, worksheet.id, 'Assigned')

    const dispatcher = await makeUser(tenant.id, 'dispatcher-409@herbe-service.test', 'dispatcher')
    authMock.mockResolvedValue(sessionFor(dispatcher))
    const res = await call(worksheet.id)

    // DomainTransitionError from approveWorksheet (assertWorksheetTransition
    // only allows Done -> Approved) surfaces as 409, per this route's header
    // comment.
    expect(res.status).toBe(409)
    const [row] = await db.select().from(schema.worksheets).where(eq(schema.worksheets.id, worksheet.id))
    expect(row.status).toBe('Assigned')
  })

  it('returns 422 for a Done worksheet whose technician has no identity_links (erp) entry, leaving its status unchanged', async () => {
    const tenant = await makeTenant('approve-422-tenant')
    const company = await makeCompany(tenant.id, 'approve-422-company')
    const customer = await makeCustomer(tenant.id, company.id, 'approve-422-customer')
    const order = await insertServiceOrder(db, { tenantId: tenant.id, erpCompanyId: company.id, customerId: customer.id })
    const technicianUser = await makeUser(tenant.id, 'tech-422@herbe-service.test', 'technician')
    // Deliberately no linkTechnicianToErp call — approveWorksheet's plain
    // Error for a missing identity_links row must surface as 422.
    const worksheet = await makeDoneWorksheet(tenant.id, company.id, order.id, technicianUser.id)

    const dispatcher = await makeUser(tenant.id, 'dispatcher-422@herbe-service.test', 'dispatcher')
    authMock.mockResolvedValue(sessionFor(dispatcher))
    const res = await call(worksheet.id)

    expect(res.status).toBe(422)
    const [row] = await db.select().from(schema.worksheets).where(eq(schema.worksheets.id, worksheet.id))
    expect(row.status).toBe('Done')
  })
})
