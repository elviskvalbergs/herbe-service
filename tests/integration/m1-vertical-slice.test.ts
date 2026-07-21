// tests/integration/m1-vertical-slice.test.ts
//
// Task 7 (M1 vertical-slice proof, .superpowers/sdd/task-7-brief.md): the
// full book -> execute -> approve -> WS4 push -> ERP read-back loop, driven
// THROUGH the new HTTP routes this slice added (app/api/service-orders,
// app/api/worksheets/[id]/transition, app/api/worksheets/[id]/approve) —
// not the domain functions directly, which lib/sync/push/engine.test.ts and
// tests/live/erp-contract.test.ts T7.3-T7.6 already prove at the domain
// level. This file's job is to prove the SAME loop is reachable through the
// routes, with real DB rows and a real fake-ERP round trip at every step.
//
// Harness: the DB + fake-ERP idiom from lib/sync/push/engine.test.ts
// (startFakeErpServer + createStandardBooksAdapter, port 0) crossed with the
// route-test convention (vi.mock('@/lib/auth'), DATABASE_URL set before
// dynamic `./route` imports) from app/api/worksheets/[id]/approve/route.test.ts.
//
// Adapter wiring: the approve route builds its OWN adapter internally via
// buildAdapterForConnection(db, erpCompanyId) — it does not accept an
// injected adapter. Task 6's own test solved this by registerAdapter'ing a
// fake adapter type that deliberately dies on the first push step (dead-end
// proof only). This file instead seeds a REAL 'standard_books' connection
// row (adapterConfigJson.baseUrl pointed at the fake ERP server + encrypted
// throwaway creds), so buildAdapterForConnection resolves to a genuine
// createStandardBooksAdapter hitting the fake ERP — the exact adapter
// construction path production uses, just pointed at a fake server. This
// lets the push actually succeed end-to-end (SVOVc + WSVc both created),
// which is the thing Task 6's test explicitly deferred to this task.
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { startFakeErpServer } from '@herbe/fake-erp'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import type { Role } from '@/lib/auth/roles'
import { encryptErpCredentials } from '@/lib/erp/credentials'
import { createStandardBooksAdapter } from '@/lib/erp/standard-books/adapter'
import { getErpRefs } from '@/lib/domain/stores/erp-refs'
import { insertServiceOrder } from '@/lib/domain/stores/service-orders'
import { insertWorksheet, setWorksheetStatus } from '@/lib/domain/stores/worksheets'

const authMock = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }))

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let server: Awaited<ReturnType<typeof startFakeErpServer>>

beforeAll(async () => {
  // Same reason as the approve route's own test file: buildAdapterForConnection
  // decrypts api_creds_encrypted, which needs an envelope key before any
  // company is seeded.
  process.env.MASTER_ENCRYPTION_KEY = 'test-only-throwaway-key-not-a-real-secret-value'

  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  process.env.DATABASE_URL = testDb.url

  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  server = await startFakeErpServer({ port: 0 })
}, 60_000)

afterAll(async () => {
  await server?.close()
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

async function makeTenant(slug: string) {
  const [tenant] = await db.insert(schema.tenants).values({ slug, name: slug }).returning()
  return tenant
}

// adapterType 'standard_books' + a baseUrl pointed at the shared fake ERP
// server + decryptable throwaway creds — so buildAdapterForConnection
// (called from inside the approve route) resolves to a real adapter hitting
// the fake ERP, not a mock. push.mainServiceLocation mirrors engine.test.ts's
// wsErpCompanyId fixture exactly (avoids depending on the fake ERP's
// MainStockBlock support, which lib/sync/push/gather.ts only falls back to
// when this setting is absent).
async function makeCompany(tenantId: string, slug: string) {
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({
      tenantId,
      displayName: slug,
      adapterType: 'standard_books',
      adapterConfigJson: { baseUrl: server.url, companyNumber: '1', push: { mainServiceLocation: 'VAN-1' } },
      apiCredsEncrypted: encryptErpCredentials({ username: 'test', password: 'test' }).toString('base64'),
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

async function makeUser(tenantId: string, email: string, role: Role) {
  const [user] = await db.insert(schema.users).values({ tenantId, email, role }).returning()
  return user
}

async function linkTechnician(tenantId: string, userId: string, erpCompanyId: string, externalId: string) {
  await db.insert(schema.identityLinks).values({
    tenantId,
    userId,
    provider: 'erp',
    erpCompanyId,
    externalId,
    linkedBy: 'test-setup',
  })
}

function sessionFor(user: { id: string; tenantId: string; role: string; sessionVersion: number }) {
  return {
    user: { id: user.id, tenantId: user.tenantId, role: user.role, sessionVersion: user.sessionVersion },
    expires: '2099-01-01T00:00:00.000Z',
  }
}

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function emptyPost(url: string) {
  return new Request(url, { method: 'POST' })
}

// Standalone verification adapter, built directly (not through
// buildAdapterForConnection) — same idiom as engine.test.ts's adapterFor(url)
// helper. Used only to inspect the fake ERP's store from the test side,
// independent of whatever the route did internally.
function verificationAdapter() {
  return createStandardBooksAdapter({
    baseUrl: server.url,
    companyNumber: '1',
    auth: { kind: 'basic', username: 'test', password: 'test' },
  })
}

describe('M1 vertical slice — through the routes (fake ERP)', () => {
  beforeEach(() => {
    authMock.mockReset()
  })

  it('drives book -> execute -> approve -> push -> ERP read-back entirely through the routes', async () => {
    const tenant = await makeTenant('m1-slice-tenant')
    const company = await makeCompany(tenant.id, 'm1-slice-company')
    const customer = await makeCustomer(tenant.id, company.id, 'm1-slice-customer')
    const technician = await makeUser(tenant.id, 'm1-tech@herbe-service.test', 'technician')
    await linkTechnician(tenant.id, technician.id, company.id, 'M1TECH')
    const dispatcher = await makeUser(tenant.id, 'm1-dispatcher@herbe-service.test', 'dispatcher')

    // --- 1. Book: dispatcher (order:view_all) creates the order + Assigned worksheet.
    const { POST: createOrder } = await import('@/app/api/service-orders/route')
    authMock.mockResolvedValue(sessionFor(dispatcher))

    const bookRes = await createOrder(
      jsonRequest('http://localhost/api/service-orders', {
        erpCompanyId: company.id,
        customerId: customer.id,
        technicianUserId: technician.id,
        description: 'M1 vertical slice: leaking radiator',
      }),
    )
    expect(bookRes.status).toBe(201)
    const { orderId, worksheetId } = await bookRes.json()
    expect(typeof orderId).toBe('string')
    expect(typeof worksheetId).toBe('string')

    const [orderAfterBooking] = await db.select().from(schema.serviceOrders).where(eq(schema.serviceOrders.id, orderId))
    expect(orderAfterBooking).toMatchObject({
      tenantId: tenant.id,
      erpCompanyId: company.id,
      customerId: customer.id,
      status: 'Planned',
    })

    const [worksheetAfterBooking] = await db.select().from(schema.worksheets).where(eq(schema.worksheets.id, worksheetId))
    expect(worksheetAfterBooking).toMatchObject({
      tenantId: tenant.id,
      erpCompanyId: company.id,
      orderId,
      technicianUserId: technician.id,
      status: 'Assigned',
    })

    // --- 2. Execute: technician walks Assigned -> Accepted -> In progress -> Done.
    const { POST: transition } = await import('@/app/api/worksheets/[id]/transition/route')
    authMock.mockResolvedValue(sessionFor(technician))

    const acceptedRes = await transition(
      jsonRequest(`http://localhost/api/worksheets/${worksheetId}/transition`, { to: 'Accepted' }),
      { params: Promise.resolve({ id: worksheetId }) },
    )
    expect(acceptedRes.status).toBe(200)
    let [row] = await db.select().from(schema.worksheets).where(eq(schema.worksheets.id, worksheetId))
    expect(row.status).toBe('Accepted')

    const inProgressRes = await transition(
      jsonRequest(`http://localhost/api/worksheets/${worksheetId}/transition`, { to: 'In progress' }),
      { params: Promise.resolve({ id: worksheetId }) },
    )
    expect(inProgressRes.status).toBe(200)
    ;[row] = await db.select().from(schema.worksheets).where(eq(schema.worksheets.id, worksheetId))
    expect(row.status).toBe('In progress')

    const doneRes = await transition(
      jsonRequest(`http://localhost/api/worksheets/${worksheetId}/transition`, {
        to: 'Done',
        workDescription: 'Replaced valve, tested — no leaks',
      }),
      { params: Promise.resolve({ id: worksheetId }) },
    )
    expect(doneRes.status).toBe(200)
    ;[row] = await db.select().from(schema.worksheets).where(eq(schema.worksheets.id, worksheetId))
    expect(row.status).toBe('Done')
    expect(row.workDescription).toBe('Replaced valve, tested — no leaks')

    // --- 3. Approve: dispatcher approves; the route's inline push runs
    // against the fake ERP for real (buildAdapterForConnection resolves to
    // the seeded 'standard_books' connection above).
    const { POST: approve } = await import('@/app/api/worksheets/[id]/approve/route')
    authMock.mockResolvedValue(sessionFor(dispatcher))

    const approveRes = await approve(emptyPost(`http://localhost/api/worksheets/${worksheetId}/approve`), {
      params: Promise.resolve({ id: worksheetId }),
    })
    expect(approveRes.status).toBe(200)
    const approveBody = await approveRes.json()
    expect(approveBody.status).toBe('approved')
    expect(typeof approveBody.groupId).toBe('string')
    // Both steps (SVOVc create, then WSVc create) genuinely ran and
    // succeeded — this is the real round trip Task 6's own test deferred to
    // this task (its fake adapter died on step 1 on purpose).
    expect(approveBody.pushSummary).toMatchObject({
      groupsProcessed: 1,
      groupsSucceeded: 1,
      stepsSucceeded: 2,
      stepsDead: 0,
    })

    // --- 4. Read back: worksheet flipped to Synced, and the fake ERP
    // genuinely holds a new SVOVc + WSVc record linked to each other.
    const [worksheetAfterApprove] = await db.select().from(schema.worksheets).where(eq(schema.worksheets.id, worksheetId))
    expect(worksheetAfterApprove.status).toBe('Synced')

    const orderRefs = await getErpRefs(db, tenant.id, 'service_order', orderId)
    expect(orderRefs).toHaveLength(1)
    expect(orderRefs[0]).toMatchObject({ purpose: 'primary', register: 'SVOVc' })

    const worksheetRefs = await getErpRefs(db, tenant.id, 'worksheet', worksheetId)
    expect(worksheetRefs).toHaveLength(1)
    expect(worksheetRefs[0]).toMatchObject({ purpose: 'primary', register: 'WSVc' })

    const [orderAfterApprove] = await db.select().from(schema.serviceOrders).where(eq(schema.serviceOrders.id, orderId))
    expect(orderAfterApprove.orderNumber).toBe(orderRefs[0].recordRef)

    const adapter = verificationAdapter()
    const svoRows = await adapter.fetchRecords('SVOVc', { 'filter.SerNr': orderRefs[0].recordRef })
    const wsRows = await adapter.fetchRecords('WSVc', { 'filter.SerNr': worksheetRefs[0].recordRef })
    expect(svoRows).toHaveLength(1)
    expect(wsRows).toHaveLength(1)
    // WSVc.SVONr must reference the SVOVc SerNr just created — the two
    // records are genuinely linked in the fake ERP, not just independently
    // present.
    expect(String(wsRows[0].SVONr)).toBe(String(svoRows[0].SerNr))
  })

  it("returns 403 when a technician calls the approve route (FIX-13 enforced at the route, not just approveWorksheet's own guards)", async () => {
    const tenant = await makeTenant('m1-slice-403-approve-tenant')
    const company = await makeCompany(tenant.id, 'm1-slice-403-approve-company')
    const customer = await makeCustomer(tenant.id, company.id, 'm1-slice-403-approve-customer')
    const technician = await makeUser(tenant.id, 'm1-403-approve-tech@herbe-service.test', 'technician')
    await linkTechnician(tenant.id, technician.id, company.id, 'M1TECH403')
    const order = await insertServiceOrder(db, { tenantId: tenant.id, erpCompanyId: company.id, customerId: customer.id })
    const worksheet = await insertWorksheet(db, {
      tenantId: tenant.id,
      erpCompanyId: company.id,
      orderId: order.id,
      technicianUserId: technician.id,
    })
    await setWorksheetStatus(db, tenant.id, worksheet.id, 'Done')

    const { POST: approve } = await import('@/app/api/worksheets/[id]/approve/route')
    authMock.mockResolvedValue(sessionFor(technician))

    const res = await approve(emptyPost(`http://localhost/api/worksheets/${worksheet.id}/approve`), {
      params: Promise.resolve({ id: worksheet.id }),
    })

    expect(res.status).toBe(403)
    const [row] = await db.select().from(schema.worksheets).where(eq(schema.worksheets.id, worksheet.id))
    expect(row.status).toBe('Done')
  })

  it("returns 403 when a technician transitions a worksheet owned by a DIFFERENT technician", async () => {
    const tenant = await makeTenant('m1-slice-403-transition-tenant')
    const company = await makeCompany(tenant.id, 'm1-slice-403-transition-company')
    const customer = await makeCustomer(tenant.id, company.id, 'm1-slice-403-transition-customer')
    const owner = await makeUser(tenant.id, 'm1-403-owner@herbe-service.test', 'technician')
    await linkTechnician(tenant.id, owner.id, company.id, 'M1OWNER')
    const intruder = await makeUser(tenant.id, 'm1-403-intruder@herbe-service.test', 'technician')
    const order = await insertServiceOrder(db, { tenantId: tenant.id, erpCompanyId: company.id, customerId: customer.id })
    const worksheet = await insertWorksheet(db, {
      tenantId: tenant.id,
      erpCompanyId: company.id,
      orderId: order.id,
      technicianUserId: owner.id,
    })
    await setWorksheetStatus(db, tenant.id, worksheet.id, 'Assigned')

    const { POST: transition } = await import('@/app/api/worksheets/[id]/transition/route')
    authMock.mockResolvedValue(sessionFor(intruder))

    const res = await transition(
      jsonRequest(`http://localhost/api/worksheets/${worksheet.id}/transition`, { to: 'Accepted' }),
      { params: Promise.resolve({ id: worksheet.id }) },
    )

    expect(res.status).toBe(403)
    const [row] = await db.select().from(schema.worksheets).where(eq(schema.worksheets.id, worksheet.id))
    expect(row.status).toBe('Assigned')
  })
})
