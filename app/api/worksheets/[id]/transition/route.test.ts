// app/api/worksheets/[id]/transition/route.test.ts
//
// Task 5: same DB-backed harness/mock-seam convention as
// app/api/service-orders/route.test.ts and app/api/sync/outbox/[id]/retry/route.test.ts
// (dynamic [id] param arrives as a Promise, same Next.js route-handler shape).
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import type { Role } from '@/lib/auth/roles'
import { insertServiceOrder } from '@/lib/domain/stores/service-orders'
import { insertWorksheet, setWorksheetStatus } from '@/lib/domain/stores/worksheets'

const authMock = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }))

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  process.env.DATABASE_URL = testDb.url

  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })
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

async function makeCompany(tenantId: string, slug: string) {
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName: slug, adapterType: 'standard_books' })
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

function sessionFor(user: { id: string; tenantId: string; role: string; sessionVersion: number }) {
  return {
    user: { id: user.id, tenantId: user.tenantId, role: user.role, sessionVersion: user.sessionVersion },
    expires: '2099-01-01T00:00:00.000Z',
  }
}

function transitionRequest(body: unknown) {
  return new Request('http://localhost/api/worksheets/x/transition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/worksheets/[id]/transition', () => {
  beforeEach(() => {
    authMock.mockReset()
  })

  it('rejects an unauthenticated request with 401, writing nothing', async () => {
    authMock.mockResolvedValue(null)

    const { POST } = await import('./route')
    const res = await POST(transitionRequest({ to: 'Accepted' }), { params: Promise.resolve({ id: 'x' }) })

    expect(res.status).toBe(401)
  })

  it('applies a legal progression (Assigned -> Accepted), saving workDescription first', async () => {
    const tenant = await makeTenant('transition-ok-tenant')
    const company = await makeCompany(tenant.id, 'transition-ok-company')
    const customer = await makeCustomer(tenant.id, company.id, 'transition-ok-customer')
    const order = await insertServiceOrder(db, { tenantId: tenant.id, customerId: customer.id })
    const technician = await makeUser(tenant.id, 'tech-ok@herbe-service.test', 'technician')
    const worksheet = await insertWorksheet(db, {
      tenantId: tenant.id,
      orderId: order.id,
      technicianUserId: technician.id,
    })
    await setWorksheetStatus(db, tenant.id, worksheet.id, 'Assigned')

    authMock.mockResolvedValue(sessionFor(technician))
    const { POST } = await import('./route')
    const res = await POST(transitionRequest({ to: 'Accepted', workDescription: 'On site now' }), {
      params: Promise.resolve({ id: worksheet.id }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ status: 'ok', to: 'Accepted' })

    const [updated] = await db.select().from(schema.worksheets).where(eq(schema.worksheets.id, worksheet.id))
    expect(updated.status).toBe('Accepted')
    expect(updated.workDescription).toBe('On site now')
  })

  it("rejects a 'to' value outside the allow-list (e.g. Approved) with 400, changing nothing", async () => {
    const tenant = await makeTenant('transition-badto-tenant')
    const company = await makeCompany(tenant.id, 'transition-badto-company')
    const customer = await makeCustomer(tenant.id, company.id, 'transition-badto-customer')
    const order = await insertServiceOrder(db, { tenantId: tenant.id, customerId: customer.id })
    const technician = await makeUser(tenant.id, 'tech-badto@herbe-service.test', 'technician')
    const worksheet = await insertWorksheet(db, {
      tenantId: tenant.id,
      orderId: order.id,
      technicianUserId: technician.id,
    })
    await setWorksheetStatus(db, tenant.id, worksheet.id, 'Done')

    authMock.mockResolvedValue(sessionFor(technician))
    const { POST } = await import('./route')
    const res = await POST(transitionRequest({ to: 'Approved' }), { params: Promise.resolve({ id: worksheet.id }) })

    expect(res.status).toBe(400)
    const [row] = await db.select().from(schema.worksheets).where(eq(schema.worksheets.id, worksheet.id))
    expect(row.status).toBe('Done')
  })

  it("forbids a technician who does not own the worksheet with 403, changing nothing", async () => {
    const tenant = await makeTenant('transition-403-tenant')
    const company = await makeCompany(tenant.id, 'transition-403-company')
    const customer = await makeCustomer(tenant.id, company.id, 'transition-403-customer')
    const order = await insertServiceOrder(db, { tenantId: tenant.id, customerId: customer.id })
    const ownerTechnician = await makeUser(tenant.id, 'tech-owner@herbe-service.test', 'technician')
    const worksheet = await insertWorksheet(db, {
      tenantId: tenant.id,
      orderId: order.id,
      technicianUserId: ownerTechnician.id,
    })
    await setWorksheetStatus(db, tenant.id, worksheet.id, 'Assigned')

    const intruderTechnician = await makeUser(tenant.id, 'tech-intruder@herbe-service.test', 'technician')
    authMock.mockResolvedValue(sessionFor(intruderTechnician))
    const { POST } = await import('./route')
    const res = await POST(transitionRequest({ to: 'Accepted' }), { params: Promise.resolve({ id: worksheet.id }) })

    expect(res.status).toBe(403)
    const [row] = await db.select().from(schema.worksheets).where(eq(schema.worksheets.id, worksheet.id))
    expect(row.status).toBe('Assigned')
  })

  it('returns 404 for a worksheet id belonging to a different tenant, without leaking existence', async () => {
    const tenantA = await makeTenant('transition-404-tenant-a')
    const tenantB = await makeTenant('transition-404-tenant-b')
    const companyB = await makeCompany(tenantB.id, 'transition-404-company-b')
    const customerB = await makeCustomer(tenantB.id, companyB.id, 'transition-404-customer-b')
    const orderB = await insertServiceOrder(db, { tenantId: tenantB.id, customerId: customerB.id })
    const technicianB = await makeUser(tenantB.id, 'tech-b@herbe-service.test', 'technician')
    const worksheetB = await insertWorksheet(db, {
      tenantId: tenantB.id,
      orderId: orderB.id,
      technicianUserId: technicianB.id,
    })
    await setWorksheetStatus(db, tenantB.id, worksheetB.id, 'Assigned')

    const technicianA = await makeUser(tenantA.id, 'tech-a@herbe-service.test', 'technician')
    authMock.mockResolvedValue(sessionFor(technicianA))
    const { POST } = await import('./route')
    const res = await POST(transitionRequest({ to: 'Accepted' }), { params: Promise.resolve({ id: worksheetB.id }) })

    expect(res.status).toBe(404)
  })

  it('returns 409 for an illegal transition (Assigned -> Done, skipping Accepted/In progress), status unchanged', async () => {
    const tenant = await makeTenant('transition-409-tenant')
    const company = await makeCompany(tenant.id, 'transition-409-company')
    const customer = await makeCustomer(tenant.id, company.id, 'transition-409-customer')
    const order = await insertServiceOrder(db, { tenantId: tenant.id, customerId: customer.id })
    const technician = await makeUser(tenant.id, 'tech-409@herbe-service.test', 'technician')
    const worksheet = await insertWorksheet(db, {
      tenantId: tenant.id,
      orderId: order.id,
      technicianUserId: technician.id,
    })
    await setWorksheetStatus(db, tenant.id, worksheet.id, 'Assigned')

    authMock.mockResolvedValue(sessionFor(technician))
    const { POST } = await import('./route')
    const res = await POST(transitionRequest({ to: 'Done' }), { params: Promise.resolve({ id: worksheet.id }) })

    expect(res.status).toBe(409)
    const [row] = await db.select().from(schema.worksheets).where(eq(schema.worksheets.id, worksheet.id))
    expect(row.status).toBe('Assigned')
  })
})
